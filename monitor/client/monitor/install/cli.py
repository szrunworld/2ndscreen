"""`python -m monitor.install install|mode`：安装（注册设备）与切换运行模式。

    install  [--mode local|remote] [--server URL] [--enrollment-code CODE] [--device-name NAME]
             [--console-url URL] [--screen NAME] [--reinstall]
    mode     local|remote

缺参数且在终端里运行时交互询问；非交互运行时缺参数直接退出码 2。

退出码：0 成功；1 前提不满足（列出全部缺项，不写任何状态）；2 参数或环境错误；3 注册或令牌保存失败。

写入顺序（只有前提全部满足后才开始写）：POST /devices → 令牌（keychain，退回 0600 文件）
→ install_config.json → 账本 monitor_state.mode。
"""

from __future__ import annotations

import argparse
import socket
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, TextIO

import httpx

from monitor.driver import _cli

from .paths import InstallConfig, Mode, MonitorPaths, load_config, save_config
from .prereq import PrereqChecker, PrereqReport
from .register import RegistrationError, build_registration, detect_capabilities, register_device
from .secrets import FileStore, KeychainStore, TokenStoreError, save_token

EXIT_OK = 0
EXIT_PREREQ = 1
EXIT_USAGE = 2
EXIT_REGISTER = 3


def _default_checker(cli_binary: str) -> PrereqChecker:
    return PrereqChecker(cli=_cli.CliRunner(cli_binary))


def _default_ledger(path: Path) -> Any:
    from monitor.ledger import open_ledger

    return open_ledger(path)


def _default_cli_binary() -> str:
    from monitor.driver.cli_driver import DEFAULT_BINARY

    return DEFAULT_BINARY


@dataclass
class InstallEnv:
    """安装命令的全部外部依赖；测试注入临时 HOME、fake CLI、fake keychain、MockTransport。"""

    paths: MonitorPaths
    checker_factory: Callable[[str], PrereqChecker] = _default_checker
    ledger_factory: Callable[[Path], Any] = _default_ledger
    keychain: KeychainStore | None = field(default_factory=KeychainStore)
    transport: httpx.BaseTransport | None = None
    stdin: TextIO = field(default_factory=lambda: sys.stdin)
    stdout: TextIO = field(default_factory=lambda: sys.stdout)
    stderr: TextIO = field(default_factory=lambda: sys.stderr)
    interactive: bool | None = None
    capabilities: Callable[[Mode], list[str]] = detect_capabilities
    now: Callable[[], datetime] = lambda: datetime.now(UTC)
    hostname: Callable[[], str] = socket.gethostname

    def is_interactive(self) -> bool:
        if self.interactive is not None:
            return self.interactive
        try:
            return self.stdin.isatty()
        except (AttributeError, ValueError):
            return False

    def say(self, text: str) -> None:
        print(text, file=self.stdout)

    def err(self, text: str) -> None:
        print(f"monitor install: {text}", file=self.stderr)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="monitor", description="招聘 Monitor 安装与模式切换")
    sub = p.add_subparsers(dest="command", required=True)
    i = sub.add_parser("install", help="检查前提、注册设备、写入模式")
    i.add_argument("--mode", choices=["local", "remote"])
    i.add_argument("--server", help="服务端基础地址，如 https://host/api/v1")
    i.add_argument("--enrollment-code", help="控制台生成的一次性注册码")
    i.add_argument("--device-name", help="设备名（默认主机名）")
    i.add_argument("--console-url", help="控制台地址（状态窗口『打开控制台』用；默认由服务端地址推导）")
    i.add_argument("--screen", default="monitor", help="2ndscreen 专用屏幕名")
    i.add_argument("--cli", dest="cli_binary", help="2ndscreen CLI 路径（默认 MONITOR_2NDSCREEN_CLI 或 PATH）")
    i.add_argument("--reinstall", action="store_true", help="已安装时重新注册（旧令牌作废需在控制台吊销）")
    i.add_argument("--allow-insecure-http", action="store_true", help=argparse.SUPPRESS)  # 仅本地联调
    m = sub.add_parser("mode", help="切换运行模式（重跑前提检查）")
    m.add_argument("mode", choices=["local", "remote"])
    m.add_argument("--cli", dest="cli_binary")
    return p


def _ask(env: InstallEnv, prompt: str, *, choices: Sequence[str] | None = None, default: str | None = None) -> str:
    while True:
        suffix = f" [{'/'.join(choices)}]" if choices else ""
        if default:
            suffix += f"（默认 {default}）"
        env.stdout.write(f"{prompt}{suffix}: ")
        env.stdout.flush()
        line = env.stdin.readline()
        if line == "":
            raise EOFError
        answer = line.strip() or (default or "")
        if not answer:
            continue
        if choices and answer not in choices:
            env.say(f"请输入 {' 或 '.join(choices)}")
            continue
        return answer


def derive_console_url(server_url: str) -> str:
    """https://host/api/v1 → https://host/"""
    parsed = httpx.URL(server_url)
    return str(parsed.copy_with(path="/", query=None, fragment=None))


def cmd_install(args: argparse.Namespace, env: InstallEnv) -> int:
    paths = env.paths
    try:
        existing = load_config(paths)
    except ValueError as exc:
        env.err(f"现有安装配置损坏：{exc}；确认后用 --reinstall 覆盖")
        if not args.reinstall:
            return EXIT_USAGE
        existing = None
    if existing is not None and not args.reinstall:
        env.err(f"本机已安装（设备 {existing.device_id}，{existing.mode} 模式）。切换模式用 `mode`，重新注册用 --reinstall")
        return EXIT_USAGE

    # 1. 收集参数（缺省时交互询问）
    mode, server, code, name = args.mode, args.server, args.enrollment_code, args.device_name
    try:
        if env.is_interactive():
            if mode is None:
                env.say("local：在你自己的 Mac 上，Monitor 在工作时段接管你的 BOSS 窗口；")
                env.say("remote：专用 Mac 无人值守，开机自动登录并由 Monitor 启动 BOSS。")
                mode = _ask(env, "选择运行模式", choices=["local", "remote"], default="local")
            server = server or _ask(env, "服务端地址")
            code = code or _ask(env, "注册码（控制台『连接设备』页生成）")
            name = name or _ask(env, "设备名", default=env.hostname()[:64] or "mac")
    except EOFError:
        env.err("输入中断")
        return EXIT_USAGE
    missing = [flag for flag, v in (("--mode", mode), ("--server", server), ("--enrollment-code", code)) if not v]
    if missing:
        env.err(f"非交互运行缺少参数：{' '.join(missing)}")
        return EXIT_USAGE
    name = (name or env.hostname() or "mac")[:64]
    assert mode in ("local", "remote")
    if not server.startswith("https://") and not args.allow_insecure_http:
        env.err("服务端只接受 HTTPS 地址")
        return EXIT_USAGE
    cli_binary = args.cli_binary or _default_cli_binary()

    # 2. 前提检查：不满足则列出全部缺项、退出非零、不写任何状态
    report = env.checker_factory(cli_binary).check(mode)  # type: ignore[arg-type]
    env.say(report.render())
    if not report.ok:
        return EXIT_PREREQ

    # 3. 注册
    try:
        body = build_registration(
            enrollment_code=code, device_name=name, mode=mode, capabilities=env.capabilities(mode)  # type: ignore[arg-type]
        )
    except ValueError as exc:  # ContractValidationError 是 ValueError 子类
        env.err(f"注册信息不合契约：{exc}")
        return EXIT_USAGE
    try:
        reg = register_device(server, body, transport=env.transport, allow_insecure_http=args.allow_insecure_http)
    except RegistrationError as exc:
        env.err(str(exc))
        return EXIT_REGISTER

    # 4. 令牌 → 配置 → 模式
    try:
        paths.ensure_app_dir()
        store = save_token(reg.device_id, reg.device_token, keychain=env.keychain, file_store=FileStore(paths.token_file))
    except (TokenStoreError, OSError) as exc:
        env.err(f"设备 {reg.device_id} 已注册，但令牌保存失败：{exc}。请在控制台吊销该设备后重新安装")
        return EXIT_REGISTER
    config = InstallConfig(
        server_url=server,
        device_id=reg.device_id,
        device_name=name,
        mode=mode,  # type: ignore[arg-type]
        token_store=store.kind,
        screen=args.screen,
        console_url=args.console_url or derive_console_url(server),
        cli_binary=args.cli_binary,
        installed_at=env.now().isoformat(),
    )
    save_config(paths, config)
    _write_mode(env, mode)  # type: ignore[arg-type]
    env.say(f"已注册设备 {reg.device_id}（{mode} 模式），令牌存放于 {'keychain' if store.kind == 'keychain' else paths.token_file}。")
    env.say("下一步：在控制台为这台设备确认绑定的招聘账户。")
    if mode == "remote":
        env.say("然后运行 monitor/launchd/install.sh remote 安装开机自启。")
    else:
        env.say("可选：运行 monitor/launchd/install.sh local 让 Monitor 随登录启动。")
    return EXIT_OK


def _write_mode(env: InstallEnv, mode: Mode) -> None:
    ledger = env.ledger_factory(env.paths.ledger)
    try:
        state = ledger.load_state()
        state.mode = mode
        ledger.save_state(state)
    finally:
        close = getattr(ledger, "close", None)
        if callable(close):
            close()


def read_mode(env: InstallEnv) -> Mode | None:
    ledger = env.ledger_factory(env.paths.ledger)
    try:
        return ledger.load_state().mode
    finally:
        close = getattr(ledger, "close", None)
        if callable(close):
            close()


def cmd_mode(args: argparse.Namespace, env: InstallEnv) -> int:
    try:
        config = load_config(env.paths)
    except ValueError as exc:
        env.err(str(exc))
        return EXIT_USAGE
    if config is None:
        env.err("本机尚未安装，先运行 install")
        return EXIT_USAGE
    target: Mode = args.mode
    cli_binary = args.cli_binary or config.cli_binary or _default_cli_binary()
    report: PrereqReport = env.checker_factory(cli_binary).check(target)
    env.say(report.render())
    if not report.ok:
        return EXIT_PREREQ
    previous = read_mode(env)
    _write_mode(env, target)
    config.mode = target
    save_config(env.paths, config)
    env.say(f"模式：{previous or config.mode} → {target}。服务端从下一次心跳得知新模式。")
    if target == "remote":
        env.say("请运行 monitor/launchd/install.sh remote 安装开机自启，并重启 Monitor。")
    else:
        env.say("如已安装 remote 的开机自启，可运行 monitor/launchd/uninstall.sh 移除后再按需安装 local。")
    return EXIT_OK


def main(argv: Sequence[str] | None = None, env: InstallEnv | None = None) -> int:
    args = build_parser().parse_args(argv)
    if env is None:
        try:
            env = InstallEnv(paths=MonitorPaths.from_env())
        except ValueError as exc:
            print(f"monitor install: {exc}", file=sys.stderr)
            return EXIT_USAGE
    if args.command == "install":
        return cmd_install(args, env)
    return cmd_mode(args, env)
