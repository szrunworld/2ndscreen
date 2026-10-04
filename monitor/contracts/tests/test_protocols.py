"""ActionHandler / Observer / Ledger 协议与账本数据模型。"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError
from vector_helpers import load_vectors

from monitor_contracts import (
    ActionContext,
    ActionHandler,
    ActionResult,
    Baseline,
    CommandState,
    DeliveryState,
    Ledger,
    LedgerCommand,
    MonitorState,
    Observer,
    OutboxEntry,
    validate_command,
    validate_command_result,
    validate_event,
)

V = {name: vec["data"] for name, vec in load_vectors("valid")}
NOW = datetime(2026, 10, 4, 1, 0, tzinfo=UTC)


def test_action_context_whitelist_default_closed():
    ctx = ActionContext(account_id="a", device_id="d", mode="local", allowed_actions=frozenset(), deadline=NOW)
    assert not ctx.is_allowed("send_greeting")
    assert ctx.clock().tzinfo is not None
    ctx2 = ActionContext(
        account_id="a", device_id="d", mode="local", allowed_actions=frozenset({"request_resume"}), deadline=NOW
    )
    assert ctx2.is_allowed("request_resume")


class _Handler:
    action = "request_resume"

    def run(self, command, driver, ctx):
        return ActionResult(status="failed", reason="action_not_allowed")

    def verify_only(self, command, driver, ctx):
        return ActionResult(status="unknown", reason="unreadable", executed_at=NOW)


class _Observer:
    def observe(self, driver, baseline):
        baseline.established = True
        return []


def test_handler_and_observer_protocols():
    assert isinstance(_Handler(), ActionHandler)
    assert isinstance(_Observer(), Observer)
    b = Baseline()
    assert _Observer().observe(None, b) == [] and b.established


def test_ledger_protocol_shape():
    names = {
        "put_command",
        "get_command",
        "list_commands",
        "transition_command",
        "pending_results",
        "mark_result_delivered",
        "append_event",
        "pending_events",
        "mark_events_delivered",
        "outbox_cursor",
        "load_state",
        "save_state",
    }
    assert names <= set(dir(Ledger))
    assert not isinstance(object(), Ledger)


def test_ledger_command_rules():
    cmd = validate_command(V["command_send_greeting"])
    LedgerCommand(command=cmd, state=CommandState.QUEUED, received_at=NOW, updated_at=NOW)
    result = validate_command_result(V["result_greeting_succeeded"])
    LedgerCommand(
        command=cmd,
        state=CommandState.SUCCEEDED,
        result=result,
        delivery=DeliveryState.PENDING,
        received_at=NOW,
        updated_at=NOW,
    )
    with pytest.raises(ValidationError):  # 终态缺结果
        LedgerCommand(command=cmd, state=CommandState.FAILED, received_at=NOW, updated_at=NOW)
    with pytest.raises(ValidationError):  # 状态与结果不一致
        LedgerCommand(
            command=cmd,
            state=CommandState.FAILED,
            result=result,
            delivery=DeliveryState.PENDING,
            received_at=NOW,
            updated_at=NOW,
        )
    with pytest.raises(ValidationError):  # 未结束却有回传状态
        LedgerCommand(
            command=cmd, state=CommandState.RUNNING, delivery=DeliveryState.PENDING, received_at=NOW, updated_at=NOW
        )


def test_ledger_command_roundtrip_json():
    cmd = validate_command(V["command_search"])
    row = LedgerCommand(command=cmd, state=CommandState.QUEUED, received_at=NOW, updated_at=NOW)
    again = LedgerCommand.model_validate_json(row.model_dump_json())
    assert again == row


def test_outbox_entry_and_monitor_state():
    ev = validate_event(V["event_application_observed"])
    entry = OutboxEntry(seq=1, event=ev, delivery=DeliveryState.PENDING, enqueued_at=NOW)
    assert OutboxEntry.model_validate_json(entry.model_dump_json()) == entry
    with pytest.raises(ValidationError):
        OutboxEntry(seq=0, event=ev, delivery=DeliveryState.PENDING, enqueued_at=NOW)
    state = MonitorState()
    assert state.needs_baseline and not state.paused and state.baseline.generation == 0
    with pytest.raises(ValidationError):
        MonitorState(paused=True)
    MonitorState(paused=True, pause_reason="user_request", mode="remote")
