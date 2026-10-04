"""send_greeting 处理器测试：FakeDriver 回放会话详情夹具，用 Advance 把"点击『发送』后"切到派生步骤。"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest
from monitor_contracts import DriverError, DriverTimeoutError, Locator

from monitor.actions import SendGreetingHandler
from monitor.core import ManualClock
from monitor.driver import Advance


def _helpers():
    name = "h1_action_test_helpers"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name("test_actions_common.py"))
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


h = _helpers()

TEXT = "你好，方便聊聊这个岗位吗？"
SEND = Locator(text="发送")


def run(steps, conversation, *, text=TEXT, advances=(), allowed=("send_greeting",), verify=False):
    clock = ManualClock(h.START)
    driver = h.fake(steps, advances=advances, clock=clock)
    guard, ctx = h.context(driver, clock, allowed=allowed, verify=verify)
    cmd = h.command("send_greeting", conversation, {"text": text}, mode="verify_only" if verify else "execute")
    handler = SendGreetingHandler(clock=clock)
    result = (handler.verify_only if verify else handler.run)(cmd, guard, ctx)
    # 结果必须能组装成合法的 command_result
    result.to_command_result(cmd, reported_at=clock.now())
    return result, driver, guard, clock


def base():
    """候选人O 的会话已打开，聊天区没有该问候。"""
    return h.raw_step("conversation_detail", 1)


def sent(step):
    return h.derive(step, "发送后：聊天区出现我方消息", add=h.own_message(step, TEXT))


# ---- 成功 ----


def test_success_types_clicks_send_and_sees_own_message():
    b = base()
    result, driver, guard, clock = run([b, sent(b)], h.CONV_O, advances=[Advance("click", on_step=0, target=SEND, goto=1)])
    assert (result.status, result.reason) == ("succeeded", None)
    assert result.navigation_performed and result.outbound_action_performed and result.externally_visible_side_effect
    assert result.executed_at == h.START
    assert [c.method for c in driver.writes] == ["click", "type_text", "click"]
    assert driver.writes[1].args["text"] == TEXT
    assert driver.writes[1].element.role == "AXTextArea"
    assert driver.writes[2].element.text == "发送"
    assert guard.navigation_calls == 1 and guard.outbound_calls == 2
    assert {f.code for f in result.observed.after} == {"greeting_text_present"}
    assert any(i.source == "chat" and i.text == TEXT for i in result.evidence)


def test_success_when_message_appears_on_a_later_poll():
    """点发送后先是"发送中"（消息未出现），等待一轮后消息才出现：轮询用注入时钟，不是固定等待。"""
    b = base()
    steps = [b, h.derive(b, "发送中：消息未出现"), sent(b)]
    driver = h.fake(steps, advances=[Advance("click", on_step=0, target=SEND, goto=1)])

    class Arrive(ManualClock):
        def sleep(self, seconds):
            super().sleep(seconds)
            if driver.step_index == 1:
                driver.goto(2)

    clock = Arrive(h.START)
    guard, ctx = h.context(driver, clock, allowed={"send_greeting"})
    result = SendGreetingHandler(clock=clock).run(h.command("send_greeting", h.CONV_O, {"text": TEXT}), guard, ctx)
    assert result.status == "succeeded"
    assert clock.sleeps == [0.5]


# ---- 已发生 ----


def test_already_sent_is_skipped_without_outbound():
    # 候选人P 的会话里已有我方消息『可以发送一下简历吗？』（带『送达』）
    result, driver, guard, _ = run([h.raw_step("conversation_detail", 0)], h.CONV_P, text="可以发送一下简历吗？")
    assert (result.status, result.reason) == ("skipped_precondition", "precondition_already_done")
    assert not result.outbound_action_performed and result.navigation_performed
    assert guard.outbound_calls == 0 and driver.count("type_text") == 0
    assert [c.method for c in driver.writes] == ["click"]  # 只有打开会话
    assert result.observed.before[-1].code == "greeting_text_present"


# ---- 歧义 ----


def test_ambiguous_target_does_not_click_anything():
    b = base()
    dup = h.derive(b, "列表里有两行候选人O（同岗位同 hints）", add=h.shifted_copy(b, range(65, 73), 390))
    result, driver, _, _ = run([dup], h.CONV_O)
    assert (result.status, result.reason) == ("failed", "target_ambiguous")
    assert driver.count() == 0
    assert not (result.navigation_performed or result.outbound_action_performed or result.externally_visible_side_effect)


# ---- 未知弹窗 ----


def test_unknown_dialog_after_send_is_unknown_and_not_clicked():
    b = base()
    blocked = h.derive(b, "发送后弹出未知提示", add=h.dialog(b, "今日沟通人数已达上限", ["知道了"]))
    result, driver, _, _ = run([b, blocked], h.CONV_O, advances=[Advance("click", on_step=0, target=SEND, goto=1)])
    assert (result.status, result.reason) == ("unknown", "unknown_dialog")
    assert result.outbound_action_performed
    assert all(c.element is None or c.element.text != "知道了" for c in driver.writes)
    assert driver.count("click") == 2  # 打开会话 + 发送
    assert any(i.source == "dialog" and "今日沟通人数已达上限" in i.text for i in result.evidence)
    assert result.observed.after[-1].code == "unknown_dialog"


def test_dialog_present_before_start_fails_without_any_click():
    b = base()
    blocked = h.derive(b, "一开始就有弹窗", add=h.dialog(b, "账号存在异常，请验证", ["去验证", "取消"]))
    result, driver, _, _ = run([blocked], h.CONV_O)
    assert (result.status, result.reason) == ("failed", "unknown_dialog")
    assert driver.count() == 0 and not result.outbound_action_performed


def test_pdf_preview_open_is_unknown_dialog_and_text_layer_never_reported():
    step = h.raw_step("attachment_entry", 4)
    secret = h.text(step, "PDF正文 someone@example.com", (400, 300, 300, 16))
    result, driver, _, _ = run([h.derive(step, "预览开着", add=[secret])], h.CONV_O)
    assert (result.status, result.reason) == ("failed", "unknown_dialog")
    assert driver.count() == 0
    dump = h.evidence_text(result)
    assert "someone@example.com" not in dump and "PDF正文" not in dump and "PDF文字层" not in dump


# ---- 超时 ----


def test_timeout_after_send_is_unknown_and_never_resends():
    result, driver, guard, clock = run([base()], h.CONV_O)
    assert (result.status, result.reason) == ("unknown", "timeout")
    assert result.outbound_action_performed and result.externally_visible_side_effect
    assert driver.count("type_text") == 1 and driver.count("click") == 2
    assert (clock.now() - h.START).total_seconds() == pytest.approx(10)
    assert result.observed.after[-1].code == "greeting_text_absent"


# ---- 白名单 ----


def test_whitelist_closed_never_touches_driver():
    clock = ManualClock(h.START)
    driver = h.fake([base()], clock=clock)
    driver.fail_next("state", DriverError("白名单关闭时不应读取界面"))
    guard, ctx = h.context(driver, clock, allowed=())
    cmd = h.command("send_greeting", h.CONV_O, {"text": TEXT})
    result = SendGreetingHandler(clock=clock).run(cmd, guard, ctx)
    assert (result.status, result.reason) == ("failed", "action_not_allowed")
    assert driver.count() == 0 and driver.rejected == []
    assert guard.navigation_calls == guard.outbound_calls == 0
    assert not (result.navigation_performed or result.outbound_action_performed or result.externally_visible_side_effect)


def test_other_action_allowed_is_not_enough():
    result, driver, _, _ = run([base()], h.CONV_O, allowed=("request_resume",))
    assert result.reason == "action_not_allowed" and driver.count() == 0


# ---- 其他失败路径 ----


def test_target_not_found_switches_tabs_but_never_sends():
    # 候选人A 的会话开着，但不在可见列表里（conversation_detail#2）；hints 为空也必须在列表里命中
    result, driver, guard, _ = run([h.raw_step("conversation_detail", 2)], h.CONV_A)
    assert (result.status, result.reason) == ("failed", "target_not_found")
    assert guard.outbound_calls == 0
    assert [c.element.label for c in driver.writes] == ["新招呼(504)", "沟通中", "全部"]
    assert result.navigation_performed and not result.outbound_action_performed


def test_header_not_switching_after_click_is_timeout_without_outbound():
    # 候选人O 的会话开着，目标是候选人P：点击 P 那一行后表头没有变化
    result, driver, guard, _ = run([base()], h.CONV_P)
    assert (result.status, result.reason) == ("failed", "timeout")
    assert guard.outbound_calls == 0 and driver.count("click") == 1


def test_missing_send_button_fails_before_typing():
    b = base()
    no_send = h.derive(b, "没有发送按钮", drop=lambda e: e["value"] == "发送")
    result, driver, _, _ = run([no_send], h.CONV_O)
    assert (result.status, result.reason) == ("failed", "target_not_found")
    assert driver.count("type_text") == 0


def test_driver_error_during_outbound_propagates_for_pipeline():
    clock = ManualClock(h.START)
    driver = h.fake([base()], clock=clock)
    driver.fail_next("type_text", DriverTimeoutError("cli timeout"))
    guard, ctx = h.context(driver, clock, allowed={"send_greeting"})
    cmd = h.command("send_greeting", h.CONV_O, {"text": TEXT})
    with pytest.raises(DriverTimeoutError):
        SendGreetingHandler(clock=clock).run(cmd, guard, ctx)
    # 守卫已把这次输入记为对外动作，管线据此回报 unknown/driver_error
    assert guard.outbound_calls == 1


def test_wrong_action_command_is_unsupported():
    clock = ManualClock(h.START)
    driver = h.fake([base()], clock=clock)
    guard, ctx = h.context(driver, clock, allowed={"send_greeting", "request_resume"})
    cmd = h.command("request_resume", h.CONV_O)
    result = SendGreetingHandler(clock=clock).run(cmd, guard, ctx)
    assert (result.status, result.reason) == ("failed", "unsupported") and driver.count() == 0


# ---- verify_only ----


def test_verify_only_succeeds_when_text_present_and_never_types():
    result, driver, guard, _ = run(
        [h.raw_step("conversation_detail", 0)], h.CONV_P, text="可以发送一下简历吗？", allowed=(), verify=True
    )
    assert result.status == "succeeded" and result.executed_at is not None
    assert not result.outbound_action_performed and result.navigation_performed
    assert guard.outbound_calls == 0 and driver.count("type_text") == 0


def test_verify_only_reports_verification_failed_when_absent():
    result, _, _, _ = run([base()], h.CONV_O, allowed=(), verify=True)
    assert (result.status, result.reason) == ("failed", "verification_failed")
    assert not result.outbound_action_performed


def test_verify_only_cannot_judge_ambiguous_target():
    b = base()
    dup = h.derive(b, "两行候选人O", add=h.shifted_copy(b, range(65, 73), 390))
    result, driver, _, _ = run([dup], h.CONV_O, allowed=(), verify=True)
    assert (result.status, result.reason) == ("unknown", "target_ambiguous") and driver.count() == 0


def test_verify_only_opening_unread_conversation_reports_read_receipt():
    step = h.raw_step("conversation_detail", 2)
    # 打开未读的候选人B 后，表头切到 B（派生：只改表头姓名）
    opened = h.derive(step, "打开候选人B")
    for e in opened["elements"]:
        if e["value"] == "候选人A":
            e["value"] = "候选人B"
    conv_b = {"candidate_name": "候选人B", "job_title": "Vue 前端 研发工程师", "hints": ["19:03"]}
    result, driver, _, _ = run(
        [step, opened], conv_b, allowed=(), verify=True, advances=[Advance("click", on_step=0, goto=1)]
    )
    assert (result.status, result.reason) == ("failed", "verification_failed")
    assert result.externally_visible_side_effect and not result.outbound_action_performed
    assert result.observed.before[0].code == "conversation_unread"
