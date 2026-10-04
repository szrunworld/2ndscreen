"""安装与切换模式时的前提检查（方案第三节"系统前提"）。

两种模式都查：
- 2ndscreen 菜单栏应用在运行（CLI 能连上）
- 辅助功能权限、屏幕录制权限（两项权限都属于 2ndscreen 菜单栏应用，因为读树、点击、截图都由它完成）

remote 另查：
- macOS 自动登录到当前用户（`defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser`）
- FileVault 关闭（`fdesetup status`，自动登录的前提）
- 系统休眠关闭（`pmset -g` 当前生效的 `sleep` 为 0）

权限没有查询命令，用无副作用的探测：建一块临时小屏（--ttl 与 --owner-pid 兜底自动销毁），
- 对它执行 `window move --pid <本进程>`：2ndscreen 先检查辅助功能权限再找窗口，本进程没有窗口，
  所以有权限时得到"no matching on-screen window"，没有权限时得到"needs the Accessibility permission"；
- 对它截图（屏上只有空白，不含用户内容）：没有权限时得到"needs the Screen Recording permission"。
探测结束后销毁临时屏、删除截图。

所有 2ndscreen 调用都经过 monitor.driver 的 CliRunner（同一套子进程、超时与错误解析）。
"""

from __future__ import annotations

import getpass
import os
import re
import subprocess
import tempfile
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

from monitor.driver import _cli

from .paths import Mode

Runner = Callable[..., subprocess.CompletedProcess[str]]

NOT_RUNNING_HINT = "is not running"
AX_DENIED = "needs the Accessibility permission"
SR_DENIED = "needs the Screen Recording permission"


@dataclass(frozen=True)
class CheckResult:
    key: str
    title: str
    ok: bool
    detail: str = ""
    fix: str = ""

    def line(self) -> str:
        mark = "✓" if self.ok else "✗"
        text = f"{mark} {self.title}"
        if self.detail:
            text += f"：{self.detail}"
        if not self.ok and self.fix:
            text += f"（处理：{self.fix}）"
        return text


@dataclass(frozen=True)
class PrereqReport:
    mode: Mode
    results: tuple[CheckResult, ...]

    @property
    def ok(self) -> bool:
        return all(r.ok for r in self.results)

    @property
    def missing(self) -> tuple[CheckResult, ...]:
        return tuple(r for r in self.results if not r.ok)

    def render(self) -> str:
        head = f"前提检查（{self.mode} 模式）："
        lines = [head, *("  " + r.line() for r in self.results)]
        if not self.ok:
            lines.append(f"缺少 {len(self.missing)} 项前提，未写入任何状态。")
        return "\n".join(lines)


TITLES = {
    "twondscreen_running": "2ndscreen 菜单栏应用在运行",
    "accessibility": "2ndscreen 已获辅助功能权限",
    "screen_recording": "2ndscreen 已获屏幕录制权限",
    "auto_login": "macOS 自动登录到当前用户",
    "filevault_off": "FileVault 已关闭",
    "sleep_disabled": "系统休眠已关闭（防休眠）",
}


@dataclass
class PrereqChecker:
    cli: _cli.CliRunner
    runner: Runner = subprocess.run
    user: str | None = None
    pid: int | None = None
    tmp_dir: Path | None = None

    def check(self, mode: Mode) -> PrereqReport:
        results: list[CheckResult] = []
        results.extend(self._check_2ndscreen())
        if mode == "remote":
            results.append(self._check_auto_login())
            results.append(self._check_filevault())
            results.append(self._check_sleep())
        return PrereqReport(mode=mode, results=tuple(results))

    # ---- 2ndscreen 与权限 ----

    def _check_2ndscreen(self) -> list[CheckResult]:
        try:
            self.cli.run(["screen", "list"])
        except _cli.CliFailure as exc:
            if NOT_RUNNING_HINT in exc.message:
                fix = "打开 2ndscreen.app（remote 模式由 launchd 拉起）"
            else:
                fix = "确认 2ndscreen CLI 路径（环境变量 MONITOR_2NDSCREEN_CLI）"
            dep = "依赖 2ndscreen 在运行，无法检查"
            return [
                self._fail("twondscreen_running", _short(exc.message), fix),
                self._fail("accessibility", dep, "先启动 2ndscreen"),
                self._fail("screen_recording", dep, "先启动 2ndscreen"),
            ]
        out = [self._pass("twondscreen_running")]
        out.extend(self._probe_permissions())
        return out

    def _probe_permissions(self) -> list[CheckResult]:
        pid = self.pid if self.pid is not None else os.getpid()
        name = f"monitor-probe-{pid}"
        try:
            self.cli.run(
                ["screen", "create", "--name", name, "--size", "800x600", "--no-hidpi", "--ttl", "2m",
                 "--owner-pid", str(pid)]
            )
        except _cli.CliFailure as exc:
            dep = f"无法创建探测屏（{_short(exc.message)}），无法检查"
            fix = "关闭多余的 2ndscreen 屏幕后重试"
            return [self._fail("accessibility", dep, fix), self._fail("screen_recording", dep, fix)]
        try:
            return [self._probe_accessibility(name, pid), self._probe_screen_recording(name)]
        finally:
            try:
                self.cli.run(["screen", "destroy", name])
            except _cli.CliFailure:
                pass  # --ttl 2m 与 --owner-pid 会兜底销毁

    def _probe_accessibility(self, screen: str, pid: int) -> CheckResult:
        fix = "系统设置 → 隐私与安全性 → 辅助功能，勾选 2ndscreen"
        try:
            self.cli.run(["window", "move", "--screen", screen, "--pid", str(pid)])
        except _cli.CliFailure as exc:
            if AX_DENIED in exc.message:
                return self._fail("accessibility", "未授权", fix)
            if exc.kind == _cli.WINDOW_LOST:
                return self._pass("accessibility")
            return self._fail("accessibility", f"无法判断（{_short(exc.message)}）", fix)
        return self._pass("accessibility")

    def _probe_screen_recording(self, screen: str) -> CheckResult:
        fix = "系统设置 → 隐私与安全性 → 屏幕录制，勾选 2ndscreen"
        with tempfile.TemporaryDirectory(dir=self.tmp_dir) as tmp:
            out = Path(tmp) / "probe.png"
            try:
                self.cli.run(["screenshot", "--screen", screen, "--output", str(out)])
            except _cli.CliFailure as exc:
                if SR_DENIED in exc.message:
                    return self._fail("screen_recording", "未授权", fix)
                return self._fail("screen_recording", f"无法判断（{_short(exc.message)}）", fix)
        return self._pass("screen_recording")

    # ---- remote 系统设置 ----

    def _run(self, argv: Sequence[str]) -> subprocess.CompletedProcess[str] | None:
        try:
            return self.runner(list(argv), capture_output=True, text=True, timeout=15, check=False)
        except (OSError, subprocess.TimeoutExpired):
            return None

    def _check_auto_login(self) -> CheckResult:
        fix = "系统设置 → 用户与群组 → 自动以此身份登录，选择当前用户"
        user = self.user or getpass.getuser()
        done = self._run(["defaults", "read", "/Library/Preferences/com.apple.loginwindow", "autoLoginUser"])
        if done is None:
            return self._fail("auto_login", "无法读取登录窗口设置", fix)
        configured = (done.stdout or "").strip()
        if done.returncode != 0 or not configured:
            return self._fail("auto_login", "未开启自动登录", fix)
        if configured != user:
            return self._fail("auto_login", f"自动登录的是另一个用户（{configured}）", fix)
        return self._pass("auto_login", f"自动登录用户 {user}")

    def _check_filevault(self) -> CheckResult:
        fix = "系统设置 → 隐私与安全性 → FileVault，关闭（自动登录要求关闭）"
        done = self._run(["fdesetup", "status"])
        if done is None or done.returncode != 0:
            return self._fail("filevault_off", "无法读取 FileVault 状态", fix)
        text = (done.stdout or "").strip()
        if "FileVault is Off" in text and "progress" not in text.lower():
            return self._pass("filevault_off")
        return self._fail("filevault_off", _short(text) or "未知状态", fix)

    def _check_sleep(self) -> CheckResult:
        fix = "sudo pmset -a sleep 0（或在系统设置 → 能源中关闭自动休眠）"
        done = self._run(["pmset", "-g"])
        if done is None or done.returncode != 0:
            return self._fail("sleep_disabled", "无法读取电源设置", fix)
        m = re.search(r"^\s*sleep\s+(\d+)", done.stdout or "", re.MULTILINE)
        if m is None:
            return self._fail("sleep_disabled", "电源设置里没有 sleep 项", fix)
        minutes = int(m.group(1))
        if minutes != 0:
            return self._fail("sleep_disabled", f"空闲 {minutes} 分钟后休眠", fix)
        return self._pass("sleep_disabled")

    # ----
    def _pass(self, key: str, detail: str = "") -> CheckResult:
        return CheckResult(key=key, title=TITLES[key], ok=True, detail=detail)

    def _fail(self, key: str, detail: str, fix: str) -> CheckResult:
        return CheckResult(key=key, title=TITLES[key], ok=False, detail=detail, fix=fix)


def _short(text: str, n: int = 120) -> str:
    text = " ".join(text.split())
    return text if len(text) <= n else text[: n - 1] + "…"
