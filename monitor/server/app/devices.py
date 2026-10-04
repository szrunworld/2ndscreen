"""设备：注册码、注册与令牌（只存哈希、可吊销）、心跳、账户绑定、暂停与恢复、设备卡片。"""

from __future__ import annotations

import base64
import secrets
from typing import TYPE_CHECKING, Annotated, Any, Literal

from fastapi import APIRouter, Body, Request
from pydantic import BaseModel, Field, StringConstraints
from pydantic.json_schema import SkipJsonSchema

import monitor_contracts as mc
from monitor_contracts import check

from .db import BindingRow, DeviceRow, EnrollmentRow, from_db_time, to_db_time, wire_time
from .main import (
    AccountIdStr,
    ApiError,
    ApiModel,
    ConsoleActor,
    Ctx,
    DeviceAuth,
    HeartbeatAckJson,
    HeartbeatJson,
    IdempotencyKeyHeader,
    NoteBody,
    RegistrationJson,
    hash_token,
    not_found,
    ok,
    problem_responses,
    run_idempotent,
    validation_failed,
)

if TYPE_CHECKING:
    from .main import AppContext

Mode = Literal["local", "remote"]
DateTimeStr = Annotated[str, Field(json_schema_extra={"format": "date-time"})]

# ---------------------------------------------------------------------------
# HTTP 形状
# ---------------------------------------------------------------------------


class EnrollmentCreate(ApiModel):
    mode: Mode
    note: Annotated[str, StringConstraints(max_length=200)] | SkipJsonSchema[None] = None


class Enrollment(BaseModel):
    enrollment_code: str
    mode: Mode
    expires_at: DateTimeStr


class DeviceRegistered(BaseModel):
    device_id: str
    device_token: str
    server_time: DateTimeStr
    contracts_version: str


class AccountBindingRequest(ApiModel):
    account_id: AccountIdStr
    note: Annotated[str, StringConstraints(max_length=200)] | SkipJsonSchema[None] = None


class AccountBinding(BaseModel):
    device_id: str
    account_id: str
    bound_at: DateTimeStr
    confirmed_by: str


class Device(BaseModel):
    device_id: str
    device_name: str
    mode: Mode
    status: Literal["online", "offline", "needs_login", "paused", "revoked"]
    paused: bool
    revoked: bool
    capabilities: list[str]
    monitor_version: str | SkipJsonSchema[None] = None
    contracts_version: str | SkipJsonSchema[None] = None
    last_heartbeat: HeartbeatJson | None
    last_heartbeat_at: DateTimeStr | None = None
    account_binding: AccountBinding | None
    login_qr_active: bool | SkipJsonSchema[None] = None


class DeviceList(BaseModel):
    items: list[Device]


# ---------------------------------------------------------------------------
# 业务
# ---------------------------------------------------------------------------


def new_enrollment_code() -> str:
    """一次性注册码：ENR- + 16 位 base32（约 80 bit 随机），满足契约 6–64 位。"""
    return "ENR-" + base64.b32encode(secrets.token_bytes(10)).decode("ascii")


def new_device_token() -> str:
    return "mdt_" + secrets.token_urlsafe(32)


def contracts_compatible(client: str, server: str = mc.__version__) -> bool:
    """主版本与次版本相同才兼容（contracts.md 第十二节第 5 条）。"""
    return client.split(".")[:2] == server.split(".")[:2]


class DeviceService:
    def __init__(self, ctx: AppContext):
        self.ctx = ctx

    def _now(self) -> str:
        return to_db_time(self.ctx.clock.now())

    def _require(self, device_id: str) -> DeviceRow:
        device = self.ctx.store.get_device(device_id)
        if device is None:
            raise not_found("设备")
        return device

    # -- 注册 ---------------------------------------------------------------

    def create_enrollment(self, mode: str, note: str | None, actor: str) -> dict[str, Any]:
        now = self.ctx.clock.now()
        code = new_enrollment_code()
        expires = to_db_time(now + self.ctx.settings.enrollment_ttl)
        self.ctx.store.insert_enrollment(EnrollmentRow(hash_token(code), mode, note, actor, to_db_time(now), expires))
        return {"enrollment_code": code, "mode": mode, "expires_at": wire_time(expires)}

    def register(self, body: Any) -> dict[str, Any]:
        """用注册码注册设备。返回值含明文令牌，只在本响应中出现一次；库里只存哈希。"""
        errors = check("device_registration", body)
        if errors:
            raise validation_failed(errors)
        code_hash = hash_token(body["enrollment_code"])
        enrollment = self.ctx.store.get_enrollment(code_hash)
        now = self._now()
        if enrollment is None or enrollment.used_at is not None or enrollment.expires_at <= now:
            raise ApiError(403, "enrollment_invalid", "注册码无效、已使用或已过期")
        if enrollment.mode != body["mode"]:
            raise ApiError(403, "enrollment_mode_mismatch", f"注册码是为 {enrollment.mode} 模式生成的")
        if not contracts_compatible(body["contracts_version"]):
            raise ApiError(
                409,
                "contracts_version_unsupported",
                f"Monitor 契约版本 {body['contracts_version']} 与服务端 {mc.__version__} 不兼容",
            )
        token = new_device_token()
        device = DeviceRow(
            device_id="dev_" + secrets.token_hex(8),
            device_name=body["device_name"],
            mode=body["mode"],
            platform=body["platform"],
            monitor_version=body["monitor_version"],
            contracts_version=body["contracts_version"],
            capabilities=list(body["capabilities"]),
            token_hash=hash_token(token),
            registered_at=now,
        )
        if not self.ctx.store.register_device(code_hash, device, now):
            raise ApiError(403, "enrollment_invalid", "注册码已被使用")
        return {
            "device_id": device.device_id,
            "device_token": token,
            "server_time": wire_time(now),
            "contracts_version": mc.__version__,
        }

    def reissue_token(self, stored: dict[str, Any]) -> dict[str, Any]:
        """注册请求重放（同一 Idempotency-Key 与请求体）：令牌未落库，重新签发并作废上一枚。

        这样断网重试仍能拿到可用令牌，同时服务端始终只保存哈希。
        """
        device = self._require(stored["device_id"])
        if device.revoked:
            raise ApiError(403, "enrollment_invalid", "该注册已被吊销，请重新生成注册码")
        token = new_device_token()
        self.ctx.store.update_device(device.device_id, token_hash=hash_token(token))
        return {**stored, "device_token": token}

    # -- 设备卡片 -----------------------------------------------------------

    def status_of(self, device: DeviceRow) -> str:
        if device.revoked:
            return "revoked"
        hb = device.last_heartbeat or {}
        if device.paused or hb.get("paused"):
            return "paused"
        last = from_db_time(device.last_heartbeat_at)
        if last is None or self.ctx.clock.now() - last > self.ctx.settings.offline_after:
            return "offline"
        if hb.get("client_state") == "login_required":
            return "needs_login"
        return "online"

    def binding_record(self, device_id: str) -> dict[str, Any] | None:
        b = self.ctx.store.get_binding(device_id)
        if b is None:
            return None
        return {
            "device_id": b.device_id,
            "account_id": b.account_id,
            "bound_at": wire_time(b.bound_at),
            "confirmed_by": b.confirmed_by,
        }

    def record(self, device: DeviceRow) -> dict[str, Any]:
        """组装 openapi Device。paused = 控制台暂停或设备自报暂停。"""
        return {
            "device_id": device.device_id,
            "device_name": device.device_name,
            "mode": device.mode,
            "status": self.status_of(device),
            "paused": device.paused or bool((device.last_heartbeat or {}).get("paused")),
            "revoked": device.revoked,
            "capabilities": device.capabilities,
            "monitor_version": device.monitor_version,
            "contracts_version": device.contracts_version,
            "last_heartbeat": device.last_heartbeat,
            "last_heartbeat_at": wire_time(device.last_heartbeat_at),
            "account_binding": self.binding_record(device.device_id),
            "login_qr_active": bool(self.ctx.login_qr_active(device.device_id)),
        }

    def get(self, device_id: str) -> dict[str, Any]:
        return self.record(self._require(device_id))

    def list(self) -> list[dict[str, Any]]:
        return [self.record(d) for d in self.ctx.store.list_devices()]

    # -- 控制台操作 ---------------------------------------------------------

    def revoke(self, device_id: str) -> dict[str, Any]:
        """吊销令牌。已领取未完成的指令不自动释放（openapi：回到可领取前需人工确认）。"""
        device = self._require(device_id)
        if not device.revoked:
            device = self.ctx.store.update_device(device_id, revoked=True, revoked_at=self._now()) or device
            self.ctx.notifier.notify()
        return self.record(device)

    def confirm_binding(self, device_id: str, account_id: str, actor: str, note: str | None) -> dict[str, Any]:
        self._require(device_id)
        self.ctx.store.set_binding(BindingRow(device_id, account_id, self._now(), actor, note))
        self.ctx.notifier.notify()
        record = self.binding_record(device_id)
        assert record is not None
        return record

    def set_paused(self, device_id: str, paused: bool, note: str | None) -> dict[str, Any]:
        self._require(device_id)
        device = self.ctx.store.update_device(device_id, paused=paused, pause_note=note)
        assert device is not None
        self.ctx.notifier.notify()
        return self.record(device)

    # -- 心跳 ---------------------------------------------------------------

    def heartbeat(self, device: DeviceRow, body: Any) -> dict[str, Any]:
        errors = check("device_heartbeat", body)
        if errors:
            raise validation_failed(errors)
        if body["device_id"] != device.device_id:
            raise validation_failed([{"path": "device_id", "message": "与设备令牌不符", "code": "device_mismatch"}])
        now = self._now()
        # 模式以最近心跳为准（monitor mode 切换后无需重新注册）
        self.ctx.store.update_device(device.device_id, last_heartbeat=body, last_heartbeat_at=now, mode=body["mode"])
        self.ctx.notifier.notify()
        binding = self.ctx.store.get_binding(device.device_id)
        confirmed = binding is not None and binding.account_id == body["account_id"]
        current = self.ctx.store.get_device(device.device_id) or device
        # 契约 0.3.3（M-1）：如实返回服务端记录的确认绑定，与心跳里的 account_id 无关；设备以它为准写入本机绑定
        account_binding = (
            None
            if binding is None
            else {"account_id": binding.account_id, "bound_at": wire_time(binding.bound_at), "confirmed_by": binding.confirmed_by}
        )
        return {
            "server_time": wire_time(now),
            "paused": current.paused,
            "policy_version": self.ctx.policy_version(binding.account_id) if confirmed and binding else None,
            "cancellations": self.ctx.store.cancellations_for(device.device_id),
            "account_confirmed": confirmed,
            "account_binding": account_binding,
        }


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------

router = APIRouter(tags=["devices"])


def _check_path_device(device_id: str, device: DeviceRow) -> None:
    if device_id != device.device_id:
        raise ApiError(403, "device_mismatch", "路径中的 device_id 与设备令牌不符")


@router.post(
    "/device-enrollments",
    operation_id="createDeviceEnrollment",
    summary="控制台生成一次性设备注册码",
    status_code=201,
    response_model=Enrollment,
    responses=problem_responses(401, 422),
)
def create_enrollment(
    request: Request,
    ctx: Ctx,
    actor: ConsoleActor,
    idempotency_key: IdempotencyKeyHeader,
    body: Annotated[EnrollmentCreate, Body()],
):
    payload = body.model_dump(mode="json")
    return run_idempotent(
        ctx,
        request,
        f"console:{actor}",
        idempotency_key,
        payload,
        lambda: (201, ctx.devices.create_enrollment(body.mode, body.note, actor)),
    )


@router.post(
    "/devices",
    operation_id="registerDevice",
    summary="Monitor 用注册码注册设备，换取设备令牌",
    status_code=201,
    response_model=DeviceRegistered,
    responses=problem_responses(403, 409, 422),
)
def register_device(
    request: Request,
    ctx: Ctx,
    idempotency_key: IdempotencyKeyHeader,
    body: Annotated[RegistrationJson, Body()],
):
    return run_idempotent(
        ctx,
        request,
        "anonymous",
        idempotency_key,
        body,
        lambda: (201, ctx.devices.register(body)),
        to_stored=lambda p: {k: v for k, v in p.items() if k != "device_token"},
        on_replay=ctx.devices.reissue_token,
    )


@router.get(
    "/devices",
    operation_id="listDevices",
    summary="设备列表（控制台）",
    response_model=DeviceList,
    responses=problem_responses(401),
)
def list_devices(ctx: Ctx, _actor: ConsoleActor):
    return ok({"items": ctx.devices.list()})


@router.get(
    "/devices/{device_id}",
    operation_id="getDevice",
    summary="设备详情（控制台）",
    response_model=Device,
    responses=problem_responses(401, 404),
)
def get_device(ctx: Ctx, _actor: ConsoleActor, device_id: str):
    return ok(ctx.devices.get(device_id))


@router.post(
    "/devices/{device_id}:revoke",
    operation_id="revokeDeviceToken",
    summary="吊销设备令牌",
    response_model=Device,
    responses=problem_responses(401, 404),
)
def revoke_device(
    request: Request, ctx: Ctx, actor: ConsoleActor, device_id: str, idempotency_key: IdempotencyKeyHeader
):
    return run_idempotent(
        ctx, request, f"console:{actor}", idempotency_key, None, lambda: (200, ctx.devices.revoke(device_id))
    )


@router.put(
    "/devices/{device_id}/account-binding",
    operation_id="confirmAccountBinding",
    summary="控制台确认设备与招聘账户的绑定",
    response_model=AccountBinding,
    responses=problem_responses(401, 404, 422),
)
def confirm_binding(
    request: Request,
    ctx: Ctx,
    actor: ConsoleActor,
    device_id: str,
    idempotency_key: IdempotencyKeyHeader,
    body: Annotated[AccountBindingRequest, Body()],
):
    return run_idempotent(
        ctx,
        request,
        f"console:{actor}",
        idempotency_key,
        body.model_dump(mode="json"),
        lambda: (200, ctx.devices.confirm_binding(device_id, body.account_id, actor, body.note)),
    )


def _pause_route(paused: bool):
    def handler(
        request: Request,
        ctx: Ctx,
        actor: ConsoleActor,
        device_id: str,
        idempotency_key: IdempotencyKeyHeader,
        body: Annotated[NoteBody | None, Body()] = None,
    ):
        note = body.note if body else None
        return run_idempotent(
            ctx,
            request,
            f"console:{actor}",
            idempotency_key,
            None if body is None else body.model_dump(mode="json"),
            lambda: (200, ctx.devices.set_paused(device_id, paused, note)),
        )

    return handler


router.add_api_route(
    "/devices/{device_id}:pause",
    _pause_route(True),
    methods=["POST"],
    operation_id="pauseDevice",
    summary="暂停设备（停止领取与新的对外动作；已发生的动作仍完成记录与回传）",
    response_model=Device,
    responses=problem_responses(401, 404),
)
router.add_api_route(
    "/devices/{device_id}:resume",
    _pause_route(False),
    methods=["POST"],
    operation_id="resumeDevice",
    summary="恢复设备",
    response_model=Device,
    responses=problem_responses(401, 404),
)


@router.post(
    "/devices/{device_id}/heartbeat",
    operation_id="postHeartbeat",
    summary="设备心跳（默认 30 秒）",
    response_model=HeartbeatAckJson,
    responses=problem_responses(401, 403, 422),
)
def post_heartbeat(
    request: Request,
    ctx: Ctx,
    device_id: str,
    device: DeviceAuth,
    idempotency_key: IdempotencyKeyHeader,
    body: Annotated[HeartbeatJson, Body()],
):
    _check_path_device(device_id, device)
    return run_idempotent(
        ctx, request, f"device:{device_id}", idempotency_key, body, lambda: (200, ctx.devices.heartbeat(device, body))
    )


__all__ = ["DeviceService", "contracts_compatible", "new_device_token", "new_enrollment_code", "router"]
