"""服务端测试公共夹具：可控时钟、内存 SQLite、TestClient、注册设备与造指令的助手，
以及按 contracts/openapi.yaml 校验响应形状的工具。F2/F3 的测试可以直接复用。"""

from __future__ import annotations

import copy
import json
import sys
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import monitor_contracts as mc
import pytest
import yaml
import warnings

with warnings.catch_warnings():
    # starlette 对 httpx 的弃用提示与本项目无关；在导入处屏蔽，不依赖从哪个目录调用 pytest
    warnings.filterwarnings("ignore", message="Using `httpx` with `starlette.testclient`")
    from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

from app.db import FakeClock, SqliteStore
from app.events import InProcessEventBus
from app.main import Settings, StaticTokenAuthenticator, create_app

SERVER_DIR = Path(__file__).resolve().parent.parent
CONTRACTS_DIR = SERVER_DIR.parent / "contracts"
OPENAPI_YAML = CONTRACTS_DIR / "openapi.yaml"
VECTORS_DIR = CONTRACTS_DIR / "tests" / "vectors" / "valid"

# 契约测试向量里的时间都在 2026-10-04 09:30+08:00 前后
T0 = datetime(2026, 10, 4, 1, 30, 0, tzinfo=UTC)
CONSOLE_TOKEN = "console-token-alice"
SERVICE_TOKEN = "service-token-mail"
ACCOUNT = "acct_demo"
API = "/api/v1"


def vector(name: str) -> dict[str, Any]:
    """读取 A 的合法测试向量（只读）。"""
    data = json.loads((VECTORS_DIR / f"{name}.json").read_text(encoding="utf-8"))
    return copy.deepcopy(data["data"])


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# openapi.yaml 响应形状校验
# ---------------------------------------------------------------------------

_BASE = "file:///monitor/contracts/"


def _registry() -> Registry:
    resources = [
        (_BASE + "openapi.yaml", Resource.from_contents(load_openapi_yaml(), default_specification=DRAFT202012))
    ]
    for path in sorted((CONTRACTS_DIR / "schemas").glob("*.json")):
        contents = json.loads(path.read_text(encoding="utf-8"))
        resources.append(
            (_BASE + "schemas/" + path.name, Resource.from_contents(contents, default_specification=DRAFT202012))
        )
    return Registry().with_resources(resources)


_CACHE: dict[str, Any] = {}


def load_openapi_yaml() -> dict[str, Any]:
    if "yaml" not in _CACHE:
        _CACHE["yaml"] = yaml.safe_load(OPENAPI_YAML.read_text(encoding="utf-8"))
    return _CACHE["yaml"]


def assert_shape(data: Any, component: str) -> None:
    """断言 data 符合 openapi.yaml 中 components.schemas.<component>（含对契约 schema 的引用）。"""
    if "registry" not in _CACHE:
        _CACHE["registry"] = _registry()
    validator = Draft202012Validator(
        {"$ref": f"{_BASE}openapi.yaml#/components/schemas/{component}"},
        registry=_CACHE["registry"],
        format_checker=Draft202012Validator.FORMAT_CHECKER,
    )
    errors = sorted(validator.iter_errors(data), key=lambda e: list(e.absolute_path))
    assert not errors, f"{component} 形状不符：" + "; ".join(f"{list(e.absolute_path)}: {e.message}" for e in errors)


def assert_problem(resp: Any, status: int, code: str | None = None) -> dict[str, Any]:
    assert resp.status_code == status, resp.text
    assert resp.headers["content-type"].startswith("application/problem+json")
    body = resp.json()
    assert_shape(body, "Problem")
    if code is not None:
        assert body["code"] == code, body
    return body


# ---------------------------------------------------------------------------
# 测试环境
# ---------------------------------------------------------------------------


class Harness:
    """一次测试的服务端实例与常用操作。"""

    def __init__(self, settings: Settings | None = None):
        self.clock = FakeClock(T0)
        self.store = SqliteStore(":memory:")
        self.bus = InProcessEventBus()
        self.messages: list[Any] = []
        self.bus.subscribe(self.messages.append)
        self.app = create_app(
            store=self.store,
            clock=self.clock,
            settings=settings,
            console_auth=StaticTokenAuthenticator({CONSOLE_TOKEN: "alice"}),
            service_auth=StaticTokenAuthenticator({SERVICE_TOKEN: "mail-ingest"}),
            bus=self.bus,
        )
        self.ctx = self.app.state.ctx
        self.client = TestClient(self.app)

    # -- HTTP --------------------------------------------------------------

    @staticmethod
    def key() -> str:
        return "test-" + uuid.uuid4().hex

    @staticmethod
    def auth(token: str | None) -> dict[str, str]:
        return {} if token is None else {"Authorization": f"Bearer {token}"}

    def post(
        self,
        path: str,
        json: Any = None,
        *,
        token: str | None = CONSOLE_TOKEN,
        key: str | None = "auto",
        method: str = "POST",
    ) -> Any:
        headers = self.auth(token)
        if key is not None:
            headers["Idempotency-Key"] = self.key() if key == "auto" else key
        kwargs: dict[str, Any] = {"headers": headers}
        if json is not None:
            kwargs["json"] = json
        return self.client.request(method, API + path, **kwargs)

    def get(self, path: str, *, token: str | None = CONSOLE_TOKEN, params: Any = None) -> Any:
        return self.client.get(API + path, headers=self.auth(token), params=params)

    # -- 设备 --------------------------------------------------------------

    def enroll(self, mode: str = "local") -> str:
        resp = self.post("/device-enrollments", {"mode": mode})
        assert resp.status_code == 201, resp.text
        return resp.json()["enrollment_code"]

    def registration(self, code: str, mode: str = "local", **overrides: Any) -> dict[str, Any]:
        body = vector(f"device_registration_{mode}")
        body["enrollment_code"] = code
        body["contracts_version"] = mc.__version__  # 向量里是旧版本号；注册时服务端会检查兼容性
        body.update(overrides)
        return body

    def register(self, mode: str = "local") -> tuple[str, str]:
        resp = self.post("/devices", self.registration(self.enroll(mode), mode), token=None)
        assert resp.status_code == 201, resp.text
        return resp.json()["device_id"], resp.json()["device_token"]

    def heartbeat_body(self, device_id: str, account_id: str | None = ACCOUNT, **overrides: Any) -> dict[str, Any]:
        body = vector("device_heartbeat_running")
        body.update(device_id=device_id, account_id=account_id, sent_at=iso(self.clock.now()), current_action=None)
        body.update(overrides)
        return body

    def heartbeat(self, device_id: str, token: str, account_id: str | None = ACCOUNT, **overrides: Any) -> Any:
        body = self.heartbeat_body(device_id, account_id, **overrides)
        return self.post(f"/devices/{device_id}/heartbeat", body, token=token)

    def bind(self, device_id: str, account_id: str = ACCOUNT) -> Any:
        return self.post(f"/devices/{device_id}/account-binding", {"account_id": account_id}, method="PUT")

    def ready_device(self, account_id: str = ACCOUNT, mode: str = "local") -> tuple[str, str]:
        """注册 + 确认绑定 + 心跳：可以领取指令的设备。"""
        device_id, token = self.register(mode)
        assert self.bind(device_id, account_id).status_code == 200
        assert self.heartbeat(device_id, token, account_id).status_code == 200
        return device_id, token

    # -- 指令 --------------------------------------------------------------

    def command(
        self,
        *,
        depends_on: str | None = None,
        expires_in: float = 600,
        account_id: str = ACCOUNT,
        action: str = "send_greeting",
        command_id: str | None = None,
    ) -> dict[str, Any]:
        """按向量构造一条指令（issued_at = 当前假时间）。"""
        name = {
            "send_greeting": "command_send_greeting",
            "request_resume": "command_request_resume_depends",
            "search_candidates": "command_search",
        }[action]
        body = vector(name)
        now = self.clock.now()
        body.update(
            command_id=command_id or str(uuid.uuid4()),
            account_id=account_id,
            issued_at=iso(now),
            expires_at=iso(now + timedelta(seconds=expires_in)),
            depends_on=depends_on,
        )
        return body

    def create(self, **kwargs: Any) -> dict[str, Any]:
        device_id = kwargs.pop("device_id", None)
        return self.ctx.commands.create_command(self.command(**kwargs), device_id=device_id)

    def claim(
        self,
        device_id: str,
        token: str,
        account_id: str = ACCOUNT,
        *,
        max_commands: int = 1,
        wait_seconds: int = 0,
        key: str | None = "auto",
    ) -> Any:
        body = {"account_id": account_id, "max_commands": max_commands, "wait_seconds": wait_seconds}
        return self.post(f"/devices/{device_id}/commands:claim", body, token=token, key=key)

    def result_body(self, command: dict[str, Any], status: str = "succeeded", **overrides: Any) -> dict[str, Any]:
        now = iso(self.clock.now())
        if command["action"] == "send_greeting":
            body = vector("result_greeting_succeeded")
        else:
            body = vector("result_greeting_succeeded")
            body["action"] = command["action"]
        body.update(command_id=command["command_id"], executed_at=now, reported_at=now)
        if status == "failed":
            body.update(
                status="failed",
                reason="target_not_found",
                navigation_performed=False,
                outbound_action_performed=False,
                externally_visible_side_effect=False,
            )
        elif status == "unknown":
            body.update(status="unknown", reason="crash_recovery")
        elif status == "cancelled":
            # 导航过但没有对外动作时可以取消（契约 0.2.0：cancelled 只要求 outbound_action_performed=false）
            body.update(status="cancelled", reason=None, executed_at=None, outbound_action_performed=False)
        body.update(overrides)
        return body

    def report(
        self,
        command: dict[str, Any],
        token: str,
        status: str = "succeeded",
        *,
        key: str | None = "auto",
        **overrides: Any,
    ) -> Any:
        body = self.result_body(command, status, **overrides)
        return self.post(f"/commands/{command['command_id']}/result", body, token=token, key=key)

    def ack(self, command_id: str, device_id: str, token: str, **overrides: Any) -> Any:
        body = {"device_id": device_id, "ledger_state": "queued", "received_at": iso(self.clock.now())}
        body.update(overrides)
        return self.post(f"/commands/{command_id}/ack", body, token=token)


@pytest.fixture
def h() -> Harness:
    harness = Harness()
    yield harness
    harness.client.close()
    harness.store.close()


# 测试模块用 `from server_testkit import ...` 取公共助手。pytest 总是先加载 conftest，这里把本模块
# 以唯一的名字登记到 sys.modules：不依赖 sys.path / import 模式 / rootdir，在 server 目录下和
# monitor/ 下（`uv run pytest server`、`uv run pytest contracts server`）都一样，也不会和其他
# 成员将来的 conftest 重名。
sys.modules.setdefault("server_testkit", sys.modules[__name__])
