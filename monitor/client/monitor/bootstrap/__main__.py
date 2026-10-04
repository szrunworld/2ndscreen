"""`python -m monitor.bootstrap [--no-ui]`：按安装配置启动 Monitor（launchd 用这个入口）。"""

from __future__ import annotations

from .app import main

raise SystemExit(main())
