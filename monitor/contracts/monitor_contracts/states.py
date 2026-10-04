"""状态机：业务流程（服务端 case）、指令执行（Monitor command）、结果回传（delivery），
以及公司邮箱邮件记录（mail，0.3.0，邮件接入 G 与服务端共用）。

迁移表是唯一依据：D1 账本、F2 服务端状态机都必须调用这里的函数判断迁移，
不得各自维护副本。自迁移（src == dst）一律不允许；重复操作的幂等由调用方处理。
"""

from __future__ import annotations

from collections.abc import Mapping
from enum import StrEnum

from .errors import IllegalTransition


class CaseStage(StrEnum):
    """业务流程状态（方案第六节）。greeted 可选：问候关闭时直接 new_application → resume_requested。

    简历主路径（0.3.0）：resume_requested → resume_linked（简历邮件到达公司邮箱并唯一关联）。
    resume_received 只是可选观察（界面上看到附件），不是必经阶段。超时未收到邮件或关联歧义时
    resume_requested → needs_human。

    人工换微信（0.3.1）：除 closed 外任何阶段都可以进入 contact_requested。进入 contact_requested
    之后简历邮件才到达时，关联照常成功但阶段不回退：resume_document 的关联独立于阶段，
    时间线记一条 resume_linked 事件。
    """

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


class MailState(StrEnum):
    """公司邮箱邮件记录 mail_message.status（方案 8.2）。"""

    PENDING = "pending"
    PROCESSED = "processed"
    NEEDS_REVIEW = "needs_review"
    FAILED = "failed"
    IGNORED = "ignored"


_C = CaseStage
# 中途任何阶段都可以转人工或关闭；needs_human 经人工处理后回到对应阶段。
CASE_TRANSITIONS: Mapping[CaseStage, frozenset[CaseStage]] = {
    # 人工换微信（0.3.1）：除 closed 外任何阶段都可以进入 contact_requested。
    _C.NEW_APPLICATION: frozenset(
        {_C.GREETED, _C.RESUME_REQUESTED, _C.RESUME_RECEIVED, _C.CONTACT_REQUESTED, _C.CLOSED, _C.NEEDS_HUMAN}
    ),
    _C.GREETED: frozenset(
        {_C.RESUME_REQUESTED, _C.RESUME_RECEIVED, _C.CONTACT_REQUESTED, _C.CLOSED, _C.NEEDS_HUMAN}
    ),
    # 主路径：邮件到达并唯一关联 → resume_linked；resume_received（界面看到附件）只是可选观察；
    # 超过 policy.resume_mail_timeout_days 未收到邮件，或关联歧义 → needs_human。
    _C.RESUME_REQUESTED: frozenset(
        {_C.RESUME_LINKED, _C.RESUME_RECEIVED, _C.CONTACT_REQUESTED, _C.CLOSED, _C.NEEDS_HUMAN}
    ),
    _C.RESUME_RECEIVED: frozenset({_C.RESUME_LINKED, _C.CONTACT_REQUESTED, _C.CLOSED, _C.NEEDS_HUMAN}),
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
    # 执行中：得到最终结果。cancelled 只允许在尚未发生对外动作时使用
    # （outbound_action_performed=false；导航过可以取消，见 command_result 规则）；
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

_M = MailState
MAIL_TRANSITIONS: Mapping[MailState, frozenset[MailState]] = {
    # 消费结果：提交成功 processed；关联歧义或找不到流程 needs_review；
    # 连续失败达到上限 failed；非 BOSS 发件人 ignored。未达上限的失败仍为 pending（attempts +1，不算迁移）。
    _M.PENDING: frozenset({_M.PROCESSED, _M.NEEDS_REVIEW, _M.FAILED, _M.IGNORED}),
    # 人工关联后
    _M.NEEDS_REVIEW: frozenset({_M.PROCESSED}),
    # 人工重试：重新入队
    _M.FAILED: frozenset({_M.PENDING}),
    _M.PROCESSED: frozenset(),
    _M.IGNORED: frozenset(),
}

TERMINAL_CASE_STAGES = frozenset(s for s, nxt in CASE_TRANSITIONS.items() if not nxt)
TERMINAL_COMMAND_STATES = frozenset(s for s, nxt in COMMAND_TRANSITIONS.items() if not nxt)
TERMINAL_DELIVERY_STATES = frozenset(s for s, nxt in DELIVERY_TRANSITIONS.items() if not nxt)
TERMINAL_MAIL_STATES = frozenset(s for s, nxt in MAIL_TRANSITIONS.items() if not nxt)

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


def can_transition_mail(src: str | MailState, dst: str | MailState) -> bool:
    """邮件记录状态迁移是否合法。未知状态名抛 ValueError。同状态更新（如 attempts +1）不是迁移，由调用方处理。"""
    s, d = _lookup(MailState, src, "mail"), _lookup(MailState, dst, "mail")
    return d in MAIL_TRANSITIONS[s]


_CHECKS = {
    "case": can_transition_case,
    "command": can_transition_command,
    "delivery": can_transition_delivery,
    "mail": can_transition_mail,
}


def require_transition(layer: str, src: str, dst: str) -> None:
    """不合法时抛 IllegalTransition；layer 为 case / command / delivery / mail。"""
    if layer not in _CHECKS:
        raise ValueError(f"未知的状态层: {layer!r}")
    if not _CHECKS[layer](src, dst):
        raise IllegalTransition(layer, str(src), str(dst))
