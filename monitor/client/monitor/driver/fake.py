"""FakeDriver：按 ax 夹具的 steps 回放界面，供观察、动作、管线与集成测试使用。

- ``state()`` 返回当前步骤的元素；每次调用发一个新的 snapshot_id。
- 写方法（click / type_text / key / scroll）与 CliDriver 有同样的目标语义：Element 必须
  属于最近一次 state() 且步骤没变，否则 StaleSnapshotError；Locator 在当前步骤里唯一定位，
  歧义或未找到照常抛错。
- 每次成功的写调用都记进 ``calls``，测试据此断言次数与参数；被拒绝的调用记进 ``rejected``。
- ``Advance`` 规则把"某个写方法调用后进入某一步"脚本化；``auto_advance=True`` 时
  没有规则命中的写调用也会进入下一步。
- ``fail_next(method, error)`` 让下一次该方法调用抛指定错误，用来测试调用方的失败路径。
- 与 CliDriver 一样默认剔除附件 PDF 预览的子树（只留容器 AXWebArea，其余重新编号，见
  pdf_preview.py）；``hide_pdf_preview=False`` 按夹具原样回放，只供测试。

FakeDriver 只回放夹具，不模拟应用逻辑：夹具通过不等于真机通过。
"""

from __future__ import annotations

import json
import struct
import zlib
from collections import deque
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from monitor_contracts import (
    ActionReceipt,
    AxFixture,
    ClickMode,
    DriverError,
    Element,
    FixtureStep,
    Frame,
    Locator,
    ScrollDirection,
    Snapshot,
    StaleSnapshotError,
    Target,
    WindowInfo,
    WindowLostError,
    WindowSelector,
    validate_ax_fixture,
)

from .locator import find_all, find_one
from .pdf_preview import strip_pdf_preview

WRITE_METHODS = ("click", "type_text", "key", "scroll")

def solid_png(width: int = 1, height: int = 1, rgb: tuple[int, int, int] = (255, 255, 255)) -> bytes:
    """生成一张纯色 PNG（无第三方依赖），screenshot_region 的缺省输出，测试里也用来造图。"""

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    row = b"\x00" + bytes(rgb) * width
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(row * height))
        + chunk(b"IEND", b"")
    )


@dataclass(frozen=True)
class Call:
    """一次 FakeDriver 调用的记录。step 是调用发生时所在步骤的 label。"""

    method: str
    args: Mapping[str, Any]
    step: str
    element: Element | None = None


@dataclass
class Advance:
    """写方法成功后切换步骤的规则，按列表顺序取第一条命中的。

    method：写方法名或 "*"；on_step：仅当当前步骤是它（label 或下标）时生效；
    target：仅当作用元素在当前步骤里命中这个定位条件时生效；when：额外判断；
    goto：目标步骤（label 或下标），None 表示下一步；once：命中一次后失效。
    """

    method: str = "*"
    goto: str | int | None = None
    on_step: str | int | None = None
    target: Locator | None = None
    when: Callable[[Call], bool] | None = None
    once: bool = False
    used: bool = field(default=False, init=False)


def load_fixture(source: AxFixture | Mapping[str, Any] | str | Path) -> AxFixture:
    """读夹具：契约模型、dict 或 JSON 文件路径，均经 validate_ax_fixture 校验。"""
    if isinstance(source, AxFixture):
        return source
    if isinstance(source, (str, Path)):
        source = json.loads(Path(source).read_text())
    return validate_ax_fixture(source)


class FakeDriver:
    def __init__(
        self,
        fixture: AxFixture | Mapping[str, Any] | str | Path,
        *,
        advances: Iterable[Advance] = (),
        auto_advance: bool = False,
        screen_ok: bool = True,
        screenshot_png: bytes | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        hide_pdf_preview: bool = True,
    ):
        self.fixture = load_fixture(fixture)
        self.hide_pdf_preview = hide_pdf_preview
        self.steps: list[FixtureStep] = list(self.fixture.steps)
        self.advances = list(advances)
        self.auto_advance = auto_advance
        self.healthy = screen_ok
        self.screenshot_png = screenshot_png if screenshot_png is not None else solid_png()
        self.clock = clock
        self.step_index = 0
        self.calls: list[Call] = []
        self.rejected: list[tuple[Call, DriverError]] = []
        self.bound: WindowInfo | None = None
        self._serial = 0
        self._latest: Snapshot | None = None
        self._latest_step = -1
        self._failures: dict[str, deque[DriverError]] = {}

    # ---- 步骤 ----

    @property
    def step(self) -> FixtureStep:
        return self.steps[self.step_index]

    def _step_position(self, ref: str | int) -> int:
        if isinstance(ref, int):
            if not 0 <= ref < len(self.steps):
                raise IndexError(f"夹具 {self.fixture.scene} 没有第 {ref} 步")
            return ref
        for pos, step in enumerate(self.steps):
            if step.label == ref:
                return pos
        raise KeyError(f"夹具 {self.fixture.scene} 没有标签为 {ref!r} 的步骤")

    def goto(self, ref: str | int) -> None:
        """直接切到某一步（测试里模拟"外部变化"，例如新消息到达）。"""
        self.step_index = self._step_position(ref)

    # ---- 断言辅助 ----

    @property
    def writes(self) -> list[Call]:
        return [c for c in self.calls if c.method in WRITE_METHODS]

    def count(self, method: str | None = None) -> int:
        """写方法调用次数；method 为 None 时统计全部写方法。"""
        if method is None:
            return len(self.writes)
        return sum(1 for c in self.calls if c.method == method)

    def fail_next(self, method: str, error: DriverError) -> None:
        """让下一次 ``method``（含 "state"、"bind_window"、"screenshot_region"）抛 error。"""
        self._failures.setdefault(method, deque()).append(error)

    def _maybe_fail(self, method: str, args: Mapping[str, Any]) -> None:
        queue = self._failures.get(method)
        if queue:
            error = queue.popleft()
            self.rejected.append((Call(method, dict(args), self.step.label), error))
            raise error

    # ---- 读 ----

    def _elements(self, snapshot_id: str | None, include_tree: bool = True) -> tuple[Element, ...]:
        """当前步骤的夹具元素（FixtureElement）转成契约 Element（按需剔除 PDF 预览子树）。"""
        source = self.step.elements
        if self.hide_pdf_preview:
            source, _ = strip_pdf_preview(source)
        elements = []
        for e in source:
            element = e.to_element(snapshot_id)
            if not include_tree:
                element = element.model_copy(update={"parent_index": None, "depth": None})
            elements.append(element)
        return tuple(elements)

    def _snapshot(self, include_tree: bool) -> Snapshot:
        self._serial += 1
        sid = f"fake-{self.fixture.scene}-{self._serial}"
        elements = self._elements(sid, include_tree)
        snapshot = Snapshot(snapshot_id=sid, taken_at=self.clock(), window=self.step.window, elements=elements)
        self._latest = snapshot
        self._latest_step = self.step_index
        return snapshot

    def state(self, include_tree: bool = False) -> Snapshot:
        self._maybe_fail("state", {"include_tree": include_tree})
        return self._snapshot(include_tree)

    # ---- 写 ----

    def _resolve(self, method: str, target: Target, args: Mapping[str, Any]) -> Element:
        try:
            if isinstance(target, Locator):
                return find_one(self._snapshot(False).elements, target)
            latest = self._latest
            if (
                target.snapshot_id is None
                or latest is None
                or target.snapshot_id != latest.snapshot_id
                or self._latest_step != self.step_index
            ):
                raise StaleSnapshotError(f"元素 {target.index} 的快照 {target.snapshot_id} 已过期")
            if target.index >= len(latest.elements) or latest.elements[target.index] != target:
                raise StaleSnapshotError(f"元素 {target.index} 与所属快照不一致")
            return target
        except DriverError as error:
            self.rejected.append((Call(method, dict(args), self.step.label), error))
            raise

    def _write(self, method: str, target: Target | None, args: dict[str, Any], method_name: str = "fake") -> ActionReceipt:
        self._maybe_fail(method, args)
        element = self._resolve(method, target, args) if target is not None else None
        call = Call(method, args, self.step.label, element)
        self.calls.append(call)
        self._apply_advances(call)
        return ActionReceipt(
            op=method,  # type: ignore[arg-type]
            method=method_name,
            element=element,
            snapshot_id=element.snapshot_id if element else None,
            performed_at=self.clock(),
            detail=f"fixture={self.fixture.scene} step={call.step}",
        )

    def _rule_matches(self, rule: Advance, call: Call) -> bool:
        if rule.once and rule.used:
            return False
        if rule.method not in ("*", call.method):
            return False
        if rule.on_step is not None and self._step_position(rule.on_step) != self.step_index:
            return False
        if rule.target is not None:
            if call.element is None:
                return False
            hits = find_all(self._elements(None), rule.target)
            if not any(h.index == call.element.index for h in hits):
                return False
        if rule.when is not None and not rule.when(call):
            return False
        return True

    def _apply_advances(self, call: Call) -> None:
        for rule in self.advances:
            if self._rule_matches(rule, call):
                rule.used = True
                self.step_index = self.step_index + 1 if rule.goto is None else self._step_position(rule.goto)
                self.step_index = min(self.step_index, len(self.steps) - 1)
                return
        if self.auto_advance:
            self.step_index = min(self.step_index + 1, len(self.steps) - 1)

    def click(self, target: Target, mode: ClickMode = "auto") -> ActionReceipt:
        return self._write("click", target, {"target": target, "mode": mode})

    def type_text(self, target: Target | None, text: str) -> ActionReceipt:
        return self._write("type_text", target, {"target": target, "text": text})

    def key(self, keys: str | Sequence[str]) -> ActionReceipt:
        return self._write("key", None, {"keys": keys if isinstance(keys, str) else tuple(keys)})

    def scroll(self, target: Target | None, direction: ScrollDirection, amount: int) -> ActionReceipt:
        return self._write("scroll", target, {"target": target, "direction": direction, "amount": amount})

    # ---- 其他 ----

    def bind_window(self, selector: WindowSelector | None = None) -> WindowInfo:
        args = {"selector": selector}
        self._maybe_fail("bind_window", args)
        window = self.step.window or WindowInfo(window_id="fake", frame=Frame(x=0, y=0, w=0, h=0))
        if selector is not None:
            mismatch = (
                (selector.pid is not None and window.pid is not None and selector.pid != window.pid)
                or (selector.app_name is not None and window.app_name not in (None, selector.app_name))
                or (selector.title_contains is not None and selector.title_contains not in window.title)
            )
            if mismatch:
                error = WindowLostError(f"夹具窗口不满足 {selector.model_dump(exclude_none=True)}")
                self.rejected.append((Call("bind_window", args, self.step.label), error))
                raise error
        self.calls.append(Call("bind_window", args, self.step.label))
        self.bound = window
        return window

    def screen_ok(self) -> bool:
        return self.healthy

    def screenshot_region(self, rect: Frame, out_path: Path) -> Path:
        """写入预设 PNG。与 CliDriver 一样只供登录接力测试使用。"""
        args = {"rect": rect, "out_path": Path(out_path)}
        self._maybe_fail("screenshot_region", args)
        self.calls.append(Call("screenshot_region", args, self.step.label))
        path = Path(out_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.screenshot_png)
        return path
