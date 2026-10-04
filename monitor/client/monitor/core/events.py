"""core 自己产生的事件（暂停、登录失效、弹窗阻断）的构造。观察类事件由 observe 模块产生。"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from monitor_contracts import (
    Conversation,
    EventModel,
    compute_event_id,
    observation_bucket,
    validate_event,
)

# core 事件的兜底时间片宽度：同一分钟内同类同原因的事件视为同一个（服务端按 event_id 去重）
CORE_EVENT_BUCKET_SECONDS = 60


def make_event(
    kind: str,
    *,
    device_id: str,
    account_id: str | None,
    payload: dict[str, Any],
    observed_at: datetime,
    conversation: Conversation | None = None,
    bucket: str | None = None,
) -> EventModel:
    """按契约构造并校验事件；event_id 用 compute_event_id 计算。"""
    bucket = bucket or observation_bucket(observed_at, CORE_EVENT_BUCKET_SECONDS)
    conv = conversation.to_wire() if conversation is not None else None
    data = {
        "event_id": compute_event_id(account_id, kind, conv, bucket),
        "device_id": device_id,
        "account_id": account_id,
        "kind": kind,
        "conversation": conv,
        "bucket": bucket,
        "observed_at": observed_at.isoformat(),
        "payload": payload,
    }
    return validate_event(data)
