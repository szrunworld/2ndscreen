"""设备注册：以 device_registration 为请求体调用 POST /devices（api.md 3.1）。"""

from __future__ import annotations

import hashlib
import platform as _platform
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any

import httpx
from monitor_contracts import ContractValidationError, validate_device_registration
from monitor_contracts import __version__ as CONTRACTS_VERSION

from .paths import Mode

MONITOR_VERSION = "0.1.0"
REGISTER_TIMEOUT_SECONDS = 20


class RegistrationError(Exception):
    def __init__(self, message: str, *, status: int | None = None, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code


@dataclass(frozen=True)
class Registered:
    device_id: str
    device_token: str
    contracts_version: str
    server_time: str

    def __repr__(self) -> str:  # 令牌不进日志
        return f"Registered(device_id={self.device_id!r}, contracts_version={self.contracts_version!r})"


def _module_exists(name: str) -> bool:
    import importlib.util

    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def detect_capabilities(mode: Mode, *, handler_actions: Iterable[str] | None = None) -> list[str]:
    """按已合并的模块声明能力：observe（E）、各动作（H 的 create_handlers）、provide_input/login_relay（K）。

    能力只表示"本版本实现了"，不等于策略允许。local 模式不声明 login_relay。
    """
    caps: list[str] = []
    if _module_exists("monitor.observe"):
        caps.append("observe")
    if handler_actions is None:
        handler_actions = []
        try:
            from monitor.actions import create_handlers  # type: ignore[import-not-found]

            handler_actions = [h.action for h in create_handlers()]
        except Exception:  # 动作模块未合并或构造失败：不声明任何动作能力
            handler_actions = []
    for action in handler_actions:
        if action not in caps:
            caps.append(action)
    if mode == "remote" and _module_exists("monitor.login"):
        caps.append("login_relay")
    if mode == "local" and "login_relay" in caps:
        caps.remove("login_relay")
    return caps


def build_registration(
    *,
    enrollment_code: str,
    device_name: str,
    mode: Mode,
    capabilities: list[str],
    os_version: str | None = None,
    arch: str | None = None,
) -> dict[str, Any]:
    """构造并校验请求体；不合契约时抛 ContractValidationError。"""
    if os_version is None:
        os_version = _platform.mac_ver()[0] or _platform.release() or "unknown"
    if arch is None:
        machine = _platform.machine()
        arch = machine if machine in ("arm64", "x86_64") else None
    body = {
        "enrollment_code": enrollment_code,
        "device_name": device_name,
        "mode": mode,
        "platform": {"os": "macos", "os_version": os_version[:32], "arch": arch},
        "monitor_version": MONITOR_VERSION,
        "contracts_version": CONTRACTS_VERSION,
        "capabilities": capabilities,
    }
    return validate_device_registration(body).to_wire()


def registration_key(enrollment_code: str) -> str:
    """Idempotency-Key：由注册码确定性生成（重试复用同一个键），不暴露注册码本身。"""
    return "register:" + hashlib.sha256(enrollment_code.encode("utf-8")).hexdigest()[:32]


def register_device(
    server_url: str,
    body: dict[str, Any],
    *,
    transport: httpx.BaseTransport | None = None,
    allow_insecure_http: bool = False,
    http_factory: Callable[..., httpx.Client] = httpx.Client,
) -> Registered:
    if not server_url.startswith("https://") and not allow_insecure_http:
        raise RegistrationError("服务端只接受 HTTPS 地址")
    try:
        validate_device_registration(body)
    except ContractValidationError as exc:
        raise RegistrationError(f"注册请求体不合契约: {exc.paths}") from None
    headers = {"Idempotency-Key": registration_key(body["enrollment_code"])}
    try:
        with http_factory(base_url=server_url.rstrip("/"), transport=transport, timeout=REGISTER_TIMEOUT_SECONDS) as http:
            resp = http.post("/devices", json=body, headers=headers)
    except httpx.HTTPError as exc:
        raise RegistrationError(f"无法连接服务端: {type(exc).__name__}") from None
    problem: dict[str, Any] = {}
    if resp.status_code != 201:
        try:
            data = resp.json()
            problem = data if isinstance(data, dict) else {}
        except ValueError:
            problem = {}
        code = problem.get("code")
        if resp.status_code == 403:
            msg = "注册码无效、已使用或已过期，请在控制台重新生成"
        elif resp.status_code == 409:
            msg = f"契约版本不兼容（本机 {CONTRACTS_VERSION}），请升级 Monitor"
        elif resp.status_code == 422:
            msg = f"服务端拒绝请求体: {problem.get('message') or code}"
        else:
            msg = f"注册失败（HTTP {resp.status_code}）: {problem.get('message') or ''}".rstrip(": ")
        raise RegistrationError(msg, status=resp.status_code, code=code)
    try:
        data = resp.json()
        return Registered(
            device_id=str(data["device_id"]),
            device_token=str(data["device_token"]),
            contracts_version=str(data.get("contracts_version", "")),
            server_time=str(data.get("server_time", "")),
        )
    except (ValueError, KeyError, TypeError):
        raise RegistrationError("服务端响应缺少 device_id 或 device_token", status=resp.status_code) from None
