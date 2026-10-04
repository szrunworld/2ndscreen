"""我方副本的保留期清理（``policy.mail_retention_days``，默认 30 天）。

删除的是**我方**存储里的副本：原始邮件副本、附件副本、解析文本；保留任务表里的元数据
（标识、sha256、状态、doc_id）并写一条清理记录，然后 PUT 一次 mail_message
（``copy_purged_at`` 填清理时间、``raw_storage_uri`` 置 null）。
**不删除 mail 服务里的邮件**：那边由管理员把 zhaopin@ 的 retention_days 设为 30，由 mail 的留存任务统一清理。

正在处理中的 pending 任务不清理（处理完后下一轮再清）。
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import timedelta

from monitor_contracts import mail_message_key

from .clock import Clock
from .server_api import ServerApiError
from .storage import BlobStorage, StorageError
from .store import MailStore, db_time
from .writer import ServerWriter, mail_message_body

logger = logging.getLogger(__name__)

DEFAULT_RETENTION_DAYS = 30


def purge_expired_copies(
    *,
    store: MailStore,
    storage: BlobStorage,
    writer: ServerWriter,
    clock: Clock,
    retention_days: int | Callable[[], int] = DEFAULT_RETENTION_DAYS,
) -> int:
    """清理超过保留期的副本，返回本次清理的邮件数。按副本写入时间（没有时按收信时间）计算。"""
    days = retention_days() if callable(retention_days) else retention_days
    if not 1 <= days <= 365:
        raise ValueError(f"mail_retention_days 超出范围 1–365：{days}")
    now = clock.now()
    cutoff = db_time(now - timedelta(days=days))
    purged = 0
    for task in store.list_tasks(["processed", "needs_review", "failed", "ignored"]):
        if task.copy_purged_at is not None or task.sha256 is None:
            continue  # 已清理过，或从未回取到副本
        stored_at = task.copy_stored_at or task.received_at
        if stored_at > cutoff:
            continue
        deleted = 0
        try:
            if task.raw_storage_uri and storage.delete(task.raw_storage_uri):
                deleted += 1
            for attachment in store.list_attachments(task.mail_message_id):
                for uri in (attachment.storage_uri, attachment.text_storage_uri):
                    if uri and storage.delete(uri):
                        deleted += 1
                store.update_attachment(attachment.mail_message_id, attachment.attachment_id,
                                        storage_uri=None, text_storage_uri=None, purged_at=db_time(now))
        except StorageError as exc:
            logger.warning("清理 %s 的副本失败，下一轮再试：%s", task.mail_message_id, exc)
            continue
        now_s = db_time(now)
        store.update_task(task.mail_message_id, raw_storage_uri=None, copy_purged_at=now_s, updated_at=now_s)
        store.log_purge(mail_message_id=task.mail_message_id, purged_at=now, retention_days=days, blobs_deleted=deleted)
        purged += 1
        refreshed = store.get_task(task.mail_message_id)
        assert refreshed is not None
        _report_purge(store, writer, refreshed.mail_message_id, now_s)
    return purged


def _report_purge(store: MailStore, writer: ServerWriter, mail_message_id: str, now_s: str) -> None:
    """PUT 一次清理结果。服务端状态已被人工推进（409 illegal_mail_transition）时以服务端为准再报一次。"""
    for _ in range(2):
        task = store.get_task(mail_message_id)
        assert task is not None
        body = mail_message_body(task, status=task.status, attempts=task.attempts,
                                 error=None if task.status == "processed" else task.error, updated_at=now_s)
        try:
            # 同状态同 attempts 的写入已经用过 mail_message_key(id, status, attempts)，
            # 清理更新用带 "-purged" 后缀的状态段区分（见 G.md 接口请求）。
            writer.put_mail_message(body, key_status=f"{task.status}-purged")
            return
        except ServerApiError as exc:
            existing = exc.existing or {}
            if exc.code == "illegal_mail_transition" and existing.get("status") not in (None, task.status):
                store.update_task(mail_message_id, status=existing["status"],
                                  error=None if existing["status"] == "processed" else task.error)
                continue
            logger.warning("回报 %s 的清理结果未送达：%s", mail_message_id, exc)
            return


def purge_key(mail_message_id: str, status: str, attempts: int) -> str:
    """清理更新使用的 Idempotency-Key（与 :func:`purge_expired_copies` 一致）。"""
    return mail_message_key(mail_message_id, f"{status}-purged", attempts)

