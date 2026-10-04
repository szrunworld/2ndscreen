"""时钟抽象：core 里所有"现在几点"和"等一会儿"都经过它，测试注入可控时钟。"""

from __future__ import annotations

import threading
import time
from datetime import UTC, datetime, timedelta
from typing import Protocol, runtime_checkable


@runtime_checkable
class Clock(Protocol):
    def now(self) -> datetime:
        """当前时间（带时区）。"""
        ...

    def sleep(self, seconds: float) -> None:
        """等待 seconds 秒；可被 wake() 提前唤醒的实现也合规。"""
        ...


class SystemClock:
    """真实时钟。sleep 可被 wake() 提前打断（用于停止信号）。"""

    def __init__(self) -> None:
        self._wake = threading.Event()

    def now(self) -> datetime:
        return datetime.now(UTC)

    def sleep(self, seconds: float) -> None:
        if seconds <= 0:
            return
        self._wake.wait(seconds)
        self._wake.clear()

    def wake(self) -> None:
        self._wake.set()

    @staticmethod
    def monotonic() -> float:
        return time.monotonic()


class ManualClock:
    """可控时钟：时间只在 advance()/sleep() 时前进。sleep 记录每次等待时长供断言。"""

    def __init__(self, start: datetime | None = None) -> None:
        if start is not None and start.tzinfo is None:
            raise ValueError("ManualClock 的起始时间必须带时区")
        self._now = start or datetime(2026, 10, 4, 1, 0, tzinfo=UTC)
        self.sleeps: list[float] = []

    def now(self) -> datetime:
        return self._now

    def advance(self, seconds: float) -> datetime:
        if seconds < 0:
            raise ValueError("时间不能倒退")
        self._now = self._now + timedelta(seconds=seconds)
        return self._now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        if seconds > 0:
            self.advance(seconds)
