"""request_resume 处理器测试：FakeDriver 回放会话详情夹具，用 Advance 把"点击『求简历』/『确认』后"切到派生步骤。

真机的求简历确认流程尚未观察（N 阶段实测）。确认气泡的形态取自『附件简历』的索取气泡（attachment_entry#1），
"点击后出现『简历请求已发送』"取自已请求过的会话（conversation_detail#0）。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest
from monitor_contracts import DriverError, Locator

from monitor.actions import RequestResumeHandler
from monitor.actions.common import detect_blockers
from monitor.actions.request_resume import is_resume_confirm
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

RESUME = Locator(text="求简历")
CONFIRM = Locator(text="确认", role="AXButton")
CONFIRM_TEXT = "确定向牛人索取简历吗？"


def run(steps, conversation=None, *, advances=(), allowed=("request_resume",), verify=False, clock=None, driver=None):
    clock = clock or ManualClock(h.START)
    driver = driver or h.fake(steps, advances=advances, clock=clock)
    guard, ctx = h.context(driver, clock, allowed=allowed, verify=verify)
    cmd = h.command("request_resume", conversation or h.CONV_O, mode="verify_only" if verify else "execute")
    handler = RequestResumeHandler(clock=clock)
    result = (handler.verify_only if verify else handler.run)(cmd, guard, ctx)
    result.to_command_result(cmd, reported_at=clock.now())
    return result, driver, guard, clock


def base():
    """候选人O 的会话已打开，聊天区没有『简历请求已发送』。"""
    return h.raw_step("conversation_detail", 1)


def requested(step):
    return h.derive(step, "请求后：聊天区出现『简历请求已发送』", add=[h.notice(step)])


def confirm_bubble(step, body=CONFIRM_TEXT, buttons=("取消", "确认")):
    return h.derive(step, f"确认气泡：{body}", add=h.dialog(step, body, buttons))


def clicked_texts(driver):
    return [c.element.text for c in driver.writes if c.element is not None]


def test_base_fixture_has_resume_button_and_no_notice():
    from monitor.actions.common import make_view, system_notices, toolbar_button

    view = make_view(h.fake([base()]).state())
    assert len(toolbar_button(view, "求简历")) == 1
    assert system_notices(view, "简历请求已发送") == []


# ---- 成功 ----


def test_success_without_confirmation():
    b = base()
    result, driver, guard, _ = run([b, requested(b)], advances=[Advance("click", on_step=0, target=RESUME, goto=1)])
    assert (result.status, result.reason) == ("succeeded", None)
    assert result.executed_at == h.START
    assert result.outbound_action_performed and result.externally_visible_side_effect and result.navigation_performed
    assert guard.navigation_calls == 1 and guard.outbound_calls == 1
    assert clicked_texts(driver)[-1] == "求简历"
    assert [f.code for f in result.observed.before][-1] == "resume_request_notice_absent"
    assert [f.code for f in result.observed.after] == ["resume_request_notice_present"]
    assert any(i.source == "chat" and i.text == "简历请求已发送" for i in result.evidence)


@pytest.mark.parametrize("body", [CONFIRM_TEXT, "确定向牛人请求附件简历吗？", "确定向牛人请求简历吗？"])
def test_success_with_matching_confirmation_bubble(body):
    b = base()
    steps = [b, confirm_bubble(b, body), requested(b)]
    advances = [
        Advance("click", on_step=0, target=RESUME, goto=1),
        Advance("click", on_step=1, target=CONFIRM, goto=2),
    ]
    result, driver, guard, _ = run(steps, advances=advances)
    assert result.status == "succeeded"
    assert clicked_texts(driver) == ["", "求简历", "确认"]  # 第一个是会话行（AXGroup 无文字）
    assert guard.outbound_calls == 2
    codes = [f.code for f in result.observed.after]
    assert codes == ["resume_confirm_dialog", "resume_confirm_clicked", "resume_request_notice_present"]
    assert any(i.source == "dialog" and body in i.text for i in result.evidence)


def test_confirmation_bubble_lingering_is_not_clicked_twice():
    b = base()
    steps = [b, confirm_bubble(b), confirm_bubble(b), requested(b)]
    driver = h.fake(
        steps,
        advances=[
            Advance("click", on_step=0, target=RESUME, goto=1),
            Advance("click", on_step=1, target=CONFIRM, goto=2),  # 点确认后气泡还在（消失动画）
        ],
    )

    class Fade(ManualClock):
        def sleep(self, seconds):
            super().sleep(seconds)
            if driver.step_index == 2 and len(self.sleeps) >= 2:
                driver.goto(3)

    result, driver, guard, clock = run(steps, driver=driver, clock=Fade(h.START))
    assert result.status == "succeeded"
    assert clicked_texts(driver).count("确认") == 1


def test_real_attachment_bubble_counts_as_resume_confirmation():
    (blocker,) = detect_blockers(h.view_of(h.raw_step("attachment_entry", 1)))
    assert is_resume_confirm(blocker)


# ---- 已发生 ----


def test_already_requested_is_skipped_by_notice_even_though_button_enabled():
    result, driver, guard, _ = run([h.raw_step("conversation_detail", 0)], h.CONV_P)
    assert (result.status, result.reason) == ("skipped_precondition", "precondition_already_done")
    assert guard.outbound_calls == 0 and "求简历" not in clicked_texts(driver)
    assert driver.count("click") == 1  # 只有打开会话
    assert result.navigation_performed and not result.outbound_action_performed
    assert result.observed.before[-1].code == "resume_request_notice_present"


# ---- 歧义 ----


def test_ambiguous_target_does_not_click_anything():
    b = base()
    dup = h.derive(b, "两行候选人O", add=h.shifted_copy(b, range(65, 73), 390))
    result, driver, _, _ = run([dup])
    assert (result.status, result.reason) == ("failed", "target_ambiguous")
    assert driver.count() == 0
    assert not (result.navigation_performed or result.outbound_action_performed or result.externally_visible_side_effect)


# ---- 未知弹窗 ----


def test_unknown_dialog_after_click_is_unknown_and_not_clicked():
    b = base()
    steps = [b, h.derive(b, "配额提示", add=h.dialog(b, "今日求简历次数已用完", ["知道了"]))]
    result, driver, _, _ = run(steps, advances=[Advance("click", on_step=0, target=RESUME, goto=1)])
    assert (result.status, result.reason) == ("unknown", "unknown_dialog")
    assert "知道了" not in clicked_texts(driver)
    assert any("今日求简历次数已用完" in i.text for i in result.evidence)


@pytest.mark.parametrize(
    ("body", "buttons"),
    [
        ("确定花费1个直豆向牛人索取简历吗？", ("取消", "确认")),  # 文案不匹配
        (CONFIRM_TEXT, ("取消", "确认", "不再提示")),  # 多出未知按钮
        (CONFIRM_TEXT, ("确定",)),  # 按钮不是『确认』
    ],
)
def test_confirmation_like_dialog_outside_whitelist_is_not_clicked(body, buttons):
    b = base()
    steps = [b, confirm_bubble(b, body, buttons)]
    result, driver, guard, _ = run(steps, advances=[Advance("click", on_step=0, target=RESUME, goto=1)])
    assert (result.status, result.reason) == ("unknown", "unknown_dialog")
    assert clicked_texts(driver)[-1] == "求简历" and guard.outbound_calls == 1


def test_second_confirmation_after_confirming_is_unknown_dialog():
    b = base()
    other = h.derive(b, "又一个气泡", add=h.dialog(b, "确定继续吗？", ["取消", "确认"]))
    steps = [b, confirm_bubble(b), other]
    advances = [
        Advance("click", on_step=0, target=RESUME, goto=1),
        Advance("click", on_step=1, target=CONFIRM, goto=2),
    ]
    result, driver, _, _ = run(steps, advances=advances)
    assert (result.status, result.reason) == ("unknown", "unknown_dialog")
    assert clicked_texts(driver).count("确认") == 1


def test_dialog_present_before_start_fails_without_any_click():
    b = base()
    result, driver, _, _ = run([confirm_bubble(b)])  # 连求简历确认气泡也不能在开始前点
    assert (result.status, result.reason) == ("failed", "unknown_dialog")
    assert driver.count() == 0


# ---- 超时 ----


def test_timeout_without_notice_is_unknown_and_not_retried():
    result, driver, guard, clock = run([base()])
    assert (result.status, result.reason) == ("unknown", "timeout")
    assert clicked_texts(driver).count("求简历") == 1 and guard.outbound_calls == 1
    assert (clock.now() - h.START).total_seconds() == pytest.approx(10)
    assert result.observed.after[-1].code == "resume_request_notice_absent"


def test_timeout_after_confirming_is_unknown():
    b = base()
    steps = [b, confirm_bubble(b), h.derive(b, "气泡消失但无提示")]
    advances = [
        Advance("click", on_step=0, target=RESUME, goto=1),
        Advance("click", on_step=1, target=CONFIRM, goto=2),
    ]
    result, driver, _, clock = run(steps, advances=advances)
    assert (result.status, result.reason) == ("unknown", "timeout")
    assert clicked_texts(driver).count("确认") == 1
    assert "resume_confirm_clicked" in [f.code for f in result.observed.after]


# ---- 白名单 ----


def test_whitelist_closed_never_touches_driver():
    clock = ManualClock(h.START)
    driver = h.fake([base()], clock=clock)
    driver.fail_next("state", DriverError("白名单关闭时不应读取界面"))
    result, driver, guard, _ = run([], allowed=("send_greeting",), clock=clock, driver=driver)
    assert (result.status, result.reason) == ("failed", "action_not_allowed")
    assert driver.count() == 0 and driver.rejected == []
    assert guard.navigation_calls == guard.outbound_calls == 0


# ---- 其他失败路径 ----


def test_missing_resume_button_fails_before_any_outbound():
    b = base()
    no_button = h.derive(b, "按钮条没有求简历", drop=lambda e: e["value"] == "求简历")
    result, driver, guard, _ = run([no_button])
    assert (result.status, result.reason) == ("failed", "target_not_found")
    assert guard.outbound_calls == 0


# ---- verify_only ----


def test_verify_only_succeeds_when_notice_present():
    result, driver, guard, _ = run([h.raw_step("conversation_detail", 0)], h.CONV_P, allowed=(), verify=True)
    assert result.status == "succeeded"
    assert not result.outbound_action_performed and guard.outbound_calls == 0
    assert "求简历" not in clicked_texts(driver)


def test_verify_only_fails_when_notice_absent():
    result, _, _, _ = run([base()], allowed=(), verify=True)
    assert (result.status, result.reason) == ("failed", "verification_failed")


def test_verify_only_with_dialog_cannot_judge():
    result, driver, _, _ = run([confirm_bubble(base())], allowed=(), verify=True)
    assert (result.status, result.reason) == ("unknown", "unknown_dialog")
    assert driver.count() == 0
