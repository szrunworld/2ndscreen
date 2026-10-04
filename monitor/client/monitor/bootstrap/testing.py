"""测试替身：fake 2ndscreen CLI（替换 CliRunner 的子进程）、fake caffeinate、fake keychain。

不调用真实 2ndscreen、不碰用户窗口；任务 M 的集成测试也可复用。
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from monitor.driver import _cli

Reply = tuple[int, Any, str]  # (exit_code, stdout JSON 对象或 None, stderr)


def ok(**payload: Any) -> Reply:
    return 0, {"ok": True, **payload}, ""


def fail(error: str, **payload: Any) -> Reply:
    return 1, {"ok": False, "error": error, **payload}, ""


def screen_info(name: str) -> dict[str, Any]:
    return {"name": name, "kind": "agent", "displayID": 400, "width": 1280, "height": 800, "hiDPI": True,
            "frame": {"x": 4800, "y": 0, "width": 1280, "height": 800}}


def window_info(pid: int, wid: int = 9001) -> dict[str, Any]:
    return {"pid": pid, "windowID": wid, "app": "BOSS直聘", "title": "BOSS直聘",
            "frame": {"x": 4800, "y": 25, "width": 1280, "height": 775}}


@dataclass
class FakeCli:
    """按动词（如 "screen create"、"window move"）应答。

    responses[verb] 是一个列表时按次序弹出（最后一个重复使用），也可以是 callable(argv) -> Reply。
    默认行为模拟一个健康的 2ndscreen：屏幕按创建/销毁维护，launch/move 成功。
    """

    responses: dict[str, Any] = field(default_factory=dict)
    calls: list[tuple[str, ...]] = field(default_factory=list)
    screens: set[str] = field(default_factory=set)
    launch_pid: int = 4242

    def verbs(self) -> list[str]:
        return [_verb(c) for c in self.calls]

    def count(self, verb: str) -> int:
        return sum(1 for c in self.calls if _verb(c) == verb)

    def __call__(self, argv: Sequence[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        args = tuple(argv[1:])
        self.calls.append(args)
        verb = _verb(args)
        spec = self.responses.get(verb)
        if callable(spec):
            reply = spec(args)
        elif isinstance(spec, list) and spec:
            reply = spec.pop(0) if len(spec) > 1 else spec[0]
        elif spec is not None:
            reply = spec
        else:
            reply = self._default(verb, args)
        code, out, err = reply
        stdout = json.dumps(out) if out is not None else ""
        return subprocess.CompletedProcess(list(argv), code, stdout, err)

    def _default(self, verb: str, args: tuple[str, ...]) -> Reply:
        if verb == "screen list":
            return ok(screens=[screen_info(s) for s in sorted(self.screens)])
        if verb == "screen create":
            name = args[args.index("--name") + 1]
            self.screens.add(name)
            return ok(screen=screen_info(name))
        if verb == "screen destroy":
            name = args[2]
            if name not in self.screens:
                return fail(f'no agent screen named "{name}"')
            self.screens.discard(name)
            return ok()
        if verb == "app launch":
            return ok(pid=self.launch_pid, windows=[window_info(self.launch_pid)])
        if verb == "window move":
            pid = int(args[args.index("--pid") + 1])
            return ok(windows=[window_info(pid)])
        if verb == "window release":
            return ok(pid=int(args[args.index("--pid") + 1]), windows=[])
        if verb == "screenshot":
            return ok(output=args[args.index("--output") + 1])
        return fail(f"FakeCli 没有为 {verb!r} 配置应答")

    def runner(self, binary: str = "2ndscreen") -> _cli.CliRunner:
        return _cli.CliRunner(binary, runner=self)


def _verb(args: Sequence[str]) -> str:
    return " ".join(args[:2]) if args and args[0] in ("screen", "app", "window") else (args[0] if args else "")


@dataclass
class FakeProc:
    argv: list[str]
    returncode: int | None = None
    terminated: bool = False

    def poll(self) -> int | None:
        return self.returncode

    def terminate(self) -> None:
        self.terminated = True
        self.returncode = -15

    def kill(self) -> None:
        self.returncode = -9

    def wait(self, timeout: float | None = None) -> int:
        return self.returncode if self.returncode is not None else 0


@dataclass
class FakePopen:
    procs: list[FakeProc] = field(default_factory=list)
    fail_with: BaseException | None = None

    def __call__(self, argv: list[str], **kwargs: Any) -> FakeProc:
        if self.fail_with is not None:
            raise self.fail_with
        p = FakeProc(list(argv))
        self.procs.append(p)
        return p


@dataclass
class FakeKeychain:
    """KeychainStore 的替身（同样的方法），不碰真实钥匙串。"""

    items: dict[str, str] = field(default_factory=dict)
    is_available: bool = True
    fail_save: bool = False
    kind: str = "keychain"

    def available(self) -> bool:
        return self.is_available

    def save(self, device_id: str, token: str) -> None:
        from monitor.install.secrets import TokenStoreError

        if self.fail_save:
            raise TokenStoreError("模拟 keychain 写入失败")
        self.items[device_id] = token

    def load(self, device_id: str) -> str:
        from monitor.install.secrets import TokenStoreError

        try:
            return self.items[device_id]
        except KeyError:
            raise TokenStoreError("keychain 中没有本设备的令牌") from None

    def delete(self, device_id: str) -> None:
        self.items.pop(device_id, None)


def subprocess_table(table: dict[tuple[str, ...], tuple[int, str]]) -> Callable[..., subprocess.CompletedProcess[str]]:
    """系统命令替身：按 argv 前缀查表返回 (exit_code, stdout)；没配置的命令返回 127。"""

    def run(argv: Sequence[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        for prefix, (code, out) in table.items():
            if tuple(argv[: len(prefix)]) == prefix:
                return subprocess.CompletedProcess(list(argv), code, out, "")
        return subprocess.CompletedProcess(list(argv), 127, "", "not configured")

    return run
