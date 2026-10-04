"""端到端（方案 8.1）：观察到『新招呼』→ application_observed → 服务端建流程、下发问候与求简历
→ 执行器执行并回报 → 结果落库（服务端 commands / cases，本机账本 delivered）。

界面由 FakeDriver 回放 B 的夹具：new_application_marker#0（基线）→ #1（候选人L 19:11 新到），
会话详情用 conversation_detail#2 换上候选人L；"发送之后""求简历之后"的界面是 H1 的派生假设。
"""

from __future__ import annotations

from integration_kit import (
    ACCOUNT,
    CANDIDATE,
    JOB,
    Screen,
    World,
    at_local,
    boss_new_greeting,
    find,
    greeting_text,
)
from monitor_contracts import CommandState, DeliveryState


def _stage(w: World) -> str | None:
    cases = w.server.cases()
    return cases[0]["stage"] if cases else None


def _start(w: World, **kw):
    fake = boss_new_greeting(w.clock, **kw)
    screen = Screen(fake)
    m = w.bound_monitor(screen)
    # 首次观察只建基线（19:05），不产生事件
    m.run_until(lambda: m.runtime.state.baseline.established and not m.runtime.state.needs_baseline, what="建基线")
    assert m.ledger.pending_events() == [] and w.server.events(kind="application_observed") == []
    # 19:11 候选人L 发来招呼；19:12 下一次观察看到它
    w.clock.advance((at_local(19, 12) - w.clock.now()).total_seconds())
    fake.goto("list_new")
    return m, fake, screen


def test_new_greeting_to_resume_request_end_to_end(w: World):
    m, fake, screen = _start(w)
    m.run_until(lambda: _stage(w) == "resume_requested", what="流程到 resume_requested")
    m.run_until(lambda: m.results_pending() == 0 and m.events_pending() == 0, what="全部回传")

    # 事件：恰好一条 application_observed，会话身份是 姓名 + 岗位（hints 为空）
    [ev] = w.server.events(kind="application_observed")
    assert ev["event"]["conversation"] == {"candidate_name": CANDIDATE, "job_title": JOB, "hints": []}
    assert ev["event"]["account_id"] == ACCOUNT

    # 服务端：一条流程、两条指令都 succeeded；求简历依赖问候
    [case] = w.server.cases()
    assert (case["candidate_name"], case["job_title"], case["stage"]) == (CANDIDATE, JOB, "resume_requested")
    cmds = w.server.commands(case_id=case["case_id"])
    by_action = {c["command"]["action"]: c for c in cmds}
    assert sorted(by_action) == ["request_resume", "send_greeting"]
    greet, resume = by_action["send_greeting"], by_action["request_resume"]
    assert greet["server_status"] == "succeeded" and resume["server_status"] == "succeeded"
    assert greet["command"]["payload"]["text"] == greeting_text()
    assert resume["command"]["depends_on"] == greet["command"]["command_id"]
    assert resume["result"]["executed_at"] is not None  # 邮件关联的时间窗起点
    assert resume["result"]["outbound_action_performed"] is True

    # 本机账本：两条都 succeeded 且已回传
    for c in (greet, resume):
        rec = m.ledger_command(c["command"]["command_id"])
        assert rec.state == CommandState.SUCCEEDED and rec.delivery == DeliveryState.DELIVERED

    # 对外动作恰好各一次：输入问候、点发送、点求简历
    assert screen.outbound() == ["greeting_type", "greeting_send", "resume_request"]
    assert screen.count("open_row") >= 1  # 打开会话（导航）
    assert fake.step.label == "detail_requested"


def test_resume_request_with_confirm_bubble_clicks_confirm_once(w: World):
    m, fake, screen = _start(w, resume_confirm=True)
    m.run_until(lambda: _stage(w) == "resume_requested", what="流程到 resume_requested")
    assert screen.outbound() == ["greeting_type", "greeting_send", "resume_request", "resume_confirm"]


def test_greeting_disabled_goes_straight_to_resume_request(w: World):
    fake = boss_new_greeting(w.clock, greet=False)
    screen = Screen(fake)
    m = w.bound_monitor(screen)
    w.enable_automation(greeting={"enabled": False, "template": "{candidate_name} 你好"})
    m.run_until(lambda: m.runtime.state.baseline.established, what="建基线")
    w.clock.advance((at_local(19, 12) - w.clock.now()).total_seconds())
    fake.goto("list_new")
    m.run_until(lambda: _stage(w) == "resume_requested", what="流程到 resume_requested")
    [case] = w.server.cases()
    assert [c["command"]["action"] for c in w.server.commands(case_id=case["case_id"])] == ["request_resume"]
    assert screen.outbound() == ["resume_request"]


def test_backlog_rows_at_baseline_never_produce_events(w: World):
    """基线时已经在『新招呼』里的会话（候选人B…）是积压，不产生事件、不生成指令。"""
    fake = boss_new_greeting(w.clock)
    screen = Screen(fake)
    m = w.bound_monitor(screen)
    m.run_until(lambda: m.runtime.state.baseline.established, what="建基线")
    for _ in range(5):  # 再观察几轮（每轮 45 秒）
        w.clock.advance(45)
        m.run(3)
    assert w.server.events(kind="application_observed") == []
    assert w.server.cases() == [] and w.server.commands() == []
    assert screen.outbound() == []
    assert set(screen.kinds()) <= {"tab_new_greeting"}  # 观察只点『新招呼』页签
    assert find(w.server.events(), kind="device_paused") == []
