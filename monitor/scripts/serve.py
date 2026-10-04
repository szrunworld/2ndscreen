"""本地 / 测试环境启动 Monitor 服务端（带控制台与服务令牌）。

`python -m app.main serve` 不能配置控制台、服务令牌（create_app 默认的 StaticTokenAuthenticator 为空，
任何控制台接口都返回 401，连注册码都生成不了，见 M 报告缺陷 M-4）。在服务端提供正式配置之前，
联调与真机验收用本脚本：令牌从环境变量读，不出现在命令行参数里。

    MONITOR_CONSOLE_TOKENS="令牌=操作者[,令牌=操作者...]"
    MONITOR_SERVICE_TOKENS="令牌=服务名[,...]"        # 邮件接入用，可省略
    uv run python scripts/serve.py --db /path/server.db [--host 127.0.0.1] [--port 8000]

只监听 HTTP；对外必须放在 HTTPS 反向代理后面（Monitor 只接受 https 地址）。
启动成功后在 stderr 打印一行 `monitor-server ready <url>`，供脚本按事件等待。
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys


def parse_tokens(text: str | None) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in (text or "").split(","):
        part = part.strip()
        if not part:
            continue
        token, sep, actor = part.partition("=")
        if not sep or not token or not actor:
            raise ValueError("令牌格式应为 令牌=操作者")
        out[token.strip()] = actor.strip()
    return out


def build_app(db: str):
    from app.db import SqliteStore
    from app.main import StaticTokenAuthenticator, create_app

    console = parse_tokens(os.environ.get("MONITOR_CONSOLE_TOKENS"))
    if not console:
        raise ValueError("没有控制台令牌：请设置环境变量 MONITOR_CONSOLE_TOKENS")
    service = parse_tokens(os.environ.get("MONITOR_SERVICE_TOKENS"))
    return create_app(
        store=SqliteStore(db),
        console_auth=StaticTokenAuthenticator(console),
        service_auth=StaticTokenAuthenticator(service),
    )


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="serve.py", description="启动 Monitor 服务端（本地 / 测试）")
    p.add_argument("--db", required=True)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    args = p.parse_args(argv)
    try:
        app = build_app(args.db)
    except ValueError as exc:
        print(f"serve.py: {exc}", file=sys.stderr)
        return 2
    import socket

    import uvicorn

    # 先绑定端口（--port 0 时由系统分配），再把实际地址打出来
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((args.host, args.port))
    host, port = sock.getsockname()[:2]
    config = uvicorn.Config(app, log_level="warning")
    server = uvicorn.Server(config)

    async def serve() -> None:
        async def announce() -> None:
            # 等 uvicorn 完成启动（含 lifespan：编排的后台定时推进）后再报就绪；按状态轮询，不是固定等待
            while not server.started and not server.should_exit:
                await asyncio.sleep(0.02)
            if server.started:
                print(f"monitor-server ready http://{host}:{port}/api/v1", file=sys.stderr, flush=True)

        await asyncio.gather(server.serve(sockets=[sock]), announce())

    asyncio.run(serve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
