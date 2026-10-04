"""招聘 Monitor 模块间契约。

其他任务只依赖本包导出的名字；契约变更流程见 docs/monitor/contracts.md
（修改后 __version__ 次版本号 +1）。
"""

from __future__ import annotations

__version__ = "0.2.0"

from .driver import (
    DRIVER_ERROR_CODES,
    ActionReceipt,
    CliFailedError,
    ClickMode,
    Driver,
    DriverError,
    DriverTimeoutError,
    Element,
    Locator,
    ScreenLostError,
    ScrollDirection,
    Snapshot,
    StaleSnapshotError,
    Target,
    TargetAmbiguousError,
    TargetNotFoundError,
    WindowInfo,
    WindowLostError,
    WindowSelector,
)
from .errors import ContractValidationError, FieldError, IllegalTransition
from .event_id import EVENT_ID_SCHEME, compute_event_id, conversation_identity, observation_bucket
from .fixtures import AxFixture, FixtureElement, FixtureStep, StepAnnotations
from .idempotency import (
    IDEMPOTENCY_KEY_PATTERN,
    claim_key,
    command_ack_key,
    command_result_key,
    events_batch_key,
    heartbeat_key,
    is_valid_idempotency_key,
    login_qr_key,
    resume_document_key,
)
from .models import (
    ACTIONS,
    CONVERSATION_ACTIONS,
    CONVERSATION_EVENT_KINDS,
    EVENT_KINDS,
    OUTWARD_ACTIONS,
    REASONS,
    RESULT_STATUSES,
    Action,
    ActionOutput,
    Command,
    CommandModel,
    CommandResult,
    ContactOutput,
    Conversation,
    ConversationTarget,
    DeviceHeartbeat,
    DeviceRegistration,
    Event,
    EventKind,
    EventModel,
    EvidenceItem,
    Fact,
    ForwardOutput,
    Frame,
    LoginQr,
    Observed,
    Policy,
    Reason,
    ResultStatus,
    SearchItem,
    SearchOutput,
    SearchSnapshot,
)
from .protocols import (
    AccountBinding,
    ActionContext,
    ActionHandler,
    ActionResult,
    Baseline,
    Ledger,
    LedgerCommand,
    MonitorState,
    Observer,
    OutboxEntry,
)
from .states import (
    CASE_TRANSITIONS,
    COMMAND_TRANSITIONS,
    DELIVERY_TRANSITIONS,
    TERMINAL_CASE_STAGES,
    TERMINAL_COMMAND_STATES,
    TERMINAL_DELIVERY_STATES,
    CaseStage,
    CommandState,
    DeliveryState,
    can_transition_case,
    can_transition_command,
    can_transition_delivery,
    require_transition,
)
from .validate import (
    CONTRACT_NAMES,
    check,
    schema_errors,
    validate,
    validate_ax_fixture,
    validate_command,
    validate_command_result,
    validate_device_heartbeat,
    validate_device_registration,
    validate_event,
    validate_login_qr,
    validate_policy,
    validate_search_snapshot,
)

__all__ = [name for name in dir() if not name.startswith("_") and name != "annotations"]
