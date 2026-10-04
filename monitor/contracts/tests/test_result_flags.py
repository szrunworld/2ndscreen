"""command_result 三个执行标志的组合规则（契约 0.2.0）。

navigation_performed / outbound_action_performed / externally_visible_side_effect：
- verify_only：允许导航，不允许对外动作；
- cancelled：不允许对外动作（running 中途取消时可以已导航）；
- expired：三个都为 false；
- 对外动作 ⇒ 对方可见；
- 三个标志在线上必填。
JSON Schema 与 pydantic 两层都要拒绝/接受同样的组合。
"""

from __future__ import annotations

import copy
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError
from vector_helpers import load_vectors

from monitor_contracts import (
    ActionResult,
    CommandResult,
    ContractValidationError,
    check,
    validate_command,
    validate_command_result,
)

V = {name: vec["data"] for name, vec in load_vectors("valid")}
NOW = datetime(2026, 10, 4, 1, 31, 20, tzinfo=UTC)
FLAGS = ("navigation_performed", "outbound_action_performed", "externally_visible_side_effect")


def _result(base: str, **changes):
    data = copy.deepcopy(V[base])
    data.update(changes)
    return data


def _flags(nav: bool, out: bool, vis: bool) -> dict:
    return dict(zip(FLAGS, (nav, out, vis), strict=True))


def _layers(data: dict) -> set[str]:
    """返回拒绝该数据的层（schema / model），空集合表示合法。"""
    return {e.layer for e in check("command_result", data)}


# --- verify_only -------------------------------------------------------------------


@pytest.mark.parametrize("vis", [False, True])
def test_verify_only_allows_navigation(vis):
    # 打开未读会话确认是否已求简历：导航 + 已读回执，但没有对外动作
    data = _result("result_resume_skipped", execution_mode="verify_only", **_flags(True, False, vis))
    validate_command_result(data)


def test_verify_only_rejects_outbound():
    data = _result("result_greeting_succeeded", execution_mode="verify_only", **_flags(True, True, True))
    errors = check("command_result", data)
    assert [e.path for e in errors] == ["outbound_action_performed"]


def test_verify_only_rejects_outbound_in_model_layer():
    data = _result("result_greeting_succeeded", execution_mode="verify_only", **_flags(True, True, True))
    with pytest.raises(ValidationError) as exc:
        CommandResult.model_validate(data)
    assert [e["ctx"]["path"] for e in exc.value.errors()] == ["outbound_action_performed"]


def test_action_result_verify_only():
    cmd = validate_command(V["command_request_resume_verify_only"])
    ok = ActionResult(status="succeeded", executed_at=NOW, navigation_performed=True, externally_visible_side_effect=True)
    ok.check_for("request_resume", "verify_only")
    assert ok.to_command_result(cmd, reported_at=NOW).navigation_performed is True
    bad = ActionResult(
        status="succeeded",
        executed_at=NOW,
        navigation_performed=True,
        outbound_action_performed=True,
        externally_visible_side_effect=True,
    )
    with pytest.raises(ValueError):
        bad.check_for("request_resume", "verify_only")
    with pytest.raises(ValueError):
        bad.to_command_result(cmd, reported_at=NOW)


# --- cancelled / expired -----------------------------------------------------------


def test_cancelled_all_false_is_valid():
    validate_command_result(_result("result_cancelled", **_flags(False, False, False)))


@pytest.mark.parametrize("vis", [False, True])
def test_cancelled_after_navigation_is_valid(vis):
    # running 中途被取消：已打开会话（可能已读），尚未点任何对外按钮
    validate_command_result(_result("result_cancelled", **_flags(True, False, vis)))


def test_cancelled_rejects_outbound():
    data = _result("result_cancelled", **_flags(True, True, True))
    assert [e.path for e in check("command_result", data)] == ["outbound_action_performed"]


def test_expired_all_false_is_valid():
    validate_command_result(_result("result_cancelled", status="expired", **_flags(False, False, False)))


@pytest.mark.parametrize("flag", FLAGS)
def test_expired_rejects_any_flag(flag):
    flags = _flags(False, False, False)
    flags[flag] = True
    if flag == "outbound_action_performed":
        flags["externally_visible_side_effect"] = True
    data = _result("result_cancelled", status="expired", **flags)
    assert flag in {e.path for e in check("command_result", data)}
    assert _layers(data)


def test_action_result_cancelled_and_expired():
    cmd = validate_command(V["command_send_greeting"])
    ActionResult(status="cancelled", navigation_performed=True).to_command_result(cmd, reported_at=NOW)
    with pytest.raises(ValueError):
        ActionResult(
            status="cancelled", outbound_action_performed=True, externally_visible_side_effect=True
        ).to_command_result(cmd, reported_at=NOW)
    with pytest.raises(ValueError):
        ActionResult(status="expired", navigation_performed=True).to_command_result(cmd, reported_at=NOW)


# --- 不变式与必填 ------------------------------------------------------------------


def test_outbound_implies_externally_visible():
    data = _result("result_greeting_succeeded", **_flags(True, True, False))
    errors = check("command_result", data)
    assert [e.path for e in errors] == ["externally_visible_side_effect"]
    with pytest.raises(ValueError):
        ActionResult(status="succeeded", executed_at=NOW, outbound_action_performed=True).check_for("send_greeting")


def test_visible_without_outbound_is_valid():
    # 只打开了未读会话：没有对外动作，但对方可能看到已读
    validate_command_result(_result("result_resume_skipped", **_flags(True, False, True)))


@pytest.mark.parametrize("flag", FLAGS)
def test_flags_are_required_on_the_wire(flag):
    data = _result("result_greeting_succeeded")
    del data[flag]
    errors = check("command_result", data)
    assert errors and all(e.layer == "schema" for e in errors)


def test_old_flag_is_rejected():
    data = _result("result_greeting_succeeded", gui_write_performed=True)
    with pytest.raises(ContractValidationError):
        validate_command_result(data)


def test_action_not_allowed_without_driver_has_all_flags_false():
    # 白名单关闭：handler 不调用 driver，三个标志保持默认 false
    cmd = validate_command(V["command_send_greeting"])
    result = ActionResult(status="failed", reason="action_not_allowed").to_command_result(cmd, reported_at=NOW)
    assert (result.navigation_performed, result.outbound_action_performed, result.externally_visible_side_effect) == (
        False,
        False,
        False,
    )


# --- 搜索算对外动作（0.3.2） ---------------------------------------------------------


@pytest.mark.parametrize("base", ["result_search_complete", "result_search_empty_confirmed"])
def test_search_success_has_all_flags_true(base):
    # 用户 2026-10-04：在搜索框输入并提交关键词算对外动作，成功的搜索三个标志都为 true
    validate_command_result(_result(base, **_flags(True, True, True)))


@pytest.mark.parametrize("flag", FLAGS)
def test_search_success_rejects_any_false_flag(flag):
    flags = _flags(True, True, True)
    flags[flag] = False
    data = _result("result_search_complete", **flags)
    assert flag in {e.path for e in check("command_result", data)}
    assert _layers(data) == {"schema"}
    with pytest.raises(ValidationError) as exc:
        CommandResult.model_validate(data)
    assert flag in {e["ctx"]["path"] for e in exc.value.errors()}


def test_search_failed_flags_reported_as_is():
    # 失败（例如读不出结果）时如实填写：已输入关键词就是 true，白名单关闭则全 false
    validate_command_result(_result("result_search_unreadable", **_flags(True, True, True)))
    validate_command_result(_result("result_search_unreadable", **_flags(False, False, False)))


def test_action_result_search_success():
    cmd = validate_command(V["command_search"])
    snap = validate_command_result(V["result_search_complete"]).output
    ok = ActionResult(
        status="succeeded",
        executed_at=NOW,
        navigation_performed=True,
        outbound_action_performed=True,
        externally_visible_side_effect=True,
        output=snap,
    )
    assert ok.to_command_result(cmd, reported_at=NOW).outbound_action_performed is True
    with pytest.raises(ValueError):
        ActionResult(status="succeeded", executed_at=NOW, navigation_performed=True, output=snap).to_command_result(
            cmd, reported_at=NOW
        )
