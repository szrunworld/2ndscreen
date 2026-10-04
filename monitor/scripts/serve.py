"""本地 / 测试环境启动 Monitor 服务端：转调正式入口 `python -m app.main serve`（app/serve.py）。

M-4 已修：服务端入口本身支持用环境变量、令牌文件或命令行参数配置控制台 / 服务令牌，本脚本只为
兼容既有用法保留（`--db` 必填），参数与环境变量和正式入口完全相同：

    MONITOR_CONSOLE_TOKENS="令牌=操作者[,令牌=操作者...]"
    MONITOR_SERVICE_TOKENS="令牌=服务名[,...]"        # 邮件接入用，可省略
    uv run python scripts/serve.py --db /path/server.db [--host 127.0.0.1] [--port 8000]
    # 等价于：cd server && uv run python -m app.main serve --db /path/server.db ...

只监听 HTTP；对外必须放在 HTTPS 反向代理后面（Monitor 只接受 https 地址）。
启动成功后在 stderr 打印一行 `monitor-server ready <url>`，供脚本按事件等待。
"""

from __future__ import annotations

import os
import sys


def main(argv: list[str] | None = None) -> int:
    from app import serve

    args = list(sys.argv[1:] if argv is None else argv)
    if "--db" not in args and not any(a.startswith("--db=") for a in args):
        print("serve.py: 缺少 --db（数据库文件路径）", file=sys.stderr)
        return 2
    return serve.main(args, os.environ)


if __name__ == "__main__":
    raise SystemExit(main())
