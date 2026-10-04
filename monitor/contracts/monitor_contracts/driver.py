"""Driver 协议：Monitor 唯一接触 GUI 的接口（由任务 C 实现 CliDriver / FakeDriver）。

只定义形状与错误分类，不含任何实现。

- 读：state() 返回一次快照；元素 index 只在该快照内有意义。
- 写：click / type_text / key / scroll 成功时返回 ActionReceipt，失败时抛 DriverError 子类，
  不用返回值表示失败。
- 目标：Element（来自快照）或 Locator（由 Driver 在最新快照中解析）。Locator 必须唯一命中，
  多处命中抛 TargetAmbiguousError，没有命中抛 TargetNotFoundError；Element 所属快照已
  过期时抛 StaleSnapshotError，不得按旧坐标点击。
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import Annotated, Literal, Protocol, Union, runtime_checkable

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

from .models import Frame, _fail

__all__ = [
    "Frame",
    "Element",
    "Locator",
    "Target",
    "WindowInfo",
    "WindowSelector",
    "Snapshot",
    "ActionReceipt",
    "ClickMode",
    "ScrollDirection",
    "Driver",
    "DriverError",
    "WindowLostError",
    "ScreenLostError",
    "DriverTimeoutError",
    "StaleSnapshotError",
    "CliFailedError",
    "TargetAmbiguousError",
    "TargetNotFoundError",
    "DRIVER_ERROR_CODES",
]


class _Frozen(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Element(_Frozen):
    """辅助功能树中的一个元素（扁平化后）。

    index 是该元素在所属快照 elements 中的位置，只在同一快照内有意义。
    label 是标题/描述类文本，value 是值类文本（输入框内容、静态文本值），都可为空串。
    enabled 为 None 表示来源不提供该信息（2ndscreen CLI 实测不输出 enabled），不等于不可用。
    snapshot_id 由 Driver 填写，用于写方法检测快照过期；夹具中省略。
    parent_index / depth 只在 state(include_tree=True) 时填写。
    """

    index: Annotated[int, Field(ge=0)]
    role: Annotated[str, Field(min_length=1, max_length=64)]
    label: str = ""
    value: str = ""
    frame: Frame
    enabled: bool | None = None
    snapshot_id: str | None = None
    parent_index: Annotated[int, Field(ge=0)] | None = None
    depth: Annotated[int, Field(ge=0)] | None = None

    @property
    def text(self) -> str:
        """可读文本：label 去空白后非空则为 label，否则为 value。不拼接两者。

        这样输入框（label='搜索'、value=已输入的关键词）仍能被 Locator(text='搜索') 精确命中。
        Locator 的 text / text_contains 都匹配本属性；定位与 evidence 默认用它。
        """
        return self.label if self.label.strip() else self.value


class Locator(_Frozen):
    """声明式定位条件，各条件取交集，至少给一项。

    text 精确匹配 Element.text；text_contains 子串匹配；role 精确匹配；
    region 要求元素中心点落在该矩形内；index 直接指定快照内位置；
    right_of 要求元素与 right_of 命中的元素在同一行（垂直中心落在其高度范围内）且位于其右侧。
    """

    text: str | None = None
    text_contains: str | None = None
    role: str | None = None
    region: Frame | None = None
    index: Annotated[int, Field(ge=0)] | None = None
    right_of: Locator | None = None

    @model_validator(mode="after")
    def _check(self) -> Locator:
        fields = (self.text, self.text_contains, self.role, self.region, self.index, self.right_of)
        if all(v is None for v in fields):
            raise _fail("", "Locator 至少需要一个条件")
        return self


Target = Union[Element, Locator]

ClickMode = Literal["auto", "ax_press", "event"]
ScrollDirection = Literal["up", "down", "left", "right"]


class WindowInfo(_Frozen):
    pid: int | None = None
    window_id: int | str
    frame: Frame
    title: str = ""
    app_name: str | None = None


class WindowSelector(_Frozen):
    """bind_window 的可选选择条件；省略时由 Driver 按自身配置（如 BOSS 客户端）绑定。"""

    app_name: str | None = None
    bundle_id: str | None = None
    pid: int | None = None
    title_contains: str | None = None

    @model_validator(mode="after")
    def _check(self) -> WindowSelector:
        if all(v is None for v in (self.app_name, self.bundle_id, self.pid, self.title_contains)):
            raise _fail("", "WindowSelector 至少需要一个条件")
        return self


class Snapshot(_Frozen):
    """一次 state() 的结果。"""

    snapshot_id: Annotated[str, Field(min_length=1)]
    taken_at: AwareDatetime
    window: WindowInfo | None
    elements: tuple[Element, ...] = ()

    @model_validator(mode="after")
    def _check_indexes(self) -> Snapshot:
        for pos, el in enumerate(self.elements):
            if el.index != pos:
                raise _fail(f"elements[{pos}].index", f"index 必须等于在 elements 中的位置 {pos}")
            if el.snapshot_id is not None and el.snapshot_id != self.snapshot_id:
                raise _fail(f"elements[{pos}].snapshot_id", "元素的 snapshot_id 必须与快照一致")
        return self


class ActionReceipt(_Frozen):
    """一次写操作的回执（成功才有；失败抛异常）。

    method 是实际使用的方式：ax_press（辅助功能动作）、event（后台合成事件）、
    paste（粘贴输入）、keystroke（逐键输入）等，由实现给出稳定字符串。
    element 是解析后实际作用的元素（key 操作为 None）。
    """

    op: Literal["click", "type_text", "key", "scroll"]
    method: Annotated[str, Field(min_length=1, max_length=32)]
    element: Element | None = None
    snapshot_id: str | None = None
    performed_at: AwareDatetime
    detail: str | None = None


# ---------------------------------------------------------------------------
# 错误分类。code 是稳定标识，可写入 heartbeat.last_error.code 与日志。
# ---------------------------------------------------------------------------


class DriverError(Exception):
    """Driver 错误基类。"""

    code = "driver_error"


class WindowLostError(DriverError):
    """绑定的窗口不存在或已关闭。"""

    code = "window_lost"


class ScreenLostError(DriverError):
    """专用屏幕不可用。"""

    code = "screen_lost"


class DriverTimeoutError(DriverError):
    """CLI 调用或等待超时。"""

    code = "timeout"


class StaleSnapshotError(DriverError):
    """目标元素所属的快照已过期（界面已变化）。"""

    code = "snapshot_stale"


class CliFailedError(DriverError):
    """2ndscreen CLI 非零退出或输出无法解析。"""

    code = "cli_failed"

    def __init__(self, returncode: int | None, stderr: str = "", message: str | None = None):
        self.returncode = returncode
        self.stderr = stderr
        super().__init__(message or f"2ndscreen CLI 失败（退出码 {returncode}）: {stderr[:200]}")


class TargetAmbiguousError(DriverError):
    """Locator 命中多个元素。"""

    code = "target_ambiguous"

    def __init__(self, locator: Locator, count: int):
        self.locator = locator
        self.count = count
        super().__init__(f"定位条件命中 {count} 个元素")


class TargetNotFoundError(DriverError):
    """Locator 没有命中任何元素。"""

    code = "target_not_found"

    def __init__(self, locator: Locator):
        self.locator = locator
        super().__init__("定位条件没有命中元素")


DRIVER_ERROR_CODES: tuple[str, ...] = (
    DriverError.code,
    WindowLostError.code,
    ScreenLostError.code,
    DriverTimeoutError.code,
    StaleSnapshotError.code,
    CliFailedError.code,
    TargetAmbiguousError.code,
    TargetNotFoundError.code,
)


@runtime_checkable
class Driver(Protocol):
    """GUI 驱动协议。实现必须不抢用户焦点、不移动用户指针。"""

    def state(self, include_tree: bool = False) -> Snapshot:
        """读取绑定窗口当前的元素树。include_tree=True 时同时填写 parent_index / depth。"""
        ...

    def click(self, target: Target, mode: ClickMode = "auto") -> ActionReceipt:
        """后台点击。auto 由实现选择 ax_press 或 event。"""
        ...

    def type_text(self, target: Target | None, text: str) -> ActionReceipt:
        """向目标（None = 当前焦点）输入文本。"""
        ...

    def key(self, keys: str | Sequence[str]) -> ActionReceipt:
        """发送按键或组合键，如 "return"、"cmd+v"、["cmd", "v"]。"""
        ...

    def scroll(self, target: Target | None, direction: ScrollDirection, amount: int) -> ActionReceipt:
        """在目标（None = 窗口中心）处滚动 amount 格。"""
        ...

    def bind_window(self, selector: WindowSelector | None = None) -> WindowInfo:
        """绑定目标窗口；之后 state() 与写方法都作用于它。"""
        ...

    def screen_ok(self) -> bool:
        """专用屏幕与绑定窗口是否仍可用。"""
        ...

    def screenshot_region(self, rect: Frame, out_path: Path) -> Path:
        """对区域截一张 PNG 写到 out_path 并返回该路径。仅供登录接力识别二维码，其他场景禁止调用。"""
        ...
