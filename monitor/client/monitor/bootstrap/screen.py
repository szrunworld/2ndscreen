"""专用屏幕与窗口归属的 2ndscreen CLI 操作（screen create/list/destroy、app launch、window move/release）。

全部经过 monitor.driver 的 CliRunner（同一套子进程、超时、JSON 与错误文案解析），不另写解析。
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

from monitor_contracts import WindowSelector

from monitor.driver import _cli
from monitor.driver.cli_driver import default_pid_resolver

ALREADY_RUNNING = "is already running"
WINDOW_REFUSED = "refused to move"
# window release 在窗口已不在本屏时的文案（AgentScreens.releaseWindows）；driver 的分类表没有收录，在这里识别
RELEASE_GONE = "has no matching window on screen"


class AppAlreadyRunning(Exception):
    """app launch 被拒：应用已在运行（应改用 window move）。"""


@dataclass
class ScreenOps:
    cli: _cli.CliRunner
    screen: str
    owner_pid: int
    size: str | None = None
    pid_resolver: Callable[[WindowSelector], list[int]] = field(default=default_pid_resolver)

    # ---- 屏幕 ----

    def screen_exists(self) -> bool:
        payload = self.cli.run(["screen", "list"]).payload
        return self.screen in _cli.parse_screens(payload)

    def ensure_screen(self) -> bool:
        """屏幕不存在时创建。返回是否新建。

        --idle-timeout 0：暂停期间没人读屏也不被回收；--owner-pid：Monitor 退出（含崩溃）后
        2ndscreen 自动销毁这块屏，窗口回到主屏，local 模式下用户不会丢窗口。
        """
        if self.screen_exists():
            return False
        args = ["screen", "create", "--name", self.screen, "--idle-timeout", "0", "--owner-pid", str(self.owner_pid)]
        if self.size:
            args += ["--size", self.size]
        self.cli.run(args)
        return True

    def destroy_screen(self) -> None:
        try:
            self.cli.run(["screen", "destroy", self.screen])
        except _cli.CliFailure as exc:
            if exc.kind != _cli.SCREEN_LOST:  # 已经不在了不算失败
                raise

    # ---- 应用与窗口 ----

    def find_pids(self, bundle_id: str) -> list[int]:
        return self.pid_resolver(WindowSelector(bundle_id=bundle_id))

    def launch(self, bundle_id: str) -> int:
        """在专用屏幕上启动应用（不激活），返回 pid。

        应用拒绝 --fill 调整尺寸时 CLI 返回 ok=false 但窗口已在屏上（C 的发现 6），此时接受。
        """
        try:
            payload = self.cli.run(["app", "launch", "--screen", self.screen, "--bundle", bundle_id, "--fill"]).payload
        except _cli.CliFailure as exc:
            if ALREADY_RUNNING in exc.message:
                raise AppAlreadyRunning(exc.message) from None
            payload = exc.payload or {}
            if not (WINDOW_REFUSED in exc.message and payload.get("pid") and _cli.parse_windows(payload)):
                raise
        pid = payload.get("pid")
        if not isinstance(pid, int):
            raise _cli.CliFailure(kind=_cli.CLI_FAILED, message="app launch 输出缺少 pid")
        return pid

    def move(self, pid: int, *, fill: bool = False, fit: bool = False) -> tuple[_cli.RawWindow, ...]:
        args = ["window", "move", "--screen", self.screen, "--pid", str(pid)]
        if fill:
            args.append("--fill")
        elif fit:
            args.append("--fit-screen")
        try:
            payload = self.cli.run(args).payload
        except _cli.CliFailure as exc:
            payload = exc.payload or {}
            windows = _cli.parse_windows(payload)
            if WINDOW_REFUSED in exc.message and windows:
                return windows  # 窗口到屏上了，只是拒绝改尺寸
            raise
        return _cli.parse_windows(payload)

    def release(self, pid: int) -> None:
        """把应用在专用屏上的窗口还给主屏，并停止跟随。窗口已不在本屏时视为成功。"""
        try:
            self.cli.run(["window", "release", "--screen", self.screen, "--pid", str(pid)])
        except _cli.CliFailure as exc:
            if exc.kind in (_cli.WINDOW_LOST, _cli.SCREEN_LOST) or RELEASE_GONE in exc.message:
                return
            raise
