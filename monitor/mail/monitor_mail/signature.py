"""mail 服务 webhook 的验签（与 remotedesk-resend ``security/signature.py`` 的出站签名对应）。

签名头：``X-RemoteDesk-Webhook-Id`` / ``-Timestamp`` / ``-Signature``；签名值 ``v1,<base64>``
（可能有多个候选，空格分隔，任一匹配即可），HMAC-SHA256 覆盖 ``{id}.{timestamp}.{原始请求体字节}``。
**必须用原始字节**：把 JSON 解析后再序列化会改变键序与分隔符，签名永远对不上。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
from collections.abc import Mapping
from dataclasses import dataclass

ID_HEADER = "X-RemoteDesk-Webhook-Id"
TIMESTAMP_HEADER = "X-RemoteDesk-Webhook-Timestamp"
SIGNATURE_HEADER = "X-RemoteDesk-Webhook-Signature"


class SignatureError(Exception):
    """推送不能证明来自 mail 服务，不得处理。``reason`` 为机器可读的原因码。"""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


@dataclass(frozen=True)
class VerifiedDelivery:
    delivery_id: str
    timestamp: int


def _secret_bytes(secret: str) -> bytes:
    # mail 服务签发的密钥是 token_urlsafe 明文；兼容 whsec_ 前缀的 base64 写法。
    if secret.startswith("whsec_"):
        return base64.b64decode(secret.removeprefix("whsec_"))
    return secret.encode("utf-8")


def _header(headers: Mapping[str, str], name: str) -> str | None:
    lowered = {k.lower(): v for k, v in headers.items()}
    value = lowered.get(name.lower())
    return value.strip() if value else None


def compute_signature(*, body: bytes, delivery_id: str, timestamp: int | str, secret: str) -> str:
    """``base64(hmac_sha256(secret, "{id}.{timestamp}.{body}"))``。"""
    signed = b".".join((delivery_id.encode("utf-8"), str(timestamp).encode("utf-8"), body))
    return base64.b64encode(hmac.new(_secret_bytes(secret), signed, hashlib.sha256).digest()).decode("ascii")


def sign_headers(*, body: bytes, delivery_id: str, timestamp: int, secret: str) -> dict[str, str]:
    """生成 mail 服务会发的三个头（测试与演练用）。"""
    value = compute_signature(body=body, delivery_id=delivery_id, timestamp=timestamp, secret=secret)
    return {ID_HEADER: delivery_id, TIMESTAMP_HEADER: str(timestamp), SIGNATURE_HEADER: f"v1,{value}"}


def verify_signature(
    *,
    body: bytes,
    headers: Mapping[str, str],
    secret: str,
    now: float,
    tolerance_seconds: int = 300,
) -> VerifiedDelivery:
    """验签并返回投递 id。任何失败都抛 :class:`SignatureError`（包括未配置密钥：未配置必须拒绝）。"""
    if not secret:
        raise SignatureError("secret_not_configured", "webhook 签名密钥未配置")
    delivery_id = _header(headers, ID_HEADER)
    timestamp = _header(headers, TIMESTAMP_HEADER)
    signature = _header(headers, SIGNATURE_HEADER)
    if not (delivery_id and timestamp and signature):
        raise SignatureError("missing_headers", "缺少签名头")
    try:
        sent_at = int(timestamp)
    except ValueError:
        raise SignatureError("malformed_timestamp", "时间戳头不是整数") from None
    if abs(now - sent_at) > tolerance_seconds:
        raise SignatureError("timestamp_out_of_tolerance", "签名时间戳超出容差")
    expected = compute_signature(body=body, delivery_id=delivery_id, timestamp=timestamp, secret=secret)
    for candidate in signature.split():
        version, _, value = candidate.partition(",")
        if version == "v1" and value and hmac.compare_digest(value, expected):
            return VerifiedDelivery(delivery_id=delivery_id, timestamp=sent_at)
    raise SignatureError("signature_mismatch", "签名不匹配")
