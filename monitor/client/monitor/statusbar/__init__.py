"""本机状态窗口（任务 J）：视图模型（viewmodel.py，纯函数）+ Tk 窗口（window.py）。"""

from __future__ import annotations

from .viewmodel import Button, StatusSnapshot, StatusView, build_view

__all__ = ["Button", "StatusSnapshot", "StatusView", "build_view"]
