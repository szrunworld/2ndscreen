"""指令队列：创建（供 F2/F3 调用）、长轮询领取、ack、结果回报、取消、查询。

服务端视角状态（api.md 第五节）：
    pending → claimed（租约中）→ acked → 与 command_result.status 相同的终态
- 租约过期未 ack：claimed 回到 pending，可被重新领取（同一 command_id）。
- 从未被领取就过期：服务端置 expired；被领取过的指令以设备回报为准。
- pending 时取消：直接 cancelled；已领取：登记 cancel_requested，经心跳与领取响应的
  cancellations 通知设备，最终状态以设备回报为准。
"""

from __future__ import annotations

import threading
import time
import uuid
from collections.abc import Mapping
from datetime import timedelta
from typing import TYPE_CHECKING, Annotated, Any, Literal

from fastapi import APIRouter, Body, Query, Request
from pydantic import BaseModel, Field
from pydantic.json_schema import SkipJsonSchema

from monitor_contracts import check, validate_command_result

from .db import CommandFilter, CommandRow, ManualActionRow, canonical_json, parse_time, to_db_time, wire_time
from .events import CommandResultRecorded
from .main import (
    AccountIdStr,
    ApiError,
    ApiModel,
    CommandJson,
    CommandResultJson,
    ConsoleActor,
    ConsoleOrService,
    Ctx,
    DeviceAuth,
    IdempotencyKeyHeader,
    NoteBody,
    check_cursor,
    not_found,
    ok,
    problem_responses,
    run_idempotent,
    validation_failed,
)

if TYPE_CHECKING:
    from .main import AppContext

COMMAND_SERVER_STATUSES = (
    "pending",
    "claimed",
    "acked",
    "succeeded",
    "failed",
    "cancelled",
    "expired",
    "skipped_precondition",
    "unknown",
)
LEDGER_STATES = ("queued", "running", "succeeded", "failed", "cancelled", "expired", "skipped_precondition", "unknown")
ServerStatus = Literal[
    "pending", "claimed", "acked", "succeeded", "failed", "cancelled", "expired", "skipped_precondition", "unknown"
]
DateTimeStr = Annotated[str, Field(json_schema_extra={"format": "date-time"})]
UuidStr = Annotated[str, Field(json_schema_extra={"format": "uuid"})]


# ---------------------------------------------------------------------------
# HTTP 形状（用于生成 openapi；响应体由下面的 *_record 函数按同样形状组装）
# ---------------------------------------------------------------------------


class ClaimRequest(ApiModel):
    account_id: AccountIdStr
    max_commands: Annotated[int, Field(ge=1, le=10)]
    wait_seconds: Annotated[int, Field(ge=0, le=30)]


class ClaimResponse(BaseModel):
    commands: list[CommandJson]
    cancellations: list[UuidStr]
    lease_seconds: Annotated[int, Field(ge=1)]
    server_time: DateTimeStr


class AckRequest(ApiModel):
    device_id: str
    ledger_state: Literal[
        "queued", "running", "succeeded", "failed", "cancelled", "expired", "skipped_precondition", "unknown"
    ]
    received_at: Annotated[str, Field(json_schema_extra={"format": "date-time"})]


class ManualActionTarget(BaseModel):
    kind: Literal["command", "resume_document", "case"]
    id: str


class ManualAction(BaseModel):
    manual_action_id: str
    type: Literal["confirm_sent", "link_resume", "stop_case", "recheck", "cancel_command", "request_wechat"]
    actor: str
    at: DateTimeStr
    note: str
    target: ManualActionTarget


class CommandRecord(BaseModel):
    command: CommandJson
    case_id: str | None = None
    server_status: ServerStatus
    device_id: str | None
    created_at: DateTimeStr
    claimed_at: DateTimeStr | None = None
    acked_at: DateTimeStr | None = None
    cancel_requested: bool | SkipJsonSchema[None] = None
    result: CommandResultJson | None
    manual_actions: list[ManualAction]


class CommandList(BaseModel):
    items: list[CommandRecord]
    next_cursor: str | None


class ResultAccepted(BaseModel):
    command_id: UuidStr
    duplicate: bool
    recorded_result: CommandResultJson


# ---------------------------------------------------------------------------
# 长轮询通知
# ---------------------------------------------------------------------------


class CommandNotifier:
    """指令可领取性可能变化时（新建、结果、取消、恢复、绑定）唤醒长轮询。

    用代数计数避免丢失唤醒：领取前记下 generation，等待到它变化或超时。
    """

    def __init__(self) -> None:
        self._cond = threading.Condition()
        self._generation = 0
        self.waiting = 0  # 正在等待的长轮询数（测试用它判断"已进入等待"，不用 sleep）

    @property
    def generation(self) -> int:
        with self._cond:
            return self._generation

    def notify(self) -> None:
        with self._cond:
            self._generation += 1
            self._cond.notify_all()

    def wait(self, since: int, timeout: float) -> bool:
        """等待 generation 超过 since；返回是否被唤醒（False 表示超时）。"""
        deadline = time.monotonic() + timeout
        with self._cond:
            self.waiting += 1
            try:
                while self._generation == since:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        return False
                    self._cond.wait(remaining)
                return True
            finally:
                self.waiting -= 1


# ---------------------------------------------------------------------------
# 业务
# ---------------------------------------------------------------------------


class CommandCreateError(ValueError):
    """create_command 的输入错误。code：validation_failed / command_conflict / dependency_not_found。"""

    def __init__(self, code: str, message: str, errors: list[Any] | None = None):
        super().__init__(message)
        self.code = code
        self.errors = errors or []


def manual_action_record(row: ManualActionRow) -> dict[str, Any]:
    return {
        "manual_action_id": row.manual_action_id,
        "type": row.type,
        "actor": row.actor,
        "at": wire_time(row.at),
        "note": row.note,
        "target": {"kind": row.target_kind, "id": row.target_id},
    }


class CommandService:
    def __init__(self, ctx: AppContext):
        self.ctx = ctx

    # -- 供 F2/F3 调用 ------------------------------------------------------

    def create_command(
        self, command: Mapping[str, Any], *, case_id: str | None = None, device_id: str | None = None
    ) -> dict[str, Any]:
        """创建一条指令（线上 command 形状），返回 CommandRecord。

        - 按契约校验；不合法抛 CommandCreateError(validation_failed)。
        - depends_on 必须是已存在、同一账户的指令，否则 CommandCreateError(dependency_not_found)。
        - 按 command_id 幂等：相同内容重复创建返回已有记录；内容不同抛 CommandCreateError(command_conflict)。
        - device_id 指定只允许某台设备领取；None 表示该账户下任何已确认绑定的设备。
        - 在 ``store.transaction()`` 块内调用时，插入加入调用方事务：调用方抛异常时指令一起回滚
          （F2 用它让"创建指令"与"更新流程"同一事务提交）。
        - issued_at 晚于当前时间的指令，在 issued_at 之前不会被领取。
        """
        data = dict(command)
        errors = check("command", data)
        if errors:
            raise CommandCreateError("validation_failed", "指令不符合契约", errors)
        command_id = str(uuid.UUID(data["command_id"]))
        depends_on = data.get("depends_on")
        if depends_on is not None:
            depends_on = str(uuid.UUID(depends_on))
            dep = self.ctx.store.get_command(depends_on)
            if dep is None or dep.account_id != data["account_id"]:
                raise CommandCreateError("dependency_not_found", f"依赖指令 {depends_on} 不存在或不属于同一账户")
        row = CommandRow(
            command_id=command_id,
            account_id=data["account_id"],
            action=data["action"],
            command=data,
            expires_at=to_db_time(parse_time(data["expires_at"])),
            created_at=to_db_time(self.ctx.clock.now()),
            case_id=case_id if case_id is not None else data.get("workflow_id"),
            device_id=device_id,
            depends_on=depends_on,
        )
        if not self.ctx.store.insert_command(row):
            existing = self.ctx.store.get_command(command_id)
            assert existing is not None
            if canonical_json(existing.command) != canonical_json(data) or existing.device_id != device_id:
                raise CommandCreateError("command_conflict", f"command_id {command_id} 已存在且内容不同")
            return self.record(existing)
        self.ctx.notifier.notify()
        stored = self.ctx.store.get_command(command_id)
        assert stored is not None
        return self.record(stored)

    def get(self, command_id: str) -> dict[str, Any] | None:
        row = self.ctx.store.get_command(command_id)
        return None if row is None else self.record(row)

    def record(self, row: CommandRow) -> dict[str, Any]:
        """组装 openapi CommandRecord。"""
        manual = self.ctx.store.list_manual_actions("command", row.command_id)
        return {
            "command": row.command,
            "case_id": row.case_id,
            "server_status": row.server_status,
            "device_id": row.claimed_by or row.device_id,
            "created_at": wire_time(row.created_at),
            "claimed_at": wire_time(row.claimed_at),
            "acked_at": wire_time(row.acked_at),
            "cancel_requested": row.cancel_requested,
            "result": row.result,
            "manual_actions": [manual_action_record(m) for m in manual],
        }

    # -- 设备侧 -------------------------------------------------------------

    def claimable_account(self, device_id: str, account_id: str) -> bool:
        """设备当前能否为该账户领取：未暂停、不需重建基线、绑定已确认且与心跳一致。"""
        device = self.ctx.store.get_device(device_id)
        binding = self.ctx.store.get_binding(device_id)
        if device is None or device.revoked or device.paused or binding is None:
            return False
        if binding.account_id != account_id:
            return False
        hb = device.last_heartbeat
        # 还没有心跳、心跳账户与绑定不一致或需要重建基线时都不下发（api.md 3.1、3.3）
        if hb is None or hb.get("account_id") != binding.account_id or hb.get("needs_baseline"):
            return False
        return True

    def claim(self, device_id: str, account_id: str, max_commands: int, wait_seconds: int) -> dict[str, Any]:
        """长轮询领取。无可领取指令时最多等待 wait_seconds 秒（真实时间），期间有变化立即重试。"""
        wait = min(wait_seconds, self.ctx.settings.max_wait_seconds)
        deadline = time.monotonic() + wait
        lease = self.ctx.settings.lease_seconds
        while True:
            generation = self.ctx.notifier.generation
            rows: list[CommandRow] = []
            if self.claimable_account(device_id, account_id):
                now = self.ctx.clock.now()
                rows = self.ctx.store.claim_commands(
                    device_id, account_id, to_db_time(now), to_db_time(now + timedelta(seconds=lease)), max_commands
                )
            remaining = deadline - time.monotonic()
            if rows or remaining <= 0:
                break
            self.ctx.notifier.wait(generation, remaining)
        return {
            "commands": [r.command for r in rows],
            "cancellations": self.ctx.store.cancellations_for(device_id),
            "lease_seconds": lease,
            "server_time": _now_wire(self.ctx),
        }

    def ack(self, command_id: str, device_id: str) -> dict[str, Any]:
        row = self.ctx.store.get_command(command_id)
        if row is None:
            raise not_found("指令")
        if not self.ctx.store.ack_command(command_id, device_id, to_db_time(self.ctx.clock.now())):
            raise ApiError(409, "command_not_owned", "指令不属于该设备（未由该设备领取或已被其他设备重新领取）")
        stored = self.ctx.store.get_command(command_id)
        assert stored is not None
        return self.record(stored)

    def report_result(self, command_id: str, device_id: str, body: Any) -> tuple[bool, dict[str, Any]]:
        """记录结果，返回 (duplicate, 已记录结果)。冲突抛 409 result_conflict（existing 带首次结果）。"""
        errors = check("command_result", body)
        if errors:
            raise validation_failed(errors)
        if str(uuid.UUID(body["command_id"])) != command_id:
            raise validation_failed([_err("command_id", "请求体 command_id 与路径不一致", "path_mismatch")])
        row = self.ctx.store.get_command(command_id)
        if row is None:
            raise not_found("指令")
        mismatched = [
            _err(name, f"与指令的 {name}={expected!r} 不一致", "command_mismatch")
            for name, expected in (
                ("action", row.command["action"]),
                ("execution_mode", row.command.get("execution_mode", "execute")),
            )
            if body.get(name, "execute" if name == "execution_mode" else None) != expected
        ]
        if mismatched:
            raise validation_failed(mismatched)
        if row.result is None:
            executed_at = body.get("executed_at")
            written = self.ctx.store.record_result(
                command_id,
                device_id,
                body,
                body["status"],
                None if executed_at is None else to_db_time(parse_time(executed_at)),
                to_db_time(self.ctx.clock.now()),
            )
            if written:
                stored = self.ctx.store.get_command(command_id)
                assert stored is not None
                self.ctx.notifier.notify()  # 依赖它的指令可能可以领取了
                self.ctx.bus.publish(
                    CommandResultRecorded(command_id, stored.case_id, body["status"], self.record(stored))
                )
                return False, body
            row = self.ctx.store.get_command(command_id)
            assert row is not None
            if row.result is None:
                raise ApiError(409, "command_not_owned", "指令不属于该设备（未由该设备领取）")
        assert row.result is not None
        if _same_result(row.result, body):
            return True, row.result
        raise ApiError(409, "result_conflict", "该指令已有不同的结果", existing=row.result)

    # -- 控制台 -------------------------------------------------------------

    def cancel(self, command_id: str, actor: str, note: str | None) -> dict[str, Any]:
        row = self.ctx.store.get_command(command_id)
        if row is None:
            raise not_found("指令")
        if row.server_status == "cancelled" and row.result is None:
            return self.record(row)  # 已取消：不再重复记录
        now = to_db_time(self.ctx.clock.now())
        if not self.ctx.store.request_cancel(command_id, now):
            current = self.ctx.store.get_command(command_id)
            raise ApiError(
                409, "command_final", "指令已有最终结果，不能取消", existing=None if current is None else current.result
            )
        self.ctx.store.insert_manual_action(
            ManualActionRow(
                manual_action_id=f"ma_{uuid.uuid4().hex}",
                type="cancel_command",
                actor=actor,
                at=now,
                note=note or "",
                target_kind="command",
                target_id=command_id,
            )
        )
        self.ctx.notifier.notify()
        stored = self.ctx.store.get_command(command_id)
        assert stored is not None
        return self.record(stored)


def _same_result(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """按契约归一化后比较（补齐默认值、统一 UUID 与时间写法）。"""
    return canonical_json(validate_command_result(a).to_wire()) == canonical_json(validate_command_result(b).to_wire())


def _err(path: str, message: str, code: str) -> dict[str, str]:
    return {"path": path, "message": message, "code": code}


def _now_wire(ctx: AppContext) -> str:
    return wire_time(to_db_time(ctx.clock.now()))  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------

router = APIRouter(tags=["commands"])


@router.post(
    "/devices/{device_id}/commands:claim",
    operation_id="claimCommands",
    summary="长轮询领取指令",
    response_model=ClaimResponse,
    responses=problem_responses(401, 403, 422),
)
def claim_commands(
    request: Request,
    ctx: Ctx,
    device_id: str,
    device: DeviceAuth,
    idempotency_key: IdempotencyKeyHeader,
    body: Annotated[ClaimRequest, Body()],
):
    if device_id != device.device_id:
        raise ApiError(403, "device_mismatch", "路径中的 device_id 与设备令牌不符")
    payload = body.model_dump(mode="json")
    return run_idempotent(
        ctx,
        request,
        f"device:{device_id}",
        idempotency_key,
        payload,
        lambda: (200, ctx.commands.claim(device_id, body.account_id, body.max_commands, body.wait_seconds)),
    )


@router.get(
    "/commands",
    operation_id="listCommands",
    summary="指令列表（控制台执行记录；邮件接入查询求简历记录，用于按执行时间窗关联邮件）",
    response_model=CommandList,
    responses=problem_responses(401),
)
def list_commands(
    ctx: Ctx,
    _actor: ConsoleOrService,
    case_id: str | None = None,
    account_id: str | None = None,
    action: Literal[
        "send_greeting",
        "request_resume",
        "request_contact_exchange",
        "search_candidates",
        "provide_input",
    ]
    | None = None,
    status: Annotated[list[ServerStatus] | None, Query(description="可重复，如 status=unknown&status=failed")] = None,
    executed_after: Annotated[str | None, Query(json_schema_extra={"format": "date-time"})] = None,
    executed_before: Annotated[str | None, Query(json_schema_extra={"format": "date-time"})] = None,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
):
    flt = CommandFilter(
        case_id=case_id,
        account_id=account_id,
        action=action,
        statuses=tuple(status or ()),
        executed_after=_query_time("executed_after", executed_after),
        executed_before=_query_time("executed_before", executed_before),
    )
    page = ctx.store.list_commands(flt, check_cursor(cursor), limit)
    return ok({"items": [ctx.commands.record(r) for r in page.items], "next_cursor": page.next_cursor})


def _query_time(name: str, value: str | None) -> str | None:
    if value is None:
        return None
    try:
        parsed = parse_time(value)
    except ValueError:
        parsed = None
    if parsed is None or parsed.tzinfo is None:
        raise validation_failed([_err(f"query.{name}", "应为带时区的 RFC 3339 时间", "format")])
    return to_db_time(parsed)


@router.get(
    "/commands/{command_id}",
    operation_id="getCommand",
    summary="指令详情（含结果、人工处理记录）",
    response_model=CommandRecord,
    responses=problem_responses(401, 404),
)
def get_command(ctx: Ctx, _actor: ConsoleActor, command_id: uuid.UUID):
    record = ctx.commands.get(str(command_id))
    if record is None:
        raise not_found("指令")
    return ok(record)


@router.post(
    "/commands/{command_id}/ack",
    operation_id="ackCommand",
    summary="Monitor 确认已把指令写入本地账本",
    response_model=CommandRecord,
    responses=problem_responses(401, 403, 404, 409),
)
def ack_command(
    request: Request,
    ctx: Ctx,
    command_id: uuid.UUID,
    device: DeviceAuth,
    idempotency_key: IdempotencyKeyHeader,
    body: Annotated[AckRequest, Body()],
):
    if body.device_id != device.device_id:
        raise ApiError(403, "device_mismatch", "请求体 device_id 与设备令牌不符")
    return run_idempotent(
        ctx,
        request,
        f"device:{device.device_id}",
        idempotency_key,
        body.model_dump(mode="json"),
        lambda: (200, ctx.commands.ack(str(command_id), device.device_id)),
    )


@router.post(
    "/commands/{command_id}/result",
    operation_id="reportCommandResult",
    summary="回报指令最终结果",
    response_model=ResultAccepted,
    responses=problem_responses(401, 404, 409, 422),
)
def report_result(
    request: Request,
    ctx: Ctx,
    command_id: uuid.UUID,
    device: DeviceAuth,
    idempotency_key: IdempotencyKeyHeader,
    body: Annotated[CommandResultJson, Body()],
):
    def handle() -> tuple[int, Any]:
        duplicate, recorded = ctx.commands.report_result(str(command_id), device.device_id, body)
        return 200, {"command_id": str(command_id), "duplicate": duplicate, "recorded_result": recorded}

    return run_idempotent(ctx, request, f"device:{device.device_id}", idempotency_key, body, handle)


@router.post(
    "/commands/{command_id}:cancel",
    operation_id="cancelCommand",
    summary="取消指令",
    response_model=CommandRecord,
    responses=problem_responses(401, 404, 409),
)
def cancel_command(
    request: Request,
    ctx: Ctx,
    command_id: uuid.UUID,
    actor: ConsoleActor,
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
        lambda: (200, ctx.commands.cancel(str(command_id), actor, note)),
    )


__all__ = [
    "COMMAND_SERVER_STATUSES",
    "CommandCreateError",
    "CommandNotifier",
    "CommandService",
    "LEDGER_STATES",
    "manual_action_record",
    "router",
]
