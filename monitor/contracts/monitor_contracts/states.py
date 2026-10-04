"""三层状态机：业务流程（服务端 case）、指令执行（Monitor command）、结果回传（delivery）。

迁移表是唯一依据：D1 账本、F2 服务端状态机都必须调用这里的函数判断迁移，
不得各自维护副本。自迁移（src == dst）一律不允许；重复操作的幂等由调用方处理。
"""

from __future__ import annotations

from collections.abc import Mapping
from enum import StrEnum

from .errors import IllegalTransition


class CaseStage(StrEnum):
    """业务流程状态（方案第六节）。greeted 可选：问候关闭时直接 new_application → resume_requested。"""

    NEW_APPLICATION = "new_application"
    GREETED = "greeted"
    RESUME_REQUESTED = "resume_requested"
    RESUME_RECEIVED = "resume_received"
    RESUME_LINKED = "resume_linked"
    CONTACT_REQUESTED = "contact_requested"
    CONTACT_AVAILABLE = "contact_available"
    CLOSED = "closed"
    NEEDS_HUMAN = "needs_human"


class CommandState(StrEnum):
    """指令执行状态（方案第六、七节）。"""

    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    EXPIRED = "expired"
    SKIPPED_PRECONDITION = "skipped_precondition"
    UNKNOWN = "unknown"


class DeliveryState(StrEnum):
    """结果与事件的回传状态。"""

    PENDING = "pending"
    DELIVERED = "delivered"


_C = CaseStage
# 中途任何阶段都可以转人工或关闭；needs_human 经人工处理后回到对应阶段。
CASE_TRANSITIONS: Mapping[CaseStage, frozenset[CaseStage]] = {
    _C.NEW_APPLICATION: frozenset(
        {_C.GREETED, _C.RESUME_REQUESTED, _C.RESUME_RECEIVED, _C.CLOSED, _C.NEEDS_HUMAN}
    ),
    _C.GREETED: frozenset({_C.RESUME_REQUESTED, _C.RESUME_RECEIVED, _C.CLOSED, _C.NEEDS_HUMAN}),
    _C.RESUME_REQUESTED: frozenset({_C.RESUME_RECEIVED, _C.RESUME_LINKED, _C.CLOSED, _C.NEEDS_HUMAN}),
    _C.RESUME_RECEIVED: frozenset({_C.RESUME_LINKED, _C.CLOSED, _C.NEEDS_HUMAN}),
    _C.RESUME_LINKED: frozenset({_C.CONTACT_REQUESTED, _C.CLOSED, _C.NEEDS_HUMAN}),
    _C.CONTACT_REQUESTED: frozenset({_C.CONTACT_AVAILABLE, _C.CLOSED, _C.NEEDS_HUMAN}),
    _C.CONTACT_AVAILABLE: frozenset({_C.CLOSED}),
    _C.NEEDS_HUMAN: frozenset(
        {
            _C.GREETED,
            _C.RESUME_REQUESTED,
            _C.RESUME_RECEIVED,
            _C.RESUME_LINKED,
            _C.CONTACT_REQUESTED,
            _C.CONTACT_AVAILABLE,
            _C.CLOSED,
        }
    ),
    _C.CLOSED: frozenset(),
}

_S = CommandState
COMMAND_TRANSITIONS: Mapping[CommandState, frozenset[CommandState]] = {
    # 排队中：可开始执行；也可在执行前被取消、过期，或因前置检查失败
    # （账户不符、白名单关闭、限额、依赖未满足）直接 failed，此时不调用 driver。
    _S.QUEUED: frozenset({_S.RUNNING, _S.CANCELLED, _S.EXPIRED, _S.FAILED}),
    # 执行中：得到最终结果。cancelled 只允许在尚未发生 GUI 写操作时使用；
    # 崩溃恢复后由 verify_only 判定，仍不明则 unknown。不允许回到 queued（防止重做）。
    _S.RUNNING: frozenset(
        {_S.SUCCEEDED, _S.FAILED, _S.CANCELLED, _S.SKIPPED_PRECONDITION, _S.UNKNOWN}
    ),
    _S.SUCCEEDED: frozenset(),
    _S.FAILED: frozenset(),
    _S.CANCELLED: frozenset(),
    _S.EXPIRED: frozenset(),
    _S.SKIPPED_PRECONDITION: frozenset(),
    # unknown 在本机是终态：停止自动重试；人工确认记在服务端 manual_actions，不改写本机结果。
    _S.UNKNOWN: frozenset(),
}

_D = DeliveryState
DELIVERY_TRANSITIONS: Mapping[DeliveryState, frozenset[DeliveryState]] = {
    _D.PENDING: frozenset({_D.DELIVERED}),
    _D.DELIVERED: frozenset(),
}

TERMINAL_CASE_STAGES = frozenset(s for s, nxt in CASE_TRANSITIONS.items() if not nxt)
TERMINAL_COMMAND_STATES = frozenset(s for s, nxt in COMMAND_TRANSITIONS.items() if not nxt)
TERMINAL_DELIVERY_STATES = frozenset(s for s, nxt in DELIVERY_TRANSITIONS.items() if not nxt)

# 有最终结果、需要回传的指令状态（与 command_result.status 枚举一致）
RESULT_COMMAND_STATES = TERMINAL_COMMAND_STATES


def _lookup[E: StrEnum](enum: type[E], value: str | E, layer: str) -> E:
    try:
        return enum(value)
    except ValueError:
        raise ValueError(f"未知的 {layer} 状态: {value!r}") from None


def can_transition_case(src: str | CaseStage, dst: str | CaseStage) -> bool:
    """业务流程迁移是否合法。未知状态名抛 ValueError。"""
    s, d = _lookup(CaseStage, src, "case"), _lookup(CaseStage, dst, "case")
    return d in CASE_TRANSITIONS[s]


def can_transition_command(src: str | CommandState, dst: str | CommandState) -> bool:
    """指令执行迁移是否合法。未知状态名抛 ValueError。"""
    s, d = _lookup(CommandState, src, "command"), _lookup(CommandState, dst, "command")
    return d in COMMAND_TRANSITIONS[s]


def can_transition_delivery(src: str | DeliveryState, dst: str | DeliveryState) -> bool:
    """回传迁移是否合法。未知状态名抛 ValueError。"""
    s, d = _lookup(DeliveryState, src, "delivery"), _lookup(DeliveryState, dst, "delivery")
    return d in DELIVERY_TRANSITIONS[s]


_CHECKS = {
    "case": can_transition_case,
    "command": can_transition_command,
    "delivery": can_transition_delivery,
}


def require_transition(layer: str, src: str, dst: str) -> None:
    """不合法时抛 IllegalTransition；layer 为 case / command / delivery。"""
    if layer not in _CHECKS:
        raise ValueError(f"未知的状态层: {layer!r}")
    if not _CHECKS[layer](src, dst):
        raise IllegalTransition(layer, str(src), str(dst))
