"""人工处理：确认已发送、重新检查、停止流程、人工换微信。

共同规则（api.md 第四节、方案第十节第 4 条）：
- 每次处理都写一条 manual_actions（actor、时间、说明），不覆盖原始执行结果与证据；
- 结果未知（unknown）的指令只给"重新检查 / 人工确认已发送 / 停止此流程"，没有重试接口；
- 换微信只能在这里由人工触发（POST /cases/{id}:request-wechat），自动流程不生成该指令。
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Annotated, Any

from fastapi import APIRouter, Body, Path, Request
from monitor_contracts import CaseStage
from pydantic import BaseModel, ConfigDict, StringConstraints

from .cases import StageNotAllowed
from .commands import CommandRecord, ManualAction, manual_action_record
from .db import ManualActionRow, parse_time, to_db_time, wire_time
from .main import (
    ApiError,
    ApiModel,
    ConsoleActor,
    Ctx,
    IdempotencyKeyHeader,
    not_found,
    problem_responses,
    run_idempotent,
)
from .policy import GATE_REASON_TEXT

if TYPE_CHECKING:
    from .main import AppContext

S = CaseStage
OPEN_SERVER_STATUSES = ("pending", "claimed", "acked")
NO_RECHECK_ACTIONS = ("search_candidates", "provide_input")


class RequiredNoteBody(ApiModel):
    note: Annotated[str, StringConstraints(min_length=1, max_length=500)]


class ManualCommandCreated(BaseModel):
    model_config = ConfigDict(extra="forbid")
    manual_action: ManualAction
    command: CommandRecord


class ManualService:
    def __init__(self, ctx: AppContext):
        self.ctx = ctx

    def _now(self) -> str:
        return to_db_time(self.ctx.clock.now())

    def _record(self, type_: str, actor: str, note: str, target_kind: str, target_id: str) -> dict[str, Any]:
        row = ManualActionRow(
            manual_action_id=f"ma_{uuid.uuid4().hex}",
            type=type_,
            actor=actor,
            at=self._now(),
            note=note,
            target_kind=target_kind,
            target_id=target_id,
        )
        self.ctx.store.insert_manual_action(row)
        return manual_action_record(row)

    def _note_case(self, case_id: str | None, manual: dict[str, Any], summary: str) -> None:
        if case_id is not None and self.ctx.cases.get(case_id) is not None:
            self.ctx.cases.note(case_id, "manual_action", manual["manual_action_id"], f"{summary}（{manual['actor']}）")

    # -- 指令 -----------------------------------------------------------------

    def confirm_sent(self, command_id: str, actor: str, note: str) -> dict[str, Any]:
        """人工确认 unknown 指令实际已发送：记录处理，按"已发生"推进流程；原始结果不变。"""
        with self.ctx.cases.lock:
            row = self.ctx.store.get_command(command_id)
            if row is None:
                raise not_found("指令")
            if row.server_status != "unknown":
                raise ApiError(409, "not_unknown", "只有结果为 unknown 的指令可以人工确认已发送", existing=row.result)
            if any(m.type == "confirm_sent" for m in self.ctx.store.list_manual_actions("command", command_id)):
                raise ApiError(409, "already_confirmed", "该指令已人工确认过")
            manual = self._record("confirm_sent", actor, note, "command", command_id)
            self._note_case(row.case_id, manual, "人工确认已发送")
            if row.case_id is not None and row.command.get("execution_mode", "execute") == "execute":
                self._advance_confirmed(row.case_id, row.action, command_id, row.result or {})
            return manual

    def _advance_confirmed(self, case_id: str, action: str, command_id: str, result: dict[str, Any]) -> None:
        orch = self.ctx.orchestrator
        if action == "send_greeting":
            # 问候指令是 unknown，不能作为 depends_on（领取要求依赖 succeeded），求简历不设依赖
            orch.mark_greeted(case_id, command_id, depends_on=None, summary="人工确认问候已发送")
        elif action == "request_resume":
            executed = result.get("executed_at")
            orch.mark_resume_requested(
                case_id,
                command_id,
                requested_at=parse_time(executed) if executed else None,
                summary="人工确认简历请求已发送",
            )
        elif action == "request_contact_exchange":
            self.ctx.cases.update(case_id, contact_status="request_sent")
            case = self.ctx.cases.get(case_id)
            if case is not None and case.stage == S.NEEDS_HUMAN.value:
                self.ctx.cases.try_transition(
                    case_id, S.CONTACT_REQUESTED.value, ref_id=command_id, summary="人工确认换微信请求已发送"
                )

    def recheck(self, command_id: str, actor: str) -> dict[str, Any]:
        """为同一动作与目标创建一条 verify_only 指令（不是重试，不受白名单与限额约束）。"""
        with self.ctx.cases.lock:
            row = self.ctx.store.get_command(command_id)
            if row is None:
                raise not_found("指令")
            if row.action in NO_RECHECK_ACTIONS:
                raise ApiError(409, "recheck_not_supported", f"{row.action} 不支持重新检查")
            orch = self.ctx.orchestrator
            case = None if row.case_id is None else self.ctx.cases.get(row.case_id)
            now = self.ctx.clock.now()
            command = dict(row.command)
            command.update(
                command_id=str(uuid.uuid4()),
                execution_mode="verify_only",
                issued_at=_wire(now),
                expires_at=_wire(now + orch.settings.command_ttl),
                depends_on=None,
            )
            if case is not None:
                record = orch.issue(case, command, "recheck")
            else:
                record = self.ctx.commands.create_command(command, case_id=row.case_id)
            manual = self._record("recheck", actor, "", "command", command_id)
            self._note_case(row.case_id, manual, "人工要求重新检查界面状态")
            return record

    # -- 流程 -----------------------------------------------------------------

    def stop(self, case_id: str, actor: str, note: str) -> dict[str, Any]:
        """停止流程：未领取的指令直接取消，已领取的登记取消（以设备回报为准），流程进入 closed。"""
        with self.ctx.cases.lock:
            case = self.ctx.cases.require(case_id)
            now = self._now()
            cancelled = 0
            for command_id in self.ctx.cases.repo.case_command_ids(case_id):
                row = self.ctx.store.get_command(command_id)
                if row is not None and row.result is None and row.server_status in OPEN_SERVER_STATUSES:
                    cancelled += int(self.ctx.store.request_cancel(command_id, now))
            if cancelled:
                self.ctx.notifier.notify()
            manual = self._record("stop_case", actor, note, "case", case_id)
            self._note_case(case_id, manual, f"人工停止流程，取消 {cancelled} 条未完成指令")
            self.ctx.cases.update(case_id, next_action=None, next_depends_on=None, blocked_reason=None)
            if case.stage != S.CLOSED.value:
                self.ctx.cases.transition(
                    case_id, S.CLOSED.value, ref_id=manual["manual_action_id"], summary="流程已停止"
                )
            return manual

    def request_wechat(self, case_id: str, actor: str, note: str) -> dict[str, Any]:
        """人工换微信：除 closed 外任何阶段可用；生成 request_contact_exchange(exchange_type=wechat)。"""
        with self.ctx.cases.lock:
            case = self.ctx.cases.require(case_id)
            if case.stage == S.CLOSED.value:
                raise ApiError(409, "stage_not_allowed", "流程已关闭，不能换微信")
            for command_id in self.ctx.cases.repo.case_command_ids(case_id):
                row = self.ctx.store.get_command(command_id)
                if (
                    row is not None
                    and row.action == "request_contact_exchange"
                    and row.command.get("execution_mode", "execute") == "execute"
                    and row.result is None
                    and row.server_status in OPEN_SERVER_STATUSES
                ):
                    raise ApiError(
                        409, "already_requested", "已有未完成的换微信指令", existing=self.ctx.commands.record(row)
                    )
            policy = self.ctx.policies.require(case.account_id)
            gate = self.ctx.policies.gate(policy, "request_contact_exchange")
            if not gate.allowed:
                raise ApiError(
                    409,
                    "policy_blocked",
                    f"策略不允许换微信：{GATE_REASON_TEXT.get(gate.reason or '', gate.reason)}",
                    errors=[{"path": "policy", "message": gate.reason or "", "code": gate.reason or "policy_blocked"}],
                )
            manual = self._record("request_wechat", actor, note, "case", case_id)
            self._note_case(case_id, manual, "人工请求换微信")
            orch = self.ctx.orchestrator
            command = orch.build_command(case, "request_contact_exchange", {"exchange_type": "wechat"})
            record = orch.issue(case, command, "manual")
            if case.stage not in (S.CONTACT_REQUESTED.value, S.CONTACT_AVAILABLE.value):
                try:
                    self.ctx.cases.transition(
                        case_id, S.CONTACT_REQUESTED.value, ref_id=manual["manual_action_id"], summary="已请求换微信"
                    )
                except StageNotAllowed:  # 迁移表保证除 closed 外都允许；这里只防并发
                    pass
            stored = self.ctx.commands.get(command["command_id"])
            return {"manual_action": manual, "command": stored or record}


def _wire(value: Any) -> str:
    return wire_time(to_db_time(value))  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------

router = APIRouter(tags=["cases"])
CaseIdPath = Annotated[str, Path(min_length=1)]


@router.post(
    "/commands/{command_id}:confirm-sent",
    operation_id="confirmCommandSent",
    summary="人工确认已发送（用于 unknown 结果）",
    tags=["commands"],
    response_model=ManualAction,
    responses=problem_responses(401, 404, 409, 422),
)
def confirm_command_sent(
    request: Request,
    ctx: Ctx,
    command_id: uuid.UUID,
    actor: ConsoleActor,
    idempotency_key: IdempotencyKeyHeader,
    body: Annotated[RequiredNoteBody, Body()],
):
    return run_idempotent(
        ctx,
        request,
        f"console:{actor}",
        idempotency_key,
        body.model_dump(mode="json"),
        lambda: (200, ctx.manual.confirm_sent(str(command_id), actor, body.note)),
    )


@router.post(
    "/commands/{command_id}:recheck",
    operation_id="recheckCommand",
    summary="重新检查界面状态",
    tags=["commands"],
    status_code=201,
    response_model=CommandRecord,
    responses=problem_responses(401, 404, 409, 422),
)
def recheck_command(
    request: Request,
    ctx: Ctx,
    command_id: uuid.UUID,
    actor: ConsoleActor,
    idempotency_key: IdempotencyKeyHeader,
):
    return run_idempotent(
        ctx,
        request,
        f"console:{actor}",
        idempotency_key,
        None,
        lambda: (201, ctx.manual.recheck(str(command_id), actor)),
    )


@router.post(
    "/cases/{case_id}:stop",
    operation_id="stopCase",
    summary="人工停止此流程",
    response_model=ManualAction,
    responses=problem_responses(401, 404, 422),
)
def stop_case(
    request: Request,
    ctx: Ctx,
    case_id: CaseIdPath,
    actor: ConsoleActor,
    idempotency_key: IdempotencyKeyHeader,
    body: Annotated[RequiredNoteBody, Body()],
):
    return run_idempotent(
        ctx,
        request,
        f"console:{actor}",
        idempotency_key,
        body.model_dump(mode="json"),
        lambda: (200, ctx.manual.stop(case_id, actor, body.note)),
    )


@router.post(
    "/cases/{case_id}:request-wechat",
    operation_id="requestWechatExchange",
    summary="人工触发换微信（生成 request_contact_exchange 指令）",
    status_code=201,
    response_model=ManualCommandCreated,
    responses=problem_responses(401, 404, 409, 422),
)
def request_wechat(
    request: Request,
    ctx: Ctx,
    case_id: CaseIdPath,
    actor: ConsoleActor,
    idempotency_key: IdempotencyKeyHeader,
    body: Annotated[RequiredNoteBody, Body()],
):
    return run_idempotent(
        ctx,
        request,
        f"console:{actor}",
        idempotency_key,
        body.model_dump(mode="json"),
        lambda: (201, ctx.manual.request_wechat(case_id, actor, body.note)),
    )


__all__ = ["ManualService", "RequiredNoteBody", "router"]
