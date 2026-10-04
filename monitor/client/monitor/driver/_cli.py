"""2ndscreen CLI 的底层调用：子进程、JSON 解析、超时与错误分类。

本模块不认识任何业务语义，也不依赖契约包；它只把一次 CLI 调用变成
``CliOutcome``（成功时的 JSON 对象）或 ``CliFailure``（带分类的失败）。
CliDriver 再把 ``CliFailure`` 翻译成契约里的 Driver 错误类型。

CLI 行为（2ndscreen-main 67b34c5 实测，样例见 monitor/fixtures/cli-samples/）：

- 每条命令向 stdout 打印一个 JSON 对象；失败时 ``ok`` 为 false、带 ``error`` 文案、
  退出码 1。
- 参数解析失败（例如 ``--pid`` 缺值）只往 stderr 写一行、退出码 2，没有 JSON。
- 与菜单栏应用的连接失败（"2ndscreen is not running"）对 state/click 等是 JSON，
  对 screen/app/window 子命令是 stderr + 退出码 1。
- CLI 自己对菜单栏应用的请求有 60 秒套接字超时；我们的超时应更短。
- ``app launch`` 可能 ``ok: false`` 但窗口已经在屏上（应用拒绝 --fill 调整尺寸），
  这种情况仍按失败返回，由调用方决定是否接受 ``windows`` 字段。
"""

from __future__ import annotations

import json
import re
import subprocess
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

# 错误分类。与契约 Driver 错误一一对应（见 cli_driver.py 的映射）。
WINDOW_LOST = "window_lost"
SCREEN_LOST = "screen_lost"
TIMEOUT = "timeout"
STALE_SNAPSHOT = "stale_snapshot"
NOT_FOUND = "not_found"
CLI_FAILED = "cli_failed"

# 默认超时（秒）。state 遍历整棵辅助功能树，Electron 页面首读可能要几秒。
DEFAULT_TIMEOUTS: Mapping[str, float] = {
    "state": 30.0,
    "screenshot": 30.0,
    "screen": 15.0,
    "window": 20.0,
    "app": 30.0,
}
DEFAULT_ACTION_TIMEOUT = 20.0

# 错误文案 → 分类。按顺序匹配，先命中先用。文案来自 CLI 源码与实测样例。
_RULES: Sequence[tuple[re.Pattern[str], str]] = (
    (re.compile(r'no screen named "'), SCREEN_LOST),
    (re.compile(r'no agent screen named "'), SCREEN_LOST),
    (re.compile(r"^no screen \S"), SCREEN_LOST),
    (re.compile(r"has no window on screen"), WINDOW_LOST),
    (re.compile(r"has no on-screen window"), WINDOW_LOST),
    (re.compile(r"has no matching on-screen window"), WINDOW_LOST),
    # window release：窗口已不在该屏（AgentScreens.swift releaseWindows）。
    (re.compile(r"has no matching window on screen"), WINDOW_LOST),
    (re.compile(r"is not on screen \""), WINDOW_LOST),
    (re.compile(r"does not expose window"), WINDOW_LOST),
    (re.compile(r"the window is on no screen"), WINDOW_LOST),
    (re.compile(r"no element \d+ in the window; run state again"), STALE_SNAPSHOT),
    (re.compile(r"no element matches \""), NOT_FOUND),
)


class CliFailure(Exception):
    """一次 CLI 调用失败。kind 是上面的分类常量之一。

    不能写成 frozen dataclass：异常穿过 ``contextlib.contextmanager`` 写的 ``with``
    （例如 core 的 ``GuiLock.hold``）时，contextlib 会给异常设 ``__traceback__``，
    frozen dataclass 的 ``__setattr__`` 会因此抛 FrozenInstanceError，把原异常换掉。
    所以这里是普通异常类：字段放在私有属性里，经只读属性暴露，构造后不应再改。
    """

    def __init__(
        self,
        kind: str,
        message: str,
        argv: Sequence[str] = (),
        exit_code: int | None = None,
        payload: Mapping[str, Any] | None = None,
        stderr: str = "",
    ):
        super().__init__(kind, message)
        self._kind = kind
        self._message = message
        self._argv = tuple(argv)
        self._exit_code = exit_code
        self._payload = payload
        self._stderr = stderr

    @property
    def kind(self) -> str:
        return self._kind

    @property
    def message(self) -> str:
        return self._message

    @property
    def argv(self) -> tuple[str, ...]:
        return self._argv

    @property
    def exit_code(self) -> int | None:
        return self._exit_code

    @property
    def payload(self) -> Mapping[str, Any] | None:
        return self._payload

    @property
    def stderr(self) -> str:
        return self._stderr

    def __str__(self) -> str:
        return f"{self.kind}: {self.message}"

    def __repr__(self) -> str:
        return f"CliFailure(kind={self.kind!r}, message={self.message!r}, exit_code={self.exit_code!r})"

    def __reduce__(self) -> tuple[Any, ...]:
        # 默认的异常 pickle 只带 args（kind, message），这里带上全部字段。
        return (type(self), (self.kind, self.message, self.argv, self.exit_code, self.payload, self.stderr))


@dataclass(frozen=True)
class CliOutcome:
    """一次成功的 CLI 调用：``payload`` 是解析后的 JSON 对象，``ok`` 必为 true。"""

    argv: tuple[str, ...]
    payload: Mapping[str, Any]
    duration_s: float = 0.0


def classify_error(message: str) -> str:
    """把 CLI 的 error 文案归类；未知文案归为 CLI_FAILED。"""
    for pattern, kind in _RULES:
        if pattern.search(message):
            return kind
    return CLI_FAILED


def interpret(
    argv: Sequence[str], exit_code: int, stdout: str, stderr: str, duration_s: float = 0.0
) -> CliOutcome:
    """把子进程的退出码与输出解释成 CliOutcome，失败时抛 CliFailure。纯函数，便于用样例测试。"""
    argv = tuple(argv)
    payload: Any = None
    text = stdout.strip()
    if text:
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            payload = None
    if not isinstance(payload, dict):
        # 没有 JSON：参数解析失败或连接失败，stderr 才是原因。
        message = stderr.strip() or text or f"exit code {exit_code}"
        raise CliFailure(
            kind=classify_error(message) if exit_code != 2 else CLI_FAILED,
            message=message,
            argv=argv,
            exit_code=exit_code,
            stderr=stderr,
        )
    if payload.get("ok") is True and exit_code == 0:
        return CliOutcome(argv=argv, payload=payload, duration_s=duration_s)
    message = str(payload.get("error") or stderr.strip() or f"exit code {exit_code}")
    raise CliFailure(
        kind=classify_error(message),
        message=message,
        argv=argv,
        exit_code=exit_code,
        payload=payload,
        stderr=stderr,
    )


# 子进程执行函数的形状，与 subprocess.run 的子集一致，测试里可替换。
Runner = Callable[..., subprocess.CompletedProcess[str]]


@dataclass
class CliRunner:
    """调用 2ndscreen CLI。不经 shell、不重试；每次调用都有超时。"""

    binary: str
    timeouts: Mapping[str, float] = field(default_factory=lambda: dict(DEFAULT_TIMEOUTS))
    action_timeout: float = DEFAULT_ACTION_TIMEOUT
    runner: Runner = subprocess.run
    clock: Callable[[], float] = time.monotonic

    def timeout_for(self, args: Sequence[str]) -> float:
        verb = args[0] if args else ""
        return float(self.timeouts.get(verb, self.action_timeout))

    def run(self, args: Sequence[str], timeout: float | None = None) -> CliOutcome:
        argv = (self.binary, *map(str, args))
        limit = self.timeout_for(args) if timeout is None else timeout
        started = self.clock()
        try:
            done = self.runner(
                list(argv),
                capture_output=True,
                text=True,
                timeout=limit,
                check=False,
                shell=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise CliFailure(
                kind=TIMEOUT,
                message=f"{args[0] if args else 'cli'} 超过 {limit:g} 秒未返回",
                argv=argv,
                stderr=_text(exc.stderr),
            ) from None
        except OSError as exc:
            # 可执行文件不存在或无权限执行。
            raise CliFailure(kind=CLI_FAILED, message=f"无法执行 CLI：{exc}", argv=argv) from None
        return interpret(argv, done.returncode, done.stdout or "", done.stderr or "", self.clock() - started)


def _text(value: str | bytes | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return value


# ---- JSON 字段解析（私有数据结构，第 2 阶段由 CliDriver 转成契约类型） ----


@dataclass(frozen=True)
class RawFrame:
    x: float
    y: float
    width: float
    height: float


@dataclass(frozen=True)
class RawElement:
    """CLI ``elements[]`` 中的一项。CLI 不输出 enabled，也不输出 focused/selected。"""

    index: int
    role: str
    label: str | None
    value: str | None
    frame: RawFrame | None
    actions: tuple[str, ...]


@dataclass(frozen=True)
class RawWindow:
    pid: int
    window_id: int
    frame: RawFrame | None
    app: str | None = None
    title: str | None = None


@dataclass(frozen=True)
class RawState:
    app: str | None
    pid: int
    screen: str
    window_id: int
    window_frame: RawFrame | None
    elements: tuple[RawElement, ...]
    tree: str
    screenshot: str | None


def parse_frame(raw: Any) -> RawFrame | None:
    if not isinstance(raw, Mapping):
        return None
    try:
        return RawFrame(float(raw["x"]), float(raw["y"]), float(raw["width"]), float(raw["height"]))
    except (KeyError, TypeError, ValueError):
        return None


def parse_element(raw: Mapping[str, Any]) -> RawElement:
    try:
        index = int(raw["index"])
        role = str(raw["role"])
    except (KeyError, TypeError, ValueError) as exc:
        raise CliFailure(kind=CLI_FAILED, message=f"元素缺少 index/role：{raw!r}") from exc
    label = raw.get("label")
    value = raw.get("value")
    return RawElement(
        index=index,
        role=role,
        label=str(label) if label is not None else None,
        value=str(value) if value is not None else None,
        frame=parse_frame(raw.get("frame")),
        actions=tuple(str(a) for a in raw.get("actions") or ()),
    )


def parse_state(payload: Mapping[str, Any]) -> RawState:
    """解析 ``state`` 的输出。缺少必需字段时抛 CLI_FAILED（CLI 版本不兼容）。"""
    try:
        elements = tuple(parse_element(e) for e in payload["elements"])
        return RawState(
            app=payload.get("app"),
            pid=int(payload["pid"]),
            screen=str(payload["screen"]),
            window_id=int(payload["windowID"]),
            window_frame=parse_frame(payload.get("windowFrame")),
            elements=elements,
            tree=str(payload.get("tree") or ""),
            screenshot=payload.get("screenshot"),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise CliFailure(kind=CLI_FAILED, message=f"state 输出缺少字段：{exc}") from exc


def parse_windows(payload: Mapping[str, Any]) -> tuple[RawWindow, ...]:
    """解析 ``app launch`` / ``window move`` 输出里的 ``windows``。"""
    out = []
    for raw in payload.get("windows") or ():
        try:
            out.append(
                RawWindow(
                    pid=int(raw["pid"]),
                    window_id=int(raw["windowID"]),
                    frame=parse_frame(raw.get("frame")),
                    app=raw.get("app"),
                    title=raw.get("title"),
                )
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise CliFailure(kind=CLI_FAILED, message=f"windows 项缺少字段：{exc}") from exc
    return tuple(out)


def parse_screens(payload: Mapping[str, Any]) -> dict[str, RawFrame | None]:
    """解析 ``screen list``：屏幕名 → 全局坐标框。"""
    return {str(s["name"]): parse_frame(s.get("frame")) for s in payload.get("screens") or () if "name" in s}
