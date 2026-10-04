"""request_contact_exchange 处理器测试：FakeDriver 回放夹具，用 Advance 把"点击『换微信』/ 确认后"切到派生步骤。

真实夹具（任务 B）：contact_exchange_state#0 未请求（候选人P）、#1 微信待同意（候选人M）、#2 不可用（候选人A，
未回复）。点击后的界面（确认气泡、出现『请求交换微信已发送』、『换微信』变灰）都是测试里派生的假设，
真机形态以 N 阶段为准（见 docs/monitor/agent-reports/H3.md）。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest
from monitor_contracts import ActionHandler, DriverError, Frame, Locator

from monitor.actions import create_handlers
from monitor.actions.common import detect_blockers
from monitor.actions.contact_exchange import (
    WECHAT_REQUESTED_NOTICE,
    RequestContactExchangeHandler,
    is_wechat_confirm,
    read_exchange_state,
)
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

CONV_M = {"candidate_name": "候选人M", "job_title": "视觉算法工程师", "hints": ["16:23"]}
PAYLOAD = {"exchange_type": "wechat"}
ACTION = "request_contact_exchange"

# 按钮条里『换电话』『换微信』外层可按 AXGroup 的位置（夹具全局坐标，contact_exchange_state#0）
PHONE_GROUP = Frame(x=4151, y=780, w=57, h=24)
WECHAT_GROUP = Frame(x=4218, y=780, w=57, h=24)
WECHAT = Locator(role="AXGroup", region=WECHAT_GROUP)
CONFIRM_TEXT = "确定与对方交换微信吗？"


def _confirm(label="确定"):
    return Locator(text=label, role="AXButton")


def run(steps, conversation=None, *, advances=(), allowed=(ACTION,), verify=False, clock=None, driver=None):
    clock = clock or ManualClock(h.START)
    driver = driver or h.fake(steps, advances=advances, clock=clock)
    guard, ctx = h.context(driver, clock, allowed=allowed, verify=verify)
    cmd = h.command(ACTION, conversation or h.CONV_P, PAYLOAD, mode="verify_only" if verify else "execute")
    handler = RequestContactExchangeHandler(clock=clock)
    result = (handler.verify_only if verify else handler.run)(cmd, guard, ctx)
    result.to_command_result(cmd, reported_at=clock.now())  # 契约跨字段规则（含 output 必填）
    return result, driver, guard, clock


def _is_group(e, frame):
    f = e["frame"]
    return e["role"] == "AXGroup" and (f["x"], f["y"], f["w"], f["h"]) == (frame.x, frame.y, frame.w, frame.h)


def base():
    """候选人P 的会话已打开，『换微信』可用，聊天区没有交换提示（contact_exchange_state#0）。"""
    return h.raw_step("contact_exchange_state", 0)


def wechat_notice(step, y=700):
    """居中系统提示『请求交换微信已发送』（宽度与 contact_exchange_state#1 一致）。"""
    return h.text(step, WECHAT_REQUESTED_NOTICE, (893, y, 108, 14))


def requested(step):
    """请求后：出现提示，『换微信』外层 AXGroup 消失（置灰），与 contact_exchange_state#1 同形。"""
    return h.derive(step, "请求后", add=[wechat_notice(step)], drop=lambda e: _is_group(e, WECHAT_GROUP))


def both_disabled(step):
    return h.derive(
        step, "两个交换按钮都置灰", drop=lambda e: _is_group(e, WECHAT_GROUP) or _is_group(e, PHONE_GROUP)
    )


def confirm_bubble(step, body=CONFIRM_TEXT, buttons=("取消", "确定")):
    return h.derive(step, f"确认气泡：{body}", add=h.dialog(step, body, buttons))


def clicked(driver):
    return [c.element for c in driver.writes if c.element is not None]


def clicked_texts(driver):
    return [e.text for e in clicked(driver)]


def wechat_clicks(driver):
    return [e for e in clicked(driver) if e.role == "AXGroup" and e.frame == WECHAT_GROUP]


def assert_phone_untouched(driver):
    assert not any(e.frame == PHONE_GROUP or e.text == "换电话" for e in clicked(driver))


def state_of(result):
    return result.output.exchange_state if result.output is not None else None


# ---- 状态识别（真实夹具） ----


def test_reads_states_from_real_fixtures():
    r0 = read_exchange_state(h.view_of(base()))
    assert (r0.kind, r0.wechat.state, r0.phone.state) == ("not_requested", "enabled", "enabled")
    assert r0.wechat.press is not None and r0.wechat.press.frame == WECHAT_GROUP

    r1 = read_exchange_state(h.view_of(h.raw_step("contact_exchange_state", 1)))
    assert (r1.kind, r1.wechat.state, r1.phone.state) == ("pending_acceptance", "disabled", "enabled")
    assert r1.notice is not None

    r2 = read_exchange_state(h.view_of(h.raw_step("contact_exchange_state", 2)))
    assert (r2.kind, r2.wechat.state, r2.phone.state) == ("unavailable", "disabled", "disabled")

    # 会话详情夹具：#2 与 contact_exchange_state#2 是同一个未回复会话（按钮置灰），其余未请求
    kinds = [read_exchange_state(h.view_of(h.raw_step("conversation_detail", i))).kind for i in range(4)]
    assert kinds == ["not_requested", "not_requested", "unavailable", "not_requested"]


def test_derived_requested_step_matches_real_pending_shape():
    assert read_exchange_state(h.view_of(requested(base()))).kind == "pending_acceptance"


# ---- 成功 ----


def test_success_without_confirmation():
    b = base()
    result, driver, guard, _ = run([b, requested(b)], advances=[Advance("click", on_step=0, target=WECHAT, goto=1)])
    assert (result.status, result.reason) == ("succeeded", None)
    assert result.output.exchange_type == "wechat" and state_of(result) == "requested"
    assert result.executed_at == h.START
    assert result.navigation_performed and result.outbound_action_performed and result.externally_visible_side_effect
    assert guard.navigation_calls == 1 and guard.outbound_calls == 1
    assert len(wechat_clicks(driver)) == 1
    assert_phone_untouched(driver)
    before = [f.code for f in result.observed.before]
    assert before[-3:] == ["wechat_exchange_notice_absent", "wechat_button_enabled", "phone_button_enabled"]
    after = [f.code for f in result.observed.after]
    assert after == ["wechat_exchange_notice_present", "wechat_button_disabled", "phone_button_enabled"]
    assert any(i.source == "chat" and i.text == WECHAT_REQUESTED_NOTICE for i in result.evidence)


@pytest.mark.parametrize(
    ("body", "label"),
    [(CONFIRM_TEXT, "确定"), (CONFIRM_TEXT, "确认"), ("确定向牛人请求交换微信吗？", "确定"), ("确认与对方换微信？", "确认")],
)
def test_success_with_wechat_confirmation_bubble(body, label):
    b = base()
    steps = [b, confirm_bubble(b, body, ("取消", label)), requested(b)]
    advances = [
        Advance("click", on_step=0, target=WECHAT, goto=1),
        Advance("click", on_step=1, target=_confirm(label), goto=2),
    ]
    result, driver, guard, _ = run(steps, advances=advances)
    assert result.status == "succeeded" and state_of(result) == "requested"
    assert clicked_texts(driver)[-1] == label and len(wechat_clicks(driver)) == 1
    assert guard.outbound_calls == 2
    codes = [f.code for f in result.observed.after]
    assert codes[:2] == ["wechat_confirm_dialog", "wechat_confirm_clicked"]
    assert any(i.source == "dialog" and body in i.text for i in result.evidence)


def test_confirmation_bubble_lingering_is_not_clicked_twice():
    b = base()
    steps = [b, confirm_bubble(b), confirm_bubble(b), requested(b)]
    driver = h.fake(
        steps,
        advances=[
            Advance("click", on_step=0, target=WECHAT, goto=1),
            Advance("click", on_step=1, target=_confirm(), goto=2),  # 点确认后气泡还在（消失动画）
        ],
    )

    class Fade(ManualClock):
        def sleep(self, seconds):
            super().sleep(seconds)
            if driver.step_index == 2 and len(self.sleeps) >= 2:
                driver.goto(3)

    result, driver, _, _ = run(steps, driver=driver, clock=Fade(h.START))
    assert result.status == "succeeded"
    assert clicked_texts(driver).count("确定") == 1


def test_success_on_another_conversation():
    # 同一流程放在别的会话上（conversation_detail#1，候选人O）也成立：规则不依赖具体候选人
    b = h.raw_step("conversation_detail", 1)
    result, driver, _, _ = run([b, requested(b)], h.CONV_O, advances=[Advance("click", on_step=0, target=WECHAT, goto=1)])
    assert result.status == "succeeded" and len(wechat_clicks(driver)) == 1


# ---- 已请求 ----


def test_already_requested_is_skipped_with_pending_acceptance():
    result, driver, guard, _ = run([h.raw_step("contact_exchange_state", 1)], CONV_M)
    assert (result.status, result.reason) == ("skipped_precondition", "precondition_already_done")
    assert state_of(result) == "pending_acceptance"
    assert guard.outbound_calls == 0 and driver.count("click") == 1  # 只有打开会话
    assert result.navigation_performed and not result.outbound_action_performed
    assert wechat_clicks(driver) == []
    assert any(i.source == "chat" and i.text == WECHAT_REQUESTED_NOTICE for i in result.evidence)


# ---- 按钮置灰（招聘方未回复） ----


def test_disabled_buttons_fail_without_outbound():
    result, driver, guard, _ = run([both_disabled(base())])
    assert (result.status, result.reason) == ("failed", "target_not_found")
    assert result.output is None
    assert guard.outbound_calls == 0 and not result.outbound_action_performed
    assert driver.count("click") == 1
    assert any("未回复" in i.text for i in result.evidence)
    assert "『换微信』置灰" in result.reason_detail


# ---- 状态无法识别（不猜） ----


@pytest.mark.parametrize(
    "make",
    [
        # 提示在、按钮却可用：未观察到的组合（可能已交换、已拒绝或请求过期）
        lambda b: h.derive(b, "提示在按钮可用", add=[wechat_notice(b)]),
        # 只有『换微信』置灰、没有提示：提示可能滚出可见区，也可能已交换
        lambda b: h.derive(b, "只有换微信置灰", drop=lambda e: _is_group(e, WECHAT_GROUP)),
        # 按钮条里找不到『换微信』
        lambda b: h.derive(b, "没有换微信", drop=lambda e: e["value"] == "换微信"),
    ],
)
def test_unrecognized_state_is_unknown_without_click(make):
    result, driver, guard, _ = run([make(base())])
    assert (result.status, result.reason) == ("unknown", "unreadable")
    assert state_of(result) == "unknown"
    assert guard.outbound_calls == 0 and wechat_clicks(driver) == []
    assert "wechat_exchange_state_unrecognized" in [f.code for f in result.observed.before]


# ---- 歧义 ----


def test_ambiguous_target_does_not_click_anything():
    b = base()
    dup = h.derive(b, "两行候选人P", add=h.shifted_copy(b, range(73, 81), 390))
    result, driver, _, _ = run([dup])
    assert (result.status, result.reason) == ("failed", "target_ambiguous")
    assert driver.count() == 0 and result.output is None
    assert not (result.navigation_performed or result.outbound_action_performed or result.externally_visible_side_effect)


# ---- 未知弹窗 ----


def test_unknown_dialog_after_click_is_unknown_and_not_clicked():
    b = base()
    steps = [b, h.derive(b, "未绑定微信", add=h.dialog(b, "您还没有设置微信号，请先设置", ["取消", "去设置"]))]
    result, driver, guard, _ = run(steps, advances=[Advance("click", on_step=0, target=WECHAT, goto=1)])
    assert (result.status, result.reason) == ("unknown", "unknown_dialog")
    assert state_of(result) == "unknown"
    assert "去设置" not in clicked_texts(driver) and "取消" not in clicked_texts(driver)
    assert guard.outbound_calls == 1
    assert any("请先设置" in i.text for i in result.evidence)


@pytest.mark.parametrize(
    ("body", "buttons"),
    [
        ("确定与对方交换电话吗？", ("取消", "确定")),  # 文案是电话
        ("确定与对方交换微信和电话吗？", ("取消", "确定")),  # 文案同时提到电话
        ("确定继续吗？", ("取消", "确定")),  # 文案没说交换微信
        (CONFIRM_TEXT, ("取消", "确定", "不再提示")),  # 多出未知按钮
        (CONFIRM_TEXT, ("确认", "确定")),  # 两个确认类按钮
        (CONFIRM_TEXT, ("取消", "好的")),  # 按钮不是确认
    ],
)
def test_confirmation_like_dialog_outside_whitelist_is_not_clicked(body, buttons):
    b = base()
    steps = [b, confirm_bubble(b, body, buttons)]
    result, driver, guard, _ = run(steps, advances=[Advance("click", on_step=0, target=WECHAT, goto=1)])
    assert (result.status, result.reason) == ("unknown", "unknown_dialog")
    assert guard.outbound_calls == 1 and len(clicked(driver)) == 2  # 打开会话 + 换微信


def test_second_dialog_after_confirming_is_unknown_dialog():
    b = base()
    other = h.derive(b, "又一个气泡", add=h.dialog(b, "今日交换次数已达上限", ["知道了"]))
    steps = [b, confirm_bubble(b), other]
    advances = [
        Advance("click", on_step=0, target=WECHAT, goto=1),
        Advance("click", on_step=1, target=_confirm(), goto=2),
    ]
    result, driver, _, _ = run(steps, advances=advances)
    assert (result.status, result.reason) == ("unknown", "unknown_dialog")
    assert clicked_texts(driver).count("确定") == 1 and "知道了" not in clicked_texts(driver)


def test_dialog_present_before_start_fails_without_any_click():
    result, driver, _, _ = run([confirm_bubble(base())])  # 连换微信确认气泡也不能在开始前点
    assert (result.status, result.reason) == ("failed", "unknown_dialog")
    assert driver.count() == 0 and result.output is None


def test_wechat_confirm_whitelist_unit():
    (blocker,) = detect_blockers(h.view_of(confirm_bubble(base())))
    assert is_wechat_confirm(blocker)
    # 求简历的索取气泡（attachment_entry#1）不是换微信确认
    (resume,) = detect_blockers(h.view_of(h.raw_step("attachment_entry", 1)))
    assert not is_wechat_confirm(resume)


# ---- 超时 ----


def test_timeout_without_notice_is_unknown_and_not_retried():
    result, driver, guard, clock = run([base()])
    assert (result.status, result.reason) == ("unknown", "timeout")
    assert state_of(result) == "unknown"
    assert len(wechat_clicks(driver)) == 1 and guard.outbound_calls == 1
    assert (clock.now() - h.START).total_seconds() == pytest.approx(10)
    assert result.observed.after[0].code == "wechat_exchange_notice_absent"


def test_timeout_after_confirming_is_unknown():
    b = base()
    steps = [b, confirm_bubble(b), h.derive(b, "气泡消失但无提示")]
    advances = [
        Advance("click", on_step=0, target=WECHAT, goto=1),
        Advance("click", on_step=1, target=_confirm(), goto=2),
    ]
    result, driver, _, _ = run(steps, advances=advances)
    assert (result.status, result.reason) == ("unknown", "timeout")
    assert clicked_texts(driver).count("确定") == 1
    assert "wechat_confirm_clicked" in [f.code for f in result.observed.after]


# ---- 白名单 ----


def test_whitelist_closed_never_touches_driver():
    clock = ManualClock(h.START)
    driver = h.fake([base()], clock=clock)
    driver.fail_next("state", DriverError("白名单关闭时不应读取界面"))
    result, driver, guard, _ = run([], allowed=("request_resume",), clock=clock, driver=driver)
    assert (result.status, result.reason) == ("failed", "action_not_allowed")
    assert driver.count() == 0 and driver.rejected == []
    assert guard.navigation_calls == guard.outbound_calls == 0
    assert result.output is None
    assert not (result.navigation_performed or result.outbound_action_performed or result.externally_visible_side_effect)


# ---- verify_only ----


def test_verify_only_succeeds_when_pending():
    result, driver, guard, _ = run([h.raw_step("contact_exchange_state", 1)], CONV_M, allowed=(), verify=True)
    assert result.status == "succeeded" and state_of(result) == "requested"
    assert not result.outbound_action_performed and guard.outbound_calls == 0
    assert wechat_clicks(driver) == [] and driver.count("click") == 1


@pytest.mark.parametrize("make", [base, lambda: both_disabled(base())])
def test_verify_only_fails_when_not_requested(make):
    result, driver, _, _ = run([make()], allowed=(), verify=True)
    assert (result.status, result.reason) == ("failed", "verification_failed")
    assert wechat_clicks(driver) == []


def test_verify_only_unrecognized_or_dialog_cannot_judge():
    b = base()
    result, _, _, _ = run([h.derive(b, "提示在按钮可用", add=[wechat_notice(b)])], allowed=(), verify=True)
    assert (result.status, result.reason, state_of(result)) == ("unknown", "unreadable", "unknown")
    result, driver, _, _ = run([confirm_bubble(b)], allowed=(), verify=True)
    assert (result.status, result.reason) == ("unknown", "unknown_dialog")
    assert driver.count() == 0


# ---- 注册与接入 D2 ----


def test_registered_through_create_handlers():
    handlers = {hd.action: hd for hd in create_handlers(clock=ManualClock(h.START))}
    assert isinstance(handlers[ACTION], RequestContactExchangeHandler)
    assert isinstance(handlers[ACTION], ActionHandler)


def test_runtime_end_to_end_with_confirmation():
    b = base()
    steps = [b, confirm_bubble(b), requested(b)]
    advances = [
        Advance("click", on_step=0, target=WECHAT, goto=1),
        Advance("click", on_step=1, target=_confirm(), goto=2),
    ]
    env, driver = h._runtime_env(steps, advances, allowed=[ACTION])
    cmd = h._runtime_command(env, ACTION, h.CONV_P, PAYLOAD)
    env.server.enqueue(cmd)
    result = h._result_of(env, cmd)
    assert result["status"] == "succeeded" and result["reason"] is None
    assert result["output"] == {"exchange_type": "wechat", "exchange_state": "requested"}
    assert result["outbound_action_performed"] and result["externally_visible_side_effect"]
    assert len(wechat_clicks(driver)) == 1 and clicked_texts(driver)[-1] == "确定"


def test_runtime_whitelist_closed():
    env, driver = h._runtime_env([base()], (), allowed=["request_resume"])
    cmd = h._runtime_command(env, ACTION, h.CONV_P, PAYLOAD)
    env.server.enqueue(cmd)
    result = h._result_of(env, cmd)
    assert (result["status"], result["reason"]) == ("failed", "action_not_allowed")
    assert driver.count() == 0
