"""启动引导与进程装配（任务 J）。

- session.py：remote 建屏、启动 BOSS、绑定、防休眠；local 工作时段内接管 / 归还窗口；GateDriver 闸门
- screen.py：2ndscreen 的 screen / app / window 子命令（经 monitor.driver 的 CliRunner）
- retry.py：有上限的退避重试 + record_error 上报
- caffeinate.py：防休眠子进程
- workhours.py：策略工作时段判断
- app.py：进程装配（运行时线程、取消线程、状态窗口），`python -m monitor.bootstrap`
"""

from __future__ import annotations

from .caffeinate import Caffeinate
from .retry import BootstrapFailed, RetryPolicy, StepFailed, run_with_retry
from .screen import AppAlreadyRunning, ScreenOps
from .session import GateDriver, LocalSession, RemoteSession, RuntimeView
from .workhours import in_work_hours

__all__ = [
    "AppAlreadyRunning",
    "BootstrapFailed",
    "Caffeinate",
    "GateDriver",
    "LocalSession",
    "RemoteSession",
    "RetryPolicy",
    "RuntimeView",
    "ScreenOps",
    "StepFailed",
    "in_work_hours",
    "run_with_retry",
]
