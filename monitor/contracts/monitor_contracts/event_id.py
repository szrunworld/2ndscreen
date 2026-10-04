"""事件幂等键 event_id 的计算规则。

event_id = sha256(规范化 JSON ["monitor-event-v1", account_id, kind, 会话身份, bucket])，
十六进制小写 64 位。会话身份 = [姓名, 岗位, 去重排序后的 hints]，各字符串先做
首尾空白裁剪与 Unicode NFC 规范化。相同输入在任何实现里必须得到相同结果；
修改本规则属于契约变更（版本号 +1）。
"""

from __future__ import annotations

import hashlib
import json
import unicodedata
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

from .models import EVENT_KINDS, Conversation

EVENT_ID_SCHEME = "monitor-event-v1"


def _norm(text: str) -> str:
    return unicodedata.normalize("NFC", text.strip())


def conversation_identity(conversation: Conversation | Mapping[str, Any] | None) -> list[Any] | None:
    """会话身份元组；None 表示该事件与会话无关。"""
    if conversation is None:
        return None
    if isinstance(conversation, Conversation):
        name, job, hints = conversation.candidate_name, conversation.job_title, conversation.hints
    else:
        name = conversation["candidate_name"]
        job = conversation["job_title"]
        hints = conversation.get("hints") or []
    return [_norm(name), _norm(job), sorted({_norm(h) for h in hints})]


def compute_event_id(
    account_id: str | None,
    kind: str,
    conversation: Conversation | Mapping[str, Any] | None,
    bucket: str,
) -> str:
    """计算事件幂等键。

    account_id 未绑定时传 None（按空串参与计算）；bucket 是观察到的变化时间片，
    由观察方给出（见 docs/monitor/contracts.md「幂等键规则」）。
    """
    if kind not in EVENT_KINDS:
        raise ValueError(f"未知的事件 kind: {kind!r}")
    if not bucket:
        raise ValueError("bucket 不能为空")
    material = json.dumps(
        [EVENT_ID_SCHEME, account_id or "", kind, conversation_identity(conversation), bucket],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def observation_bucket(observed_at: datetime, width_seconds: int = 3600) -> str:
    """兜底的时间片：把带时区时间按 UTC 向下取整到 width_seconds。

    观察方能读到界面上的变化时间（如消息时间文本）或已在基线中记录首次看到的
    时间片时，应优先用那个，保证同一变化在多次观察中得到同一 bucket。
    """
    if observed_at.tzinfo is None:
        raise ValueError("observed_at 必须带时区")
    if width_seconds <= 0:
        raise ValueError("width_seconds 必须为正")
    ts = int(observed_at.astimezone(UTC).timestamp())
    start = datetime.fromtimestamp(ts - ts % width_seconds, UTC)
    return f"{start.strftime('%Y-%m-%dT%H:%M:%SZ')}/{width_seconds}"
