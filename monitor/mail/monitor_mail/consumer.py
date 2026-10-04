"""消费者：按租约领取 pending 任务并处理（方案 8.2 第 3、4 条）。

一次处理的步骤（每步都可以在崩溃后重做而不重复入库）：

1. 推送登记：服务端还没有这封邮件时先 ``PUT /mail-messages/{id}``（pending，只有标识）。
2. 回取邮件：``GET /v1/integration/messages/{id}``，规范化 JSON 写入我方存储并记 sha256。
   之后的重试直接用已存的副本（详情里有已读、标签等会变的字段，重取会让哈希漂移）。
3. BOSS 发件人白名单：配置了白名单且不在其中 → ignored（不下载附件）；
   白名单为空 → 无法判断，继续处理但最终进 needs_review（不猜）。
4. 附件：取下载链接后立即下载（链接过期则重取一次），写我方存储与 sha256；
   按（mail_message_id，附件 sha256）去重，同一封信里内容相同的附件只写一份文档。
5. 关联：账户 + 岗位 + 姓名 + request_resume 执行时间窗，唯一命中才关联（见 matching）。
   决定在第一次做出后落库，重试沿用，保证同一封信的所有附件结论一致。
6. PDF 文本：pypdf 提取，疑似扫描版只标记。
7. ``POST /resume-documents``（每个去重后的附件一份），再 ``PUT /mail-messages``（processed / needs_review）。

失败：mail 或存储出错计一次失败（attempts +1，按退避推迟）；达到上限转 failed。
服务端暂时不可用不计失败（不是这封信的问题），只推迟。
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from monitor_contracts import can_transition_mail, mail_message_key

from .clock import Clock, to_wire_time
from .config import MailSettings
from .mail_api import (
    AttachmentInfo,
    DownloadLinkExpired,
    MailApi,
    MailApiError,
    MessageDetail,
)
from .matching import LinkDecision, decide_link, extract_hints
from .pdf_text import extract_pdf_text, is_pdf
from .server_api import ServerApi, ServerApiError
from .storage import BlobStorage, StorageError, sha256_hex
from .store import AttachmentRow, MailStore, TaskRow, db_time
from .writer import ServerWriter, mail_message_body

logger = logging.getLogger(__name__)

#: 失败重试的退避：60 秒起，每次翻倍，最长 1 小时。
RETRY_BASE_SECONDS = 60
RETRY_MAX_SECONDS = 3600


class LeaseLost(Exception):
    """处理中租约被别人接手（本次处理放弃，交给接手者；所有写入都幂等）。"""


@dataclass(frozen=True)
class ProcessOutcome:
    mail_message_id: str
    status: str
    attempts: int
    error: str | None = None
    documents: tuple[str, ...] = ()


def canonical_json(data: Any) -> bytes:
    return json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _uuid_part(mail_message_id: str) -> str:
    return mail_message_id.removeprefix("mail:")


class Consumer:
    def __init__(
        self,
        *,
        store: MailStore,
        mail: MailApi,
        server: ServerApi,
        storage: BlobStorage,
        settings: MailSettings,
        clock: Clock,
        owner: str | None = None,
    ) -> None:
        self.store = store
        self.mail = mail
        self.server = server
        self.storage = storage
        self.settings = settings
        self.clock = clock
        self.owner = owner or f"consumer-{uuid.uuid4()}"
        self.writer = ServerWriter(store=store, server=server, clock=clock)

    # ---- 推送登记 ---------------------------------------------------------------

    def registration_body(self, task: TaskRow) -> dict[str, Any]:
        return mail_message_body(task, status="pending", attempts=0, error=None,
                                 updated_at=task.registered_at, with_copy=False)

    def register_pending(self) -> int:
        """把还没登记到服务端的任务以 pending 登记（只有标识）。返回本次成功登记的数量。"""
        count = 0
        for task in self.store.list_tasks():
            body = self.registration_body(task)
            if self.writer.is_sent(self._registration_key(task)):
                continue
            try:
                self.writer.put_mail_message(body)
            except ServerApiError as exc:
                if exc.transient:
                    break
                logger.warning("登记 %s 被服务端拒绝：%s", task.mail_message_id, exc)
                continue
            count += 1
        return count

    @staticmethod
    def _registration_key(task: TaskRow) -> str:
        return mail_message_key(task.mail_message_id, "pending", 0)

    # ---- 领取与处理 -------------------------------------------------------------

    def process_next(self) -> ProcessOutcome | None:
        """领取并处理一条；没有可处理的任务时返回 None。"""
        task = self.store.claim(owner=self.owner, now=self.clock.now(), lease_seconds=self.settings.lease_seconds)
        if task is None:
            return None
        return self.process(task)

    def run_until_idle(self, limit: int = 1000) -> list[ProcessOutcome]:
        outcomes: list[ProcessOutcome] = []
        for _ in range(limit):
            outcome = self.process_next()
            if outcome is None:
                break
            outcomes.append(outcome)
        return outcomes

    def process(self, task: TaskRow) -> ProcessOutcome:
        try:
            if not self.writer.is_sent(self._registration_key(task)):
                self.writer.put_mail_message(self.registration_body(task))
            return self._process(task)
        except LeaseLost:
            logger.info("%s 的租约已被接手，放弃本次处理", task.mail_message_id)
            current = self.store.get_task(task.mail_message_id)
            return ProcessOutcome(task.mail_message_id, current.status if current else "pending",
                                  current.attempts if current else task.attempts, "lease_lost")
        except ServerApiError as exc:
            if exc.transient:
                return self._postpone(task, f"server_unavailable: {exc}")
            return self._record_failure(task, f"server_rejected: {exc}")
        except MailApiError as exc:
            return self._record_failure(task, f"{exc.code}: {exc}")
        except StorageError as exc:
            return self._record_failure(task, f"storage_error: {exc}")

    def _renew(self, task: TaskRow) -> None:
        now = self.clock.now()
        if not self.store.update_task(
            task.mail_message_id,
            owner=self.owner,
            lease_expires_at=db_time(now + timedelta(seconds=self.settings.lease_seconds)),
        ):
            raise LeaseLost(task.mail_message_id)

    def _process(self, task: TaskRow) -> ProcessOutcome:
        detail, task = self._load_copy(task)
        self._renew(task)
        sender = self._classify_sender(detail.from_address)
        if sender == "not_boss":
            return self._finish(task, "ignored", "non_boss_sender", ())

        candidates = [a for a in detail.attachments if self._is_resume_candidate(a)]
        rows = [self._fetch_attachment(task, detail, info) for info in candidates]
        self._renew(task)
        unique: dict[str, AttachmentRow] = {}
        for row in rows:
            unique.setdefault(row.sha256, row)

        decision = self._decision(task, detail, sender)
        documents: list[str] = []
        for sha, row in unique.items():
            doc = self._write_document(task, detail, row, decision)
            documents.append(doc)
            for same in rows:
                if same.sha256 == sha:
                    self.store.update_attachment(same.mail_message_id, same.attachment_id, doc_id=doc)
            self._renew(task)

        if not unique:
            return self._finish(task, "needs_review", "no_resume_attachment", ())
        if not decision.linked:
            return self._finish(task, "needs_review", decision.reason or "unlinked", tuple(documents))
        return self._finish(task, "processed", None, tuple(documents))

    # ---- 步骤 ------------------------------------------------------------------

    def _load_copy(self, task: TaskRow) -> tuple[MessageDetail, TaskRow]:
        """已有副本且哈希一致时复用；否则回取并写副本。"""
        if task.raw_storage_uri and task.sha256:
            data = self.storage.get(task.raw_storage_uri)
            if data is not None and sha256_hex(data) == task.sha256:
                return MessageDetail.from_data(json.loads(data)), task
        detail = self.mail.get_message(task.provider_message_id)
        data = canonical_json(detail.raw)
        uri = self.storage.put(f"messages/{_uuid_part(task.mail_message_id)}.json", data)
        digest = sha256_hex(data)
        if task.sha256 and task.sha256 != digest:
            # 服务端的 sha256 一旦写入不可变；旧副本丢了又重取到不同内容，只能交给人工。
            logger.warning("%s 的副本丢失且重取内容不同", task.mail_message_id)
        changes = {
            "sha256": task.sha256 or digest,
            "raw_storage_uri": uri,
            "copy_stored_at": db_time(self.clock.now()),
            "message_id": detail.rfc_message_id,
            "from_address": detail.from_address,
            "subject": detail.subject,
            # received_at 不改：登记时已用推送的 occurred_at 写给服务端，写入后不可变。
        }
        if not self.store.update_task(task.mail_message_id, owner=self.owner, **changes):
            raise LeaseLost(task.mail_message_id)
        refreshed = self.store.get_task(task.mail_message_id)
        assert refreshed is not None
        return detail, refreshed

    def _classify_sender(self, from_address: str | None) -> str:
        """boss / not_boss / unverified（白名单为空，不猜）。"""
        allow = self.settings.boss_sender_allowlist
        if not allow:
            return "unverified"
        address = (from_address or "").strip().lower()
        for entry in allow:
            if entry.startswith("@") and address.endswith(entry):
                return "boss"
            if address == entry:
                return "boss"
        return "not_boss"

    def _is_resume_candidate(self, info: AttachmentInfo) -> bool:
        if info.is_inline:
            return False
        name = info.filename.lower()
        return name.endswith(self.settings.resume_extensions) or info.content_type == "application/pdf"

    def _fetch_attachment(self, task: TaskRow, detail: MessageDetail, info: AttachmentInfo) -> AttachmentRow:
        existing = {a.attachment_id: a for a in self.store.list_attachments(task.mail_message_id)}.get(info.id)
        if existing and existing.storage_uri:
            data = self.storage.get(existing.storage_uri)
            if data is not None and sha256_hex(data) == existing.sha256:
                return existing
        link = self.mail.get_download_link(detail.id, info.id)
        try:
            data = self.mail.download(link.url)
        except DownloadLinkExpired:
            # 链接过期（例如排队太久）：重取一次链接立即下载；再失败按处理失败计。
            link = self.mail.get_download_link(detail.id, info.id)
            data = self.mail.download(link.url)
        uri = self.storage.put(f"attachments/{_uuid_part(task.mail_message_id)}/{info.id}", data)
        return self.store.upsert_attachment(
            AttachmentRow(
                mail_message_id=task.mail_message_id,
                attachment_id=info.id,
                filename=info.filename[:255],
                content_type=info.content_type,
                size_bytes=len(data),
                sha256=sha256_hex(data),
                storage_uri=uri,
                text_storage_uri=None,
                parse_status=None,
                page_count=None,
                doc_id=None,
                purged_at=None,
            )
        )

    def _decision(self, task: TaskRow, detail: MessageDetail, sender: str) -> LinkDecision:
        if task.link_json:
            saved = json.loads(task.link_json)
            return LinkDecision(saved["method"], saved["case_id"], saved["command_id"],
                                tuple(saved.get("candidate_case_ids", ())), saved.get("reason"))
        hints = extract_hints(detail.subject, detail.text, self.settings)
        decision = decide_link(hints, received_at=detail.received_at, server=self.server, settings=self.settings)
        if sender == "unverified":
            suggested = (decision.case_id,) if decision.case_id else decision.candidate_case_ids
            decision = LinkDecision.unlinked("sender_unverified", suggested)
        saved = {**decision.to_wire(), "candidate_case_ids": list(decision.candidate_case_ids),
                 "reason": decision.reason}
        if not self.store.update_task(task.mail_message_id, owner=self.owner, link_json=json.dumps(saved)):
            raise LeaseLost(task.mail_message_id)
        return decision

    def _write_document(self, task: TaskRow, detail: MessageDetail, row: AttachmentRow,
                        decision: LinkDecision) -> str:
        parse = self._parse(task, row)
        body: dict[str, Any] = {
            "variant": "original",
            "mail_message_id": task.mail_message_id,
            "derived_from": None,
            "mail": {
                "mailbox": task.mailbox,
                "message_id": detail.rfc_message_id,
                "received_at": to_wire_time(detail.received_at),
                "subject": detail.subject[:500] if detail.subject else None,
                "from_address": detail.from_address,
                "raw_storage_uri": task.raw_storage_uri,
            },
            "attachment": {
                "filename": row.filename,
                "sha256": row.sha256,
                "size_bytes": row.size_bytes,
                "content_type": row.content_type or "application/octet-stream",
                "storage_uri": row.storage_uri,
            },
            "link": decision.to_wire(),
            "parse": parse,
        }
        response = self.writer.create_resume_document(body)
        return str(response["doc_id"])

    def _parse(self, task: TaskRow, row: AttachmentRow) -> dict[str, Any] | None:
        data = self.storage.get(row.storage_uri) if row.storage_uri else None
        if data is None or not is_pdf(data):
            return None  # 非 PDF（doc/docx）第一版不解析，服务端记为 pending
        result = extract_pdf_text(data, min_chars_per_page=self.settings.scanned_min_chars_per_page)
        text_uri = None
        if result.text:
            text_uri = self.storage.put(
                f"texts/{_uuid_part(task.mail_message_id)}/{row.attachment_id}.txt", result.text.encode("utf-8")
            )
        self.store.update_attachment(row.mail_message_id, row.attachment_id, parse_status=result.parse_status,
                                     text_storage_uri=text_uri, page_count=result.page_count)
        return {"parse_status": result.parse_status, "text_storage_uri": text_uri,
                "page_count": result.page_count, "error": result.error}

    # ---- 收尾 ------------------------------------------------------------------

    def _finish(self, task: TaskRow, status: str, error: str | None, documents: tuple[str, ...]) -> ProcessOutcome:
        if not can_transition_mail("pending", status):  # pragma: no cover - 只会传入合法终态
            raise ValueError(f"非法迁移 pending → {status}")
        current = self.store.get_task(task.mail_message_id)
        assert current is not None
        now_s = db_time(self.clock.now())
        body = mail_message_body(current, status=status, attempts=current.attempts,
                                 error=None if status == "processed" else error, updated_at=now_s)
        final_status = status
        try:
            self.writer.put_mail_message(body)
        except ServerApiError as exc:
            if exc.status == 409 and exc.code == "illegal_mail_transition" and exc.existing:
                # 服务端状态已被人工推进（例如人工关联后 processed）：以服务端为准。
                final_status = str(exc.existing.get("status", status))
            else:
                raise
        if not self.store.update_task(task.mail_message_id, owner=self.owner, status=final_status,
                                      error=None if final_status == "processed" else error,
                                      lease_owner=None, lease_expires_at=None, next_attempt_at=None,
                                      updated_at=now_s):
            raise LeaseLost(task.mail_message_id)
        return ProcessOutcome(task.mail_message_id, final_status, current.attempts, error, documents)

    def _postpone(self, task: TaskRow, reason: str) -> ProcessOutcome:
        current = self.store.get_task(task.mail_message_id) or task
        delay = timedelta(seconds=RETRY_BASE_SECONDS)
        self.store.update_task(task.mail_message_id, owner=self.owner, lease_owner=None, lease_expires_at=None,
                               next_attempt_at=db_time(self.clock.now() + delay))
        return ProcessOutcome(task.mail_message_id, current.status, current.attempts, reason[:500])

    def _record_failure(self, task: TaskRow, reason: str) -> ProcessOutcome:
        current = self.store.get_task(task.mail_message_id) or task
        if current.lease_owner != self.owner:
            return ProcessOutcome(task.mail_message_id, current.status, current.attempts, "lease_lost")
        attempts = current.attempts + 1
        error = reason[:500]
        status = "failed" if attempts >= current.attempt_limit else "pending"
        now = self.clock.now()
        delay = min(RETRY_BASE_SECONDS * 2 ** (attempts - 1), RETRY_MAX_SECONDS)
        self.store.update_task(
            task.mail_message_id,
            owner=self.owner,
            status=status,
            attempts=attempts,
            error=error,
            lease_owner=None,
            lease_expires_at=None,
            next_attempt_at=None if status == "failed" else db_time(now + timedelta(seconds=delay)),
            updated_at=db_time(now),
        )
        refreshed = self.store.get_task(task.mail_message_id)
        assert refreshed is not None
        try:
            self.writer.put_mail_message(
                mail_message_body(refreshed, status=status, attempts=attempts, error=error, updated_at=db_time(now))
            )
        except ServerApiError as exc:
            # 已落 outbox，flush 会补发；这里不再计失败。
            logger.warning("回报 %s 失败状态未送达：%s", task.mail_message_id, exc)
        if status == "failed":
            logger.error("邮件 %s 连续失败 %d 次，转 failed：%s", task.mail_message_id, attempts, error)
        return ProcessOutcome(task.mail_message_id, status, attempts, error)

    # ---- 人工重试 --------------------------------------------------------------

    def requeue(self, mail_message_id: str) -> bool:
        """failed → pending（人工重试）：再给一轮 max_attempts 次机会。"""
        task = self.store.get_task(mail_message_id)
        if task is None or not can_transition_mail(task.status, "pending"):
            return False
        now_s = db_time(self.clock.now())
        self.store.update_task(mail_message_id, status="pending", next_attempt_at=None, lease_owner=None,
                               lease_expires_at=None, attempt_limit=task.attempts + self.settings.max_attempts,
                               updated_at=now_s)
        refreshed = self.store.get_task(mail_message_id)
        assert refreshed is not None
        try:
            self.writer.put_mail_message(mail_message_body(refreshed, status="pending", attempts=refreshed.attempts,
                                                           error=refreshed.error, updated_at=now_s))
        except ServerApiError as exc:
            logger.warning("回报 %s 人工重试未送达：%s", mail_message_id, exc)
        return True
