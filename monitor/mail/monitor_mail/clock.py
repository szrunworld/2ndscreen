"""时钟：生产用系统时钟，测试用可控时钟（不写固定 sleep）。"""

from __future__ import annotations

import threading
from datetime import UTC, datetime, timedelta
from typing import Protocol


class Clock(Protocol):
    def now(self) -> datetime:
        """当前时间，必须带时区（UTC）。"""
        ...


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(UTC)


class FakeClock:
    """可控时钟：测试里用 advance() 推进时间。"""

    def __init__(self, start: datetime | None = None) -> None:
        start = start or datetime(2026, 10, 4, 2, 0, tzinfo=UTC)
        if start.tzinfo is None:
            raise ValueError("FakeClock 的起点必须带时区")
        self._now = start
        self._lock = threading.Lock()

    def now(self) -> datetime:
        with self._lock:
            return self._now

    def advance(self, seconds: float = 0, **kwargs: float) -> datetime:
        delta = timedelta(seconds=seconds, **kwargs)
        if delta < timedelta(0):
            raise ValueError("时钟不能倒退")
        with self._lock:
            self._now += delta
            return self._now


def to_wire_time(value: datetime) -> str:
    """RFC 3339（UTC，带 Z 之外的 +00:00 也合法；统一用 isoformat）。"""
    if value.tzinfo is None:
        raise ValueError("时间必须带时区")
    return value.astimezone(UTC).isoformat()


def parse_time(value: str) -> datetime:
    """解析 ISO 时间。mail 服务推送的 occurred_at 等字段没有时区（库里存的是 UTC），按 UTC 处理。"""
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)
