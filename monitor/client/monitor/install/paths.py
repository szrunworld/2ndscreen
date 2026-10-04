"""本机安装布局与安装配置（install_config.json）。

所有路径都从 HOME 推导（测试用临时 HOME），不写系统级目录：

    ~/Library/Application Support/RecruitMonitor/
    ├── install_config.json   服务端地址、device_id、设备名、专用屏幕名、令牌存放方式（不含令牌）
    ├── ledger.sqlite3        本地账本（monitor_state.mode 在这里）
    ├── device_token          令牌文件（仅 keychain 不可用时，0600）
    └── logs/                 launchd 的 stdout / stderr

mode 的权威来源是账本里的 monitor_state.mode；install_config.json 只记录安装时的选择，便于排查。
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal

Mode = Literal["local", "remote"]
TokenStoreKind = Literal["keychain", "file"]

APP_DIR_NAME = "RecruitMonitor"
CONFIG_NAME = "install_config.json"
LEDGER_NAME = "ledger.sqlite3"
TOKEN_FILE_NAME = "device_token"
CONFIG_VERSION = 1


@dataclass(frozen=True)
class MonitorPaths:
    home: Path

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> MonitorPaths:
        env = dict(os.environ) if env is None else env
        home = env.get("HOME")
        if not home:
            raise ValueError("没有 HOME 环境变量，无法确定安装目录")
        return cls(Path(home))

    @property
    def app_dir(self) -> Path:
        return self.home / "Library" / "Application Support" / APP_DIR_NAME

    @property
    def config(self) -> Path:
        return self.app_dir / CONFIG_NAME

    @property
    def ledger(self) -> Path:
        return self.app_dir / LEDGER_NAME

    @property
    def token_file(self) -> Path:
        return self.app_dir / TOKEN_FILE_NAME

    @property
    def logs(self) -> Path:
        return self.app_dir / "logs"

    @property
    def launch_agents(self) -> Path:
        return self.home / "Library" / "LaunchAgents"

    def ensure_app_dir(self) -> None:
        self.app_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(self.app_dir, 0o700)


@dataclass
class InstallConfig:
    server_url: str
    device_id: str
    device_name: str
    mode: Mode
    token_store: TokenStoreKind
    screen: str = "monitor"
    console_url: str | None = None
    boss_bundle_id: str = "com.zhipin.www"
    boss_app_name: str = "BOSS直聘"
    cli_binary: str | None = None
    installed_at: str | None = None
    config_version: int = CONFIG_VERSION
    extra: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False, indent=2, sort_keys=True)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> InstallConfig:
        known = {f for f in cls.__dataclass_fields__}  # noqa: C416
        missing = {"server_url", "device_id", "device_name", "mode", "token_store"} - set(data)
        if missing:
            raise ValueError(f"安装配置缺少字段: {sorted(missing)}")
        if data["mode"] not in ("local", "remote"):
            raise ValueError(f"安装配置 mode 非法: {data['mode']!r}")
        return cls(**{k: v for k, v in data.items() if k in known})


def load_config(paths: MonitorPaths) -> InstallConfig | None:
    """读安装配置；未安装返回 None，内容损坏抛 ValueError。"""
    try:
        text = paths.config.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"安装配置不是合法 JSON: {exc}") from None
    if not isinstance(data, dict):
        raise ValueError("安装配置应为 JSON 对象")
    return InstallConfig.from_dict(data)


def save_config(paths: MonitorPaths, config: InstallConfig) -> None:
    """原子写入（临时文件 + rename），权限 0600。"""
    paths.ensure_app_dir()
    tmp = paths.config.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(config.to_json())
    os.replace(tmp, paths.config)
