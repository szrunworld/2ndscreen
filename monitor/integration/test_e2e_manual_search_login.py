"""人工换微信（含工作时段外顺延）、搜索快照（三种结局）、登录失效暂停与恢复。"""

from __future__ import annotations

from datetime import datetime

import pytest

from integration_kit import (
    LoginStandIn,
    Screen,
    World,
    at_local,
    boss_new_greeting,
    boss_search,
    boss_wechat,
    case_stage,
    create_observer,
    login_page_step,
    reach_new_greeting,
    reach_resume_requested,
    server_cmd,
)

# ---------------------------------------------------------------------------
# 人工换微信（方案 8.3，api.md 第四节）
# ---------------------------------------------------------------------------


def _request_wechat(w: World) -> dict:
    [case] = w.server.cases()
    return w.server.ok("POST", f"/cases/{case['case_id']}:request-wechat", {"note": "约面试前加微信"}, status=201)


def test_manual_wechat_request_in_work_hours(w: World):
    m, _, screen = reach_resume_requested(w)
    screen.show(boss_wechat(w.clock))
    created = _request_wechat(w)
    assert created["scheduled_for"] is None
    assert created["command"]["command"]["payload"] == {"exchange_type": "wechat"}
    assert case_stage(w) == "contact_requested"

    m.run_until(lambda: server_cmd(w, "request_contact_exchange")["server_status"] == "succeeded", what="换微信执行")
    rec = server_cmd(w, "request_contact_exchange")
    assert rec["result"]["output"] == {"exchange_type": "wechat", "exchange_state": "requested"}
    assert screen.outbound() == ["greeting_type", "greeting_send", "resume_request", "wechat_request"]
    assert screen.fake.step.label == "detail_wechat_sent"
    # 自动流程从不生成换微信：只有这一条
    assert [c["command"]["action"] for c in w.server.commands()].count("request_contact_exchange") == 1


def test_manual_wechat_outside_work_hours_is_deferred_to_next_window(w: World):
    m, _, screen = reach_resume_requested(w)
    screen.show(boss_wechat(w.clock))
    # 23:40（上海）不在 08:00–23:30 的工作时段内
    w.clock.advance((at_local(23, 40) - w.clock.now()).total_seconds())
    m.run(2)
    created = _request_wechat(w)
    opens = at_local(8, 0, day=5)
    assert datetime.fromisoformat(created["scheduled_for"].replace("Z", "+00:00")) == opens
    assert created["command"]["command"]["issued_at"] == created["scheduled_for"]

    # 夜里 Monitor 一直在线：领取接口不下发 issued_at 未到的指令
    claims_before = w.cluster.count(":claim")
    m.run_until(lambda: w.clock.now() >= at_local(7, 59, day=5), max_rounds=2000, what="等到次日 07:59")
    assert w.cluster.count(":claim") > claims_before  # 一直在领取，只是领不到
    assert server_cmd(w, "request_contact_exchange")["server_status"] == "pending"
    assert screen.count("wechat_request") == 0

    m.run_until(
        lambda: server_cmd(w, "request_contact_exchange")["server_status"] == "succeeded", max_rounds=200,
        what="工作时段开始后执行",
    )
    executed = server_cmd(w, "request_contact_exchange")["result"]["executed_at"]
    assert datetime.fromisoformat(executed.replace("Z", "+00:00")) >= opens
    assert screen.count("wechat_request") == 1


# ---------------------------------------------------------------------------
# 搜索（方案 8.4）：三种结局分开
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("outcome", "status", "coverage"),
    [
        ("results", "succeeded", "partial"),
        ("no_results", "succeeded", "empty_confirmed"),
        ("unreadable", "failed", "unreadable"),
    ],
)
def test_search_snapshot_three_outcomes(w: World, outcome: str, status: str, coverage: str):
    query = "前端开发"
    screen = Screen(boss_search(w.clock, query, outcome))
    m = w.bound_monitor(screen, observe=False)
    m.run_until(lambda: m.runtime.policy is not None, what="上线")
    run = w.server.ok("POST", "/search-runs", {"account_id": "acct_boss_1", "query": query, "max_results": 20}, status=201)
    sid = run["search_id"]
    m.run_until(lambda: w.server.ok("GET", f"/search-runs/{sid}")["outcome"] is not None, what="快照回传")

    got = w.server.ok("GET", f"/search-runs/{sid}")
    assert got["outcome"] == outcome
    assert got["snapshot"]["coverage"] == coverage
    cmd = w.server.command(run["command_id"])
    assert cmd["server_status"] == status
    result = cmd["result"]
    if outcome == "results":
        [item] = got["snapshot"]["items"]
        assert item["result_ref"] == f"{sid}:item_1" and item["masked_name"] == "候选人S1**"
    else:
        assert got["snapshot"]["items"] == []  # 无结果与读不出都为空，只能靠 coverage / outcome 区分
    if outcome == "unreadable":
        assert result["reason"] == "unreadable" and got["snapshot"]["unreadable_reason"]
    # 搜索算对外动作（0.3.2）：输入并提交过关键词，三个标志都为 true
    assert result["outbound_action_performed"] and result["externally_visible_side_effect"]
    # 恰好输入一次、提交一次；没有点任何结果卡片、没有滚动
    assert screen.outbound() == ["search_type", "search_submit"]
    assert screen.count("scroll") == 0 and screen.count("open_row") == 0


def test_search_outside_work_hours_is_refused_not_deferred(w: World):
    w.clock.advance((at_local(23, 45) - w.clock.now()).total_seconds())
    screen = Screen(boss_search(w.clock, "前端", "results"))
    w.bound_monitor(screen, observe=False)
    resp = w.server.call("POST", "/search-runs", {"account_id": "acct_boss_1", "query": "前端", "max_results": 5})
    assert resp.status_code == 409 and resp.json()["code"] == "policy_blocked"
    assert w.server.commands() == []


# ---------------------------------------------------------------------------
# 登录失效：暂停对外动作 → 用户登录 → 恢复
# ---------------------------------------------------------------------------


def _login_world(w: World):
    fake = boss_new_greeting(w.clock)
    fake.steps.append(fake.steps[0].model_validate(login_page_step()))
    screen = Screen(fake)
    # 真实观察器 E 外面套一层登录页替身
    m = w.bound_monitor(screen, observer=LoginStandIn(create_observer(clock=w.clock.now), screen))
    return m, fake, screen


def test_login_expired_pauses_then_resumes_after_login(w: World):
    m, fake, screen = _login_world(w)
    m.run_until(lambda: m.runtime.state.baseline.established, what="建基线")
    # 登录失效：界面回到登录页
    fake.goto("login_page")
    w.clock.advance(45)
    m.run_until(lambda: m.runtime.state.paused, what="登录失效暂停")
    assert m.runtime.state.pause_reason == "login_required"
    m.run_until(lambda: m.events_pending() == 0, what="事件补传")
    assert [e["event"]["payload"]["reason"] for e in w.server.events(kind="login_required")] == ["session_expired"]
    assert w.server.events(kind="device_paused")[0]["event"]["payload"]["reason"] == "login_required"
    m.run_until(
        lambda: w.server.device(m.identity.device_id)["last_heartbeat"]["paused"] is True, what="心跳带上暂停"
    )
    hb = w.server.device(m.identity.device_id)["last_heartbeat"]
    assert hb["pause_reason"] == "login_required" and hb["client_state"] == "login_required"
    claims = w.cluster.count(":claim")
    for _ in range(10):
        w.clock.advance(30)
        m.run(2)
    assert w.cluster.count(":claim") == claims  # 暂停期间不领取

    # 用户在本机登录完成，候选人L 已在『新招呼』里：观察到 login_ok 自动恢复，新投递照常处理
    w.clock.advance(max(0.0, (at_local(19, 12) - w.clock.now()).total_seconds()))
    fake.goto("list_new")
    w.clock.advance(45)
    m.run_until(lambda: case_stage(w) == "resume_requested", what="恢复后执行")
    assert not m.runtime.state.paused
    assert len(w.server.events(kind="login_ok")) == 1
    assert screen.outbound() == ["greeting_type", "greeting_send", "resume_request"]


def test_command_running_on_login_page_fails_without_outbound(w: World):
    """登录失效发生在指令领取之后、执行之前：处理器在登录页找不到会话 → failed，没有对外动作；
    流程转人工。（处理器不识别登录页，不会回报 login_required，见 xfail 用例。）"""
    m, fake, screen = _login_world(w)
    reach_new_greeting(w, fake, m)
    m.run_until(lambda: m.ledger.list_commands(), what="领取问候")
    fake.goto("login_page")
    m.run_until(lambda: server_cmd(w, "send_greeting")["server_status"] == "failed", what="问候失败")
    assert server_cmd(w, "send_greeting")["result"]["outbound_action_performed"] is False
    assert screen.outbound() == []
    assert case_stage(w) == "needs_human"


@pytest.mark.xfail(
    strict=True,
    reason="等待 K：观察器把登录页归为 unknown（E 报告第六节），不产生 login_required；"
    "需要 K 的登录页识别与真实登录页夹具",
)
def test_real_observer_reports_login_required_on_login_page(w: World):
    fake = boss_new_greeting(w.clock)
    fake.steps.append(fake.steps[0].model_validate(login_page_step()))
    screen = Screen(fake)
    m = w.bound_monitor(screen)
    m.run_until(lambda: m.runtime.state.baseline.established, what="建基线")
    fake.goto("login_page")
    w.clock.advance(45)
    m.run(5)
    assert m.runtime.state.paused and m.runtime.state.pause_reason == "login_required"
