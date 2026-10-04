"""对服务端的写：先把请求体落进 outbox，再发送；重试复用同一个键与同一个请求体。

这样崩溃重领、断网重试都不会出现"同键不同体"（服务端 422）或重复入库；
发送失败的请求留在 outbox，由 :meth:`ServerWriter.flush` 按创建顺序补发。
"""

from __future__ import annotations

from typing import Any

from monitor_contracts import (
    mail_message_key,
    mail_verification_key,
    resume_document_key,
    validate_mail_message,
    validate_mail_verification,
)

from .clock import Clock, to_wire_time
from .server_api import ServerApi, ServerApiError
from .store import MailStore, OutboxRow, TaskRow, from_db_time


def mail_message_body(task: TaskRow, *, status: str, attempts: int, error: str | None, updated_at: str,
                      with_copy: bool = True) -> dict[str, Any]:
    """按契约 mail_message 组装请求体（时间转成 RFC 3339）。with_copy=False 时只带标识（推送登记）。"""
    received = from_db_time(task.received_at)
    updated = from_db_time(updated_at)
    assert received is not None and updated is not None
    purged = from_db_time(task.copy_purged_at) if with_copy else None
    body: dict[str, Any] = {
        "mail_message_id": task.mail_message_id,
        "provider": "remotedesk-mail",
        "provider_message_id": task.provider_message_id,
        "webhook_delivery_id": task.webhook_delivery_id,
        "mailbox": task.mailbox,
        "message_id": (task.message_id[:998] if task.message_id else None) if with_copy else None,
        "received_at": to_wire_time(received),
        "sha256": task.sha256 if with_copy else None,
        "raw_storage_uri": task.raw_storage_uri if with_copy and not purged else None,
        "copy_purged_at": to_wire_time(purged) if purged else None,
        "from_address": (task.from_address[:254] if task.from_address else None) if with_copy else None,
        "subject": (task.subject[:500] if task.subject else None) if with_copy else None,
        "status": status,
        "attempts": attempts,
        "error": error[:500] if error else error,
        "updated_at": to_wire_time(max(updated, received)),
    }
    validate_mail_message(body)
    return body


class ServerWriter:
    def __init__(self, *, store: MailStore, server: ServerApi, clock: Clock) -> None:
        self.store = store
        self.server = server
        self.clock = clock

    def _send(self, row: OutboxRow) -> dict[str, Any]:
        if row.sent and row.response is not None:
            return row.response
        if row.method == "PUT" and row.path.startswith("/mail-messages/"):
            response = self.server.put_mail_message(row.path.removeprefix("/mail-messages/"), row.body, row.idem_key)
        elif row.method == "POST" and row.path == "/resume-documents":
            response = self.server.create_resume_document(row.body, row.idem_key)
        elif row.method == "POST" and row.path == "/mail-verifications":
            response = self.server.post_mail_verification(row.body, row.idem_key)
        else:  # pragma: no cover - 只会由本模块写入
            raise ValueError(f"未知的待发请求：{row.method} {row.path}")
        self.store.mark_sent(row.idem_key, response, self.clock.now())
        return response

    def _submit(self, *, key: str, method: str, path: str, body: dict[str, Any]) -> dict[str, Any]:
        row = self.store.prepare_request(idem_key=key, method=method, path=path, body=body, now=self.clock.now())
        return self._send(row)

    def put_mail_message(self, body: dict[str, Any], *, key_status: str | None = None) -> dict[str, Any]:
        """PUT /mail-messages/{id}。键默认是 mail_message_key(id, status, attempts)。"""
        key = mail_message_key(body["mail_message_id"], key_status or body["status"], body["attempts"])
        return self._submit(key=key, method="PUT", path=f"/mail-messages/{body['mail_message_id']}", body=body)

    def is_sent(self, key: str) -> bool:
        row = self.store.get_request(key)
        return bool(row and row.sent)

    def create_resume_document(self, body: dict[str, Any]) -> dict[str, Any]:
        key = resume_document_key(body["mail_message_id"], body["attachment"]["sha256"])
        return self._submit(key=key, method="POST", path="/resume-documents", body=body)

    def post_verification(self, body: dict[str, Any]) -> dict[str, Any]:
        validate_mail_verification(body)
        return self._submit(
            key=mail_verification_key(body["verification_id"]), method="POST", path="/mail-verifications", body=body
        )

    def flush(self) -> tuple[int, int]:
        """按创建顺序补发 outbox 里没发出去的请求。遇到暂时性错误就停（保持顺序）。返回 (成功, 剩余)。"""
        pending = self.store.unsent_requests()
        sent = 0
        for row in pending:
            try:
                self._send(row)
            except ServerApiError as exc:
                if exc.transient:
                    break
                # 永久错误（例如 409）：记下响应，不再重发，交给核对任务发现不一致。
                self.store.mark_sent(row.idem_key, {"error": str(exc), "status": exc.status, "code": exc.code},
                                     self.clock.now())
            sent += 1
        return sent, len(pending) - sent
