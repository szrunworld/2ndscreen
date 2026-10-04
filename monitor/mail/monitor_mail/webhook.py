"""``POST /webhooks/mail``：接收 mail 服务的 webhook（方案 8.2 第 2 条）。

- 用**原始请求体字节**验签，时间戳容差默认 5 分钟；签名错误、缺头、过期一律 401。
- 只接 ``mail.ready``：其他事件（received / bounced）回 2xx 并忽略——非 2xx 会让 mail 重试或落死。
- 按投递 id 与 mail_message_id 两层幂等写任务表（pending），**不做任何网络调用**，立即 2xx。
  向服务端登记 pending（PUT /mail-messages）由消费者循环完成，所以服务端短暂不可用不影响收推送。

本模块只提供 router，挂到哪个应用由协调者装配（见 G.md "装配说明"）。
"""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from monitor_contracts import compute_mail_message_id

from .clock import Clock, parse_time
from .config import MailSettings
from .signature import SignatureError, verify_signature
from .store import MailStore

logger = logging.getLogger(__name__)

READY_EVENT = "mail.ready"


def handle_delivery(
    *, body: bytes, headers: dict[str, str], store: MailStore, settings: MailSettings, clock: Clock
) -> tuple[int, dict[str, Any]]:
    """处理一次推送，返回 (HTTP 状态码, 响应体)。与 FastAPI 无关，便于单测。"""
    now = clock.now()
    try:
        verified = verify_signature(
            body=body,
            headers=headers,
            secret=settings.webhook_secret,
            now=now.timestamp(),
            tolerance_seconds=settings.timestamp_tolerance_seconds,
        )
    except SignatureError as exc:
        logger.warning("拒绝未通过验签的推送：%s", exc.reason)
        return 401, {"accepted": False, "reason": exc.reason}

    try:
        payload = json.loads(body)
        if not isinstance(payload, dict):
            raise ValueError("推送体不是对象")
    except ValueError:
        # 签名正确但不是 JSON：mail 侧的缺陷，回 400（mail 对非 408/429 的 4xx 不重试）。
        return 400, {"accepted": False, "reason": "malformed_body"}

    delivery_id = str(payload.get("id") or verified.delivery_id)
    if delivery_id != verified.delivery_id:
        return 400, {"accepted": False, "reason": "delivery_id_mismatch"}
    event = payload.get("event")
    if event != READY_EVENT:
        return 200, {"accepted": False, "ignored": True, "reason": "event_not_subscribed"}
    if payload.get("direction") not in (None, "inbound"):
        return 200, {"accepted": False, "ignored": True, "reason": "not_inbound"}
    if settings.expected_mailbox_id and payload.get("mailbox_id") != settings.expected_mailbox_id:
        return 200, {"accepted": False, "ignored": True, "reason": "other_mailbox"}
    try:
        mail_message_id = compute_mail_message_id(str(payload.get("message_id") or ""))
        occurred_at = parse_time(str(payload["occurred_at"])) if payload.get("occurred_at") else None
    except (ValueError, TypeError):
        return 400, {"accepted": False, "reason": "malformed_body"}

    duplicate_delivery, created = store.record_delivery(
        delivery_id=delivery_id,
        event=event,
        mail_message_id=mail_message_id,
        provider_message_id=mail_message_id.removeprefix("mail:"),
        mailbox=settings.mailbox,
        occurred_at=occurred_at,
        has_attachments=payload.get("has_attachments"),
        now=now,
        attempt_limit=settings.max_attempts,
    )
    return 200, {
        "accepted": True,
        "mail_message_id": mail_message_id,
        "duplicate": duplicate_delivery or not created,
    }


def create_webhook_router(*, store: MailStore, settings: MailSettings, clock: Clock, path: str = "/webhooks/mail") -> APIRouter:
    """返回挂着 ``POST {path}`` 的 router。"""
    router = APIRouter(tags=["mail-webhook"])

    @router.post(path, include_in_schema=False)
    async def receive_mail_webhook(request: Request) -> JSONResponse:
        body = await request.body()  # 原始字节，验签必须用它
        status, content = handle_delivery(
            body=body, headers=dict(request.headers), store=store, settings=settings, clock=clock
        )
        return JSONResponse(status_code=status, content=content)

    return router
