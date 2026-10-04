"""三层状态机：覆盖方案第六、七节的全部状态与关键迁移。"""

from __future__ import annotations

import itertools

import pytest

from monitor_contracts import (
    CASE_TRANSITIONS,
    COMMAND_TRANSITIONS,
    DELIVERY_TRANSITIONS,
    RESULT_STATUSES,
    TERMINAL_CASE_STAGES,
    TERMINAL_COMMAND_STATES,
    TERMINAL_DELIVERY_STATES,
    CaseStage,
    CommandState,
    DeliveryState,
    IllegalTransition,
    can_transition_case,
    can_transition_command,
    can_transition_delivery,
    require_transition,
)

# 方案第六节原文列出的状态
SPEC_CASE_STAGES = {
    "new_application",
    "greeted",
    "resume_requested",
    "resume_received",
    "resume_linked",
    "contact_requested",
    "contact_available",
    "closed",
    "needs_human",
}
SPEC_COMMAND_STATES = {
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "expired",
    "skipped_precondition",
    "unknown",
}
SPEC_DELIVERY_STATES = {"pending", "delivered"}

# 独立写出的期望迁移（与实现表逐项对照，任何改动都必须同时改这里）
EXPECTED_CASE = {
    ("new_application", "greeted"),
    ("new_application", "resume_requested"),
    ("new_application", "resume_received"),
    ("new_application", "closed"),
    ("new_application", "needs_human"),
    ("greeted", "resume_requested"),
    ("greeted", "resume_received"),
    ("greeted", "closed"),
    ("greeted", "needs_human"),
    ("resume_requested", "resume_received"),
    ("resume_requested", "resume_linked"),
    ("resume_requested", "closed"),
    ("resume_requested", "needs_human"),
    ("resume_received", "resume_linked"),
    ("resume_received", "closed"),
    ("resume_received", "needs_human"),
    ("resume_linked", "contact_requested"),
    # 0.3.1：人工换微信，除 closed 外任何阶段都可以进入 contact_requested
    ("new_application", "contact_requested"),
    ("greeted", "contact_requested"),
    ("resume_requested", "contact_requested"),
    ("resume_received", "contact_requested"),
    ("resume_linked", "closed"),
    ("resume_linked", "needs_human"),
    ("contact_requested", "contact_available"),
    ("contact_requested", "closed"),
    ("contact_requested", "needs_human"),
    ("contact_available", "closed"),
    ("needs_human", "greeted"),
    ("needs_human", "resume_requested"),
    ("needs_human", "resume_received"),
    ("needs_human", "resume_linked"),
    ("needs_human", "contact_requested"),
    ("needs_human", "contact_available"),
    ("needs_human", "closed"),
}
EXPECTED_COMMAND = {
    ("queued", "running"),
    ("queued", "cancelled"),
    ("queued", "expired"),
    ("queued", "failed"),
    ("running", "succeeded"),
    ("running", "failed"),
    ("running", "cancelled"),
    ("running", "skipped_precondition"),
    ("running", "unknown"),
}
EXPECTED_DELIVERY = {("pending", "delivered")}


def test_all_spec_states_present():
    assert {s.value for s in CaseStage} == SPEC_CASE_STAGES
    assert {s.value for s in CommandState} == SPEC_COMMAND_STATES
    assert {s.value for s in DeliveryState} == SPEC_DELIVERY_STATES
    assert set(CASE_TRANSITIONS) == set(CaseStage)
    assert set(COMMAND_TRANSITIONS) == set(CommandState)
    assert set(DELIVERY_TRANSITIONS) == set(DeliveryState)


@pytest.mark.parametrize(
    ("fn", "states", "expected"),
    [
        (can_transition_case, SPEC_CASE_STAGES, EXPECTED_CASE),
        (can_transition_command, SPEC_COMMAND_STATES, EXPECTED_COMMAND),
        (can_transition_delivery, SPEC_DELIVERY_STATES, EXPECTED_DELIVERY),
    ],
    ids=["case", "command", "delivery"],
)
def test_full_transition_matrix(fn, states, expected):
    for src, dst in itertools.product(sorted(states), repeat=2):
        assert fn(src, dst) == ((src, dst) in expected), f"{src} -> {dst}"


def test_every_state_is_reachable_or_initial():
    for table, initial in (
        (CASE_TRANSITIONS, CaseStage.NEW_APPLICATION),
        (COMMAND_TRANSITIONS, CommandState.QUEUED),
        (DELIVERY_TRANSITIONS, DeliveryState.PENDING),
    ):
        targets = set().union(*table.values())
        for state in table:
            assert state == initial or state in targets, state


def test_terminal_states():
    assert TERMINAL_CASE_STAGES == {CaseStage.CLOSED}
    assert {s.value for s in TERMINAL_COMMAND_STATES} == set(RESULT_STATUSES)
    assert TERMINAL_DELIVERY_STATES == {DeliveryState.DELIVERED}


def test_greeting_is_optional():
    # 问候关闭时直接请求简历
    assert can_transition_case("new_application", "resume_requested")


@pytest.mark.parametrize(
    ("src", "dst", "allowed", "spec_row"),
    [
        ("queued", "cancelled", True, "排队时被取消"),
        ("queued", "expired", True, "指令过期"),
        ("queued", "failed", True, "上限/白名单/账户不符：不调用 driver 直接失败"),
        ("running", "unknown", True, "点击后崩溃，结果未知"),
        ("running", "queued", False, "崩溃恢复不得回到排队重做"),
        ("unknown", "running", False, "unknown 停止自动重试"),
        ("unknown", "succeeded", False, "人工确认记在服务端，不改写本机结果"),
        ("running", "expired", False, "已开始执行的指令不再判过期"),
        ("succeeded", "failed", False, "终态不可变"),
    ],
)
def test_section_seven_exception_rows(src, dst, allowed, spec_row):
    assert can_transition_command(src, dst) is allowed, spec_row


def test_self_transitions_are_not_allowed():
    for s in CaseStage:
        assert not can_transition_case(s, s)
    for s in CommandState:
        assert not can_transition_command(s, s)
    for s in DeliveryState:
        assert not can_transition_delivery(s, s)


def test_unknown_state_name_raises():
    with pytest.raises(ValueError):
        can_transition_case("new_application", "hired")
    with pytest.raises(ValueError):
        can_transition_command("waiting", "running")
    with pytest.raises(ValueError):
        can_transition_delivery("pending", "sent")


def test_require_transition():
    require_transition("command", "queued", "running")
    with pytest.raises(IllegalTransition) as info:
        require_transition("delivery", "delivered", "pending")
    assert info.value.layer == "delivery"
    assert info.value.src == "delivered"
    with pytest.raises(ValueError):
        require_transition("nope", "a", "b")


def test_enum_members_accepted():
    assert can_transition_command(CommandState.QUEUED, CommandState.RUNNING)
    assert can_transition_case(CaseStage.CONTACT_REQUESTED, CaseStage.CONTACT_AVAILABLE)
