"""契约的 pydantic v2 模型。

JSON Schema（schemas/*.json）是线上格式的权威；本模块与之逐字段对应，另外承担
JSON Schema 无法表达的跨字段语义校验（例如 result_ref 前缀必须等于 search_id、
event_id 必须等于 compute_event_id 的结果）。语义错误统一用 ``_fail`` 抛出，
携带字段路径，供 validate_* 转成字段级错误。
"""

from __future__ import annotations

import re
from typing import Annotated, Any, Literal, Union, get_args
from uuid import UUID

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)
from pydantic_core import PydanticCustomError

from .mail_id import MAIL_MESSAGE_ID_PATTERN, compute_mail_message_id

# ---------------------------------------------------------------------------
# 基础类型
# ---------------------------------------------------------------------------

Action = Literal[
    "send_greeting",
    "request_resume",
    "request_contact_exchange",
    "search_candidates",
    "provide_input",
]
ACTIONS: tuple[str, ...] = Action.__args__  # type: ignore[attr-defined]

# 会话类动作：需要 workflow_id 与 conversation 目标。
# forward_resume 自 0.3.0 移除：简历由 BOSS 在候选人同意后自动发到公司邮箱，Monitor 不转发。
CONVERSATION_ACTIONS: frozenset[str] = frozenset({"send_greeting", "request_resume", "request_contact_exchange"})
# 对外动作：受策略白名单、每日上限与最小间隔约束（provide_input 是人工代填，不在其列）
OUTWARD_ACTIONS: frozenset[str] = frozenset(CONVERSATION_ACTIONS | {"search_candidates"})

ResultStatus = Literal["succeeded", "failed", "cancelled", "expired", "skipped_precondition", "unknown"]
RESULT_STATUSES: tuple[str, ...] = ResultStatus.__args__  # type: ignore[attr-defined]

Reason = Literal[
    "action_not_allowed",
    "rate_limited",
    "target_ambiguous",
    "target_not_found",
    "unknown_dialog",
    "login_required",
    "captcha",
    "account_mismatch",
    "paused",
    "dependency_not_satisfied",
    "timeout",
    "unreadable",
    "unsupported",
    "precondition_already_done",
    "verification_failed",
    "driver_error",
    "crash_recovery",
]
REASONS: tuple[str, ...] = Reason.__args__  # type: ignore[attr-defined]

EventKind = Literal[
    "application_observed",
    "attachment_available",
    "contact_exchange_updated",
    "conversation_ambiguous",
    "login_required",
    "login_qr",
    "login_ok",
    "human_input_required",
    "blocked_by_dialog",
    "device_paused",
]
EVENT_KINDS: tuple[str, ...] = EventKind.__args__  # type: ignore[attr-defined]
CONVERSATION_EVENT_KINDS: frozenset[str] = frozenset(
    {"application_observed", "attachment_available", "contact_exchange_updated", "conversation_ambiguous"}
)

Mode = Literal["local", "remote"]
ExecutionMode = Literal["execute", "verify_only"]
ExchangeType = Literal["wechat"]  # 0.3.0 起只换微信
ExchangeState = Literal["requested", "pending_acceptance", "available", "refused", "unknown"]
Coverage = Literal["partial", "complete", "unreadable", "empty_confirmed"]
PauseReason = Literal["user_request", "login_required", "account_switched", "anomaly", "server_request", "rebaseline"]

AccountId = Annotated[str, StringConstraints(min_length=1, max_length=128)]
DeviceId = Annotated[str, StringConstraints(min_length=1, max_length=128)]
WorkflowId = Annotated[str, StringConstraints(min_length=1, max_length=128)]
EventId = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
Hint = Annotated[str, StringConstraints(min_length=1, max_length=100)]
SearchId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,64}$")]
ResultRef = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,64}:item_[1-9][0-9]*$")]
FactCode = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,63}$")]
Email = Annotated[str, StringConstraints(pattern=r"^[^@\s]+@[^@\s]+$", max_length=254)]
SemVer = Annotated[str, StringConstraints(pattern=r"^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$")]
HHMM = Annotated[str, StringConstraints(pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")]


def _fail(path: str, message: str) -> PydanticCustomError:
    """构造带字段路径的语义错误（由 validate_* 解析 ctx.path）。"""
    return PydanticCustomError("contract_semantic", "{message}", {"path": path, "message": message})


class ContractModel(BaseModel):
    """所有契约模型的基类：拒绝未知字段。"""

    model_config = ConfigDict(extra="forbid")

    def to_wire(self) -> dict[str, Any]:
        """序列化成线上 JSON 形状（时间为 ISO 字符串，UUID 为字符串）。"""
        return self.model_dump(mode="json")


# ---------------------------------------------------------------------------
# 公共结构
# ---------------------------------------------------------------------------


class Conversation(ContractModel):
    candidate_name: Annotated[str, StringConstraints(min_length=1, max_length=64)]
    job_title: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    hints: Annotated[list[Hint], Field(max_length=10)] = Field(default_factory=list)


class Frame(ContractModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    x: float
    y: float
    w: Annotated[float, Field(ge=0)]
    h: Annotated[float, Field(ge=0)]

    def center(self) -> tuple[float, float]:
        return (self.x + self.w / 2, self.y + self.h / 2)

    def contains(self, x: float, y: float) -> bool:
        return self.x <= x <= self.x + self.w and self.y <= y <= self.y + self.h


class EvidenceItem(ContractModel):
    text: Annotated[str, StringConstraints(max_length=500)]
    role: Annotated[str, StringConstraints(max_length=64)] | None = None
    source: Literal["element", "dialog", "chat", "list", "other"] = "element"
    captured_at: AwareDatetime

    def to_wire(self) -> dict[str, Any]:
        return self.model_dump(mode="json", exclude_none=True)


Evidence = Annotated[list[EvidenceItem], Field(max_length=50)]


class Fact(ContractModel):
    code: FactCode
    detail: Annotated[str, StringConstraints(max_length=500)] | None = None


class Observed(ContractModel):
    before: Annotated[list[Fact], Field(max_length=50)] = Field(default_factory=list)
    after: Annotated[list[Fact], Field(max_length=50)] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# 指令 command
# ---------------------------------------------------------------------------


class ConversationTarget(ContractModel):
    """会话目标。v1 只能以会话为目标，搜索结果不能作为任何动作的目标（0.3.0 删除 result_ref）。"""

    conversation: Conversation
    candidate_ref: Annotated[str, StringConstraints(max_length=128)] | None = None


class SearchTarget(ContractModel):
    scope: Literal["current_page"]


class InputTarget(ContractModel):
    input_request_id: UUID


class EmptyPayload(ContractModel):
    pass


class SendGreetingPayload(ContractModel):
    text: Annotated[str, StringConstraints(min_length=1, max_length=500)]


class RequestContactExchangePayload(ContractModel):
    exchange_type: ExchangeType


class SearchCandidatesPayload(ContractModel):
    search_id: SearchId
    query: Annotated[str, StringConstraints(min_length=1, max_length=100)]
    max_results: Annotated[int, Field(ge=1, le=100)]


class ProvideInputPayload(ContractModel):
    # 敏感值：repr=False，避免出现在日志与异常信息里
    value: Annotated[str, StringConstraints(min_length=1, max_length=64)] = Field(repr=False)


class _CommandBase(ContractModel):
    command_id: UUID
    account_id: AccountId
    execution_mode: ExecutionMode = "execute"
    issued_at: AwareDatetime
    expires_at: AwareDatetime
    depends_on: UUID | None = None

    @model_validator(mode="after")
    def _check_times(self) -> _CommandBase:
        if self.expires_at <= self.issued_at:
            raise _fail("expires_at", "expires_at 必须晚于 issued_at")
        if self.depends_on is not None and self.depends_on == self.command_id:
            raise _fail("depends_on", "指令不能依赖自身")
        return self

    @property
    def is_verify_only(self) -> bool:
        return self.execution_mode == "verify_only"


class SendGreetingCommand(_CommandBase):
    action: Literal["send_greeting"]
    workflow_id: WorkflowId
    target: ConversationTarget
    payload: SendGreetingPayload


class RequestResumeCommand(_CommandBase):
    action: Literal["request_resume"]
    workflow_id: WorkflowId
    target: ConversationTarget
    payload: EmptyPayload


class RequestContactExchangeCommand(_CommandBase):
    action: Literal["request_contact_exchange"]
    workflow_id: WorkflowId
    target: ConversationTarget
    payload: RequestContactExchangePayload


class SearchCandidatesCommand(_CommandBase):
    action: Literal["search_candidates"]
    workflow_id: None
    execution_mode: Literal["execute"] = "execute"
    target: SearchTarget
    payload: SearchCandidatesPayload


class ProvideInputCommand(_CommandBase):
    action: Literal["provide_input"]
    workflow_id: None
    execution_mode: Literal["execute"] = "execute"
    target: InputTarget
    payload: ProvideInputPayload


Command = Annotated[
    Union[
        SendGreetingCommand,
        RequestResumeCommand,
        RequestContactExchangeCommand,
        SearchCandidatesCommand,
        ProvideInputCommand,
    ],
    Field(discriminator="action"),
]
CommandModel = Union[
    SendGreetingCommand,
    RequestResumeCommand,
    RequestContactExchangeCommand,
    SearchCandidatesCommand,
    ProvideInputCommand,
]

# ---------------------------------------------------------------------------
# 搜索快照 search_snapshot
# ---------------------------------------------------------------------------


# 卡片文本原文：不得含中国大陆手机号样式的 11 位数字（与 schema 的 not.pattern 一致）
_PHONE_LIKE = re.compile(r"1[3-9][0-9]{9}")
CardText = Annotated[str, StringConstraints(min_length=1, max_length=500)]


def _check_card_text(path: str, text: str) -> None:
    if _PHONE_LIKE.search(text):
        raise _fail(path, "疑似手机号：搜索快照只放卡片上的可读文本，不得含联系方式")


class CardField(ContractModel):
    """卡片上的一段可读文本。label 只在界面上确有可见标签时填写，不要自行命名。"""

    label: Annotated[str, StringConstraints(min_length=1, max_length=64)] | None = None
    text: CardText


class SearchItem(ContractModel):
    """一张结果卡片。只原样转述界面已有的文本，不识别身份（0.3.0）。"""

    result_ref: ResultRef
    position: Annotated[int, Field(ge=1, le=100)]
    fields: Annotated[list[CardField], Field(min_length=1, max_length=60)]
    masked_name: Annotated[str, StringConstraints(min_length=1, max_length=64)] | None = None
    prop_card_texts: Annotated[
        list[Annotated[str, StringConstraints(min_length=1, max_length=200)]], Field(max_length=20)
    ]

    @model_validator(mode="after")
    def _check(self) -> SearchItem:
        if not self.result_ref.endswith(f":item_{self.position}"):
            raise _fail("result_ref", f"result_ref 末尾的序号必须等于 position（应为 :item_{self.position}）")
        for i, f in enumerate(self.fields):
            _check_card_text(f"fields[{i}].text", f.text)
        if self.masked_name is not None:
            _check_card_text("masked_name", self.masked_name)
        for i, t in enumerate(self.prop_card_texts):
            _check_card_text(f"prop_card_texts[{i}]", t)
        return self


class SearchSnapshot(ContractModel):
    search_id: SearchId
    query: Annotated[str, StringConstraints(min_length=1, max_length=100)]
    scope: Literal["current_page"]
    coverage: Coverage
    unreadable_reason: Annotated[str, StringConstraints(min_length=1, max_length=200)] | None = None
    items: Annotated[list[SearchItem], Field(max_length=100)]
    captured_at: AwareDatetime

    @model_validator(mode="after")
    def _check_coverage(self) -> SearchSnapshot:
        if self.coverage == "unreadable":
            if self.items:
                raise _fail("items", "coverage=unreadable 时 items 必须为空（读取失败不得伪装成结果）")
            if not self.unreadable_reason:
                raise _fail("unreadable_reason", "coverage=unreadable 时必须给出 unreadable_reason")
        else:
            if self.unreadable_reason is not None:
                raise _fail("unreadable_reason", "只有 coverage=unreadable 时才能填写 unreadable_reason")
            if self.coverage == "empty_confirmed" and self.items:
                raise _fail("items", "coverage=empty_confirmed 时 items 必须为空")
            if self.coverage in ("partial", "complete") and not self.items:
                raise _fail("items", f"coverage={self.coverage} 时 items 至少一条；无结果应为 empty_confirmed")
        prefix = f"{self.search_id}:"
        seen: set[str] = set()
        for i, item in enumerate(self.items):
            if not item.result_ref.startswith(prefix):
                raise _fail(f"items[{i}].result_ref", f"result_ref 必须以 {prefix} 开头")
            if item.result_ref in seen:
                raise _fail(f"items[{i}].result_ref", "result_ref 在同一快照内重复")
            seen.add(item.result_ref)
        return self

    @property
    def outcome(self) -> Literal["results", "no_results", "unreadable"]:
        """三种结局：有结果 / 确认无结果 / 无法读取。调用方必须按此分支，不能只看 items 是否为空。"""
        if self.coverage == "unreadable":
            return "unreadable"
        if self.coverage == "empty_confirmed":
            return "no_results"
        return "results"


# ---------------------------------------------------------------------------
# 指令结果 command_result
# ---------------------------------------------------------------------------


class SearchOutput(ContractModel):
    snapshot: SearchSnapshot


class ContactOutput(ContractModel):
    exchange_type: ExchangeType
    exchange_state: ExchangeState


ActionOutput = Union[SearchOutput, ContactOutput]

_OUTPUT_FOR_ACTION: dict[str, type[ContractModel] | None] = {
    "search_candidates": SearchOutput,
    "request_contact_exchange": ContactOutput,
    "send_greeting": None,
    "request_resume": None,
    "provide_input": None,
}


def check_result_rules(
    *,
    action: str,
    status: str,
    reason: str | None,
    execution_mode: str,
    navigation_performed: bool,
    outbound_action_performed: bool,
    externally_visible_side_effect: bool,
    executed_at: Any,
    output: Any,
) -> None:
    """command_result 的跨字段规则（ActionResult 也复用）。违反时抛带路径的错误。"""
    if status == "succeeded":
        if reason is not None:
            raise _fail("reason", "status=succeeded 时 reason 必须为 null")
        if executed_at is None:
            raise _fail("executed_at", "status=succeeded 时 executed_at 必填")
    if status in ("failed", "unknown", "skipped_precondition") and reason is None:
        raise _fail("reason", f"status={status} 时必须给出 reason")
    if status in ("cancelled", "expired"):
        if executed_at is not None:
            raise _fail("executed_at", f"status={status} 表示未执行，executed_at 必须为 null")
    # cancelled 可能发生在 running 中途：允许已导航（如实记录），但不能有对外动作；
    # expired 只从 queued 进入，什么都没做过。
    if status == "cancelled" and outbound_action_performed:
        raise _fail("outbound_action_performed", "status=cancelled 时不得发生过对外动作；动作已发生应回报实际结果")
    if status == "expired":
        for name, flag in (
            ("navigation_performed", navigation_performed),
            ("outbound_action_performed", outbound_action_performed),
            ("externally_visible_side_effect", externally_visible_side_effect),
        ):
            if flag:
                raise _fail(name, "status=expired 表示从未开始执行，三个标志都必须为 false")
    if execution_mode == "verify_only" and outbound_action_performed:
        raise _fail("outbound_action_performed", "verify_only 指令不得发生对外动作（导航允许）")
    if outbound_action_performed and not externally_visible_side_effect:
        raise _fail(
            "externally_visible_side_effect",
            "outbound_action_performed=true 时 externally_visible_side_effect 必须为 true",
        )

    expected = _OUTPUT_FOR_ACTION[action]
    if output is not None and (expected is None or not isinstance(output, expected)):
        raise _fail("output", f"action={action} 不允许这种 output")
    if action == "search_candidates" and status == "succeeded":
        if output is None:
            raise _fail("output", "search_candidates 成功时必须带 output.snapshot")
        if output.snapshot.coverage == "unreadable":
            raise _fail(
                "output.snapshot.coverage",
                "无法读取的快照不能回报为 succeeded；应为 status=failed, reason=unreadable",
            )
        # 0.3.2：搜索算对外动作（用户 2026-10-04），成功的搜索一定输入并提交过关键词。
        for name, flag in (
            ("navigation_performed", navigation_performed),
            ("outbound_action_performed", outbound_action_performed),
            ("externally_visible_side_effect", externally_visible_side_effect),
        ):
            if not flag:
                raise _fail(name, f"search_candidates 成功时 {name} 必须为 true（搜索算对外动作，0.3.2）")
    if action == "request_contact_exchange" and status in ("succeeded", "skipped_precondition") and output is None:
        raise _fail("output", f"request_contact_exchange 在 status={status} 时必须带 output.exchange_state")


class CommandResult(ContractModel):
    command_id: UUID
    action: Action
    execution_mode: ExecutionMode = "execute"
    status: ResultStatus
    reason: Reason | None
    reason_detail: Annotated[str, StringConstraints(max_length=500)] | None = None
    observed: Observed
    evidence: Evidence
    # 三个标志在线上必填：缺省 false 会把"忘了填"当成"没有对外动作"。含义见 contracts.md 第四节。
    navigation_performed: bool
    outbound_action_performed: bool
    externally_visible_side_effect: bool
    executed_at: AwareDatetime | None
    reported_at: AwareDatetime
    output: ActionOutput | None = None

    @model_validator(mode="after")
    def _check_rules(self) -> CommandResult:
        check_result_rules(
            action=self.action,
            status=self.status,
            reason=self.reason,
            execution_mode=self.execution_mode,
            navigation_performed=self.navigation_performed,
            outbound_action_performed=self.outbound_action_performed,
            externally_visible_side_effect=self.externally_visible_side_effect,
            executed_at=self.executed_at,
            output=self.output,
        )
        return self


# ---------------------------------------------------------------------------
# 事件 event
# ---------------------------------------------------------------------------


class ApplicationObservedPayload(ContractModel):
    marker_text: Annotated[str, StringConstraints(max_length=100)] | None = None
    evidence: Evidence


class AttachmentAvailablePayload(ContractModel):
    attachment_name: Annotated[str, StringConstraints(max_length=200)] | None = None
    evidence: Evidence


class ContactExchangeUpdatedPayload(ContractModel):
    exchange_type: ExchangeType
    exchange_state: ExchangeState
    evidence: Evidence


class AmbiguousCandidate(ContractModel):
    position: Annotated[int, Field(ge=0)]
    hints: Annotated[list[Hint], Field(max_length=10)] = Field(default_factory=list)
    summary: Annotated[str, StringConstraints(max_length=200)] | None = None


class ConversationAmbiguousPayload(ContractModel):
    match_count: Annotated[int, Field(ge=2)]
    candidates: Annotated[list[AmbiguousCandidate], Field(min_length=2, max_length=20)]
    evidence: Evidence

    @model_validator(mode="after")
    def _check_count(self) -> ConversationAmbiguousPayload:
        if self.match_count < len(self.candidates):
            raise _fail("match_count", "match_count 不能小于 candidates 条数")
        return self


class LoginRequiredPayload(ContractModel):
    reason: Literal["logged_out", "session_expired", "account_switched", "unknown"]
    mode: Mode


class LoginQrEventPayload(ContractModel):
    qr_seq: Annotated[int, Field(ge=1)]
    expires_at: AwareDatetime


class LoginOkPayload(ContractModel):
    mode: Mode
    account_display: Annotated[str, StringConstraints(max_length=64)] | None = None


# 人工输入请求的默认有效期（0.3.2）：事件没给 expires_at 时，服务端按 observed_at + 该值计算。
INPUT_REQUEST_TTL_SECONDS = 600


class HumanInputRequiredPayload(ContractModel):
    input_request_id: UUID
    input_kind: Literal["sms_code", "text", "slider", "confirm_on_phone", "unknown"]
    prompt_text: Annotated[str, StringConstraints(max_length=200)]
    can_fill: bool
    # 0.3.2：请求有效期。为 null 时服务端取 observed_at + INPUT_REQUEST_TTL_SECONDS；
    # 控制台提交的 provide_input 指令 expires_at 等于它，过期后提交返回 409。
    expires_at: AwareDatetime | None = None

    @model_validator(mode="after")
    def _check_fill(self) -> HumanInputRequiredPayload:
        if self.input_kind in ("slider", "confirm_on_phone", "unknown") and self.can_fill:
            raise _fail("can_fill", f"input_kind={self.input_kind} 无法代填，can_fill 必须为 false")
        return self


class BlockedByDialogPayload(ContractModel):
    dialog_kind: Literal["captcha", "risk_warning", "quota_limit", "unknown"]
    dialog_text: Annotated[str, StringConstraints(max_length=500)]
    buttons: Annotated[list[Annotated[str, StringConstraints(max_length=50)]], Field(max_length=10)] = Field(
        default_factory=list
    )
    command_id: UUID | None = None


class DevicePausedPayload(ContractModel):
    reason: PauseReason
    by: Literal["user", "monitor", "server"]
    detail: Annotated[str, StringConstraints(max_length=200)] | None = None


class _EventBase(ContractModel):
    event_id: EventId
    device_id: DeviceId
    bucket: Annotated[str, StringConstraints(min_length=1, max_length=64)]
    observed_at: AwareDatetime

    @model_validator(mode="after")
    def _check_event_id(self) -> _EventBase:
        from .event_id import compute_event_id  # 避免循环导入

        expected = compute_event_id(
            self.account_id,  # type: ignore[attr-defined]
            self.kind,  # type: ignore[attr-defined]
            self.conversation,  # type: ignore[attr-defined]
            self.bucket,
        )
        if self.event_id != expected:
            raise _fail("event_id", "event_id 与 compute_event_id(account_id, kind, conversation, bucket) 不一致")
        return self


class ApplicationObservedEvent(_EventBase):
    kind: Literal["application_observed"]
    account_id: AccountId
    conversation: Conversation
    payload: ApplicationObservedPayload


class AttachmentAvailableEvent(_EventBase):
    kind: Literal["attachment_available"]
    account_id: AccountId
    conversation: Conversation
    payload: AttachmentAvailablePayload


class ContactExchangeUpdatedEvent(_EventBase):
    kind: Literal["contact_exchange_updated"]
    account_id: AccountId
    conversation: Conversation
    payload: ContactExchangeUpdatedPayload


class ConversationAmbiguousEvent(_EventBase):
    kind: Literal["conversation_ambiguous"]
    account_id: AccountId
    conversation: Conversation
    payload: ConversationAmbiguousPayload


class LoginRequiredEvent(_EventBase):
    kind: Literal["login_required"]
    account_id: AccountId | None
    conversation: None
    payload: LoginRequiredPayload


class LoginQrEvent(_EventBase):
    kind: Literal["login_qr"]
    account_id: AccountId | None
    conversation: None
    payload: LoginQrEventPayload


class LoginOkEvent(_EventBase):
    kind: Literal["login_ok"]
    account_id: AccountId | None
    conversation: None
    payload: LoginOkPayload


class HumanInputRequiredEvent(_EventBase):
    kind: Literal["human_input_required"]
    account_id: AccountId | None
    conversation: Conversation | None
    payload: HumanInputRequiredPayload

    @model_validator(mode="after")
    def _check_expiry(self) -> HumanInputRequiredEvent:
        if self.payload.expires_at is not None and self.payload.expires_at <= self.observed_at:
            raise _fail("payload.expires_at", "expires_at 必须晚于 observed_at")
        return self


class BlockedByDialogEvent(_EventBase):
    kind: Literal["blocked_by_dialog"]
    account_id: AccountId | None
    conversation: Conversation | None
    payload: BlockedByDialogPayload


class DevicePausedEvent(_EventBase):
    kind: Literal["device_paused"]
    account_id: AccountId | None
    conversation: None
    payload: DevicePausedPayload


EventModel = Union[
    ApplicationObservedEvent,
    AttachmentAvailableEvent,
    ContactExchangeUpdatedEvent,
    ConversationAmbiguousEvent,
    LoginRequiredEvent,
    LoginQrEvent,
    LoginOkEvent,
    HumanInputRequiredEvent,
    BlockedByDialogEvent,
    DevicePausedEvent,
]
Event = Annotated[EventModel, Field(discriminator="kind")]

# ---------------------------------------------------------------------------
# 策略 policy
# ---------------------------------------------------------------------------

OutwardAction = Literal["send_greeting", "request_resume", "request_contact_exchange", "search_candidates"]


class JobScope(ContractModel):
    mode: Literal["all", "listed"]
    job_titles: Annotated[
        list[Annotated[str, StringConstraints(min_length=1, max_length=128)]], Field(max_length=200)
    ]

    @model_validator(mode="after")
    def _check(self) -> JobScope:
        if self.mode == "listed" and not self.job_titles:
            raise _fail("job_titles", "mode=listed 时至少列出一个岗位")
        if len(set(self.job_titles)) != len(self.job_titles):
            raise _fail("job_titles", "岗位重复")
        return self


class GreetingPolicy(ContractModel):
    enabled: bool
    template: Annotated[str, StringConstraints(max_length=500)]

    @model_validator(mode="after")
    def _check(self) -> GreetingPolicy:
        if self.enabled and not self.template:
            raise _fail("template", "开启问候时模板不能为空")
        return self


class AfterResumeReceived(ContractModel):
    """简历关联（resume_linked）后的自动动作。0.3.0 起只能是 none：换微信只能由人工在控制台触发，
    服务端不得在任何自动流程中生成 request_contact_exchange。wait_for_parse 保留，当前不起作用。"""

    action: Literal["none"] = "none"
    wait_for_parse: bool = True


class WorkWindow(ContractModel):
    days: Annotated[list[Annotated[int, Field(ge=1, le=7)]], Field(min_length=1)]
    start: HHMM
    end: HHMM

    @model_validator(mode="after")
    def _check(self) -> WorkWindow:
        if len(set(self.days)) != len(self.days):
            raise _fail("days", "星期重复")
        return self


class WorkHours(ContractModel):
    timezone: Annotated[str, StringConstraints(min_length=1, max_length=64)]
    windows: Annotated[list[WorkWindow], Field(max_length=14)]


class PerActionCounts(ContractModel):
    send_greeting: Annotated[int, Field(ge=0, le=86400)]
    request_resume: Annotated[int, Field(ge=0, le=86400)]
    request_contact_exchange: Annotated[int, Field(ge=0, le=86400)]
    search_candidates: Annotated[int, Field(ge=0, le=86400)]


class Policy(ContractModel):
    account_id: AccountId
    policy_version: Annotated[int, Field(ge=1)]
    allowed_actions: list[OutwardAction] = Field(default_factory=list)
    job_scope: JobScope
    greeting: GreetingPolicy
    auto_request_resume: bool
    after_resume_received: AfterResumeReceived = Field(default_factory=AfterResumeReceived)
    # 求简历成功后超过该天数仍未收到并关联简历邮件，流程进入 needs_human
    resume_mail_timeout_days: Annotated[int, Field(ge=1, le=30)] = 3
    # 只读展示：BOSS 账户预留的公司邮箱，以服务端配置为准，PUT 时忽略请求中的值
    company_mailbox: Email | None = None
    # 我方邮件副本的保留天数；到期由我方清理任务删除副本、只留元数据（mail 服务里的邮件由其留存任务处理）
    mail_retention_days: Annotated[int, Field(ge=1, le=365)] = 30
    work_hours: WorkHours
    daily_limits: PerActionCounts
    min_interval_seconds: PerActionCounts
    pause_on_anomaly: Literal[True]
    paused: bool
    updated_at: AwareDatetime
    updated_by: Annotated[str, StringConstraints(min_length=1, max_length=128)]

    @model_validator(mode="after")
    def _check(self) -> Policy:
        if len(set(self.allowed_actions)) != len(self.allowed_actions):
            raise _fail("allowed_actions", "白名单重复")
        return self


# ---------------------------------------------------------------------------
# 设备 device_registration / device_heartbeat / login_qr
# ---------------------------------------------------------------------------

Capability = Literal[
    "observe",
    "send_greeting",
    "request_resume",
    "request_contact_exchange",
    "search_candidates",
    "provide_input",
    "login_relay",
]


class Platform(ContractModel):
    os: Literal["macos"]
    os_version: Annotated[str, StringConstraints(min_length=1, max_length=32)]
    arch: Literal["arm64", "x86_64"] | None = None


class DeviceRegistration(ContractModel):
    enrollment_code: Annotated[str, StringConstraints(min_length=6, max_length=64)] = Field(repr=False)
    device_name: Annotated[str, StringConstraints(min_length=1, max_length=64)]
    mode: Mode
    platform: Platform
    monitor_version: SemVer
    contracts_version: Annotated[str, StringConstraints(pattern=r"^[0-9]+\.[0-9]+\.[0-9]+$")]
    capabilities: list[Capability]

    @model_validator(mode="after")
    def _check(self) -> DeviceRegistration:
        if len(set(self.capabilities)) != len(self.capabilities):
            raise _fail("capabilities", "能力重复")
        if self.mode == "local" and "login_relay" in self.capabilities:
            raise _fail("capabilities", "本机模式不做二维码接力，不得声明 login_relay")
        return self


class CurrentAction(ContractModel):
    command_id: UUID
    action: Action
    started_at: AwareDatetime


class QueueCounts(ContractModel):
    queued_commands: Annotated[int, Field(ge=0)]
    undelivered_results: Annotated[int, Field(ge=0)]
    outbox_events: Annotated[int, Field(ge=0)]


class LastError(ContractModel):
    code: FactCode
    message: Annotated[str, StringConstraints(max_length=500)] | None = None
    scene: Annotated[str, StringConstraints(max_length=64)] | None = None
    at: AwareDatetime

    @model_validator(mode="after")
    def _check(self) -> LastError:
        if self.code == "unsupported_presentation" and not self.scene:
            raise _fail("scene", "unsupported_presentation 必须说明 scene")
        return self


# 0.3.3 增加 suspended：本机模式下窗口已归还用户或接管失败，GUI 挂起
ClientState = Literal["running", "not_running", "login_required", "blocked_by_dialog", "unknown", "suspended"]
CLIENT_STATES: tuple[str, ...] = get_args(ClientState)


class DeviceHeartbeat(ContractModel):
    device_id: DeviceId
    sent_at: AwareDatetime
    mode: Mode
    account_id: AccountId | None
    client_state: ClientState
    paused: bool
    pause_reason: PauseReason | None = None
    needs_baseline: bool
    current_action: CurrentAction | None
    queue: QueueCounts
    last_error: LastError | None = None
    monitor_version: SemVer

    @model_validator(mode="after")
    def _check(self) -> DeviceHeartbeat:
        if self.paused and self.pause_reason is None:
            raise _fail("pause_reason", "paused=true 时必须给出 pause_reason")
        return self


class HeartbeatAccountBinding(ContractModel):
    """心跳回执里的绑定账户（0.3.3），字段与本机 monitor_state.account_binding 一致。"""

    account_id: AccountId
    bound_at: AwareDatetime
    confirmed_by: Annotated[str, StringConstraints(min_length=1, max_length=128)]


class HeartbeatAck(ContractModel):
    """心跳响应（0.3.3 纳入契约）。account_binding 是服务端记录的确认绑定，设备以它为准。"""

    server_time: AwareDatetime
    paused: bool
    policy_version: Annotated[int, Field(ge=1)] | None
    cancellations: list[UUID]
    account_confirmed: bool | None = None
    account_binding: HeartbeatAccountBinding | None

    @model_validator(mode="after")
    def _check(self) -> HeartbeatAck:
        if self.account_confirmed and self.account_binding is None:
            raise _fail("account_binding", "account_confirmed=true 时 account_binding 不能为 null")
        if self.policy_version is not None and self.account_binding is None:
            raise _fail("policy_version", "没有确认的绑定账户时 policy_version 必须为 null")
        return self


class LoginQr(ContractModel):
    device_id: DeviceId
    account_id: AccountId | None
    qr_payload: Annotated[str, StringConstraints(min_length=1, max_length=2048)] = Field(repr=False)
    qr_seq: Annotated[int, Field(ge=1)]
    captured_at: AwareDatetime
    expires_at: AwareDatetime
    decoder: Literal["vision_barcode", "other"]

    @model_validator(mode="after")
    def _check(self) -> LoginQr:
        if self.expires_at <= self.captured_at:
            raise _fail("expires_at", "expires_at 必须晚于 captured_at")
        return self


# ---------------------------------------------------------------------------
# 公司邮箱 mail_message / mail_verification（0.3.0，邮件接入 G 写入，控制台展示）
# ---------------------------------------------------------------------------

MailStatus = Literal["pending", "processed", "needs_review", "failed", "ignored"]
MAIL_STATUSES: tuple[str, ...] = MailStatus.__args__  # type: ignore[attr-defined]
MailMessageId = Annotated[str, StringConstraints(pattern=MAIL_MESSAGE_ID_PATTERN)]
Sha256Hex = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]


class MailMessage(ContractModel):
    """公司邮箱 zhaopin@ 里的一封邮件在我方的记录（方案 8.2，0.3.1 起来自 mail 服务的 mail.ready 推送）。

    收到推送即以 pending 写入（此时只有标识，副本字段为 null）；回取邮件与附件、写我方副本后
    补齐 sha256 与 raw_storage_uri。状态按 states.MAIL_TRANSITIONS 前进。Monitor 不删除 mail
    服务里的邮件；我方副本按 policy.mail_retention_days 清理，只留元数据（copy_purged_at）。
    """

    mail_message_id: MailMessageId
    provider: Literal["remotedesk-mail"]
    provider_message_id: UUID
    webhook_delivery_id: Annotated[str, StringConstraints(min_length=1, max_length=128)] | None = None
    mailbox: Email
    message_id: Annotated[str, StringConstraints(min_length=1, max_length=998)] | None
    received_at: AwareDatetime
    sha256: Sha256Hex | None
    raw_storage_uri: Annotated[str, StringConstraints(min_length=1, max_length=1024)] | None = None
    copy_purged_at: AwareDatetime | None = None
    from_address: Annotated[str, StringConstraints(max_length=254)] | None = None
    subject: Annotated[str, StringConstraints(max_length=500)] | None = None
    status: MailStatus
    attempts: Annotated[int, Field(ge=0)] = 0
    error: Annotated[str, StringConstraints(min_length=1, max_length=500)] | None = None
    updated_at: AwareDatetime

    @model_validator(mode="after")
    def _check(self) -> MailMessage:
        if self.mail_message_id != compute_mail_message_id(self.provider_message_id):
            raise _fail("mail_message_id", "mail_message_id 必须等于 'mail:' + provider_message_id（小写 UUID）")
        if self.status in ("processed", "needs_review"):
            if self.sha256 is None:
                raise _fail("sha256", f"status={self.status} 时必须已有我方副本的 sha256")
            if self.raw_storage_uri is None and self.copy_purged_at is None:
                raise _fail("raw_storage_uri", f"status={self.status} 时必须给出我方副本位置（已按保留期清理的除外）")
        if self.copy_purged_at is not None:
            if self.raw_storage_uri is not None:
                raise _fail("raw_storage_uri", "副本已清理（copy_purged_at 非空）时 raw_storage_uri 必须为 null")
            if self.copy_purged_at < self.received_at:
                raise _fail("copy_purged_at", "copy_purged_at 不能早于 received_at")
        if self.status == "failed" and self.error is None:
            raise _fail("error", "status=failed 时必须给出 error")
        if self.status == "processed" and self.error is not None:
            raise _fail("error", "status=processed 时 error 必须为 null")
        if self.updated_at < self.received_at:
            raise _fail("updated_at", "updated_at 不能早于 received_at")
        return self


MailCheckCode = Literal[
    "pending_backlog",
    "copy_missing",
    "hash_mismatch",
    "document_without_copy",
    "needs_review_mismatch",
    "failed_mismatch",
    "webhook_delivery_failed",
    "upstream_missing",
]
MAIL_CHECK_CODES: tuple[str, ...] = MailCheckCode.__args__  # type: ignore[attr-defined]


class MailCheck(ContractModel):
    """一个检查项。做不了（例如 mail 还没有列出邮件的接口，upstream_missing 无法对账）时
    count 为 null 并写明 unavailable_reason，不能报 0 冒充"没问题"。"""

    code: MailCheckCode
    count: Annotated[int, Field(ge=0)] | None
    unavailable_reason: Annotated[str, StringConstraints(min_length=1, max_length=200)] | None = None
    refs: Annotated[list[Annotated[str, StringConstraints(min_length=1, max_length=128)]], Field(max_length=20)] = (
        Field(default_factory=list)
    )

    @model_validator(mode="after")
    def _check(self) -> MailCheck:
        if (self.count is None) != (self.unavailable_reason is not None):
            raise _fail("count", "count 为 null 当且仅当给出 unavailable_reason")
        if self.count is None and self.refs:
            raise _fail("refs", "未执行的检查项不能带 refs")
        return self


class OverdueResumeRequest(ContractModel):
    case_id: WorkflowId
    command_id: UUID
    requested_at: AwareDatetime
    days_waiting: Annotated[int, Field(ge=0)]


class MailVerification(ContractModel):
    """核对任务的一次结果（方案 8.2 第 5 条）。outcome 只反映邮箱完整性检查；超时提醒单列。"""

    verification_id: Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9._:-]{8,128}$")]
    mailbox: Email
    started_at: AwareDatetime
    finished_at: AwareDatetime
    outcome: Literal["ok", "issues_found", "failed"]
    error: Annotated[str, StringConstraints(min_length=1, max_length=500)] | None = None
    checks: Annotated[list[MailCheck], Field(max_length=len(MAIL_CHECK_CODES))]
    overdue_resume_requests: Annotated[list[OverdueResumeRequest], Field(max_length=200)] = Field(
        default_factory=list
    )
    # 本次按 policy.mail_retention_days 清理的我方副本数量（只删副本，不删 mail 里的邮件）
    purged_copies: Annotated[int, Field(ge=0)] = 0

    @model_validator(mode="after")
    def _check(self) -> MailVerification:
        if self.finished_at < self.started_at:
            raise _fail("finished_at", "finished_at 不能早于 started_at")
        codes = [c.code for c in self.checks]
        if len(set(codes)) != len(codes):
            raise _fail("checks", "检查项重复")
        if self.outcome == "failed":
            if self.error is None:
                raise _fail("error", "outcome=failed 时必须给出 error")
            return self
        if self.error is not None:
            raise _fail("error", "只有 outcome=failed 时才能填写 error")
        missing = [c for c in MAIL_CHECK_CODES if c not in codes]
        if missing:
            raise _fail("checks", f"outcome={self.outcome} 时必须包含全部检查项，缺少 {', '.join(missing)}")
        any_issue = any((c.count or 0) > 0 for c in self.checks)
        if self.outcome == "ok" and any_issue:
            raise _fail("outcome", "有检查项 count>0 时 outcome 不能是 ok")
        if self.outcome == "issues_found" and not any_issue:
            raise _fail("outcome", "所有已执行检查项 count=0 时 outcome 应为 ok（未执行的项不算问题）")
        return self
