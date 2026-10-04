"""登录接力（方案 8.5，仅独立设备模式）与人工输入桥接。

- ``POST /login-qr``（设备令牌）：只接受 mode=remote 的设备（本机模式 403 local_mode），请求体的
  device_id 必须是令牌所属设备（403 device_mismatch）。每台设备只保留最新一张：qr_seq 不小于当前值时
  覆盖（并清除撤下标记），更小的视为迟到的旧码，忽略。二维码内容只保存到 expires_at。
- ``GET /devices/{device_id}/login-qr``（控制台）：每次成功读取都记录查看者，响应带
  ``Cache-Control: no-store``；过期或已撤下返回 410，不返回内容；过期时顺手删除内容。
- ``POST /devices/{device_id}/login-qr:withdraw``（设备或控制台）：撤下，重复调用同样 204。
- ``GET /devices/{device_id}/login-qr/views``（控制台）：查看记录。
- ``login_ok`` 事件到达时自动撤下该设备的二维码。
- ``human_input_required`` 事件到达时登记人工输入请求；``POST /input-requests/{id}/response``（控制台）
  只对 can_fill=true、未回应、未过期的请求生成 provide_input 指令（定向给发出请求的设备）。

人工输入的值只出现在发给设备的指令里：不写日志、不进事件；接口响应里的 payload.value 打码；
指令有了结果或过期后，服务端把库里的值抹掉（``scrub_finished_inputs``）。
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import secrets
import uuid
from datetime import timedelta
from typing import TYPE_CHECKING, Annotated, Any

from fastapi import APIRouter, Body, Depends, Request, Response, Security
from pydantic import BaseModel, Field

from monitor_contracts import INPUT_REQUEST_TTL_SECONDS, check

from .commands import CommandCreateError, CommandRecord
from .db import SqliteStore, canonical_json, parse_time, to_db_time, wire_time
from .events import CommandResultRecorded, EventReceived
from .main import (
    ApiError,
    ApiModel,
    BearerCred,
    ConsoleActor,
    Ctx,
    DeviceAuth,
    IdempotencyKeyHeader,
    console_bearer,
    contract_ref,
    device_bearer,
    get_ctx,
    hash_token,
    not_found,
    ok,
    problem_responses,
    run_idempotent,
    validation_failed,
)

if TYPE_CHECKING:
    from .main import AppContext

log = logging.getLogger(__name__)

LoginQrJson = Annotated[dict[str, Any], contract_ref("./schemas/login_qr.json")]
DateTimeStr = Annotated[str, Field(json_schema_extra={"format": "date-time"})]
DeviceIdPath = Annotated[str, contract_ref("./schemas/common.json#/$defs/device_id")]
REDACTED = "******"
_IDEMPOTENCY_SECRET = secrets.token_bytes(32)  # 进程重启后同键重放会得到 422，可接受（控制台每次点击生成新键）
# 人工输入请求的默认有效期（契约 0.3.2 INPUT_REQUEST_TTL_SECONDS，短信验证码通常 5–10 分钟失效）
INPUT_REQUEST_TTL = timedelta(seconds=INPUT_REQUEST_TTL_SECONDS)


# ---------------------------------------------------------------------------
# HTTP 形状
# ---------------------------------------------------------------------------


class LoginQrAccepted(BaseModel):
    device_id: str
    qr_seq: int
    expires_at: DateTimeStr


class LoginQrView(BaseModel):
    device_id: str
    qr_payload: str
    qr_seq: int
    captured_at: DateTimeStr
    expires_at: DateTimeStr


class LoginQrViewRecord(BaseModel):
    viewer: str
    viewed_at: DateTimeStr
    qr_seq: int


class LoginQrViewList(BaseModel):
    items: list[LoginQrViewRecord]


class InputResponse(ApiModel):
    value: Annotated[str, Field(min_length=1, max_length=64, json_schema_extra={"writeOnly": True})]


# ---------------------------------------------------------------------------
# 存储
# ---------------------------------------------------------------------------


class LoginRelayStore:
    def __init__(self, store: SqliteStore):
        self._s = store

    # -- 二维码 ---------------------------------------------------------------

    def upsert_qr(self, qr: dict[str, Any], now: str) -> dict[str, Any]:
        """保存新码（qr_seq 不小于当前值时覆盖），返回当前生效的记录。"""
        with self._s._tx() as c:
            current = c.execute("SELECT * FROM login_qrs WHERE device_id = ?", (qr["device_id"],)).fetchone()
            values = (
                qr.get("account_id"),
                qr["qr_payload"],
                qr["qr_seq"],
                to_db_time(parse_time(qr["captured_at"])),
                to_db_time(parse_time(qr["expires_at"])),
                qr["decoder"],
                now,
                qr["device_id"],
            )
            if current is None:
                c.execute(
                    """INSERT INTO login_qrs (account_id, qr_payload, qr_seq, captured_at, expires_at, decoder,
                           uploaded_at, device_id) VALUES (?,?,?,?,?,?,?,?)""",
                    values,
                )
            elif qr["qr_seq"] >= current["qr_seq"]:
                c.execute(
                    """UPDATE login_qrs SET account_id = ?, qr_payload = ?, qr_seq = ?, captured_at = ?, expires_at = ?,
                           decoder = ?, uploaded_at = ?, withdrawn_at = NULL, withdrawn_by = NULL WHERE device_id = ?""",
                    values,
                )
            row = c.execute("SELECT * FROM login_qrs WHERE device_id = ?", (qr["device_id"],)).fetchone()
            return dict(row)

    def get_qr(self, device_id: str) -> dict[str, Any] | None:
        r = self._s._one("SELECT * FROM login_qrs WHERE device_id = ?", (device_id,))
        return None if r is None else dict(r)

    def withdraw(self, device_id: str, by: str, now: str) -> bool:
        """撤下并删除内容；没有二维码或已撤下返回 False。"""
        with self._s._tx() as c:
            cur = c.execute(
                """UPDATE login_qrs SET withdrawn_at = ?, withdrawn_by = ?, qr_payload = NULL
                   WHERE device_id = ? AND withdrawn_at IS NULL""",
                (now, by, device_id),
            )
            return cur.rowcount == 1

    def purge_expired(self, now: str) -> int:
        """删除已过期二维码的内容（只留元数据）；返回清理条数。"""
        with self._s._tx() as c:
            return c.execute(
                "UPDATE login_qrs SET qr_payload = NULL WHERE qr_payload IS NOT NULL AND expires_at <= ?", (now,)
            ).rowcount

    def record_view(self, device_id: str, viewer: str, now: str, qr_seq: int) -> None:
        with self._s._tx() as c:
            c.execute(
                "INSERT INTO login_qr_views (device_id, viewer, viewed_at, qr_seq) VALUES (?,?,?,?)",
                (device_id, viewer, now, qr_seq),
            )

    def views(self, device_id: str) -> list[dict[str, Any]]:
        rows = self._s._all(
            "SELECT viewer, viewed_at, qr_seq FROM login_qr_views WHERE device_id = ? ORDER BY seq", (device_id,)
        )
        return [{"viewer": r["viewer"], "viewed_at": wire_time(r["viewed_at"]), "qr_seq": r["qr_seq"]} for r in rows]

    # -- 人工输入请求 -----------------------------------------------------------

    def insert_input_request(self, row: dict[str, Any]) -> bool:
        with self._s._tx() as c:
            cur = c.execute(
                """INSERT OR IGNORE INTO input_requests (input_request_id, device_id, account_id, event_id, input_kind,
                       prompt_text, can_fill, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)""",
                (
                    row["input_request_id"],
                    row["device_id"],
                    row["account_id"],
                    row["event_id"],
                    row["input_kind"],
                    row["prompt_text"],
                    int(row["can_fill"]),
                    row["created_at"],
                    row["expires_at"],
                ),
            )
            return cur.rowcount == 1

    def get_input_request(self, input_request_id: str) -> dict[str, Any] | None:
        r = self._s._one("SELECT * FROM input_requests WHERE input_request_id = ?", (input_request_id,))
        return None if r is None else {**dict(r), "can_fill": bool(r["can_fill"])}

    def claim_input_request(self, input_request_id: str, command_id: str, actor: str, now: str) -> bool:
        """原子地把请求标为已回应；已回应返回 False。"""
        with self._s._tx() as c:
            cur = c.execute(
                """UPDATE input_requests SET command_id = ?, responded_by = ?, responded_at = ?
                   WHERE input_request_id = ? AND command_id IS NULL""",
                (command_id, actor, now, input_request_id),
            )
            return cur.rowcount == 1

    def release_input_request(self, input_request_id: str, command_id: str) -> None:
        with self._s._tx() as c:
            c.execute(
                """UPDATE input_requests SET command_id = NULL, responded_by = NULL, responded_at = NULL
                   WHERE input_request_id = ? AND command_id = ?""",
                (input_request_id, command_id),
            )

    def scrub_command_value(self, command_id: str) -> bool:
        """把 provide_input 指令里保存的人工输入值抹掉（commands 表由 F1 定义，这里只改 payload.value）。"""
        with self._s._tx() as c:
            r = c.execute(
                "SELECT command_json FROM commands WHERE command_id = ? AND action = 'provide_input'", (command_id,)
            ).fetchone()
            if r is None:
                return False
            command = json.loads(r["command_json"])
            if command.get("payload", {}).get("value") == REDACTED:
                return False
            command["payload"]["value"] = REDACTED
            c.execute("UPDATE commands SET command_json = ? WHERE command_id = ?", (canonical_json(command), command_id))
            return True

    def finished_input_commands(self, now: str) -> list[str]:
        rows = self._s._all(
            """SELECT command_id FROM commands WHERE action = 'provide_input'
                 AND (result_json IS NOT NULL OR server_status IN ('cancelled', 'expired') OR expires_at <= ?)""",
            (now,),
        )
        return [r["command_id"] for r in rows]


# ---------------------------------------------------------------------------
# 业务
# ---------------------------------------------------------------------------


def redact_command_record(record: dict[str, Any]) -> dict[str, Any]:
    """CommandRecord 里的 provide_input 值打码（返回副本）。"""
    command = record.get("command") or {}
    if command.get("action") != "provide_input":
        return record
    redacted = json.loads(json.dumps(record))
    redacted["command"]["payload"]["value"] = REDACTED
    return redacted


class LoginRelayService:
    def __init__(self, ctx: AppContext):
        self.ctx = ctx
        self.store = LoginRelayStore(ctx.store)  # type: ignore[arg-type]
        self.input_request_ttl = INPUT_REQUEST_TTL
        self._unsubscribe = ctx.bus.subscribe(self._on_message)  # type: ignore[arg-type]

    def _now(self) -> str:
        return to_db_time(self.ctx.clock.now())

    # -- 二维码 ---------------------------------------------------------------

    def upload(self, device_id: str, mode: str, body: Any) -> dict[str, Any]:
        if mode != "remote":
            raise ApiError(403, "local_mode", "本机模式设备不做二维码接力，请在本机 BOSS 客户端登录")
        errors = check("login_qr", body)
        if errors:
            raise validation_failed(errors)
        if body["device_id"] != device_id:
            raise ApiError(403, "device_mismatch", "请求体 device_id 与设备令牌不符")
        row = self.store.upsert_qr(body, self._now())
        return {"device_id": device_id, "qr_seq": row["qr_seq"], "expires_at": wire_time(row["expires_at"])}

    def is_active(self, device_id: str) -> bool:
        """设备卡片上的 login_qr_active：有未过期、未撤下的二维码。"""
        row = self.store.get_qr(device_id)
        return (
            row is not None
            and row["withdrawn_at"] is None
            and row["qr_payload"] is not None
            and row["expires_at"] > self._now()
        )

    def view(self, device_id: str, viewer: str) -> dict[str, Any]:
        if self.ctx.store.get_device(device_id) is None:
            raise not_found("设备")
        row = self.store.get_qr(device_id)
        if row is None:
            raise not_found("登录二维码")
        now = self._now()
        if row["withdrawn_at"] is not None:
            raise ApiError(410, "qr_withdrawn", "二维码已撤下")
        if row["expires_at"] <= now or row["qr_payload"] is None:
            self.store.purge_expired(now)
            raise ApiError(410, "qr_expired", "二维码已过期，等待设备刷新")
        self.store.record_view(device_id, viewer, now, row["qr_seq"])
        return {
            "device_id": device_id,
            "qr_payload": row["qr_payload"],
            "qr_seq": row["qr_seq"],
            "captured_at": wire_time(row["captured_at"]),
            "expires_at": wire_time(row["expires_at"]),
        }

    def withdraw(self, device_id: str, by: str) -> bool:
        if self.ctx.store.get_device(device_id) is None:
            raise not_found("设备")
        return self.store.withdraw(device_id, by, self._now())

    def views(self, device_id: str) -> list[dict[str, Any]]:
        if self.ctx.store.get_device(device_id) is None:
            raise not_found("设备")
        return self.store.views(device_id)

    # -- 人工输入 ---------------------------------------------------------------

    def respond(self, input_request_id: str, value: str, actor: str) -> dict[str, Any]:
        """生成 provide_input 指令，返回打码后的 CommandRecord。value 不写日志。"""
        req = self.store.get_input_request(input_request_id)
        if req is None:
            raise not_found("人工输入请求")
        if not req["can_fill"]:
            raise ApiError(409, "input_not_fillable", "该请求不能代填（滑块、手机确认等需在设备或手机上处理）")
        if req["command_id"] is not None:
            raise ApiError(409, "input_already_responded", "该请求已经回应过")
        now = self.ctx.clock.now()
        if req["expires_at"] <= to_db_time(now):
            raise ApiError(409, "input_request_expired", "该请求已过期")
        account_id = req["account_id"]
        if account_id is None:
            binding = self.ctx.store.get_binding(req["device_id"])
            account_id = None if binding is None else binding.account_id
        if account_id is None:
            raise ApiError(409, "account_unbound", "发出请求的设备还没有确认绑定账户，无法下发指令")
        command_id = str(uuid.uuid4())
        if not self.store.claim_input_request(input_request_id, command_id, actor, to_db_time(now)):
            raise ApiError(409, "input_already_responded", "该请求已经回应过")
        command = {
            "command_id": command_id,
            "workflow_id": None,
            "account_id": account_id,
            "action": "provide_input",
            "execution_mode": "execute",
            "target": {"input_request_id": input_request_id},
            "payload": {"value": value},
            "issued_at": wire_time(to_db_time(now)),
            "expires_at": wire_time(req["expires_at"]),
            "depends_on": None,
        }
        try:
            record = self.ctx.commands.create_command(command, device_id=req["device_id"])
        except CommandCreateError as exc:
            self.store.release_input_request(input_request_id, command_id)
            # 错误里可能带值的片段：只回字段路径与错误码
            raise validation_failed(
                [{"path": getattr(e, "path", ""), "message": "不符合契约", "code": getattr(e, "code", exc.code)} for e in exc.errors]
                or [{"path": "value", "message": "不符合契约", "code": exc.code}]
            ) from None
        log.info("人工输入请求 %s 已由 %s 回应，生成 provide_input 指令 %s", input_request_id, actor, command_id)
        return redact_command_record(record)

    def scrub_finished_inputs(self) -> int:
        """把已有结果、已取消或已过期的 provide_input 指令中的值抹掉；返回处理条数。"""
        return sum(self.store.scrub_command_value(cid) for cid in self.store.finished_input_commands(self._now()))

    # -- 事件 -----------------------------------------------------------------

    def _on_message(self, message: Any) -> None:
        if isinstance(message, EventReceived):
            if message.kind == "login_ok":
                self.store.withdraw(message.device_id, "event:login_ok", self._now())
            elif message.kind == "human_input_required":
                self._register_input_request(message)
        elif isinstance(message, CommandResultRecorded) and message.record["command"]["action"] == "provide_input":
            self.store.scrub_command_value(message.command_id)

    def _register_input_request(self, message: EventReceived) -> None:
        """登记人工输入请求。有效期（0.3.2）取事件 payload.expires_at；为空时取 observed_at + 默认有效期。
        设备离线补报的旧请求可能登记时就已过期，此时提交返回 409 input_request_expired。"""
        event = message.record["event"]
        payload = event["payload"]
        now = self.ctx.clock.now()
        if payload.get("expires_at"):
            expires = parse_time(payload["expires_at"])
        else:
            expires = parse_time(event["observed_at"]) + self.input_request_ttl
        self.store.insert_input_request(
            {
                "input_request_id": str(uuid.UUID(payload["input_request_id"])),
                "device_id": message.device_id,
                "account_id": message.account_id,
                "event_id": message.event_id,
                "input_kind": payload["input_kind"],
                "prompt_text": payload["prompt_text"],
                "can_fill": bool(payload["can_fill"]),
                "created_at": to_db_time(now),
                "expires_at": to_db_time(expires),
            }
        )


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------

router = APIRouter(tags=["login"])


def require_device_or_console(
    request: Request,
    device: Annotated[BearerCred, Security(device_bearer)],
    console: Annotated[BearerCred, Security(console_bearer)],
) -> tuple[str, str]:
    """设备令牌或控制台会话任一有效即可：返回 ("device", device_id) 或 ("console", actor)。"""
    ctx = get_ctx(request)
    cred = device or console
    if cred is None:
        raise ApiError(401, "unauthorized", "未认证或令牌已吊销")
    row = ctx.store.get_device_by_token_hash(hash_token(cred.credentials))
    if row is not None and not row.revoked:
        return "device", row.device_id
    actor = ctx.console_auth.authenticate(cred.credentials)
    if actor is not None:
        return "console", actor
    raise ApiError(401, "unauthorized", "未认证或令牌已吊销")


@router.post(
    "/login-qr",
    operation_id="postLoginQr",
    summary="独立设备上传登录二维码内容",
    status_code=201,
    response_model=LoginQrAccepted,
    responses=problem_responses(401, 403, 422),
)
def post_login_qr(
    request: Request,
    ctx: Ctx,
    device: DeviceAuth,
    idempotency_key: IdempotencyKeyHeader,
    body: Annotated[LoginQrJson, Body()],
):
    return run_idempotent(
        ctx,
        request,
        f"device:{device.device_id}",
        idempotency_key,
        body,
        lambda: (201, ctx.login_relay.upload(device.device_id, device.mode, body)),
    )


@router.get(
    "/devices/{device_id}/login-qr",
    operation_id="getLoginQr",
    summary="控制台读取当前登录二维码（记录查看者）",
    response_model=LoginQrView,
    responses={
        200: {"headers": {"Cache-Control": {"description": "固定为 no-store", "schema": {"type": "string"}}}},
        **problem_responses(401, 404, 410),
    },
)
def get_login_qr(ctx: Ctx, actor: ConsoleActor, device_id: DeviceIdPath):
    resp = ok(ctx.login_relay.view(device_id, actor))
    resp.headers["Cache-Control"] = "no-store"
    return resp


@router.post(
    "/devices/{device_id}/login-qr:withdraw",
    operation_id="withdrawLoginQr",
    summary="撤下二维码（登录完成或设备放弃本次登录）",
    status_code=204,
    response_class=Response,
    responses=problem_responses(401, 403, 404),
)
def withdraw_login_qr(
    ctx: Ctx,
    device_id: DeviceIdPath,
    principal: Annotated[tuple[str, str], Depends(require_device_or_console)],
    idempotency_key: IdempotencyKeyHeader,
):
    # 撤下本身幂等（重复调用同样 204），不需要保存首次响应；Idempotency-Key 只做格式校验
    kind, who = principal
    if kind == "device" and who != device_id:
        raise ApiError(403, "device_mismatch", "路径中的 device_id 与设备令牌不符")
    ctx.login_relay.withdraw(device_id, f"{kind}:{who}")
    return Response(status_code=204)


@router.get(
    "/devices/{device_id}/login-qr/views",
    operation_id="listLoginQrViews",
    summary="二维码查看记录",
    response_model=LoginQrViewList,
    responses=problem_responses(401, 404),
)
def list_login_qr_views(ctx: Ctx, _actor: ConsoleActor, device_id: DeviceIdPath):
    return ok({"items": ctx.login_relay.views(device_id)})


@router.post(
    "/input-requests/{input_request_id}/response",
    operation_id="respondInputRequest",
    summary="控制台提交人工输入（生成 provide_input 指令）",
    status_code=201,
    response_model=CommandRecord,
    responses=problem_responses(401, 404, 409),
)
def respond_input_request(
    request: Request,
    ctx: Ctx,
    input_request_id: uuid.UUID,
    actor: ConsoleActor,
    idempotency_key: IdempotencyKeyHeader,
    body: Annotated[InputResponse, Body()],
):
    return run_idempotent(
        ctx,
        request,
        f"console:{actor}",
        idempotency_key,
        # 幂等记录里只放进程内密钥做的 HMAC，不放可被穷举的明文哈希（验证码只有几位数字）
        {"value_hmac": hmac.new(_IDEMPOTENCY_SECRET, body.value.encode(), hashlib.sha256).hexdigest()},
        lambda: (201, ctx.login_relay.respond(str(input_request_id), body.value, actor)),
    )


__all__ = [
    "INPUT_REQUEST_TTL",
    "LoginRelayService",
    "LoginRelayStore",
    "REDACTED",
    "redact_command_record",
    "require_device_or_console",
    "router",
]
