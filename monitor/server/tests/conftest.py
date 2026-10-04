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


# ---------------------------------------------------------------------------
# F3 助手：事件、策略、邮件记录、简历文档的请求体（只追加，不改上面已有的行为）
# ---------------------------------------------------------------------------


def make_event(device_id: str, name: str, *, account_id: Any = "keep", bucket: str | None = None, **payload: Any) -> dict[str, Any]:
    """取 A 的合法事件向量，换成本设备；可改 account_id / bucket / payload 字段，event_id 随之重算。"""
    event = vector(name)
    event["device_id"] = device_id
    if account_id != "keep":
        event["account_id"] = account_id
    if bucket is not None:
        event["bucket"] = bucket
    event["payload"].update(payload)
    event["event_id"] = mc.compute_event_id(event["account_id"], event["kind"], event["conversation"], event["bucket"])
    return event


def login_ok_event(device_id: str, bucket: str = "2026-10-04T01:00:00Z/3600") -> dict[str, Any]:
    """契约向量里没有 login_ok，按 event.json 构造一个。"""
    event = {
        "device_id": device_id,
        "account_id": None,
        "kind": "login_ok",
        "conversation": None,
        "bucket": bucket,
        "observed_at": "2026-10-04T09:31:05+08:00",
        "payload": {"mode": "remote", "account_display": None},
    }
    event["event_id"] = mc.compute_event_id(None, "login_ok", None, bucket)
    return event


def post_events(h: Harness, device_id: str, token: str, events: list[dict[str, Any]]) -> Any:
    resp = h.post("/events", {"device_id": device_id, "events": events}, token=token)
    assert resp.status_code == 200, resp.text
    return resp


def search_policy(account_id: str = ACCOUNT, **overrides: Any) -> dict[str, Any]:
    """开启搜索的策略（线上 policy 形状）。"""
    policy = vector("policy_default")
    policy["account_id"] = account_id
    policy["allowed_actions"] = ["send_greeting", "request_resume", "search_candidates"]
    policy.update(overrides)
    return policy


def mail_body(name: str = "mail_message_pending", provider_message_id: str | None = None, **overrides: Any) -> dict[str, Any]:
    """邮件记录请求体（取契约向量）；换 provider_message_id 时主键随之重算。"""
    body = vector(name)
    if provider_message_id is not None:
        body["provider_message_id"] = provider_message_id
        body["mail_message_id"] = mc.compute_mail_message_id(provider_message_id)
    body.update(overrides)
    return body


def put_mail(h: Harness, body: dict[str, Any], *, token: str | None = SERVICE_TOKEN, key: str | None = "auto") -> Any:
    return h.post(f"/mail-messages/{body['mail_message_id']}", body, token=token, key=key, method="PUT")


def resume_body(
    mail_message_id: str,
    *,
    sha: str = "b" * 64,
    method: str = "none",
    case_id: str | None = None,
    command_id: str | None = None,
    candidates: list[str] | None = None,
    **overrides: Any,
) -> dict[str, Any]:
    """原件 POST /resume-documents 请求体。"""
    body: dict[str, Any] = {
        "variant": "original",
        "mail_message_id": mail_message_id,
        "mail": {
            "mailbox": "zhaopin@remotedesk.io",
            "message_id": "<x@mail.example>",
            "received_at": "2026-10-04T10:02:00+08:00",
            "subject": "候选人A 的简历（后端工程师）",
            "from_address": "noreply@zhipin.example",
            "raw_storage_uri": "file:///tmp/m.json",
        },
        "attachment": {
            "filename": "resume.pdf",
            "sha256": sha,
            "size_bytes": 1024,
            "content_type": "application/pdf",
            "storage_uri": f"file:///tmp/{sha[:8]}.pdf",
        },
        "link": {"method": method, "case_id": case_id, "command_id": command_id, "candidate_case_ids": candidates or []},
    }
    body.update(overrides)
    return body


# 测试模块用 `from server_testkit import ...` 取公共助手。pytest 总是先加载 conftest，这里把本模块
# 以唯一的名字登记到 sys.modules：不依赖 sys.path / import 模式 / rootdir，在 server 目录下和
# monitor/ 下（`uv run pytest server`、`uv run pytest contracts server`）都一样，也不会和其他
# 成员将来的 conftest 重名。
sys.modules.setdefault("server_testkit", sys.modules[__name__])
