"""安装与运行模式（任务 J）：前提检查、设备注册、令牌存放、模式切换。

入口：`python -m monitor.install install|mode ...`（见 cli.py）。
"""

from __future__ import annotations

from .cli import EXIT_OK, EXIT_PREREQ, EXIT_REGISTER, EXIT_USAGE, InstallEnv, main
from .paths import InstallConfig, MonitorPaths, load_config, save_config
from .prereq import CheckResult, PrereqChecker, PrereqReport
from .register import RegistrationError, build_registration, detect_capabilities, register_device
from .secrets import FileStore, KeychainStore, TokenStoreError, save_token

__all__ = [
    "EXIT_OK",
    "EXIT_PREREQ",
    "EXIT_REGISTER",
    "EXIT_USAGE",
    "CheckResult",
    "FileStore",
    "InstallConfig",
    "InstallEnv",
    "KeychainStore",
    "MonitorPaths",
    "PrereqChecker",
    "PrereqReport",
    "RegistrationError",
    "TokenStoreError",
    "build_registration",
    "detect_capabilities",
    "load_config",
    "main",
    "register_device",
    "save_config",
    "save_token",
]
