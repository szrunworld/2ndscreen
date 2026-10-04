"""指令编排：订阅 F1 的 EventBus，按事件和指令结果推进 recruitment_case，按策略生成对外指令。

自动流程只到"简历请求已发送"（方案 8.1，用户 2026-10-04 决定）：

    application_observed（新招呼页签的会话）→ 建立或合并 case（账户 + 候选人 + 岗位）
      → 岗位在自动处理范围内时：
         问候开启 → send_greeting；成功（或界面显示已问候）→ 自动求简历开启时 request_resume
                                                         （depends_on = 问候指令）
         问候关闭 → 自动求简历开启时直接 request_resume
      → request_resume 成功 → resume_requested；之后等简历邮件（任务 G 关联 → resume_linked）

规则：
- 每一步在生成指令前都过策略判定（白名单、暂停、工作时段、每日上限）；不满足时把这一步挂在
  case.next_action 上，记录 blocked_reason，由 ``tick()`` 在条件满足后补发（事件、结果、策略保存
  都会触发 tick，部署时另有后台定时器）。工作时段外不生成任何对外指令。
- 问候或求简历结果 unknown：不推进、不重发，case 转 needs_human（reason=unknown_result），
  只能人工 confirm-sent / recheck / stop。failed、expired 同样转人工，不自动重试。
- 任何自动流程都不生成 request_contact_exchange；换微信只由 manual.py 的 request-wechat 生成。
- 收到简历后不做自动动作（policy.after_resume_received.action 只能是 none）。
"""

from __future__ import annotations

import logging
import threading
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from monitor_contracts import CaseStage

from .cases import CaseRow, StageNotAllowed
from .commands import CommandCreateError
from .db import from_db_time, parse_time, to_db_time, wire_time
from .events import BusMessage, CommandResultRecorded, EventReceived
from .policy import GATE_REASON_TEXT, job_in_scope, render_greeting

if TYPE_CHECKING:
    from .main import AppContext

log = logging.getLogger(__name__)

S = CaseStage
EARLY_STAGES = (S.NEW_APPLICATION.value, S.GREETED.value)
DONE_STATUSES = ("succeeded", "skipped_precondition")  # skipped_precondition = 界面显示动作已发生过
AUTO_ACTIONS = ("send_greeting", "request_resume")  # 自动流程只会生成这两种

EXCHANGE_STATE_TO_CONTACT = {
    "requested": "request_sent",
    "pending_acceptance": "pending_acceptance",
    "available": "available",
    "refused": "refused",
    "unknown": "pending_confirmation",
}

RESULT_TEXT = {
    "succeeded": "成功",
    "failed": "失败",
    "cancelled": "已取消",
    "expired": "已过期",
    "skipped_precondition": "动作已发生过，跳过",
    "unknown": "结果未知",
}
ACTION_TEXT = {
    "send_greeting": "问候",
    "request_resume": "求简历",
    "request_contact_exchange": "换微信",
    "search_candidates": "搜索",
    "provide_input": "代填输入",
}


@dataclass(frozen=True)
class OrchestratorSettings:
    command_ttl: timedelta = timedelta(hours=2)  # 自动与人工指令的有效期
    tick_interval_seconds: float = 60.0  # 后台定时推进的间隔（仅部署时启动）


def new_command_id() -> str:
    return str(uuid.uuid4())


class Orchestrator:
    def __init__(self, ctx: AppContext, settings: OrchestratorSettings | None = None):
        self.ctx = ctx
        self.settings = settings or OrchestratorSettings()
        self._unsubscribe = ctx.bus.subscribe(self.handle)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def cases(self):  # noqa: ANN201 - 简写
        return self.ctx.cases

    def _now(self) -> datetime:
        return self.ctx.clock.now()

    # -- 订阅入口 -------------------------------------------------------------

    def handle(self, message: BusMessage) -> None:
        """总线入口：一条消息的全部处理在一个事务里完成（建 case、生成指令、改阶段、写时间线），
        失败整体回滚，留给 tick() 的恢复步骤重做。处理是幂等的：已处理过的消息直接跳过。"""
        if isinstance(message, EventReceived):
            self.apply_event(message)
        elif isinstance(message, CommandResultRecorded):
            self.apply_result(message)
        self.tick()

    def apply_event(self, msg: EventReceived) -> str | None:
        with self.cases.atomic():
            row = self.ctx.store.get_event(msg.event_id)
            if row is not None and row.case_id is not None:
                return row.case_id  # 已处理（例如恢复步骤先做了）
            return self.on_event(msg)

    def apply_result(self, msg: CommandResultRecorded) -> None:
        with self.cases.atomic():
            if msg.case_id is not None and self.cases.repo.result_applied(msg.case_id, msg.command_id):
                return  # 已处理
            self.on_result(msg)

    # -- 事件 -----------------------------------------------------------------

    def on_event(self, msg: EventReceived) -> str | None:
        """处理一条新事件，返回关联到的 case_id（没有关联时 None）。"""
        event = msg.record["event"]
        account_id, conversation = event.get("account_id"), event.get("conversation")
        if account_id is None or conversation is None:
            return None  # 登录、暂停等设备类事件不进入流程
        kind = msg.kind
        if kind == "application_observed":
            return self._on_application(msg.event_id, account_id, conversation)
        if kind == "conversation_ambiguous":
            case, _ = self.cases.open_case(account_id, conversation, msg.event_id)
            self._link_event(case.case_id, msg.event_id, "同岗位出现同名会话，无法唯一定位")
            self.cases.to_needs_human(
                case.case_id, "conversation_ambiguous", ref_id=msg.event_id, summary="会话歧义，转人工处理"
            )
            return case.case_id
        case = self.cases.find(account_id, conversation)
        if case is None:
            return None  # 附件、换微信状态等只更新已有流程，不建新流程
        if kind == "attachment_available":
            self._link_event(case.case_id, msg.event_id, "会话中出现附件简历（可选观察）")
            if case.stage in (S.NEW_APPLICATION.value, S.GREETED.value, S.RESUME_REQUESTED.value):
                self.cases.try_transition(
                    case.case_id, S.RESUME_RECEIVED.value, ref_id=msg.event_id, summary="界面看到附件简历"
                )
        elif kind == "contact_exchange_updated":
            state = event["payload"]["exchange_state"]
            self._link_event(case.case_id, msg.event_id, f"微信交换状态：{state}")
            self.cases.update(case.case_id, contact_status=EXCHANGE_STATE_TO_CONTACT[state])
            if state == "available" and case.stage in (S.CONTACT_REQUESTED.value, S.NEEDS_HUMAN.value):
                self.cases.try_transition(
                    case.case_id, S.CONTACT_AVAILABLE.value, ref_id=msg.event_id, summary="候选人已同意，微信可用"
                )
        else:
            self._link_event(case.case_id, msg.event_id, f"事件 {kind}")
        return case.case_id

    def _link_event(self, case_id: str, event_id: str, summary: str) -> None:
        self.ctx.events.link_case(event_id, case_id)
        self.cases.note(case_id, "event", event_id, summary)

    def _on_application(self, event_id: str, account_id: str, conversation: dict[str, Any]) -> str:
        case, created = self.cases.open_case(account_id, conversation, event_id)
        if not created:
            # 同一新投递换了 bucket：合并到已有 case，不重复建、不重复下发
            self._link_event(case.case_id, event_id, "重复观察到同一新投递，已合并")
            return case.case_id
        self.ctx.events.link_case(event_id, case.case_id)
        policy = self.ctx.policies.get(account_id)
        assert policy is not None  # case 已存在，账户一定已知
        if not job_in_scope(policy, case.job_title):
            self.cases.note(case.case_id, "stage_change", event_id, "岗位不在自动处理范围，不自动处理")
            return case.case_id
        first = self._first_step(policy)
        if first is None:
            self.cases.note(case.case_id, "stage_change", event_id, "策略未开启自动问候与自动求简历")
            return case.case_id
        self.cases.update(case.case_id, next_action=first, next_depends_on=None)
        self.advance(case.case_id)
        return case.case_id

    @staticmethod
    def _first_step(policy: dict[str, Any]) -> str | None:
        if policy["greeting"]["enabled"]:
            return "send_greeting"
        if policy["auto_request_resume"]:
            return "request_resume"
        return None

    # -- 指令结果 -------------------------------------------------------------

    def on_result(self, msg: CommandResultRecorded) -> None:
        if msg.case_id is None:
            return
        case = self.cases.get(msg.case_id)
        if case is None:
            return
        command = msg.record["command"]
        result = msg.record["result"] or {}
        action, status = command["action"], msg.status
        mode = command.get("execution_mode", "execute")
        reason = result.get("reason")
        text = (
            f"{ACTION_TEXT.get(action, action)}{'（重新检查）' if mode == 'verify_only' else ''}："
            + RESULT_TEXT.get(status, status)
        )
        if reason:
            text += f"（{reason}）"
        self.cases.note(case.case_id, "command_result", msg.command_id, text)
        if mode == "verify_only":
            return  # 重新检查只记录，是否确认已发送由人工 confirm-sent 决定
        if case.stage == S.CLOSED.value:
            return
        if action == "send_greeting":
            self._after_greeting(case, msg.command_id, status)
        elif action == "request_resume":
            self._after_resume_request(case, msg.command_id, status, result)
        elif action == "request_contact_exchange":
            self._after_wechat(case, msg.command_id, status, result)

    def _human(self, case: CaseRow, command_id: str, status: str, action: str) -> None:
        reason = "unknown_result" if status == "unknown" else f"command_{status}"
        with self.cases.atomic():
            self.cases.update(case.case_id, next_action=None, next_depends_on=None, blocked_reason=None)
            self.cases.to_needs_human(
                case.case_id,
                reason,
                ref_id=command_id,
                summary=f"{ACTION_TEXT[action]}结果{RESULT_TEXT.get(status, status)}，不自动推进、不重发，转人工",
            )

    def _after_greeting(self, case: CaseRow, command_id: str, status: str) -> None:
        if status in DONE_STATUSES:
            self.mark_greeted(case.case_id, command_id, depends_on=command_id if status == "succeeded" else None)
        elif status != "cancelled":
            self._human(case, command_id, status, "send_greeting")

    def mark_greeted(self, case_id: str, ref_id: str, *, depends_on: str | None, summary: str = "问候已发送") -> None:
        """问候已完成（结果成功、界面显示已问候或人工确认）：进入 greeted，按策略挂上求简历。"""
        case = self.cases.get(case_id)
        if case is None:
            return
        if case.stage in (S.NEW_APPLICATION.value, S.NEEDS_HUMAN.value):
            if not self.cases.try_transition(case_id, S.GREETED.value, ref_id=ref_id, summary=summary):
                return
        elif case.stage != S.GREETED.value:
            return  # 已经走到后面的阶段（例如人工换微信），不回退
        policy = self.ctx.policies.get(case.account_id)
        if policy is not None and policy["auto_request_resume"]:
            self.cases.update(case_id, next_action="request_resume", next_depends_on=depends_on)
            self.advance(case_id)
        else:
            self.cases.update(case_id, next_action=None, next_depends_on=None, blocked_reason=None)

    def _after_resume_request(self, case: CaseRow, command_id: str, status: str, result: dict[str, Any]) -> None:
        if status in DONE_STATUSES:
            executed_at = result.get("executed_at")
            self.mark_resume_requested(
                case.case_id,
                command_id,
                requested_at=None if executed_at is None else parse_time(executed_at),
            )
        elif status != "cancelled":
            self._human(case, command_id, status, "request_resume")

    def mark_resume_requested(
        self, case_id: str, ref_id: str, *, requested_at: datetime | None, summary: str = "简历请求已发送"
    ) -> None:
        """求简历已完成：进入 resume_requested，记录请求时间（邮件超时从这里起算）。"""
        case = self.cases.get(case_id)
        if case is None:
            return
        at = to_db_time(requested_at or self._now())
        if case.stage in (S.NEW_APPLICATION.value, S.GREETED.value, S.NEEDS_HUMAN.value):
            if self.cases.try_transition(case_id, S.RESUME_REQUESTED.value, ref_id=ref_id, summary=summary):
                self.cases.update(case_id, resume_requested_at=at)
        elif case.resume_requested_at is None:
            self.cases.update(case_id, resume_requested_at=at)  # 阶段不回退，只记时间

    def _after_wechat(self, case: CaseRow, command_id: str, status: str, result: dict[str, Any]) -> None:
        output = result.get("output") or {}
        if status in DONE_STATUSES:
            state = output.get("exchange_state", "requested")
            self.cases.update(case.case_id, contact_status=EXCHANGE_STATE_TO_CONTACT.get(state, "request_sent"))
            if state == "available":
                self.cases.try_transition(
                    case.case_id, S.CONTACT_AVAILABLE.value, ref_id=command_id, summary="微信已可用"
                )
        elif status == "unknown":
            self.cases.update(case.case_id, contact_status="pending_confirmation")
            self._human(case, command_id, status, "request_contact_exchange")
        elif status in ("failed", "expired"):
            self._human(case, command_id, status, "request_contact_exchange")

    # -- 生成指令 -------------------------------------------------------------

    def build_command(
        self,
        case: CaseRow,
        action: str,
        payload: dict[str, Any],
        *,
        depends_on: str | None = None,
        execution_mode: str = "execute",
        issued_at: datetime | None = None,
    ) -> dict[str, Any]:
        """issued_at 默认现在；晚于现在时，领取接口在该时间之前不下发这条指令。"""
        now = issued_at or self._now()
        return {
            "command_id": new_command_id(),
            "workflow_id": case.case_id,
            "account_id": case.account_id,
            "action": action,
            "execution_mode": execution_mode,
            "target": {"conversation": case.conversation, "candidate_ref": case.case_id},
            "payload": payload,
            "issued_at": wire_time(to_db_time(now)),
            "expires_at": wire_time(to_db_time(now + self.settings.command_ttl)),
            "depends_on": depends_on,
        }

    def issue(self, case: CaseRow, command: dict[str, Any], origin: str) -> dict[str, Any]:
        """创建指令（F1 create_command）、登记来源并写时间线，返回 CommandRecord。"""
        if origin == "auto" and command["action"] not in AUTO_ACTIONS:
            raise ValueError(f"自动流程不得生成 {command['action']}")
        record = self.ctx.commands.create_command(command, case_id=case.case_id)
        now = to_db_time(self._now())
        self.cases.repo.register_command(command["command_id"], case.case_id, origin, now)
        mode = "（重新检查）" if command.get("execution_mode") == "verify_only" else ""
        self.cases.note(case.case_id, "command", command["command_id"], f"下发{ACTION_TEXT[command['action']]}{mode}")
        return record

    def advance(self, case_id: str) -> dict[str, Any] | None:
        """尝试执行 case 上挂起的下一步；策略不允许时记录原因并保留。返回生成的 CommandRecord。"""
        with self.cases.atomic():
            case = self.cases.get(case_id)
            if case is None or case.next_action is None:
                return None
            if case.stage not in EARLY_STAGES:
                self.cases.update(case_id, next_action=None, next_depends_on=None, blocked_reason=None)
                return None
            policy = self.ctx.policies.get(case.account_id)
            assert policy is not None
            action = case.next_action
            gate = self.ctx.policies.gate(policy, action)
            if not gate.allowed:
                if case.blocked_reason != gate.reason:
                    self.cases.update(case_id, blocked_reason=gate.reason)
                    self.cases.note(
                        case_id,
                        "stage_change",
                        case_id,
                        f"{ACTION_TEXT[action]}暂缓：{GATE_REASON_TEXT.get(gate.reason or '', gate.reason)}",
                    )
                return None
            if action == "send_greeting":
                payload = {"text": render_greeting(policy["greeting"]["template"], case.candidate_name, case.job_title)}
            else:
                payload = {}
            command = self.build_command(case, action, payload, depends_on=case.next_depends_on)
            try:
                record = self.issue(case, command, "auto")
            except CommandCreateError as exc:
                log.warning("生成 %s 失败：%s %s", action, exc.code, exc)
                self.cases.update(case_id, next_action=None, next_depends_on=None, blocked_reason=None)
                self.cases.to_needs_human(
                    case_id,
                    "command_create_failed",
                    ref_id=case_id,
                    summary=f"{ACTION_TEXT[action]}指令生成失败：{exc}",
                )
                return None
            self.cases.update(case_id, next_action=None, next_depends_on=None, blocked_reason=None)
            return record

    # -- 定时推进 -------------------------------------------------------------

    def tick(self) -> None:
        """定时推进，每一项各自一个事务，单项失败只记日志、不影响其他项：

        1. 恢复：重做崩溃或异常时没处理完的新投递事件与指令结果（见 recover）；
        2. 补发被挂起的自动步骤；
        3. 未领取就过期的自动指令转人工；求简历后超时未收到邮件转人工。
        """
        self.recover()
        for case in self.cases.repo.cases_with_next_action():
            self._guarded(self.advance, case.case_id)
        self._guarded(self._expire_unclaimed)
        self._guarded(self._resume_timeouts)

    def _guarded(self, fn: Callable[..., Any], *args: Any) -> None:
        try:
            fn(*args)
        except Exception:
            log.exception("编排步骤 %s 失败，已回滚，下次 tick 重试", getattr(fn, "__name__", fn))

    def recover(self) -> int:
        """重做没处理完的消息，返回重做条数。

        事件与结果由 F1 先提交、再经总线投递给本模块；进程在两者之间崩溃、或处理时抛异常（事务回滚）
        都会留下"已落库但未处理"的记录。判定依据与处理写在同一个事务里，所以不会重复处理：
        - 新投递 / 会话歧义事件：处理后一定关联到 case（events.case_id 非空）；
        - 指令结果：处理后一定有一条该指令的 command_result 时间线。
        """
        done = 0
        for row in self.cases.repo.unprocessed_events():
            record = self.ctx.events.get(row.event_id)
            assert record is not None
            msg = EventReceived(row.event_id, row.kind, row.account_id, row.device_id, record)
            try:
                self.apply_event(msg)
                done += 1
            except Exception:
                log.exception("恢复事件 %s 失败", row.event_id)
        for row in self.cases.repo.unapplied_results():
            assert row.result is not None
            msg = CommandResultRecorded(row.command_id, row.case_id, row.server_status, self.ctx.commands.record(row))
            try:
                self.apply_result(msg)
                done += 1
            except Exception:
                log.exception("恢复指令结果 %s 失败", row.command_id)
        return done

    def _expire_unclaimed(self) -> None:
        now = to_db_time(self._now())
        for stage in EARLY_STAGES:
            for case in self.cases.repo.cases_in_stage(stage):
                if case.next_action is not None:
                    continue
                latest = self.cases.repo.latest_command_id(case.case_id)
                row = None if latest is None else self.ctx.store.get_command(latest)
                if row is None or row.result is not None or row.expires_at > now:
                    continue
                if row.server_status in ("pending", "expired") and row.claimed_by is None:
                    if self.cases.repo.command_origin(row.command_id) == "auto":
                        self._human(case, row.command_id, "expired", row.action)

    def _resume_timeouts(self) -> None:
        now = self._now()
        for case in self.cases.repo.cases_in_stage(S.RESUME_REQUESTED.value):
            if case.resume_requested_at is None:
                continue
            policy = self.ctx.policies.get(case.account_id)
            if policy is None:
                continue
            requested = from_db_time(case.resume_requested_at)
            assert requested is not None
            if now - requested < timedelta(days=policy["resume_mail_timeout_days"]):
                continue
            if self.cases.repo.has_linked_resume(case.case_id):
                continue
            self.cases.to_needs_human(
                case.case_id,
                "resume_mail_timeout",
                ref_id=case.case_id,
                summary=f"求简历后 {policy['resume_mail_timeout_days']} 天仍未收到简历邮件，转人工",
            )

    # -- 后台定时器（部署时由应用启动事件开启；测试直接调用 tick） ------------------

    def start_background(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()

        def loop() -> None:
            self._guarded(self.tick)  # 启动时先做一次（含崩溃恢复）
            while not self._stop.wait(self.settings.tick_interval_seconds):
                try:
                    self.tick()
                except Exception:  # 定时任务不能因单次失败退出
                    log.exception("定时推进失败")

        self._thread = threading.Thread(target=loop, name="case-orchestrator-tick", daemon=True)
        self._thread.start()

    def stop_background(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None

    def close(self) -> None:
        self.stop_background()
        self._unsubscribe()


def with_background_tick(orch: Orchestrator, inner: Callable[[Any], Any]) -> Callable[[Any], Any]:
    """包装应用的 lifespan：启动时开启后台定时推进，关闭时停止。"""

    @asynccontextmanager
    async def lifespan(app: Any) -> AsyncIterator[Any]:
        orch.start_background()
        try:
            async with inner(app) as state:
                yield state
        finally:
            orch.stop_background()

    return lifespan


__all__ = [
    "AUTO_ACTIONS",
    "Orchestrator",
    "OrchestratorSettings",
    "StageNotAllowed",
    "new_command_id",
    "with_background_tick",
]
