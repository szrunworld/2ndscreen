"""模型的语义规则：搜索三种结局、ActionResult 组装、敏感字段不进 repr。"""

from __future__ import annotations

import copy
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError
from vector_helpers import load_vectors

from monitor_contracts import (
    ActionResult,
    CommandResult,
    ContactOutput,
    ContractValidationError,
    DeviceRegistration,
    SearchOutput,
    check,
    validate_command,
    validate_command_result,
    validate_device_heartbeat,
    validate_device_registration,
    validate_event,
    validate_login_qr,
    validate_policy,
    validate_search_snapshot,
)
from monitor_contracts.models import (
    ApplicationObservedEvent,
    ProvideInputCommand,
    SearchCandidatesCommand,
    SendGreetingCommand,
)

V = {name: vec["data"] for name, vec in load_vectors("valid")}
NOW = datetime(2026, 10, 4, 1, 31, 20, tzinfo=UTC)


# --- 搜索：unreadable 与 empty_confirmed 必须可区分 --------------------------------


def test_search_outcomes_are_distinct():
    unreadable = validate_search_snapshot(V["snapshot_unreadable"])
    empty = validate_search_snapshot(V["snapshot_empty_confirmed"])
    partial = validate_search_snapshot(V["snapshot_partial"])
    assert unreadable.items == [] and empty.items == []
    assert unreadable.outcome == "unreadable"
    assert empty.outcome == "no_results"
    assert partial.outcome == "results"


def test_unreadable_cannot_carry_items_or_be_success():
    bad = copy.deepcopy(V["snapshot_unreadable"])
    bad["items"] = V["snapshot_partial"]["items"]
    assert [e.path for e in check("search_snapshot", bad)] == ["items"]

    result = copy.deepcopy(V["result_search_unreadable"])
    result["status"], result["reason"] = "succeeded", None
    assert "output.snapshot.coverage" in [e.path for e in check("command_result", result)]


def test_empty_confirmed_may_not_carry_unreadable_reason():
    bad = {**V["snapshot_empty_confirmed"], "unreadable_reason": "x"}
    assert [e.path for e in check("search_snapshot", bad)] == ["unreadable_reason"]


# --- validate_* 返回正确的模型类型 -----------------------------------------------


def test_validate_functions_return_models():
    assert isinstance(validate_command(V["command_send_greeting"]), SendGreetingCommand)
    assert isinstance(validate_command(V["command_search"]), SearchCandidatesCommand)
    assert isinstance(validate_event(V["event_application_observed"]), ApplicationObservedEvent)
    assert isinstance(validate_command_result(V["result_search_complete"]).output, SearchOutput)
    assert validate_policy(V["policy_default"]).pause_on_anomaly is True
    assert validate_device_registration(V["device_registration_remote"]).mode == "remote"
    assert validate_device_heartbeat(V["device_heartbeat_paused"]).paused is True
    assert validate_login_qr(V["login_qr_first"]).qr_seq == 1


def test_validate_rejects_non_object():
    with pytest.raises(ContractValidationError) as info:
        validate_command(["not", "an", "object"])
    assert info.value.errors[0].path == ""


def test_verify_only_flag():
    cmd = validate_command(V["command_request_resume_verify_only"])
    assert cmd.is_verify_only
    assert not validate_command(V["command_send_greeting"]).is_verify_only


# --- ActionResult → CommandResult --------------------------------------------------


def test_action_result_to_command_result():
    cmd = validate_command(V["command_contact_exchange"])
    ar = ActionResult(
        status="succeeded",
        executed_at=NOW,
        gui_write_performed=True,
        output=ContactOutput(exchange_type="phone", exchange_state="requested"),
    )
    result = ar.to_command_result(cmd, reported_at=NOW)
    assert isinstance(result, CommandResult)
    assert result.command_id == cmd.command_id
    assert check("command_result", result.to_wire()) == []


def test_action_result_rules_are_enforced():
    cmd = validate_command(V["command_send_greeting"])
    with pytest.raises(ValidationError):
        ActionResult(status="succeeded").to_command_result(cmd, reported_at=NOW)  # 缺 executed_at
    with pytest.raises(ValidationError):
        ActionResult(status="failed", executed_at=NOW).to_command_result(cmd, reported_at=NOW)  # 缺 reason
    with pytest.raises(ValidationError):
        ActionResult(status="cancelled", gui_write_performed=True).to_command_result(cmd, reported_at=NOW)


def test_action_result_check_for():
    ar = ActionResult(status="failed", reason="action_not_allowed")
    ar.check_for("send_greeting")
    with pytest.raises(ValueError):
        ActionResult(status="succeeded", executed_at=NOW).check_for("search_candidates")  # 缺快照
    with pytest.raises(ValueError):
        ActionResult(status="succeeded", executed_at=NOW, gui_write_performed=True).check_for(
            "request_resume", "verify_only"
        )


# --- 敏感字段 ----------------------------------------------------------------------


def test_sensitive_values_not_in_repr():
    cmd = validate_command(V["command_provide_input"])
    assert isinstance(cmd, ProvideInputCommand)
    assert "123456" not in repr(cmd)
    reg = DeviceRegistration(**V["device_registration_remote"])
    assert "ENR-7Q4K-22" not in repr(reg)
    qr = validate_login_qr(V["login_qr_first"])
    assert "abc123" not in repr(qr)
    # 但线上序列化必须保留原值
    assert cmd.to_wire()["payload"]["value"] == "123456"
