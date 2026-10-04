"""核对任务（方案 8.2 第 6 条），结果 ``POST /mail-verifications``。

检查项（契约 mail_verification 的 8 项，各出现一次）：

| code | 怎么查 |
| --- | --- |
| pending_backlog | 本地任务表里 pending 且登记超过 30 分钟 |
| copy_missing | 未清理的邮件副本或附件副本在存储里不存在 |
| hash_mismatch | 副本存在但 sha256 与记录不一致 |
| document_without_copy | 已写成 resume_document 的附件，副本不存在（且未按保留期清理） |
| needs_review_mismatch | 本地 needs_review 与服务端 ``GET /mail-messages?status=needs_review`` 不一致（人工关联后 processed 的不算） |
| failed_mismatch | 本地 failed 与服务端 failed 队列不一致 |
| webhook_delivery_failed | mail 投递台账里失败 / 落死的投递（需要 admin 凭据，没有则 count=null） |
| upstream_missing | mail 里有、我方没有的邮件（需要 G0 的列出接口，没有则 count=null） |

另外：``overdue_resume_requests``（求简历成功超过 resume_mail_timeout_days 未收到简历，只提醒）、
``purged_copies``（本次清理数量，核对前先跑一次保留期清理）。某项做不了时报 ``count=null`` 与原因，不报 0。
mail 的 key 自检失败时整次核对 ``outcome=failed``。
"""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from monitor_contracts import validate_mail_verification

from .clock import Clock, parse_time, to_wire_time
from .config import MailSettings
from .mail_api import DeliveryLedger, MailApi, MailApiError, UpstreamListingUnavailable
from .retention import DEFAULT_RETENTION_DAYS, purge_expired_copies
from .server_api import ServerApi, ServerApiError
from .storage import BlobStorage, StorageError, sha256_hex
from .store import MailStore, db_time, from_db_time
from .writer import ServerWriter

logger = logging.getLogger(__name__)

CHECK_CODES = (
    "pending_backlog",
    "copy_missing",
    "hash_mismatch",
    "document_without_copy",
    "needs_review_mismatch",
    "failed_mismatch",
    "webhook_delivery_failed",
    "upstream_missing",
)
MAX_REFS = 20
UPSTREAM_UNAVAILABLE = "mail 尚无 integration 列出邮件接口（任务 G0），无法对账"
LEDGER_UNAVAILABLE = "未配置 mail 投递台账的管理凭据，无法读取失败投递"


class SelfCheckError(Exception):
    """mail 的 key 自检失败（配错 key、绑错邮箱、缺 mail.read）。"""


def self_check(mail: MailApi, settings: MailSettings) -> str:
    """调 ``GET /v1/integration/mailbox`` 确认 key 绑的是本邮箱（主地址或别名）且有 mail.read。返回 mailbox_id。"""
    try:
        info = mail.get_mailbox()
    except MailApiError as exc:
        raise SelfCheckError(f"mail key 自检失败：{exc.code}: {exc}") from exc
    if info.primary_address.strip().lower() not in settings.mailbox_addresses:
        expected = "、".join(sorted(settings.mailbox_addresses))
        raise SelfCheckError(f"mail key 绑定的邮箱是 {info.primary_address}，不是 {expected}")
    if "mail.read" not in info.scopes:
        raise SelfCheckError("mail key 缺少 mail.read")
    if settings.expected_mailbox_id and info.mailbox_id != settings.expected_mailbox_id:
        raise SelfCheckError("mail key 绑定的 mailbox_id 与配置不一致")
    return info.mailbox_id


@dataclass
class _Check:
    code: str
    count: int | None
    refs: list[str]
    unavailable_reason: str | None = None

    def to_wire(self) -> dict[str, Any]:
        return {"code": self.code, "count": self.count, "refs": self.refs[:MAX_REFS],
                "unavailable_reason": self.unavailable_reason}


def _check(code: str, refs: list[str]) -> _Check:
    return _Check(code, len(refs), sorted(set(refs)))


def _unavailable(code: str, reason: str) -> _Check:
    return _Check(code, None, [], reason[:200])


class Verifier:
    def __init__(
        self,
        *,
        store: MailStore,
        mail: MailApi,
        server: ServerApi,
        storage: BlobStorage,
        settings: MailSettings,
        clock: Clock,
        ledger: DeliveryLedger | None = None,
        retention_days: int | Callable[[], int] = DEFAULT_RETENTION_DAYS,
        resume_mail_timeout_days: int | Callable[[], int] = 3,
    ) -> None:
        self.store = store
        self.mail = mail
        self.server = server
        self.storage = storage
        self.settings = settings
        self.clock = clock
        self.ledger = ledger
        self.retention_days = retention_days
        self.resume_mail_timeout_days = resume_mail_timeout_days
        self.writer = ServerWriter(store=store, server=server, clock=clock)

    def run(self) -> dict[str, Any]:
        """跑一次核对并提交，返回提交的 mail_verification。提交失败抛 ServerApiError（已落 outbox）。"""
        started = self.clock.now()
        try:
            self_check(self.mail, self.settings)
            purged = purge_expired_copies(store=self.store, storage=self.storage, writer=self.writer,
                                          clock=self.clock, retention_days=self.retention_days)
            checks = [
                self._pending_backlog(),
                *self._copies(),
                *self._server_queues(),
                self._delivery_failures(),
                self._upstream_missing(),
            ]
            overdue = self._overdue()
            body = self._body(started, outcome=None, checks=checks, overdue=overdue, purged=purged, error=None)
        except (SelfCheckError, ServerApiError, MailApiError, StorageError, ValueError) as exc:
            logger.error("核对失败：%s", exc)
            body = self._body(started, outcome="failed", checks=[], overdue=[], purged=0,
                              error=f"{type(exc).__name__}: {exc}"[:500])
        validate_mail_verification(body)
        self.writer.post_verification(body)
        return body

    def _body(self, started: datetime, *, outcome: str | None, checks: list[_Check], overdue: list[dict[str, Any]],
              purged: int, error: str | None) -> dict[str, Any]:
        finished = max(self.clock.now(), started)
        if outcome is None:
            outcome = "issues_found" if any((c.count or 0) > 0 for c in checks) else "ok"
        digest = hashlib.sha256(self.settings.mailbox.encode()).hexdigest()[:8]
        return {
            "verification_id": f"verify:{digest}:{started.strftime('%Y%m%dT%H%M%S%fZ')}",
            "mailbox": self.settings.mailbox,
            "started_at": to_wire_time(started),
            "finished_at": to_wire_time(finished),
            "outcome": outcome,
            "error": error,
            "checks": [c.to_wire() for c in checks],
            "overdue_resume_requests": overdue[:200],
            "purged_copies": purged,
        }

    # ---- 本地检查 ---------------------------------------------------------------

    def _pending_backlog(self) -> _Check:
        cutoff = db_time(self.clock.now() - timedelta(minutes=self.settings.pending_backlog_minutes))
        return _check("pending_backlog",
                      [t.mail_message_id for t in self.store.list_tasks(["pending"]) if t.registered_at <= cutoff])

    def _copies(self) -> list[_Check]:
        missing: list[str] = []
        mismatch: list[str] = []
        doc_missing: list[str] = []
        for task in self.store.list_tasks():
            if task.copy_purged_at is None and task.raw_storage_uri and task.sha256:
                data = self.storage.get(task.raw_storage_uri)
                if data is None:
                    missing.append(task.mail_message_id)
                elif sha256_hex(data) != task.sha256:
                    mismatch.append(task.mail_message_id)
        for attachment in self.store.list_attachments():
            if attachment.purged_at is not None or not attachment.storage_uri:
                continue
            data = self.storage.get(attachment.storage_uri)
            if data is None:
                missing.append(attachment.mail_message_id)
                if attachment.doc_id:
                    doc_missing.append(attachment.doc_id)
            elif sha256_hex(data) != attachment.sha256:
                mismatch.append(attachment.mail_message_id)
        return [_check("copy_missing", missing), _check("hash_mismatch", mismatch),
                _check("document_without_copy", doc_missing)]

    # ---- 与服务端对账 ---------------------------------------------------------

    def _server_queues(self) -> list[_Check]:
        mailbox = self.settings.mailbox
        server_review = {m["mail_message_id"] for m in self.server.list_mail_messages(statuses=["needs_review"], mailbox=mailbox)}
        server_failed = {m["mail_message_id"] for m in self.server.list_mail_messages(statuses=["failed"], mailbox=mailbox)}
        local_review = {t.mail_message_id: t for t in self.store.list_tasks(["needs_review"])}
        local_failed = {t.mail_message_id for t in self.store.list_tasks(["failed"])}

        # 本地 needs_review、服务端已不在队列：如果是人工关联后 processed，同步本地，不算不一致。
        gone = set(local_review) - server_review
        resolved: set[str] = set()
        if gone:
            oldest = min(from_db_time(local_review[i].received_at) for i in gone)
            processed = {
                m["mail_message_id"]
                for m in self.server.list_mail_messages(statuses=["processed"], mailbox=mailbox, received_after=oldest)
            }
            resolved = gone & processed
            now_s = db_time(self.clock.now())
            for mail_message_id in resolved:
                self.store.update_task(mail_message_id, status="processed", error=None, updated_at=now_s)
        review_mismatch = sorted((server_review ^ set(local_review)) - resolved)
        failed_mismatch = sorted(server_failed ^ local_failed)
        return [_check("needs_review_mismatch", review_mismatch), _check("failed_mismatch", failed_mismatch)]

    def _delivery_failures(self) -> _Check:
        if self.ledger is None:
            return _unavailable("webhook_delivery_failed", LEDGER_UNAVAILABLE)
        now = self.clock.now()
        since = now - timedelta(hours=self.settings.delivery_lookback_hours)
        try:
            records = [r for r in self.ledger.list_deliveries(since=since)
                       if r.event == "mail.ready" and r.status in ("failed", "dead")]
        except MailApiError as exc:
            return _unavailable("webhook_delivery_failed", f"读取投递台账失败：{exc.code}")
        if records and self.settings.auto_replay_dead_deliveries:
            try:
                self.ledger.replay_window(since=since, until=now)
            except MailApiError as exc:
                logger.warning("按窗口重放失败：%s", exc)
        return _check("webhook_delivery_failed", [r.id for r in records])

    def _upstream_missing(self) -> _Check:
        since = self.clock.now() - timedelta(days=DEFAULT_RETENTION_DAYS)
        known = {t.provider_message_id for t in self.store.list_tasks()}
        missing: list[str] = []
        cursor: str | None = None
        try:
            for _ in range(1000):
                page = self.mail.list_messages(since=since, cursor=cursor)
                missing.extend(f"mail:{m.message_id}" for m in page.items if m.message_id not in known)
                cursor = page.next_cursor
                if not cursor:
                    break
        except UpstreamListingUnavailable:
            return _unavailable("upstream_missing", UPSTREAM_UNAVAILABLE)
        except MailApiError as exc:
            return _unavailable("upstream_missing", f"列出 mail 邮件失败：{exc.code}")
        return _check("upstream_missing", missing)

    def _overdue(self) -> list[dict[str, Any]]:
        days = self.resume_mail_timeout_days() if callable(self.resume_mail_timeout_days) else self.resume_mail_timeout_days
        now = self.clock.now()
        before = now - timedelta(days=days)
        after = now - timedelta(days=self.settings.overdue_lookback_days)
        overdue: list[dict[str, Any]] = []
        seen_cases: set[str] = set()
        for record in self.server.list_commands(action="request_resume", statuses=["succeeded"],
                                                executed_after=after, executed_before=before):
            command = record.get("command") or {}
            result = record.get("result") or {}
            case_id = record.get("case_id") or command.get("workflow_id")
            if not case_id or case_id in seen_cases or result.get("status") != "succeeded":
                continue
            seen_cases.add(case_id)
            docs = [d for d in self.server.list_resume_documents(case_id=case_id) if d.get("variant") == "original"]
            if docs:
                continue
            requested_at = parse_time(result["executed_at"])
            overdue.append({
                "case_id": case_id,
                "command_id": command["command_id"],
                "requested_at": to_wire_time(requested_at),
                "days_waiting": max(0, (now - requested_at).days),
            })
            if len(overdue) >= 200:
                break
        return overdue
