"""动作、观察、账本三类 Protocol 及其数据模型（实现分别在任务 H、E、D1）。"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Annotated, Any, Protocol, runtime_checkable
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

from .driver import Driver
from .models import (
    Action,
    ActionOutput,
    CommandModel,
    CommandResult,
    Event,
    EventModel,
    Evidence,
    ExecutionMode,
    Mode,
    Observed,
    PauseReason,
    Reason,
    ResultStatus,
    check_result_rules,
)
from .states import CommandState, DeliveryState


def _utcnow() -> datetime:
    return datetime.now(UTC)


# ---------------------------------------------------------------------------
# 动作 ActionHandler
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ActionContext:
    """执行一条指令时由 core 注入的上下文。

    allowed_actions 是本地白名单与策略白名单的交集（默认空 = 全部关闭）；
    deadline 通常是指令的 expires_at；clock 便于测试注入时间。
    """

    account_id: str
    device_id: str
    mode: Mode
    allowed_actions: frozenset[str]
    deadline: datetime
    clock: Callable[[], datetime] = field(default=_utcnow)

    def is_allowed(self, action: str) -> bool:
        return action in self.allowed_actions


class ActionResult(BaseModel):
    """动作处理器的返回值；由 core 转成线上的 CommandResult。"""

    model_config = ConfigDict(extra="forbid")

    status: ResultStatus
    reason: Reason | None = None
    reason_detail: str | None = None
    observed: Observed = Field(default_factory=Observed)
    evidence: Evidence = Field(default_factory=list)
    # 见 contracts.md 第四节。处理器必须如实设置；默认 false 只是"什么都没做"的便利值。
    navigation_performed: bool = False
    outbound_action_performed: bool = False
    externally_visible_side_effect: bool = False
    executed_at: AwareDatetime | None = None
    output: ActionOutput | None = None

    def to_command_result(self, command: CommandModel, *, reported_at: datetime) -> CommandResult:
        """组装成 CommandResult，并执行与 command_result 相同的跨字段规则。"""
        return CommandResult(
            command_id=command.command_id,
            action=command.action,
            execution_mode=command.execution_mode,
            status=self.status,
            reason=self.reason,
            reason_detail=self.reason_detail,
            observed=self.observed,
            evidence=self.evidence,
            navigation_performed=self.navigation_performed,
            outbound_action_performed=self.outbound_action_performed,
            externally_visible_side_effect=self.externally_visible_side_effect,
            executed_at=self.executed_at,
            reported_at=reported_at,
            output=self.output,
        )

    def check_for(self, action: str, execution_mode: ExecutionMode = "execute") -> None:
        """提前按指令动作校验（不必等到组装 CommandResult）。"""
        check_result_rules(
            action=action,
            status=self.status,
            reason=self.reason,
            execution_mode=execution_mode,
            navigation_performed=self.navigation_performed,
            outbound_action_performed=self.outbound_action_performed,
            externally_visible_side_effect=self.externally_visible_side_effect,
            executed_at=self.executed_at,
            output=self.output,
        )


@runtime_checkable
class ActionHandler(Protocol):
    """单个动作的处理器。

    run：完整执行（定位与核对目标 → 检查是否已发生 → 执行 → 验证）。白名单未开启时
    必须返回 failed(reason=action_not_allowed) 且不调用 driver（三个标志都为 false）。
    verify_only：判断该指令的动作是否已经发生；用于崩溃恢复与 execution_mode=verify_only。
    允许导航（打开会话、切页签、滚动，navigation_performed 可为 true；打开未读会话产生
    已读回执时 externally_visible_side_effect 也要如实为 true），不允许任何对外动作
    （发送、确认、点击求简历/换微信、代填并提交等，outbound_action_performed 必须为 false）。
    打开会话产生的已读回执是用户已接受的副作用，如实记录即可。
    能确认已发生 → succeeded；确认未发生 → failed(reason=verification_failed)；
    无法判断 → unknown。
    """

    action: Action

    def run(self, command: CommandModel, driver: Driver, ctx: ActionContext) -> ActionResult: ...

    def verify_only(self, command: CommandModel, driver: Driver, ctx: ActionContext) -> ActionResult: ...


# ---------------------------------------------------------------------------
# 观察 Observer
# ---------------------------------------------------------------------------


class Baseline(BaseModel):
    """观察基线。data 的内部结构由观察模块（任务 E）自定，必须可 JSON 序列化。

    observe() 可以就地更新 data / established / generation / updated_at；
    core 在 observe() 返回后通过 Ledger.save_state 持久化。
    """

    model_config = ConfigDict(extra="forbid")

    account_id: str | None = None
    established: bool = False
    generation: Annotated[int, Field(ge=0)] = 0
    updated_at: AwareDatetime | None = None
    data: dict[str, Any] = Field(default_factory=dict)


@runtime_checkable
class Observer(Protocol):
    """从元素树得到业务事件，只读，不执行任何动作。

    baseline.established 为 False 时只建立基线并返回空列表（首次启动、needs_baseline）。
    返回的事件必须用 compute_event_id 生成 event_id。
    """

    def observe(self, driver: Driver, baseline: Baseline) -> list[EventModel]: ...


# ---------------------------------------------------------------------------
# 账本 Ledger
# ---------------------------------------------------------------------------


class AccountBinding(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_id: str
    bound_at: AwareDatetime
    confirmed_by: str


class MonitorState(BaseModel):
    """monitor_state 表的内容。"""

    model_config = ConfigDict(extra="forbid")

    mode: Mode | None = None
    account_binding: AccountBinding | None = None
    paused: bool = False
    pause_reason: PauseReason | None = None
    needs_baseline: bool = True
    baseline: Baseline = Field(default_factory=Baseline)
    last_online_at: AwareDatetime | None = None

    @model_validator(mode="after")
    def _check(self) -> MonitorState:
        if self.paused and self.pause_reason is None:
            raise ValueError("paused=true 时必须给出 pause_reason")
        return self


class LedgerCommand(BaseModel):
    """command_ledger 的一行。delivery 在有最终结果前为 None。"""

    model_config = ConfigDict(extra="forbid")

    command: Annotated[CommandModel, Field(discriminator="action")]
    state: CommandState
    result: CommandResult | None = None
    delivery: DeliveryState | None = None
    received_at: AwareDatetime
    updated_at: AwareDatetime

    @model_validator(mode="after")
    def _check(self) -> LedgerCommand:
        terminal = self.state not in (CommandState.QUEUED, CommandState.RUNNING)
        if terminal and (self.result is None or self.delivery is None):
            raise ValueError("终态指令必须有 result 与 delivery")
        if not terminal and (self.result is not None or self.delivery is not None):
            raise ValueError("未结束的指令不能有 result / delivery")
        if self.result is not None and self.result.status != self.state.value:
            raise ValueError("result.status 必须与 state 一致")
        return self


class OutboxEntry(BaseModel):
    """event_outbox 的一行。seq 单调递增，用作补传游标。"""

    model_config = ConfigDict(extra="forbid")

    seq: Annotated[int, Field(ge=1)]
    event: Event
    delivery: DeliveryState
    enqueued_at: AwareDatetime


@runtime_checkable
class Ledger(Protocol):
    """本地 SQLite 账本（任务 D1 实现）。所有方法在单个事务内完成。"""

    # 指令 ---------------------------------------------------------------
    def put_command(self, command: CommandModel, *, received_at: datetime) -> tuple[LedgerCommand, bool]:
        """按 command_id 幂等写入（state=queued）。返回 (记录, 是否新建)；已存在时原样返回已有记录。"""
        ...

    def get_command(self, command_id: UUID) -> LedgerCommand | None: ...

    def list_commands(self, *, states: Iterable[CommandState] | None = None) -> list[LedgerCommand]: ...

    def transition_command(
        self,
        command_id: UUID,
        to: CommandState,
        *,
        at: datetime,
        result: CommandResult | None = None,
    ) -> LedgerCommand:
        """按 can_transition_command 迁移，非法时抛 IllegalTransition。
        迁移到终态必须同时给出 result（status 与 to 一致），并把 delivery 置为 pending。"""
        ...

    # 结果回传 -----------------------------------------------------------
    def pending_results(self, *, limit: int = 100) -> list[CommandResult]:
        """delivery=pending 的结果，按完成时间排序。"""
        ...

    def mark_result_delivered(self, command_id: UUID) -> None:
        """收到服务端确认后调用；按 can_transition_delivery 迁移。重复调用无副作用。"""
        ...

    # 事件 outbox --------------------------------------------------------
    def append_event(self, event: EventModel, *, at: datetime) -> bool:
        """按 event_id 幂等写入 outbox；已存在返回 False。"""
        ...

    def pending_events(self, *, after_seq: int = 0, limit: int = 100) -> list[OutboxEntry]:
        """seq > after_seq 且未确认的事件，按 seq 升序。"""
        ...

    def mark_events_delivered(self, event_ids: Iterable[str]) -> None: ...

    def outbox_cursor(self) -> int:
        """补传游标：最大的 seq，使得所有 seq ≤ 它的事件都已确认；空表为 0。"""
        ...

    # 本机状态 -----------------------------------------------------------
    def load_state(self) -> MonitorState: ...

    def save_state(self, state: MonitorState) -> None: ...
