"""CliDriver：通过 2ndscreen CLI 实现契约 ``Driver`` Protocol。

一个 CliDriver 只服务一块专用屏幕上的一个绑定窗口：

- ``bind_window`` 找到屏幕上的目标窗口并记住 pid 与 window id；之后每条命令都带
  ``--screen/--pid/--window-id``，窗口关闭时得到 WindowLostError，而不会悄悄换到同一应用
  的别的窗口。绑定只读不写，不移动窗口（接管窗口是任务 J 的 bootstrap 做的事）。
- 不做重试；失败一律抛契约里的 DriverError 子类（重试策略属于任务 D2）。

快照过期检测（CLI 本身做不到，必须由这里负责）：

CLI 的 ``--index`` 指向菜单栏应用为该窗口缓存的"最近一次 state"，任何进程对同一窗口
调用 state 都会替换这份缓存，而 CLI 不报错。所以写方法：

1. 目标是 Element 时，要求 ``element.snapshot_id`` 等于本 Driver 最近一次 ``state()``
   的快照，否则 StaleSnapshotError；
2. ``verify_before_write=True``（默认）时再读一次 state，核对同一 index 上的元素
   角色、label 与位置没变，变了就 StaleSnapshotError、不点击。这一步同时把 CLI 的缓存
   刷新成刚核对过的这份，index 才可靠；
3. 动作返回后核对 CLI 回报的元素与预期一致，不一致抛 StaleSnapshotError（此时动作
   已送达，异常的 ``delivered`` 为 True）。

目标是 Locator 时，先读一次新快照，在其中唯一定位，再按 index 执行。
"""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
import uuid
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from monitor_contracts import (
    ActionReceipt,
    CliFailedError,
    ClickMode,
    DriverError,
    DriverTimeoutError,
    Element,
    Frame,
    Locator,
    ScreenLostError,
    ScrollDirection,
    Snapshot,
    StaleSnapshotError,
    Target,
    TargetNotFoundError,
    WindowInfo,
    WindowLostError,
    WindowSelector,
)

from . import _cli
from .locator import find_one

DEFAULT_BINARY = os.environ.get("MONITOR_2NDSCREEN_CLI", "2ndscreen")

# CLI 的 route → ActionReceipt.method（稳定字符串）。原始 route 写进 detail。
_ROUTE_METHODS = {
    "ax.press": "ax_press",
    "ax.insert": "ax_insert",
    "ax.value": "ax_value",
    "event.click": "event",
    "event.right": "event",
    "event.double": "event",
    "event.wheel": "event",
    "event.unicode": "keystroke",
    "event.key": "keystroke",
    "event.key.menu": "keystroke",
}

_ZERO = Frame(x=0, y=0, w=0, h=0)


def _now() -> datetime:
    return datetime.now(UTC)


def _new_id() -> str:
    return uuid.uuid4().hex


def _enabled_unknown() -> bool | None:
    """CLI 不输出 enabled。契约改为 ``bool | None`` 后填 None（未知）；旧契约只能填 True。"""
    try:
        Element(index=0, role="AXUnknown", frame=_ZERO, enabled=None)  # type: ignore[arg-type]
    except Exception:
        return True
    return None


ENABLED_UNKNOWN = _enabled_unknown()


def to_driver_error(failure: _cli.CliFailure) -> DriverError:
    """把 _cli 的分类映射到契约错误类型。"""
    if failure.kind == _cli.WINDOW_LOST:
        return WindowLostError(failure.message)
    if failure.kind == _cli.SCREEN_LOST:
        return ScreenLostError(failure.message)
    if failure.kind == _cli.TIMEOUT:
        return DriverTimeoutError(failure.message)
    if failure.kind == _cli.STALE_SNAPSHOT:
        return StaleSnapshotError(failure.message)
    if failure.kind == _cli.NOT_FOUND:
        # 只有用 CLI 的 --text 时才会出现；本 Driver 不用 --text，保留映射以防万一。
        return TargetNotFoundError(Locator(text=failure.message))
    return CliFailedError(failure.exit_code, failure.stderr, message=f"2ndscreen CLI 失败：{failure.message}")


_TREE_LINE = re.compile(r"^(?P<indent> *)- (?:\[(?P<index>\d+)\] )?")


def parse_tree(tree: str) -> dict[int, tuple[int | None, int]]:
    """从 CLI 的 tree 文本求每个带编号元素的 (parent_index, depth)。

    tree 每行是 ``{两个空格 × 深度}- [index] Role "label" = "value"``，没编号的节点省略
    ``[index]``。parent_index 是最近的带编号祖先；depth 是树深度（含不带编号的节点）。
    """
    out: dict[int, tuple[int | None, int]] = {}
    stack: list[tuple[int, int | None]] = []
    for line in tree.splitlines():
        m = _TREE_LINE.match(line)
        if not m:
            continue
        depth = len(m.group("indent")) // 2
        while stack and stack[-1][0] >= depth:
            stack.pop()
        index = int(m.group("index")) if m.group("index") is not None else None
        if index is not None:
            parent = next((i for _, i in reversed(stack) if i is not None), None)
            out[index] = (parent, depth)
        stack.append((depth, index))
    return out


def to_frame(raw: _cli.RawFrame | None) -> Frame:
    if raw is None:
        return _ZERO
    return Frame(x=raw.x, y=raw.y, w=max(raw.width, 0.0), h=max(raw.height, 0.0))


def snapshot_from_state(
    state: _cli.RawState, *, snapshot_id: str, taken_at: datetime, include_tree: bool = False
) -> Snapshot:
    """把 CLI state 转成契约 Snapshot。CLI 不带 --query 时元素编号从 0 连续，与位置一致。"""
    tree = parse_tree(state.tree) if include_tree else {}
    elements = []
    for pos, raw in enumerate(state.elements):
        if raw.index != pos:
            raise CliFailedError(None, message=f"CLI 元素编号不连续：位置 {pos} 是 index {raw.index}")
        parent, depth = tree.get(raw.index, (None, None))
        elements.append(
            Element(
                index=raw.index,
                role=raw.role,
                label=raw.label or "",
                value=raw.value or "",
                frame=to_frame(raw.frame),
                enabled=ENABLED_UNKNOWN,  # type: ignore[arg-type]
                snapshot_id=snapshot_id,
                parent_index=parent,
                depth=depth,
            )
        )
    title = ""
    if state.elements and state.elements[0].role.startswith("AXWindow"):
        title = state.elements[0].label or ""
    window = WindowInfo(
        pid=state.pid,
        window_id=state.window_id,
        frame=to_frame(state.window_frame),
        title=title,
        app_name=state.app,
    )
    return Snapshot(snapshot_id=snapshot_id, taken_at=taken_at, window=window, elements=tuple(elements))


def split_keys(keys: str | Sequence[str]) -> tuple[str, list[str]]:
    """"cmd+shift+v" 或 ["cmd", "shift", "v"] → ("v", ["cmd", "shift"])。"""
    parts = [p.strip() for p in (keys.split("+") if isinstance(keys, str) else keys)]
    parts = [p for p in parts if p]
    if not parts:
        raise CliFailedError(None, message="key 需要至少一个按键")
    return parts[-1], parts[:-1]


def default_pid_resolver(selector: WindowSelector) -> list[int]:
    """按 bundle id 或应用名找 pid（macOS ``lsappinfo``）。只读，不激活应用。"""
    if selector.bundle_id:
        query = f"bundleid={selector.bundle_id}"
    elif selector.app_name:
        query = f"name={selector.app_name}"
    else:
        return []
    try:
        found = subprocess.run(["lsappinfo", "find", query], capture_output=True, text=True, timeout=5)
        pids = []
        for asn in re.findall(r"ASN:[0-9a-fx\-]+", found.stdout):
            info = subprocess.run(
                ["lsappinfo", "info", "-only", "pid", asn], capture_output=True, text=True, timeout=5
            )
            m = re.search(r'"pid"=(\d+)', info.stdout)
            if m:
                pids.append(int(m.group(1)))
        return pids
    except (OSError, subprocess.TimeoutExpired):
        return []


ToolRunner = Callable[[Sequence[str]], str]


def _run_tool(argv: Sequence[str]) -> str:
    try:
        done = subprocess.run(list(argv), capture_output=True, text=True, timeout=30, check=False)
    except subprocess.TimeoutExpired:
        raise DriverTimeoutError(f"{argv[0]} 超时") from None
    except OSError as exc:
        raise CliFailedError(None, message=f"无法执行 {argv[0]}：{exc}") from None
    if done.returncode != 0:
        raise CliFailedError(done.returncode, done.stderr, message=f"{argv[0]} 失败：{done.stderr.strip()}")
    return done.stdout


class CliDriver:
    """契约 Driver 的 2ndscreen CLI 实现。"""

    def __init__(
        self,
        screen: str,
        *,
        binary: str = DEFAULT_BINARY,
        runner: _cli.CliRunner | None = None,
        default_selector: WindowSelector | None = None,
        pid_resolver: Callable[[WindowSelector], list[int]] = default_pid_resolver,
        verify_before_write: bool = True,
        clock: Callable[[], datetime] = _now,
        id_factory: Callable[[], str] = _new_id,
        tool_runner: ToolRunner = _run_tool,
    ):
        self.screen = screen
        self.cli = runner or _cli.CliRunner(binary)
        self.default_selector = default_selector
        self.pid_resolver = pid_resolver
        self.verify_before_write = verify_before_write
        self.clock = clock
        self.id_factory = id_factory
        self.tool_runner = tool_runner
        self.window: WindowInfo | None = None
        self.last_problem: str | None = None
        self._latest: Snapshot | None = None
        self._latest_actions: dict[int, tuple[str, ...]] = {}

    # ---- 调用与目标参数 ----

    def _run(self, args: Sequence[Any], timeout: float | None = None) -> Mapping[str, Any]:
        try:
            return self.cli.run([str(a) for a in args], timeout=timeout).payload
        except _cli.CliFailure as failure:
            raise to_driver_error(failure) from None

    def _target_args(self) -> list[Any]:
        if self.window is None:
            raise WindowLostError("还没有绑定窗口：先调用 bind_window()")
        return ["--screen", self.screen, "--pid", self.window.pid, "--window-id", self.window.window_id]

    # ---- 绑定 ----

    def bind_window(self, selector: WindowSelector | None = None) -> WindowInfo:
        selector = selector or self.default_selector
        if selector is None:
            raise WindowLostError("没有绑定条件：传入 WindowSelector 或在构造时给 default_selector")
        pids = [selector.pid] if selector.pid is not None else self.pid_resolver(selector)
        found: list[WindowInfo] = []
        for pid in dict.fromkeys(pids):
            try:
                payload = self._run(["state", "--screen", self.screen, "--pid", pid])
            except WindowLostError:
                continue  # 这个进程在本屏没有窗口
            snapshot = snapshot_from_state(
                _cli.parse_state(payload), snapshot_id=self.id_factory(), taken_at=self.clock()
            )
            window = snapshot.window
            assert window is not None
            if selector.app_name and window.app_name != selector.app_name:
                continue
            if selector.title_contains and selector.title_contains not in window.title:
                continue
            found.append(window)
        if not found:
            raise WindowLostError(f"屏幕 {self.screen} 上没有满足条件的窗口：{selector.model_dump(exclude_none=True)}")
        if len(found) > 1:
            ids = [w.window_id for w in found]
            raise DriverError(f"多个窗口满足绑定条件 {ids}，请用 pid 区分")
        self.window = found[0]
        self._latest = None
        self._latest_actions = {}
        return self.window

    # ---- 读 ----

    def _capture(self, include_tree: bool = False) -> tuple[Snapshot, _cli.RawState]:
        raw = _cli.parse_state(self._run(["state", *self._target_args()]))
        snapshot = snapshot_from_state(
            raw, snapshot_id=self.id_factory(), taken_at=self.clock(), include_tree=include_tree
        )
        return snapshot, raw

    def state(self, include_tree: bool = False) -> Snapshot:
        snapshot, raw = self._capture(include_tree)
        if snapshot.window is not None:
            self.window = snapshot.window
        self._latest = snapshot
        self._latest_actions = {e.index: e.actions for e in raw.elements}
        return snapshot

    # ---- 目标解析与过期检测 ----

    @staticmethod
    def _same_element(a: Element, b: Element) -> bool:
        # value 可能因输入而变（文本框），不参与比较。
        return a.index == b.index and a.role == b.role and a.label == b.label and a.frame == b.frame

    def _resolve(self, target: Target) -> Element:
        if isinstance(target, Locator):
            return find_one(self.state().elements, target)
        latest = self._latest
        if target.snapshot_id is None or latest is None or target.snapshot_id != latest.snapshot_id:
            raise StaleSnapshotError(
                f"元素 {target.index} 属于快照 {target.snapshot_id}，最近的快照是 "
                f"{latest.snapshot_id if latest else '无'}；请重新 state()"
            )
        if target.index >= len(latest.elements) or not self._same_element(latest.elements[target.index], target):
            raise StaleSnapshotError(f"元素 {target.index} 与所属快照里的不一致")
        if self.verify_before_write:
            fresh, _ = self._capture()
            if target.index >= len(fresh.elements) or not self._same_element(fresh.elements[target.index], target):
                raise StaleSnapshotError(f"界面已变化：元素 {target.index}（{target.role} {target.label!r}）不在原处")
        return target

    def _check_delivered(self, payload: Mapping[str, Any], expected: Element) -> None:
        raw = payload.get("element")
        if not isinstance(raw, Mapping):
            return
        got = _cli.parse_element(raw)
        if got.index != expected.index or got.role != expected.role or to_frame(got.frame) != expected.frame:
            error = StaleSnapshotError(
                f"CLI 作用在了 index {got.index}（{got.role}），预期 {expected.index}（{expected.role}）"
            )
            error.delivered = True  # type: ignore[attr-defined]
            raise error

    def _receipt(self, op: str, payload: Mapping[str, Any], element: Element | None) -> ActionReceipt:
        route = str(payload.get("route") or "unknown")
        return ActionReceipt(
            op=op,  # type: ignore[arg-type]
            method=_ROUTE_METHODS.get(route, route.replace(".", "_")[:32]),
            element=element,
            snapshot_id=element.snapshot_id if element else None,
            performed_at=self.clock(),
            detail=f"route={route}",
        )

    # ---- 写 ----

    def click(self, target: Target, mode: ClickMode = "auto") -> ActionReceipt:
        element = self._resolve(target)
        if mode == "event":
            cx, cy = element.frame.center()
            payload = self._run(["click", *self._target_args(), "--x", f"{cx:g}", "--y", f"{cy:g}"])
            return self._receipt("click", payload, element)
        if mode == "ax_press" and "AXPress" not in self._latest_actions.get(element.index, ()):
            raise CliFailedError(None, message=f"元素 {element.index}（{element.role}）不支持 AXPress")
        payload = self._run(["click", *self._target_args(), "--index", element.index])
        self._check_delivered(payload, element)
        return self._receipt("click", payload, element)

    def type_text(self, target: Target | None, text: str) -> ActionReceipt:
        if target is None:
            payload = self._run(["type", *self._target_args(), "--value", text])
            return self._receipt("type_text", payload, None)
        element = self._resolve(target)
        payload = self._run(["type", *self._target_args(), "--index", element.index, "--value", text])
        self._check_delivered(payload, element)
        return self._receipt("type_text", payload, element)

    def key(self, keys: str | Sequence[str]) -> ActionReceipt:
        key, modifiers = split_keys(keys)
        args: list[Any] = ["key", *self._target_args(), "--key", key]
        if modifiers:
            args += ["--modifiers", ",".join(modifiers)]
        return self._receipt("key", self._run(args), None)

    def scroll(self, target: Target | None, direction: ScrollDirection, amount: int) -> ActionReceipt:
        args: list[Any] = ["scroll", *self._target_args(), "--direction", direction, "--amount", amount]
        if target is None:
            return self._receipt("scroll", self._run(args), None)
        element = self._resolve(target)
        payload = self._run([*args, "--index", element.index])
        self._check_delivered(payload, element)
        return self._receipt("scroll", payload, element)

    # ---- 健康检查 ----

    def _screen_frame(self) -> Frame:
        screens = _cli.parse_screens(self._run(["screen", "list"]))
        if self.screen not in screens:
            raise ScreenLostError(f'no screen named "{self.screen}"')
        return to_frame(screens[self.screen])

    def screen_ok(self) -> bool:
        """专用屏幕在、绑定窗口（如有）还在屏上时为 True。原因写在 ``last_problem``。"""
        try:
            self._screen_frame()
            if self.window is not None:
                self._capture()
        except DriverError as exc:
            self.last_problem = f"{exc.code}: {exc}"
            return False
        self.last_problem = None
        return True

    # ---- 登录接力专用截图 ----

    def screenshot_region(self, rect: Frame, out_path: Path) -> Path:
        """对专用屏幕上的一块区域截图，写 PNG 到 out_path 并返回路径。

        仅供登录接力（任务 K）截取登录二维码使用；除登录二维码外不得调用——Monitor 的
        数据路径是元素树，不是截图（方案第十一节：evidence 不含截图）。

        实现：``screenshot --screen`` 截整屏（HiDPI 屏是 2 倍像素），按屏幕框与像素比例
        换算后用 macOS 自带的 ``sips`` 裁剪。区域必须完整落在专用屏幕内。
        """
        screen = self._screen_frame()
        if not (
            screen.contains(rect.x, rect.y)
            and screen.contains(rect.x + rect.w, rect.y + rect.h)
            and rect.w > 0
            and rect.h > 0
        ):
            raise DriverError(f"截图区域 {rect} 不在屏幕 {self.screen} {screen} 内")
        out_path = Path(out_path)
        with tempfile.TemporaryDirectory(prefix="monitor-shot-") as tmp:
            full = Path(tmp) / "screen.png"
            self._run(["screenshot", "--screen", self.screen, "--output", full])
            info = self.tool_runner(["sips", "-g", "pixelWidth", "-g", "pixelHeight", str(full)])
            width = re.search(r"pixelWidth:\s*(\d+)", info)
            if not width or screen.w <= 0:
                raise CliFailedError(None, message=f"读不出截图尺寸：{info.strip()}")
            scale = int(width.group(1)) / screen.w
            x = round((rect.x - screen.x) * scale)
            y = round((rect.y - screen.y) * scale)
            w = round(rect.w * scale)
            h = round(rect.h * scale)
            out_path.parent.mkdir(parents=True, exist_ok=True)
            self.tool_runner(
                ["sips", "-c", str(h), str(w), "--cropOffset", str(y), str(x), str(full), "--out", str(out_path)]
            )
        return out_path

    # ---- 录制模式 ----

    def record_step(self, recorder: Any, label: str, annotations: Any = None, include_tree: bool = False) -> Snapshot:
        """读一次 state 并交给 FixtureRecorder（见 record.py）脱敏后记为一步。"""
        snapshot = self.state(include_tree=include_tree)
        recorder.add_step(snapshot, label, annotations)
        return snapshot
