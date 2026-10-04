"""编排：方案 8.1 端到端（新投递 → 问候 → 求简历）、unknown 不推进、工作时段与限额、超时转人工。

Monitor 一侧用 TestClient 模拟：上报事件、领取、ack、回报结果。时间全部用 FakeClock。
T0 = 2026-10-04 09:30（上海，周日）；auto_policy 的工作时段是每天 09:00–18:00。
"""

from __future__ import annotations

from typing import Any

import pytest
from server_testkit import (
    Harness,
    assert_shape,
    auto_policy,
    case_commands,
    claim_all,
    conversation,
    observe,
    only_case,
    run_command,
    set_policy,
)

from app.orchestrator import Orchestrator, OrchestratorSettings

pytestmark = pytest.mark.usefixtures("no_subscriber_errors")


def setup(h: Harness, **policy: Any) -> tuple[str, str]:
    device_id, token = h.ready_device()
    auto_policy(h, **policy)
    return device_id, token


def actions(commands: list[dict[str, Any]]) -> list[str]:
    return [c["action"] for c in commands]


# ---------------------------------------------------------------------------
# 方案 8.1 端到端
# ---------------------------------------------------------------------------


def test_e2e_8_1_new_application_greeting_then_resume_request(h: Harness):
    device_id, token = setup(h)
    event = observe(h, device_id, token)

    case = only_case(h)
    assert case["stage"] == "new_application"
    assert h.store.get_event(event["event_id"]).case_id == case["case_id"]

    # 1) 问候：模板已渲染；没有 depends_on
    [greeting] = claim_all(h, device_id, token)
    assert greeting["action"] == "send_greeting" and greeting["workflow_id"] == case["case_id"]
    assert greeting["payload"]["text"] == "候选人A 你好，后端工程师 岗位方便发份简历吗？"
    assert greeting["target"]["conversation"] == conversation()
    h.clock.advance(60)
    run_command(h, device_id, token, greeting)
    assert only_case(h)["stage"] == "greeted"

    # 2) 问候成功后才生成求简历，depends_on 指向问候
    [resume] = claim_all(h, device_id, token)
    assert resume["action"] == "request_resume" and resume["depends_on"] == greeting["command_id"]
    assert resume["payload"] == {}
    h.clock.advance(60)
    run_command(h, device_id, token, resume)

    detail = h.get(f"/cases/{case['case_id']}").json()
    assert_shape(detail, "CaseDetail")
    assert detail["stage"] == "resume_requested"
    assert [t["stage_to"] for t in detail["timeline"] if t["type"] == "stage_change" and t["stage_to"]] == [
        "new_application",
        "greeted",
        "resume_requested",
    ]
    # 自动流程到"简历请求已发送"为止：没有任何换微信指令，也没有更多指令
    assert actions(case_commands(h, case["case_id"])) == ["send_greeting", "request_resume"]
    assert claim_all(h, device_id, token) == []

    # 3) 简历邮件到达并唯一关联（任务 G 调用）→ resume_linked，不做自动动作
    assert h.ctx.cases.link_resume(case["case_id"], "doc_1")
    h.ctx.orchestrator.tick()
    assert only_case(h)["stage"] == "resume_linked"
    assert actions(case_commands(h, case["case_id"])) == ["send_greeting", "request_resume"]


def test_greeting_disabled_requests_resume_directly(h: Harness):
    device_id, token = setup(h, greeting=False)
    observe(h, device_id, token)
    [resume] = claim_all(h, device_id, token)
    assert resume["action"] == "request_resume" and resume["depends_on"] is None
    run_command(h, device_id, token, resume)
    assert only_case(h)["stage"] == "resume_requested"


def test_greeting_without_auto_resume_stops_after_greeting(h: Harness):
    device_id, token = setup(h, auto_request_resume=False)
    observe(h, device_id, token)
    [greeting] = claim_all(h, device_id, token)
    run_command(h, device_id, token, greeting)
    assert only_case(h)["stage"] == "greeted"
    assert claim_all(h, device_id, token) == []


def test_nothing_enabled_creates_case_but_no_commands(h: Harness):
    device_id, token = setup(h, greeting=False, auto_request_resume=False)
    observe(h, device_id, token)
    case = only_case(h)
    assert case["stage"] == "new_application" and case["latest_command"] is None


def test_greeting_already_done_on_screen_requests_resume_without_dependency(h: Harness):
    device_id, token = setup(h)
    observe(h, device_id, token)
    [greeting] = claim_all(h, device_id, token)
    run_command(h, device_id, token, greeting, "skipped_precondition")
    [resume] = claim_all(h, device_id, token)
    # skipped_precondition 不是 succeeded，依赖它会永远领不到，所以不设 depends_on
    assert resume["action"] == "request_resume" and resume["depends_on"] is None
    assert only_case(h)["stage"] == "greeted"


def test_job_out_of_scope_is_not_processed(h: Harness):
    device_id, token = setup(h, job_scope={"mode": "listed", "job_titles": ["前端工程师"]})
    observe(h, device_id, token)
    case = only_case(h)
    assert case["stage"] == "new_application"
    assert claim_all(h, device_id, token) == []


# ---------------------------------------------------------------------------
# unknown / failed 不推进、不重发
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("status", ["unknown", "failed"])
def test_greeting_not_done_goes_to_human_without_resume_request(h: Harness, status: str):
    device_id, token = setup(h)
    observe(h, device_id, token)
    [greeting] = claim_all(h, device_id, token)
    run_command(h, device_id, token, greeting, status)
    case = only_case(h)
    assert case["stage"] == "needs_human" and case["needs_human"] is True
    assert case["needs_human_reason"] == ("unknown_result" if status == "unknown" else "command_failed")
    h.clock.advance(3600)
    h.ctx.orchestrator.tick()
    assert claim_all(h, device_id, token) == []
    assert actions(case_commands(h, case["case_id"])) == ["send_greeting"]  # 没有重发，也没有求简历


def test_resume_request_unknown_goes_to_human(h: Harness):
    device_id, token = setup(h, greeting=False)
    observe(h, device_id, token)
    [resume] = claim_all(h, device_id, token)
    run_command(h, device_id, token, resume, "unknown")
    case = only_case(h)
    assert case["stage"] == "needs_human" and case["needs_human_reason"] == "unknown_result"
    assert claim_all(h, device_id, token) == []


def test_cancelled_greeting_does_not_change_stage(h: Harness):
    device_id, token = setup(h)
    observe(h, device_id, token)
    [greeting] = claim_all(h, device_id, token)
    run_command(h, device_id, token, greeting, "cancelled")
    assert only_case(h)["stage"] == "new_application"
    assert claim_all(h, device_id, token) == []


def test_result_after_case_closed_only_recorded(h: Harness):
    device_id, token = setup(h)
    observe(h, device_id, token)
    [greeting] = claim_all(h, device_id, token)
    case_id = only_case(h)["case_id"]
    assert h.post(f"/cases/{case_id}:stop", {"note": "不合适"}).status_code == 200
    run_command(h, device_id, token, greeting)  # 已领取的指令以设备回报为准
    case = only_case(h)
    assert case["stage"] == "closed"
    assert claim_all(h, device_id, token) == []


# ---------------------------------------------------------------------------
# 策略：工作时段、白名单、暂停、每日上限
# ---------------------------------------------------------------------------


def test_outside_work_hours_generates_no_outbound_command_until_window_opens(h: Harness):
    device_id, token = h.ready_device()
    window = {"timezone": "Asia/Shanghai", "windows": [{"days": [7], "start": "10:00", "end": "12:00"}]}
    auto_policy(h, work_hours=window)
    observe(h, device_id, token)  # 09:30，工作时段外
    assert claim_all(h, device_id, token) == []
    case_id = only_case(h)["case_id"]
    assert h.ctx.cases.get(case_id).blocked_reason == "outside_work_hours"
    assert any("不在工作时段内" in t["summary"] for t in h.ctx.cases.detail(case_id)["timeline"])

    h.clock.advance(31 * 60)  # 10:01
    h.ctx.orchestrator.tick()
    [greeting] = claim_all(h, device_id, token)
    assert greeting["action"] == "send_greeting"

    h.clock.advance(2 * 3600)  # 12:01，又到工作时段外：问候成功也不生成求简历
    run_command(h, device_id, token, greeting)
    assert only_case(h)["stage"] == "greeted"
    assert claim_all(h, device_id, token) == []
    assert h.ctx.cases.get(case_id).next_action == "request_resume"


def test_empty_work_hours_never_generates(h: Harness):
    device_id, token = setup(h, work_hours={"timezone": "Asia/Shanghai", "windows": []})
    observe(h, device_id, token)
    h.clock.advance(6 * 3600)
    h.ctx.orchestrator.tick()
    assert claim_all(h, device_id, token) == []


def test_action_not_in_whitelist_waits_until_policy_enabled(h: Harness):
    device_id, token = setup(h, allowed_actions=[])
    observe(h, device_id, token)
    assert claim_all(h, device_id, token) == []
    case_id = only_case(h)["case_id"]
    assert h.ctx.cases.get(case_id).blocked_reason == "not_allowed"
    set_policy(h, allowed_actions=["send_greeting", "request_resume"])  # 保存策略会触发推进
    assert actions(claim_all(h, device_id, token)) == ["send_greeting"]


def test_paused_policy_generates_nothing(h: Harness):
    device_id, token = setup(h, paused=True)
    observe(h, device_id, token)
    assert claim_all(h, device_id, token) == []
    case_id = only_case(h)["case_id"]
    assert h.ctx.cases.get(case_id).blocked_reason == "paused"
    assert case_commands(h, case_id) == []


def test_all_devices_paused_generates_nothing(h: Harness):
    device_id, token = setup(h)
    assert h.post(f"/devices/{device_id}:pause", {"note": "午休"}).status_code == 200
    observe(h, device_id, token)
    case_id = only_case(h)["case_id"]
    assert h.ctx.cases.get(case_id).blocked_reason == "devices_paused"
    assert case_commands(h, case_id) == []


def test_daily_limit_defers_extra_greetings_to_next_day(h: Harness):
    device_id, token = setup(
        h,
        daily_limits={
            "send_greeting": 1,
            "request_resume": 40,
            "request_contact_exchange": 40,
            "search_candidates": 40,
        },
    )
    observe(h, device_id, token, conversation("候选人A"))
    observe(h, device_id, token, conversation("候选人B"))
    assert actions(claim_all(h, device_id, token)) == ["send_greeting"]
    blocked = [c for c in h.ctx.cases.repo.cases_with_next_action()]
    assert len(blocked) == 1 and blocked[0].blocked_reason == "daily_limit_reached"
    h.clock.advance(24 * 3600)  # 第二天 09:30
    h.ctx.orchestrator.tick()
    assert actions(claim_all(h, device_id, token)) == ["send_greeting"]


# ---------------------------------------------------------------------------
# 过期与超时
# ---------------------------------------------------------------------------


def test_unclaimed_auto_command_expiring_goes_to_human(h: Harness):
    device_id, token = setup(h)
    observe(h, device_id, token)
    h.clock.advance(3 * 3600)  # 超过 2 小时有效期，从未被领取
    h.ctx.orchestrator.tick()
    case = only_case(h)
    assert case["stage"] == "needs_human" and case["needs_human_reason"] == "command_expired"
    assert claim_all(h, device_id, token) == []


def test_resume_mail_timeout_goes_to_human(h: Harness):
    device_id, token = setup(h, greeting=False)
    observe(h, device_id, token)
    [resume] = claim_all(h, device_id, token)
    run_command(h, device_id, token, resume)
    h.clock.advance(3 * 86400 - 60)
    h.ctx.orchestrator.tick()
    assert only_case(h)["stage"] == "resume_requested"
    h.clock.advance(120)
    h.ctx.orchestrator.tick()
    case = only_case(h)
    assert case["stage"] == "needs_human" and case["needs_human_reason"] == "resume_mail_timeout"
    # 超时转人工后邮件才到：人工路径 needs_human → resume_linked
    assert h.ctx.cases.link_resume(case["case_id"], "doc_late")
    assert only_case(h)["stage"] == "resume_linked"


def test_linked_resume_prevents_timeout(h: Harness):
    device_id, token = setup(h, greeting=False)
    observe(h, device_id, token)
    [resume] = claim_all(h, device_id, token)
    run_command(h, device_id, token, resume)
    case_id = only_case(h)["case_id"]
    h.ctx.cases.link_resume(case_id, "doc_1")
    h.clock.advance(10 * 86400)
    h.ctx.orchestrator.tick()
    assert only_case(h)["stage"] == "resume_linked"


# ---------------------------------------------------------------------------
# 自动流程不得生成换微信；后台定时器
# ---------------------------------------------------------------------------


def test_auto_origin_refuses_contact_exchange(h: Harness):
    device_id, token = setup(h, greeting=False, auto_request_resume=False)
    observe(h, device_id, token)
    case = h.ctx.cases.get(only_case(h)["case_id"])
    orch = h.ctx.orchestrator
    command = orch.build_command(case, "request_contact_exchange", {"exchange_type": "wechat"})
    with pytest.raises(ValueError):
        orch.issue(case, command, "auto")
    assert case_commands(h, case.case_id) == []


def test_auto_flow_never_issues_contact_exchange_even_after_resume(h: Harness):
    device_id, token = setup(h, greeting=False)
    observe(h, device_id, token)
    [resume] = claim_all(h, device_id, token)
    run_command(h, device_id, token, resume)
    case_id = only_case(h)["case_id"]
    h.ctx.cases.link_resume(case_id, "doc_1")
    h.ctx.cases.mark_resume_parsed("doc_1")
    h.clock.advance(3600)
    h.ctx.orchestrator.tick()
    assert "request_contact_exchange" not in actions(case_commands(h, case_id))


def test_background_tick_starts_and_stops(h: Harness):
    orch = Orchestrator(h.ctx, OrchestratorSettings(tick_interval_seconds=0.01))
    calls: list[int] = []
    orch.tick = lambda: calls.append(1)  # type: ignore[method-assign]
    orch.start_background()
    orch.start_background()  # 重复启动无副作用
    import time

    deadline = time.monotonic() + 2
    while not calls and time.monotonic() < deadline:
        time.sleep(0.01)
    orch.close()
    assert calls
    assert orch._thread is None


def test_background_tick_survives_errors(h: Harness):
    orch = Orchestrator(h.ctx, OrchestratorSettings(tick_interval_seconds=0.01))
    calls: list[int] = []

    def boom() -> None:
        calls.append(1)
        raise RuntimeError("坏了")

    orch.tick = boom  # type: ignore[method-assign]
    orch.start_background()
    import time

    deadline = time.monotonic() + 2
    while len(calls) < 2 and time.monotonic() < deadline:
        time.sleep(0.01)
    orch.close()
    assert len(calls) >= 2


def test_lifespan_runs_background_tick(h: Harness):
    from fastapi.testclient import TestClient

    with TestClient(h.app) as client:
        assert h.ctx.orchestrator._thread is not None
        assert client.get("/api/v1/overview").status_code == 401
    assert h.ctx.orchestrator._thread is None


def test_events_without_account_are_ignored(h: Harness):
    device_id, token = setup(h)
    from server_testkit import vector

    ev = vector("event_login_required")
    ev["device_id"] = device_id
    resp = h.post("/events", {"device_id": device_id, "events": [ev]}, token=token)
    assert resp.status_code == 200 and resp.json()["results"][0]["status"] == "accepted"
    assert h.get("/cases").json()["items"] == []
