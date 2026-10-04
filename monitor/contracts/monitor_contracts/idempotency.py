"""Idempotency-Key 的格式与推荐生成规则（见 docs/monitor/api.md）。

所有写接口都必须带 Idempotency-Key。同一个键在 24 小时内重放，服务端返回首次
的响应；同键不同请求体返回 422 idempotency_key_reused。Monitor 的重试必须复用
同一个键，因此键由业务标识确定性地生成，而不是每次随机。
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable
from datetime import datetime
from typing import Literal
from uuid import UUID

IDEMPOTENCY_KEY_PATTERN = r"^[A-Za-z0-9._:-]{8,128}$"
_KEY_RE = re.compile(IDEMPOTENCY_KEY_PATTERN)


def is_valid_idempotency_key(key: str) -> bool:
    return bool(_KEY_RE.fullmatch(key))


def _digest(text: str, n: int = 32) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:n]


def _key(prefix: str, *parts: str) -> str:
    key = ":".join((prefix, *parts))
    if not is_valid_idempotency_key(key):
        key = f"{prefix}:{_digest(':'.join(parts))}"
    return key


def command_result_key(command_id: UUID | str) -> str:
    """POST /commands/{id}/result：每个指令只有一个结果。"""
    return _key("result", str(command_id))


def command_ack_key(command_id: UUID | str) -> str:
    """POST /commands/{id}/ack。"""
    return _key("ack", str(command_id))


def claim_key(device_id: str, claim_attempt_id: UUID | str) -> str:
    """POST /devices/{id}/commands:claim：同一次领取尝试的重试复用 claim_attempt_id。"""
    return _key("claim", device_id, str(claim_attempt_id))


def heartbeat_key(device_id: str, sent_at: datetime) -> str:
    return _key("hb", device_id, _digest(sent_at.isoformat(), 16))


def events_batch_key(event_ids: Iterable[str]) -> str:
    """POST /events：按排序后的 event_id 集合生成，同一批次重传得到同一个键。"""
    ids = sorted(set(event_ids))
    if not ids:
        raise ValueError("事件批次不能为空")
    return _key("events", _digest(",".join(ids)))


def login_qr_key(device_id: str, qr_seq: int) -> str:
    return _key("qr", device_id, str(qr_seq))


def resume_document_key(source_id: str, sha256: str) -> str:
    """POST /resume-documents：来源标识 + 文件内容哈希。

    原件（variant=original）的 source_id 是 mail_message_id；品牌化版本（variant=branded）
    的 source_id 是 ``"branded:" + derived_from``（原件 doc_id）。
    """
    return _key("doc", _digest(f"{source_id}\n{sha256}"))


def mail_message_key(
    mail_message_id: str, status: str, attempts: int, revision: Literal["purged"] | None = None
) -> str:
    """PUT /mail-messages/{id}：同一封邮件的同一次写入（状态 + 失败次数）复用同一个键。

    未达上限的失败仍为 pending、attempts +1，所以键里要带 attempts，否则两次写入撞键。
    副本按保留期清理后要再 PUT 一次（填 copy_purged_at），此时 status 与 attempts 都没变，
    用 revision="purged"，状态段变为 "<status>-purged"（0.3.2，与任务 G 的实现逐字节一致）。
    """
    if revision is not None:
        if revision != "purged":
            raise ValueError(f"未知的 revision: {revision!r}")
        status = f"{status}-purged"
    return _key("mail", mail_message_id.removeprefix("mail:"), status, str(attempts))


def mail_verification_key(verification_id: str) -> str:
    """POST /mail-verifications：一次核对一个键。"""
    return _key("verify", verification_id)
