"""有上限的退避重试。每次失败都经 report（即 MonitorRuntime.record_error）上报，用尽后抛 BootstrapFailed。

等待经注入的 sleep（运行时用 SystemClock.sleep，可被 wake() 打断；测试用 ManualClock），没有固定 sleep。
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from monitor_contracts import DriverError

from monitor.driver import _cli

from .screen import AppAlreadyRunning


class StepFailed(Exception):
    """引导步骤的业务性失败（如找不到 BOSS 进程），可重试。"""


RETRYABLE: tuple[type[BaseException], ...] = (_cli.CliFailure, DriverError, AppAlreadyRunning, OSError, StepFailed)


@dataclass(frozen=True)
class RetryPolicy:
    attempts: int = 6
    base_seconds: float = 2.0
    factor: float = 2.0
    max_seconds: float = 120.0

    def __post_init__(self) -> None:
        if self.attempts < 1:
            raise ValueError("attempts 至少为 1")
        if self.base_seconds < 0 or self.factor < 1 or self.max_seconds < 0:
            raise ValueError("退避参数非法")

    def delay(self, failures: int) -> float:
        return min(self.base_seconds * self.factor ** (failures - 1), self.max_seconds)


class BootstrapFailed(Exception):
    def __init__(self, step: str, attempts: int, last: BaseException):
        super().__init__(f"{step} 连续失败 {attempts} 次，已停止重试：{last}")
        self.step = step
        self.attempts = attempts
        self.last = last


def run_with_retry[T](
    step: str,
    fn: Callable[[], T],
    *,
    policy: RetryPolicy,
    sleep: Callable[[float], None],
    report: Callable[[str, str], None],
    should_stop: Callable[[], bool] = lambda: False,
) -> T:
    """step 用作错误码后缀（bootstrap_<step>），只能是小写字母、数字、下划线。"""
    code = f"bootstrap_{step}"
    for attempt in range(1, policy.attempts + 1):
        try:
            return fn()
        except RETRYABLE as exc:
            report(code, f"{step} 第 {attempt}/{policy.attempts} 次失败：{exc}"[:500])
            if attempt == policy.attempts or should_stop():
                raise BootstrapFailed(step, attempt, exc) from exc
            sleep(policy.delay(attempt))
    raise AssertionError("unreachable")
