"""服务端正式入口 `python -m app.main serve`：读取部署配置（令牌、Webhook）并启动 uvicorn（缺陷 M-4）。

令牌只从环境变量、令牌文件或命令行参数读，不写进仓库；日志与报错里只出现操作者名和个数，不出现令牌本身。

    MONITOR_CONSOLE_TOKENS="令牌=操作者[,令牌=操作者...]"   # 控制台会话令牌，至少一个
    MONITOR_SERVICE_TOKENS="令牌=服务名[,...]"              # 内部服务（邮件接入）令牌，可省略
    MONITOR_WEBHOOK_URL / MONITOR_WEBHOOK_SECRET            # 待办通知 Webhook，可省略

    uv run python -m app.main serve --db /path/server.db [--host 127.0.0.1] [--port 8000]
        [--console-tokens-file 文件] [--service-tokens-file 文件]
        [--console-token 令牌=操作者 ...] [--service-token 令牌=服务名 ...]

令牌文件每行一个 `令牌=操作者`（也可逗号分隔），`#` 开头为注释；适合放在 0600 文件或 secret 挂载里。
命令行上的令牌会出现在 `ps` 输出里，只用于本地调试；部署用环境变量或令牌文件。
多个来源合并；同一令牌在不同来源对应不同操作者时拒绝启动。

只监听 HTTP，对外必须放在 HTTPS 反向代理后面（Monitor 只接受 https 地址）。
启动完成（含 lifespan 里编排的后台推进）后在 stderr 打印一行 `monitor-server ready <url>`，供脚本按事件等待。
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

CONSOLE_TOKENS_ENV = "MONITOR_CONSOLE_TOKENS"
SERVICE_TOKENS_ENV = "MONITOR_SERVICE_TOKENS"
WEBHOOK_URL_ENV = "MONITOR_WEBHOOK_URL"
WEBHOOK_SECRET_ENV = "MONITOR_WEBHOOK_SECRET"

MIN_TOKEN_LENGTH = 16  # 令牌太短容易被猜中
MAX_ACTOR_LENGTH = 128  # 操作者名会写进绑定记录 confirmed_by（契约 heartbeat_ack 上限 128）


class ConfigError(ValueError):
    """配置错误。消息里不含令牌。"""


@dataclass(frozen=True)
class ServeConfig:
    db: str
    host: str
    port: int
    console_tokens: dict[str, str]
    service_tokens: dict[str, str]
    webhook_url: str | None = None
    webhook_secret: str | None = None

    def __repr__(self) -> str:  # 令牌与密钥不进 repr
        return (
            f"ServeConfig(db={self.db!r}, host={self.host!r}, port={self.port}, "
            f"console={sorted(set(self.console_tokens.values()))}, service={sorted(set(self.service_tokens.values()))}, "
            f"webhook={'on' if self.webhook_url else 'off'})"
        )

    def summary(self) -> str:
        """启动日志用的一行摘要：只有操作者名与个数。"""
        return (
            f"控制台令牌 {len(self.console_tokens)} 个（{', '.join(sorted(set(self.console_tokens.values())))}），"
            f"服务令牌 {len(self.service_tokens)} 个，Webhook {'开启' if self.webhook_url else '关闭'}"
        )


def parse_tokens(text: str | None, source: str) -> dict[str, str]:
    """解析 `令牌=操作者` 列表（逗号或换行分隔，`#` 开头的行是注释）。"""
    out: dict[str, str] = {}
    for line in (text or "").splitlines():
        if line.strip().startswith("#"):
            continue
        for part in line.split(","):
            part = part.strip()
            if not part:
                continue
            token, sep, actor = part.partition("=")
            token, actor = token.strip(), actor.strip()
            if not sep or not token or not actor:
                raise ConfigError(f"{source}：令牌格式应为 令牌=操作者")
            if len(token) < MIN_TOKEN_LENGTH:
                raise ConfigError(f"{source}：操作者 {actor} 的令牌太短（至少 {MIN_TOKEN_LENGTH} 个字符）")
            if len(actor) > MAX_ACTOR_LENGTH:
                raise ConfigError(f"{source}：操作者名超过 {MAX_ACTOR_LENGTH} 个字符")
            _put(out, token, actor, source)
    return out


def _put(out: dict[str, str], token: str, actor: str, source: str) -> None:
    if out.get(token, actor) != actor:
        raise ConfigError(f"{source}：同一令牌对应了不同操作者（{out[token]}、{actor}）")
    out[token] = actor


def _merge(sources: list[tuple[str, dict[str, str]]]) -> dict[str, str]:
    out: dict[str, str] = {}
    for source, tokens in sources:
        for token, actor in tokens.items():
            _put(out, token, actor, source)
    return out


def _read_file(path: str, source: str) -> str:
    try:
        return Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"{source}：读不到令牌文件 {path}（{exc.strerror}）") from None


def _collect(environ: Mapping[str, str], env: str, file: str | None, cli: list[str], kind: str) -> dict[str, str]:
    """一类令牌的三个来源：环境变量、令牌文件、命令行。"""
    sources = [(env, parse_tokens(environ.get(env), env))]
    if file:
        flag = f"--{kind}-tokens-file"
        sources.append((flag, parse_tokens(_read_file(file, flag), flag)))
    sources.append((f"--{kind}-token", parse_tokens("\n".join(cli), f"--{kind}-token")))
    return _merge(sources)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m app.main serve", description="启动 Monitor 服务端")
    p.add_argument("--db", default="monitor_server.db", help="SQLite 数据库文件")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000, help="0 表示由系统分配")
    p.add_argument("--console-tokens-file", help="控制台令牌文件（每行 令牌=操作者）")
    p.add_argument("--service-tokens-file", help="服务令牌文件（每行 令牌=服务名）")
    p.add_argument(
        "--console-token", action="append", default=[], metavar="令牌=操作者", help="可重复；会出现在 ps 里，仅调试用"
    )
    p.add_argument(
        "--service-token", action="append", default=[], metavar="令牌=服务名", help="可重复；会出现在 ps 里，仅调试用"
    )
    return p


def load_config(argv: list[str], environ: Mapping[str, str]) -> ServeConfig:
    """合并命令行、令牌文件与环境变量。没有任何控制台令牌时报错（否则控制台接口全部 401）。"""
    args = build_parser().parse_args(argv)
    console = _collect(environ, CONSOLE_TOKENS_ENV, args.console_tokens_file, args.console_token, "console")
    service = _collect(environ, SERVICE_TOKENS_ENV, args.service_tokens_file, args.service_token, "service")
    if not console:
        raise ConfigError(
            f"没有控制台令牌：请设置环境变量 {CONSOLE_TOKENS_ENV}，或用 --console-tokens-file / --console-token"
        )
    if set(console) & set(service):
        raise ConfigError("同一令牌不能同时作控制台令牌和服务令牌")
    webhook_url = (environ.get(WEBHOOK_URL_ENV) or "").strip() or None
    webhook_secret = environ.get(WEBHOOK_SECRET_ENV) or None
    if webhook_secret and not webhook_url:
        raise ConfigError(f"设置了 {WEBHOOK_SECRET_ENV} 但没有 {WEBHOOK_URL_ENV}")
    return ServeConfig(
        db=args.db,
        host=args.host,
        port=args.port,
        console_tokens=console,
        service_tokens=service,
        webhook_url=webhook_url,
        webhook_secret=webhook_secret,
    )


def build_app(config: ServeConfig, **overrides: Any):
    """按配置装配应用（测试可用 overrides 注入时钟等）。"""
    from .db import SqliteStore
    from .main import StaticTokenAuthenticator, create_app
    from .notify import WebhookNotifier

    notifiers = [WebhookNotifier(config.webhook_url, secret=config.webhook_secret)] if config.webhook_url else None
    kwargs: dict[str, Any] = {
        "store": SqliteStore(config.db),
        "console_auth": StaticTokenAuthenticator(config.console_tokens),
        "service_auth": StaticTokenAuthenticator(config.service_tokens),
        "notifiers": notifiers,
    }
    kwargs.update(overrides)
    return create_app(**kwargs)


def run(config: ServeConfig) -> None:
    """先绑定端口（--port 0 时由系统分配），uvicorn 启动完成后打印就绪行。"""
    import asyncio
    import socket

    import uvicorn

    app = build_app(config)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((config.host, config.port))
    host, port = sock.getsockname()[:2]
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning"))

    async def serve() -> None:
        async def announce() -> None:
            # 等 uvicorn 完成启动（含 lifespan）再报就绪；按状态轮询，不是固定等待
            while not server.started and not server.should_exit:
                await asyncio.sleep(0.02)
            if server.started:
                print(f"monitor-server ready http://{host}:{port}/api/v1", file=sys.stderr, flush=True)

        await asyncio.gather(server.serve(sockets=[sock]), announce())

    print(f"monitor-server {config.summary()}", file=sys.stderr, flush=True)
    asyncio.run(serve())


def main(argv: list[str], environ: Mapping[str, str]) -> int:
    try:
        config = load_config(argv, environ)
    except ConfigError as exc:
        print(f"serve: {exc}", file=sys.stderr)
        return 2
    run(config)
    return 0


__all__ = ["ConfigError", "ServeConfig", "build_app", "load_config", "main", "parse_tokens", "run"]
