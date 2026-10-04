"""服务端装配与 HTTP 公共层：配置、错误（problem+json）、认证、Idempotency-Key、openapi 导出。

业务模块（devices / commands / events，以及 F2/F3 将新增的模块）从这里取公共设施，
路由在 create_app() 里装配（延迟导入，避免循环引用）。

命令行：
    uv run python -m app.main export-openapi [输出路径]   # 从代码导出 openapi.json
    uv run python -m app.main serve --db monitor.db       # 本地启动（uvicorn）
"""

from __future__ import annotations

import hashlib
import json
import sys
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import timedelta
from typing import TYPE_CHECKING, Annotated, Any, Protocol

from fastapi import Depends, FastAPI, Header, Request, Security
from fastapi.exceptions import RequestValidationError
from fastapi.openapi.utils import get_openapi
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, StringConstraints, WithJsonSchema
from pydantic.json_schema import SkipJsonSchema
from starlette.exceptions import HTTPException as StarletteHTTPException

import monitor_contracts as mc
from monitor_contracts import FieldError as ContractFieldError

from .db import Clock, DeviceRow, IdempotencyRow, SqliteStore, Store, SystemClock, canonical_json, to_db_time

if TYPE_CHECKING:
    from .commands import CommandNotifier, CommandService
    from .devices import DeviceService
    from .events import EventBus, EventService

API_PREFIX = "/api/v1"
PROBLEM_MEDIA_TYPE = "application/problem+json"

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Settings:
    lease_seconds: int = 60  # 领取后必须在此时间内 ack
    enrollment_ttl: timedelta = timedelta(hours=24)  # 注册码有效期
    idempotency_ttl: timedelta = timedelta(hours=24)  # 幂等键保存期（api.md：24 小时）
    offline_after: timedelta = timedelta(seconds=90)  # 超过此时间无心跳视为 offline
    max_wait_seconds: int = 30  # 长轮询上限（契约 ClaimRequest.wait_seconds ≤ 30）


# ---------------------------------------------------------------------------
# 契约 schema 引用：生成 openapi 时替换成 $ref，与 contracts/openapi.yaml 的引用一致
# ---------------------------------------------------------------------------


def contract_ref(ref: str) -> WithJsonSchema:
    """把字段在导出的 openapi 中标成对契约 schema 文件的引用（如 ./schemas/command.json）。"""
    return WithJsonSchema({"x-contract-ref": ref})


ContractJson = dict[str, Any]
CommandJson = Annotated[ContractJson, contract_ref("./schemas/command.json")]
CommandResultJson = Annotated[ContractJson, contract_ref("./schemas/command_result.json")]
EventJson = Annotated[ContractJson, contract_ref("./schemas/event.json")]
HeartbeatJson = Annotated[ContractJson, contract_ref("./schemas/device_heartbeat.json")]
RegistrationJson = Annotated[ContractJson, contract_ref("./schemas/device_registration.json")]
AccountIdStr = Annotated[
    str, StringConstraints(min_length=1, max_length=128), contract_ref("./schemas/common.json#/$defs/account_id")
]
IdempotencyKeyHeader = Annotated[
    str, Header(alias="Idempotency-Key", pattern=mc.IDEMPOTENCY_KEY_PATTERN, description="写接口幂等键")
]


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProblemFieldError(BaseModel):
    model_config = ConfigDict(title="FieldError")
    path: str
    message: str
    code: str


class Problem(BaseModel):
    code: str
    message: str
    errors: list[ProblemFieldError] | SkipJsonSchema[None] = None
    existing: Any = None


class NoteBody(ApiModel):
    note: Annotated[str, StringConstraints(max_length=500)] | SkipJsonSchema[None] = None


def problem_responses(*codes: int) -> dict[int | str, dict[str, Any]]:
    """为路由声明 problem+json 错误响应（与 openapi.yaml 中的错误码一一对应）。"""
    names = {
        401: "未认证或令牌已吊销",
        403: "无权操作",
        404: "资源不存在",
        409: "冲突",
        412: "版本不一致",
        422: "请求体不符合契约或幂等键被不同请求体复用",
    }
    return {
        code: {
            "description": names.get(code, "错误"),
            "content": {PROBLEM_MEDIA_TYPE: {"schema": {"$ref": "#/components/schemas/Problem"}}},
        }
        for code in codes
    }


# ---------------------------------------------------------------------------
# 错误
# ---------------------------------------------------------------------------


class ApiError(Exception):
    """业务层抛出、由异常处理器转成 problem+json 的错误。"""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        errors: list[ContractFieldError] | list[dict[str, str]] | None = None,
        existing: Any = None,
    ):
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code
        self.message = message
        self.errors = [_field_error_dict(e) for e in errors] if errors else None
        self.existing = existing


def _field_error_dict(e: ContractFieldError | dict[str, str]) -> dict[str, str]:
    if isinstance(e, dict):
        return {"path": e["path"], "message": e["message"], "code": e["code"]}
    return {"path": e.path, "message": e.message, "code": e.code}


def validation_failed(
    errors: list[ContractFieldError] | list[dict[str, str]], message: str = "请求体不符合契约"
) -> ApiError:
    return ApiError(422, "validation_failed", message, errors=errors)


def not_found(what: str) -> ApiError:
    return ApiError(404, "not_found", f"{what} 不存在")


def ok(payload: Any, status: int = 200) -> JSONResponse:
    """成功响应。所有路由都直接返回 JSONResponse，响应形状由业务层按 openapi 组装
    （response_model 只用于生成文档，避免 pydantic 把可省略字段序列化成 null）。"""
    return JSONResponse(payload, status_code=status)


def check_cursor(cursor: str | None) -> str | None:
    """列表游标是不透明字符串（当前实现为数字）；无效游标返回 422。"""
    if cursor is not None and not cursor.isdigit():
        raise validation_failed([{"path": "query.cursor", "message": "游标无效", "code": "invalid_cursor"}])
    return cursor


def problem_response(status: int, body: dict[str, Any]) -> JSONResponse:
    return JSONResponse(
        {k: v for k, v in body.items() if v is not None}, status_code=status, media_type=PROBLEM_MEDIA_TYPE
    )


def _loc_path(loc: tuple[Any, ...]) -> str:
    parts = list(loc)
    if parts and parts[0] == "body":
        parts = parts[1:]
    out = ""
    for p in parts:
        out += f"[{p}]" if isinstance(p, int) else (f".{p}" if out else str(p))
    return out


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return problem_response(
            exc.status, {"code": exc.code, "message": exc.message, "errors": exc.errors, "existing": exc.existing}
        )

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        errors = [
            {"path": _loc_path(tuple(e["loc"])), "message": str(e["msg"]), "code": str(e["type"])} for e in exc.errors()
        ]
        return problem_response(422, {"code": "validation_failed", "message": "请求不符合接口定义", "errors": errors})

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "http_error")
        return problem_response(exc.status_code, {"code": code, "message": str(exc.detail)})


# ---------------------------------------------------------------------------
# 认证
# ---------------------------------------------------------------------------


class TokenAuthenticator(Protocol):
    """控制台会话 / 服务令牌的校验接口：返回 actor 名，无效时返回 None。"""

    def authenticate(self, token: str) -> str | None: ...


class StaticTokenAuthenticator:
    """最简实现：固定的令牌 → actor 映射（控制台登录体系不在 F1 范围）。"""

    def __init__(self, tokens: dict[str, str] | None = None):
        self._tokens = dict(tokens or {})

    def authenticate(self, token: str) -> str | None:
        return self._tokens.get(token)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


device_bearer = HTTPBearer(
    scheme_name="deviceToken", auto_error=False, description="设备令牌（POST /devices 返回，可吊销）"
)
console_bearer = HTTPBearer(scheme_name="consoleSession", auto_error=False, description="控制台用户会话")
service_bearer = HTTPBearer(scheme_name="serviceToken", auto_error=False, description="内部服务（邮件接入）令牌")

BearerCred = HTTPAuthorizationCredentials | None


def _unauthorized(message: str = "未认证或令牌已吊销") -> ApiError:
    return ApiError(401, "unauthorized", message)


def get_ctx(request: Request) -> AppContext:
    return request.app.state.ctx


def require_device(request: Request, cred: Annotated[BearerCred, Security(device_bearer)]) -> DeviceRow:
    """设备令牌认证：只比较哈希；已吊销的令牌返回 401。"""
    if cred is None:
        raise _unauthorized()
    device = get_ctx(request).store.get_device_by_token_hash(hash_token(cred.credentials))
    if device is None or device.revoked:
        raise _unauthorized()
    return device


def require_console(request: Request, cred: Annotated[BearerCred, Security(console_bearer)]) -> str:
    """控制台会话认证，返回 actor。"""
    if cred is None:
        raise _unauthorized()
    actor = get_ctx(request).console_auth.authenticate(cred.credentials)
    if actor is None:
        raise _unauthorized()
    return actor


def require_console_or_service(
    request: Request,
    console: Annotated[BearerCred, Security(console_bearer)],
    service: Annotated[BearerCred, Security(service_bearer)],
) -> str:
    """控制台会话或服务令牌任一有效即可（两者同一个 Authorization 头）。"""
    ctx = get_ctx(request)
    cred = console or service
    if cred is None:
        raise _unauthorized()
    actor = ctx.console_auth.authenticate(cred.credentials)
    if actor is not None:
        return f"console:{actor}"
    service_actor = ctx.service_auth.authenticate(cred.credentials)
    if service_actor is not None:
        return f"service:{service_actor}"
    raise _unauthorized()


DeviceAuth = Annotated[DeviceRow, Depends(require_device)]
ConsoleActor = Annotated[str, Depends(require_console)]
ConsoleOrService = Annotated[str, Depends(require_console_or_service)]


# ---------------------------------------------------------------------------
# Idempotency-Key
# ---------------------------------------------------------------------------


class _KeyedLocks:
    """同一个幂等键的并发请求串行执行（不同键互不阻塞，长轮询不会挡住别人）。"""

    def __init__(self) -> None:
        self._guard = threading.Lock()
        self._locks: dict[tuple[str, ...], list[Any]] = {}

    @contextmanager
    def hold(self, key: tuple[str, ...]) -> Iterator[None]:
        with self._guard:
            entry = self._locks.setdefault(key, [threading.Lock(), 0])
            entry[1] += 1
        try:
            with entry[0]:
                yield
        finally:
            with self._guard:
                entry[1] -= 1
                if entry[1] == 0:
                    self._locks.pop(key, None)


def request_hash(body: Any) -> str:
    return hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()


def run_idempotent(
    ctx: AppContext,
    request: Request,
    principal: str,
    key: str,
    body: Any,
    handler: Callable[[], tuple[int, Any]],
    *,
    to_stored: Callable[[Any], Any] | None = None,
    on_replay: Callable[[Any], Any] | None = None,
) -> JSONResponse:
    """按（principal, 方法, 路径, 键）执行一次写操作并保存 2xx 响应 24 小时。

    - 同键同请求体：原样返回首次响应（on_replay 可在返回前补全不落库的字段）。
    - 同键不同请求体：422 idempotency_key_reused。
    - 非 2xx（ApiError）不保存，重放时重新判断。
    - to_stored 用于在落库前去掉不能明文保存的字段（例如设备令牌）。
    """
    method, path = request.method, request.url.path
    digest = request_hash(body)
    with ctx.idempotency_locks.hold((principal, method, path, key)):
        now = ctx.clock.now()
        existing = ctx.store.get_idempotency(principal, method, path, key)
        if existing is not None and existing.created_at >= to_db_time(now - ctx.settings.idempotency_ttl):
            if existing.request_hash != digest:
                raise ApiError(422, "idempotency_key_reused", "同一个 Idempotency-Key 不能用于不同的请求体")
            payload = on_replay(existing.body) if on_replay else existing.body
            return JSONResponse(payload, status_code=existing.status_code)
        status, payload = handler()
        if 200 <= status < 300:
            stored = to_stored(payload) if to_stored else payload
            ctx.store.put_idempotency(
                IdempotencyRow(principal, method, path, key, digest, status, stored, to_db_time(now))
            )
        return JSONResponse(payload, status_code=status)


# ---------------------------------------------------------------------------
# 装配
# ---------------------------------------------------------------------------


@dataclass
class AppContext:
    """一次应用实例的全部依赖。测试通过 create_app(...) 注入 fake。"""

    store: Store
    clock: Clock
    settings: Settings
    console_auth: TokenAuthenticator
    service_auth: TokenAuthenticator
    bus: EventBus
    notifier: CommandNotifier
    devices: DeviceService = field(init=False)
    commands: CommandService = field(init=False)
    events: EventService = field(init=False)
    policy_version: Callable[[str], int | None] = field(default=lambda account_id: None)
    login_qr_active: Callable[[str], bool] = field(default=lambda device_id: False)
    idempotency_locks: _KeyedLocks = field(default_factory=_KeyedLocks)


Ctx = Annotated[AppContext, Depends(get_ctx)]


def create_app(
    *,
    store: Store | None = None,
    clock: Clock | None = None,
    settings: Settings | None = None,
    console_auth: TokenAuthenticator | None = None,
    service_auth: TokenAuthenticator | None = None,
    bus: EventBus | None = None,
    policy_version: Callable[[str], int | None] | None = None,
    login_qr_active: Callable[[str], bool] | None = None,
) -> FastAPI:
    """创建应用。所有依赖可注入；未给出时用默认实现（内存 SQLite、系统时钟、进程内事件总线）。

    policy_version(account_id)：心跳响应里的策略版本，F2 注入；默认 None。
    login_qr_active(device_id)：设备卡片上是否有有效二维码，F3 注入；默认 False。
    """
    from . import commands, devices, events

    ctx = AppContext(
        store=store or SqliteStore(),
        clock=clock or SystemClock(),
        settings=settings or Settings(),
        console_auth=console_auth or StaticTokenAuthenticator(),
        service_auth=service_auth or StaticTokenAuthenticator(),
        bus=bus or events.InProcessEventBus(),
        notifier=commands.CommandNotifier(),
    )
    if policy_version is not None:
        ctx.policy_version = policy_version
    if login_qr_active is not None:
        ctx.login_qr_active = login_qr_active
    ctx.events = events.EventService(ctx)
    ctx.commands = commands.CommandService(ctx)
    ctx.devices = devices.DeviceService(ctx)

    app = FastAPI(
        title="招聘 Monitor 服务端 API",
        version=mc.__version__,
        summary="Monitor 设备、指令、事件接口（F1）",
    )
    app.state.ctx = ctx
    install_error_handlers(app)
    app.include_router(devices.router, prefix=API_PREFIX)
    app.include_router(commands.router, prefix=API_PREFIX)
    app.include_router(events.router, prefix=API_PREFIX)
    app.openapi = lambda: _cached_openapi(app)  # type: ignore[method-assign]
    return app


# ---------------------------------------------------------------------------
# openapi 导出
# ---------------------------------------------------------------------------


def _replace_contract_refs(node: Any) -> Any:
    if isinstance(node, dict):
        if "x-contract-ref" in node:
            return {"$ref": node["x-contract-ref"]}
        return {k: _replace_contract_refs(v) for k, v in node.items()}
    if isinstance(node, list):
        return [_replace_contract_refs(v) for v in node]
    return node


def export_openapi(app: FastAPI) -> dict[str, Any]:
    """从代码生成 openapi 文档，形状与 contracts/openapi.yaml 对齐：

    - 路径去掉 /api/v1 前缀，前缀写进 servers；
    - 契约字段替换为 ./schemas/*.json 引用；
    - FastAPI 自动加的 422（HTTPValidationError）改为 problem+json 的 Problem；
    - 没有认证依赖的接口显式写 security: []。
    """
    spec = get_openapi(
        title=app.title, version=app.version, summary=app.summary, routes=app.routes, servers=[{"url": API_PREFIX}]
    )
    spec = _replace_contract_refs(spec)
    schemas = spec.setdefault("components", {}).setdefault("schemas", {})
    schemas.pop("HTTPValidationError", None)
    schemas.pop("ValidationError", None)
    problem = Problem.model_json_schema(ref_template="#/components/schemas/{model}")
    for name, sub in problem.pop("$defs", {}).items():
        schemas[name] = sub
    schemas["Problem"] = problem
    paths: dict[str, Any] = {}
    for path, item in spec["paths"].items():
        short = path[len(API_PREFIX) :] if path.startswith(API_PREFIX) else path
        for op in item.values():
            op.setdefault("security", [])
            resp = op.get("responses", {}).get("422")
            if resp and "application/json" in resp.get("content", {}):
                resp["content"] = {PROBLEM_MEDIA_TYPE: {"schema": {"$ref": "#/components/schemas/Problem"}}}
        paths[short] = item
    spec["paths"] = paths
    return spec


def _cached_openapi(app: FastAPI) -> dict[str, Any]:
    if app.openapi_schema is None:
        app.openapi_schema = export_openapi(app)
    return app.openapi_schema


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] not in ("export-openapi", "serve"):
        print("用法: python -m app.main export-openapi [输出路径] | serve [--db 路径] [--port 端口]", file=sys.stderr)
        return 2
    if args[0] == "export-openapi":
        text = json.dumps(export_openapi(create_app()), ensure_ascii=False, indent=2)
        if len(args) > 1:
            with open(args[1], "w", encoding="utf-8") as fh:
                fh.write(text + "\n")
        else:
            print(text)
        return 0
    import uvicorn  # 只有 serve 需要

    db = args[args.index("--db") + 1] if "--db" in args else "monitor_server.db"
    port = int(args[args.index("--port") + 1]) if "--port" in args else 8000
    uvicorn.run(create_app(store=SqliteStore(db)), host="127.0.0.1", port=port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "API_PREFIX",
    "AccountIdStr",
    "ApiError",
    "ApiModel",
    "AppContext",
    "CommandJson",
    "CommandResultJson",
    "ConsoleActor",
    "ConsoleOrService",
    "Ctx",
    "DeviceAuth",
    "EventJson",
    "HeartbeatJson",
    "IdempotencyKeyHeader",
    "NoteBody",
    "Problem",
    "RegistrationJson",
    "Settings",
    "StaticTokenAuthenticator",
    "check_cursor",
    "create_app",
    "ok",
    "export_openapi",
    "hash_token",
    "not_found",
    "problem_responses",
    "run_idempotent",
    "validation_failed",
]
