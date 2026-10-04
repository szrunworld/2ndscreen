"""通知：适配器接口 + 两个实现（控制台待办列表、Webhook 推送），由内部事件触发。

触发来源（都经 ``ctx.bus``，在数据库提交之后同步投递）：

| 内部消息 | 条件 | 通知 kind |
| --- | --- | --- |
| ``EventReceived`` | kind=login_required | ``login_required``（本机模式提示在本机登录，独立设备提示扫码） |
| ``EventReceived`` | kind=login_qr | ``login_qr``（独立设备需要扫码登录，方案 8.5 第 4 条） |
| ``EventReceived`` | kind=blocked_by_dialog | ``blocked_by_dialog`` |
| ``CaseNeedsHuman`` | F2 发布：流程转 needs_human | ``case_needs_human`` |
| ``MailMessageStatusChanged`` | 邮件记录进入 failed | ``mail_failed`` |
| ``MailVerificationRecorded`` | 核对 outcome 为 issues_found / failed | ``mail_verification`` |

同一来源只通知一次：``notification_id`` 由来源标识确定（例如事件的 event_id），待办表按它去重，
已存在时不再推送。通知正文只放运营需要的最少信息，不放候选人姓名、二维码内容、人工输入的值。

一个适配器失败（例如 Webhook 连不上）只记录投递失败，不影响其他适配器，也不影响触发它的 HTTP 请求。
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import urllib.request
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass
from typing import TYPE_CHECKING, Any, Literal, Protocol

from .db import SqliteStore, canonical_json, parse_time, to_db_time, wire_time
from .events import EventReceived
from .mail_endpoints import MailMessageStatusChanged, MailVerificationRecorded

if TYPE_CHECKING:
    from .main import AppContext

log = logging.getLogger(__name__)

Severity = Literal["info", "warning", "critical"]


# ---------------------------------------------------------------------------
# 消息与接口
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CaseNeedsHuman:
    """F2 在流程转 needs_human 时发布到 ``ctx.bus``（本模块据此生成待办与推送）。

    reason 用 F2 的 needs_human_reason（例如 resume_mail_timeout、result_unknown、conversation_ambiguous）。
    transition_id 区分同一流程的多次转入（例如时间线条目的 seq），同一个值只通知一次。
    """

    case_id: str
    account_id: str
    reason: str
    transition_id: str


@dataclass(frozen=True)
class Notification:
    """一条待处理通知。ref 指向控制台里应打开的对象（device / case / mail_message / mail_verification）。"""

    notification_id: str
    kind: str
    severity: Severity
    title: str
    body: str
    account_id: str | None
    device_id: str | None
    ref_kind: str
    ref_id: str
    created_at: str  # RFC 3339

    def to_wire(self) -> dict[str, Any]:
        return asdict(self)


class Notifier(Protocol):
    """通知适配器。``channel`` 用于投递记录；``send`` 失败时抛异常，由 NotificationService 记录。"""

    channel: str

    def send(self, notification: Notification) -> None: ...


# ---------------------------------------------------------------------------
# 存储
# ---------------------------------------------------------------------------


class NotificationStore:
    def __init__(self, store: SqliteStore):
        self._s = store

    def insert(self, n: Notification) -> bool:
        """按 notification_id 幂等插入；已存在返回 False。"""
        with self._s._tx() as c:
            cur = c.execute(
                """INSERT OR IGNORE INTO notifications (notification_id, kind, severity, title, body, account_id,
                       device_id, ref_kind, ref_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (
                    n.notification_id,
                    n.kind,
                    n.severity,
                    n.title,
                    n.body,
                    n.account_id,
                    n.device_id,
                    n.ref_kind,
                    n.ref_id,
                    to_db_time_wire(n.created_at),
                ),
            )
            return cur.rowcount == 1

    def list(self, *, open_only: bool, account_id: str | None, cursor: str | None, limit: int) -> Any:
        where: list[str] = []
        args: list[Any] = []
        if open_only:
            where.append("resolved_at IS NULL")
        if account_id is not None:
            where.append("account_id = ?")
            args.append(account_id)
        return self._s._page("notifications", where, args, cursor, limit, _todo_record)

    def get(self, notification_id: str) -> dict[str, Any] | None:
        r = self._s._one("SELECT * FROM notifications WHERE notification_id = ?", (notification_id,))
        return None if r is None else _todo_record(r)

    def resolve(self, notification_id: str, actor: str, now: str) -> bool:
        with self._s._tx() as c:
            cur = c.execute(
                "UPDATE notifications SET resolved_at = ?, resolved_by = ? WHERE notification_id = ? AND resolved_at IS NULL",
                (now, actor, notification_id),
            )
            return cur.rowcount == 1

    def record_delivery(self, notification_id: str, channel: str, status: str, attempts: int, error: str | None, now: str) -> None:
        with self._s._tx() as c:
            c.execute(
                """INSERT INTO notification_deliveries (notification_id, channel, status, attempts, last_error, at)
                   VALUES (?,?,?,?,?,?)""",
                (notification_id, channel, status, attempts, error, now),
            )

    def deliveries(self, notification_id: str) -> list[dict[str, Any]]:
        rows = self._s._all(
            "SELECT channel, status, attempts, last_error, at FROM notification_deliveries WHERE notification_id = ? ORDER BY seq",
            (notification_id,),
        )
        return [{**dict(r), "at": wire_time(r["at"])} for r in rows]


def to_db_time_wire(value: str) -> str:
    return to_db_time(parse_time(value))


def _todo_record(r: Any) -> dict[str, Any]:
    return {
        "notification_id": r["notification_id"],
        "kind": r["kind"],
        "severity": r["severity"],
        "title": r["title"],
        "body": r["body"],
        "account_id": r["account_id"],
        "device_id": r["device_id"],
        "ref": {"kind": r["ref_kind"], "id": r["ref_id"]},
        "created_at": wire_time(r["created_at"]),
        "resolved_at": wire_time(r["resolved_at"]),
        "resolved_by": r["resolved_by"],
    }


# ---------------------------------------------------------------------------
# 适配器实现
# ---------------------------------------------------------------------------


class ConsoleTodoNotifier:
    """控制台待办列表：通知本身已由 NotificationService 写入 notifications 表，这里提供读与"已处理"。

    openapi 0.3.1 还没有待办接口（见 F3 报告"接口请求"），控制台或总览通过这些方法读取。
    """

    channel = "console"

    def __init__(self, store: NotificationStore, clock: Any):
        self._store = store
        self._clock = clock

    def send(self, notification: Notification) -> None:
        # 待办行在 NotificationService.publish 里与去重一起写入，这里无需再写
        return None

    def list_open(self, account_id: str | None = None, cursor: str | None = None, limit: int = 50) -> Any:
        return self._store.list(open_only=True, account_id=account_id, cursor=cursor, limit=limit)

    def list_all(self, account_id: str | None = None, cursor: str | None = None, limit: int = 50) -> Any:
        return self._store.list(open_only=False, account_id=account_id, cursor=cursor, limit=limit)

    def resolve(self, notification_id: str, actor: str) -> bool:
        """标记已处理；不存在或已处理返回 False。"""
        return self._store.resolve(notification_id, actor, to_db_time(self._clock.now()))


PostFunc = Callable[[str, bytes, dict[str, str], float], int]


def urllib_post(url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
    """默认的 HTTP 发送（标准库，不引入运行时依赖）；返回状态码，网络错误抛异常。"""
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - URL 来自部署配置
        return int(resp.status)


class WebhookError(RuntimeError):
    pass


class WebhookNotifier:
    """Webhook 推送：POST JSON 到部署配置的 URL，可选 HMAC-SHA256 签名。

    - 请求头 ``X-Monitor-Notification-Id``（接收方据此去重）；配置了 secret 时加
      ``X-Monitor-Signature: sha256=<hex>``，覆盖原始请求体字节。
    - 立即重试最多 ``max_attempts`` 次（不 sleep，失败的推送留在投递记录里，待办列表仍可见）。
    - 2xx 视为成功，其他状态码与网络错误视为失败。
    """

    channel = "webhook"

    def __init__(
        self,
        url: str,
        *,
        secret: str | None = None,
        post: PostFunc = urllib_post,
        timeout: float = 5.0,
        max_attempts: int = 3,
    ):
        if not url:
            raise ValueError("Webhook URL 不能为空")
        if max_attempts < 1:
            raise ValueError("max_attempts 至少为 1")
        self.url = url
        self._secret = secret
        self._post = post
        self._timeout = timeout
        self.max_attempts = max_attempts
        self.last_attempts = 0

    def payload(self, notification: Notification) -> bytes:
        return json.dumps(notification.to_wire(), ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()

    def headers(self, notification: Notification, body: bytes) -> dict[str, str]:
        headers = {"Content-Type": "application/json", "X-Monitor-Notification-Id": notification.notification_id}
        if self._secret:
            digest = hmac.new(self._secret.encode(), body, hashlib.sha256).hexdigest()
            headers["X-Monitor-Signature"] = f"sha256={digest}"
        return headers

    def send(self, notification: Notification) -> None:
        body = self.payload(notification)
        headers = self.headers(notification, body)
        last: str = ""
        for attempt in range(1, self.max_attempts + 1):
            self.last_attempts = attempt
            try:
                status = self._post(self.url, body, headers, self._timeout)
            except Exception as exc:  # 网络错误：再试
                last = f"{type(exc).__name__}: {exc}"
                continue
            if 200 <= status < 300:
                return
            last = f"HTTP {status}"
        raise WebhookError(f"Webhook 推送失败（{self.max_attempts} 次）：{last}")


# ---------------------------------------------------------------------------
# 服务：把内部消息转成通知并分发
# ---------------------------------------------------------------------------


LOGIN_REASON_TEXT = {"local": "请在本机 BOSS 客户端完成登录", "remote": "设备需要登录：请在控制台用绑定账号的手机扫码"}


class NotificationService:
    """订阅事件总线，生成通知、写待办表（按 notification_id 去重），再交给各适配器。"""

    def __init__(self, ctx: AppContext, notifiers: Sequence[Notifier] | None = None):
        self.ctx = ctx
        self.store = NotificationStore(ctx.store)  # type: ignore[arg-type]
        self.console = ConsoleTodoNotifier(self.store, ctx.clock)
        self.notifiers: list[Notifier] = [self.console, *(notifiers or [])]
        self._unsubscribe = ctx.bus.subscribe(self.handle)  # type: ignore[arg-type]

    def close(self) -> None:
        self._unsubscribe()

    # -- 映射 -----------------------------------------------------------------

    def handle(self, message: Any) -> None:
        notification = self.from_message(message)
        if notification is not None:
            self.publish(notification)

    def from_message(self, message: Any) -> Notification | None:
        """内部消息 → 通知；不需要通知的消息返回 None。"""
        now = wire_time(to_db_time(self.ctx.clock.now()))
        assert now is not None
        if isinstance(message, EventReceived):
            return self._from_event(message, now)
        if isinstance(message, CaseNeedsHuman):
            return Notification(
                notification_id=_nid("case_needs_human", message.case_id, message.transition_id),
                kind="case_needs_human",
                severity="warning",
                title="招聘流程需要人工处理",
                body=f"原因：{message.reason}",
                account_id=message.account_id,
                device_id=None,
                ref_kind="case",
                ref_id=message.case_id,
                created_at=now,
            )
        if isinstance(message, MailMessageStatusChanged) and message.new_status == "failed":
            record = message.record
            return Notification(
                notification_id=_nid("mail_failed", message.mail_message_id, str(record.get("attempts", 0))),
                kind="mail_failed",
                severity="warning",
                title="简历邮件处理失败",
                body=f"邮件 {message.mail_message_id} 连续处理失败：{record.get('error') or '未知原因'}",
                account_id=None,
                device_id=None,
                ref_kind="mail_message",
                ref_id=message.mail_message_id,
                created_at=now,
            )
        if isinstance(message, MailVerificationRecorded) and message.outcome in ("issues_found", "failed"):
            v = message.verification
            if message.outcome == "failed":
                body = f"核对没有跑完：{v.get('error') or '未知原因'}"
            else:
                issues = [f"{c['code']}={c['count']}" for c in v.get("checks", []) if c.get("count")]
                body = "发现问题：" + "，".join(issues)
            return Notification(
                notification_id=_nid("mail_verification", message.verification_id),
                kind="mail_verification",
                severity="warning",
                title="邮箱核对发现问题" if message.outcome == "issues_found" else "邮箱核对失败",
                body=body,
                account_id=None,
                device_id=None,
                ref_kind="mail_verification",
                ref_id=message.verification_id,
                created_at=now,
            )
        return None

    def _from_event(self, message: EventReceived, now: str) -> Notification | None:
        event = message.record["event"]
        payload = event.get("payload") or {}
        common = {
            "account_id": message.account_id,
            "device_id": message.device_id,
            "ref_kind": "device",
            "ref_id": message.device_id,
            "created_at": now,
        }
        if message.kind == "login_required":
            mode = payload.get("mode", "remote")
            return Notification(
                notification_id=_nid("login_required", message.event_id),
                kind="login_required",
                severity="critical",
                title="BOSS 登录失效，对外动作已暂停",
                body=LOGIN_REASON_TEXT.get(mode, LOGIN_REASON_TEXT["remote"]),
                **common,
            )
        if message.kind == "login_qr":
            return Notification(
                notification_id=_nid("login_qr", message.event_id),
                kind="login_qr",
                severity="critical",
                title="设备需要登录",
                body=f"二维码已更新（第 {payload.get('qr_seq')} 张），请在控制台打开设备卡片扫码",
                **common,
            )
        if message.kind == "blocked_by_dialog":
            return Notification(
                notification_id=_nid("blocked_by_dialog", message.event_id),
                kind="blocked_by_dialog",
                severity="critical",
                title="BOSS 弹窗阻断，相关执行已暂停",
                body=f"弹窗类型：{payload.get('dialog_kind')}；文案：{payload.get('dialog_text')}",
                **common,
            )
        return None

    # -- 分发 -----------------------------------------------------------------

    def publish(self, notification: Notification) -> bool:
        """写待办并分发；同一个 notification_id 第二次调用不再分发，返回 False。"""
        if not self.store.insert(notification):
            return False
        now = to_db_time(self.ctx.clock.now())
        for notifier in self.notifiers:
            if notifier is self.console:
                continue  # 待办行已写入
            attempts = getattr(notifier, "max_attempts", 1)
            try:
                notifier.send(notification)
            except Exception as exc:
                used = getattr(notifier, "last_attempts", attempts)
                log.warning("通知 %s 经 %s 投递失败：%s", notification.notification_id, notifier.channel, exc)
                self.store.record_delivery(notification.notification_id, notifier.channel, "failed", used, str(exc)[:500], now)
            else:
                used = getattr(notifier, "last_attempts", 1)
                self.store.record_delivery(notification.notification_id, notifier.channel, "delivered", used, None, now)
        return True


def _nid(kind: str, *parts: str) -> str:
    digest = hashlib.sha256(canonical_json([kind, *parts]).encode()).hexdigest()[:32]
    return f"ntf_{digest}"


__all__ = [
    "CaseNeedsHuman",
    "ConsoleTodoNotifier",
    "Notification",
    "NotificationService",
    "NotificationStore",
    "Notifier",
    "WebhookError",
    "WebhookNotifier",
    "urllib_post",
]
