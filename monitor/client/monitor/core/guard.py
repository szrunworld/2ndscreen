"""包在真实 Driver 外面的守卫：统计写调用、在只读场景拒绝写调用。

- 执行指令时用 read_only=False：每次写调用（click / type_text / key / scroll）在转发前先计数，
  因此即使写调用中途抛错，也按"可能已经动过界面"处理（gui_write_performed 取保守值）。
- verify_only、崩溃恢复、观察时用 read_only=True：任何写调用直接抛 ReadOnlyViolation，
  不会到达真实 Driver。
- screenshot_region 只供登录接力使用，经过守卫一律拒绝。
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from monitor_contracts import (
    ActionReceipt,
    ClickMode,
    Driver,
    DriverError,
    Frame,
    ScrollDirection,
    Snapshot,
    Target,
    WindowInfo,
    WindowSelector,
)

WRITE_METHODS = ("click", "type_text", "key", "scroll")


class ReadOnlyViolation(DriverError):
    """只读场景里调用了写方法（或截图）。属于处理器的缺陷，按 driver_error 处理。"""

    code = "driver_error"


class GuardedDriver:
    def __init__(self, inner: Driver, *, read_only: bool) -> None:
        self._inner = inner
        self.read_only = read_only
        self.write_calls = 0

    @property
    def wrote(self) -> bool:
        return self.write_calls > 0

    def _before_write(self, method: str) -> None:
        if self.read_only:
            raise ReadOnlyViolation(f"只读模式下不允许调用 {method}")
        self.write_calls += 1

    # 只读方法 -----------------------------------------------------------
    def state(self, include_tree: bool = False) -> Snapshot:
        return self._inner.state(include_tree=include_tree)

    def bind_window(self, selector: WindowSelector | None = None) -> WindowInfo:
        return self._inner.bind_window(selector)

    def screen_ok(self) -> bool:
        return self._inner.screen_ok()

    # 写方法 -------------------------------------------------------------
    def click(self, target: Target, mode: ClickMode = "auto") -> ActionReceipt:
        self._before_write("click")
        return self._inner.click(target, mode)

    def type_text(self, target: Target | None, text: str) -> ActionReceipt:
        self._before_write("type_text")
        return self._inner.type_text(target, text)

    def key(self, keys: str | Sequence[str]) -> ActionReceipt:
        self._before_write("key")
        return self._inner.key(keys)

    def scroll(self, target: Target | None, direction: ScrollDirection, amount: int) -> ActionReceipt:
        self._before_write("scroll")
        return self._inner.scroll(target, direction, amount)

    def screenshot_region(self, rect: Frame, out_path: Path) -> Path:
        raise ReadOnlyViolation("指令执行与观察不允许截图（仅登录接力可用）")
