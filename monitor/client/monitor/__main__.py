"""`python -m monitor`：只做参数解析与装配，业务行为全部在 monitor.core。

其他模块按"模块:工厂"注入，默认值是各任务约定的入口（见 docs/monitor/agent-reports/D2.md）：

    --ledger    monitor.ledger:open_ledger         f(path: Path) -> Ledger
    --observer  monitor.observe:create_observer    f() -> Observer；传 none 表示不观察
    --handlers  monitor.actions:create_handlers    f() -> Iterable[ActionHandler]
    Driver      monitor.driver.CliDriver(screen)

设备令牌从 --token-file（权限必须是 0600 或更严）或环境变量 MONITOR_DEVICE_TOKEN 读取，不接受命令行明文。
"""

from __future__ import annotations

import argparse
import importlib
import os
import signal
import stat
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from monitor_contracts import OUTWARD_ACTIONS

TOKEN_ENV = "MONITOR_DEVICE_TOKEN"
DEFAULT_LEDGER = "monitor.ledger:open_ledger"
DEFAULT_OBSERVER = "monitor.observe:create_observer"
DEFAULT_HANDLERS = "monitor.actions:create_handlers"


class SetupError(Exception):
    """装配失败：参数、令牌或依赖模块有问题。退出码 2。"""


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="monitor", description="招聘 Monitor 本机常驻进程")
    p.add_argument("--server-url", required=True, help="服务端基础地址，如 https://host/api/v1（只接受 https）")
    p.add_argument("--device-id", required=True)
    p.add_argument("--token-file", type=Path, help="设备令牌文件（0600）；缺省读环境变量 " + TOKEN_ENV)
    p.add_argument("--db", type=Path, required=True, help="本地 SQLite 账本路径")
    p.add_argument("--mode", choices=["local", "remote"], default="local")
    p.add_argument("--screen", default="monitor", help="2ndscreen 专用屏幕名")
    p.add_argument("--heartbeat-interval", type=float, default=30.0)
    p.add_argument("--observe-interval", type=float, default=45.0, help="观察周期（秒），默认 45")
    p.add_argument(
        "--allow-action",
        action="append",
        choices=sorted(OUTWARD_ACTIONS),
        help="本地白名单（可重复）；缺省允许全部，实际是否执行仍由策略白名单决定",
    )
    p.add_argument("--ledger", default=DEFAULT_LEDGER, metavar="MODULE:FACTORY")
    p.add_argument("--observer", default=DEFAULT_OBSERVER, metavar="MODULE:FACTORY|none")
    p.add_argument("--handlers", default=DEFAULT_HANDLERS, metavar="MODULE:FACTORY")
    p.add_argument("--allow-insecure-http", action="store_true", help=argparse.SUPPRESS)  # 仅本地联调
    return p


def load_factory(spec: str) -> Callable[..., Any]:
    """解析 "包.模块:属性"。"""
    mod_name, sep, attr = spec.partition(":")
    if not sep or not mod_name or not attr:
        raise SetupError(f"工厂写法应为 模块:属性，收到 {spec!r}")
    try:
        mod = importlib.import_module(mod_name)
    except ImportError as exc:
        raise SetupError(f"无法导入 {mod_name}（{exc}）；该模块可能尚未合并") from exc
    try:
        return getattr(mod, attr)
    except AttributeError:
        raise SetupError(f"{mod_name} 中没有 {attr}") from None


def read_token(token_file: Path | None, env: dict[str, str]) -> str:
    if token_file is not None:
        try:
            st = token_file.stat()
        except FileNotFoundError:
            raise SetupError(f"令牌文件不存在: {token_file}") from None
        if st.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
            raise SetupError(f"令牌文件权限过宽（{oct(st.st_mode & 0o777)}），应为 0600")
        token = token_file.read_text(encoding="utf-8").strip()
    else:
        token = env.get(TOKEN_ENV, "").strip()
    if not token:
        raise SetupError(f"没有设备令牌：请提供 --token-file 或环境变量 {TOKEN_ENV}")
    return token


def assemble(args: argparse.Namespace, *, env: dict[str, str] | None = None, transport: Any = None) -> Any:
    """按参数装配 MonitorRuntime（不启动）。transport 仅供测试注入。"""
    from monitor.core import CommandClient, MonitorRuntime, RuntimeConfig, SystemClock

    if not args.server_url.startswith("https://") and not args.allow_insecure_http:
        raise SetupError("服务端只接受 HTTPS 地址")
    token = read_token(args.token_file, dict(os.environ) if env is None else env)
    clock = SystemClock()
    ledger = load_factory(args.ledger)(args.db)
    observer = None if args.observer == "none" else load_factory(args.observer)()
    handlers = {h.action: h for h in load_factory(args.handlers)()}
    driver = _make_driver(args)
    client = CommandClient(
        base_url=args.server_url, device_id=args.device_id, token=token, transport=transport, now=clock.now
    )
    config = RuntimeConfig(
        device_id=args.device_id,
        mode=args.mode,
        heartbeat_interval=args.heartbeat_interval,
        observe_interval=args.observe_interval,
        local_allowed_actions=frozenset(args.allow_action) if args.allow_action else frozenset(OUTWARD_ACTIONS),
    )
    return MonitorRuntime(
        config=config, ledger=ledger, driver=driver, client=client, handlers=handlers, clock=clock, observer=observer
    )


def _make_driver(args: argparse.Namespace) -> Any:
    from monitor.driver import CliDriver

    return CliDriver(args.screen)


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        runtime = assemble(args)
    except (SetupError, ValueError) as exc:
        print(f"monitor: {exc}", file=sys.stderr)
        return 2
    signal.signal(signal.SIGTERM, lambda *_: runtime.stop())
    signal.signal(signal.SIGINT, lambda *_: runtime.stop())
    runtime.run_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
