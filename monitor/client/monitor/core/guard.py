"""包在真实 Driver 外面的守卫：区分导航与对外动作、在只读场景拒绝写调用、执行中取消。

契约 0.2.0 把"动过界面"拆成 navigation_performed / outbound_action_performed /
externally_visible_side_effect。Driver 层分不清一次点击是导航还是对外动作，所以采用显式声明：

    with ctx.outbound():          # 或 driver.outbound()，两者等价
        driver.click(send_button)

- outbound() 块内的写调用记为对外动作；块外的写调用记为导航。
- 计数发生在转发给真实 Driver 之前，因此写调用中途抛错也按"可能已经发生"处理（取保守值）。

三种模式：
- execute（执行指令 run）：全部写方法可用；outbound() 可用。
- verify（verify_only 指令与崩溃恢复）：click / scroll 可用（导航）；type_text / key 一律拒绝
  （只读核实不需要输入）；进入 outbound() 直接拒绝。
- read_only（观察）：任何写调用都拒绝。
被拒绝的调用抛 ReadOnlyViolation，不会到达真实 Driver。screenshot_region 只供登录接力使用，经过守卫一律拒绝。

取消：执行中收到取消请求后，尚未发生对外动作时，下一次写调用或进入 outbound() 抛 CommandCancelled；
已经发生过对外动作则不再打断，由管线回报实际结果。
"""

from __future__ import annotations

from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from monitor_contracts import (
    ActionContext,
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

GuardMode = Literal["execute", "verify", "read_only"]

WRITE_METHODS = ("click", "type_text", "key", "scroll")
# verify 模式下也拒绝的写方法：输入只会出现在对外动作（或无需输入的只读核实）里
VERIFY_BLOCKED = frozenset({"type_text", "key"})


class ReadOnlyViolation(DriverError):
    """只读 / 核实场景里调用了不允许的写方法（或截图、或声明对外动作）。属于处理器缺陷，按 driver_error 处理。"""

    code = "driver_error"


class CommandCancelled(Exception):
    """执行中被取消，且还没有发生对外动作。

    故意不继承 DriverError：处理器不应把它当作驱动错误吞掉。即使被处理器吞掉，管线也会按取消请求
    与守卫记录判定结果。
    """


def _never() -> bool:
    return False


class GuardedDriver:
    def __init__(self, inner: Driver, *, mode: GuardMode, cancelled: Callable[[], bool] = _never) -> None:
        if mode not in ("execute", "verify", "read_only"):
            raise ValueError(f"未知的守卫模式: {mode}")
        self._inner = inner
        self.mode: GuardMode = mode
        self._cancelled = cancelled
        self._outbound_depth = 0
        self.navigation_calls = 0
        self.outbound_calls = 0

    @property
    def navigated(self) -> bool:
        return self.navigation_calls > 0

    @property
    def outbound_performed(self) -> bool:
        return self.outbound_calls > 0

    def cancel_requested(self) -> bool:
        return self._cancelled()

    def _check_cancel(self) -> None:
        if not self.outbound_performed and self._cancelled():
            raise CommandCancelled("执行中被取消")

    @contextmanager
    def outbound(self) -> Iterator[None]:
        """声明接下来的写调用是对外动作（对候选人或第三方可见）。可嵌套。"""
        if self.mode != "execute":
            raise ReadOnlyViolation("verify_only / 只读场景不允许对外动作")
        self._check_cancel()
        self._outbound_depth += 1
        try:
            yield
        finally:
            self._outbound_depth -= 1

    def _before_write(self, method: str) -> None:
        if self.mode == "read_only":
            raise ReadOnlyViolation(f"只读模式下不允许调用 {method}")
        if self.mode == "verify" and method in VERIFY_BLOCKED:
            raise ReadOnlyViolation(f"verify_only 下不允许调用 {method}（视为对外动作）")
        self._check_cancel()
        if self._outbound_depth:
            self.outbound_calls += 1
        else:
            self.navigation_calls += 1

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


@dataclass(frozen=True)
class ExecContext(ActionContext):
    """core 注入给处理器的 ActionContext（契约类型的子类，处理器按 ActionContext 使用即可）。

    额外提供：
    - outbound()：声明对外动作的上下文管理器（转给守卫）。
    - cancel_requested()：执行中是否收到了取消，处理器可在耗时步骤之间轮询并尽早返回。
    """

    guard: GuardedDriver | None = field(default=None, compare=False, repr=False)

    def outbound(self):
        if self.guard is None:
            raise RuntimeError("这个上下文没有绑定守卫，无法声明对外动作")
        return self.guard.outbound()

    def cancel_requested(self) -> bool:
        return self.guard is not None and self.guard.cancel_requested()
