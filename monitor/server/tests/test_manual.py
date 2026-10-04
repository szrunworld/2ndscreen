"""人工处理：方案 8.3 端到端（人工换微信）、确认已发送、重新检查、停止流程。"""

from __future__ import annotations

from typing import Any

import pytest
from server_testkit import (
    Harness,
    assert_problem,
    assert_shape,
    auto_policy,
    case_commands,
    claim_all,
    make_case_event,
    observe,
    only_case,
    run_command,
    send_events,
    set_policy,
)

pytestmark = pytest.mark.usefixtures("no_subscriber_errors")


def setup(h: Harness, **policy: Any) -> tuple[str, str]:
    device_id, token = h.ready_device()
    auto_policy(h, **policy)
    return device_id, token


def wechat(h: Harness, case_id: str, note: str = "约面试", **kw: Any) -> Any:
    return h.post(f"/cases/{case_id}:request-wechat", {"note": note}, **kw)


def to_resume_linked(h: Harness, device_id: str, token: str) -> str:
    """走完自动流程并关联简历，返回 case_id。"""
    observe(h, device_id, token)
    for _ in range(2):
        [command] = claim_all(h, device_id, token)
        run_command(h, device_id, token, command)
    case_id = only_case(h)["case_id"]
    assert h.ctx.cases.link_resume(case_id, "doc_1")
    return case_id


# ---------------------------------------------------------------------------
# 方案 8.3 端到端：只换微信、仅人工
# ---------------------------------------------------------------------------


def test_e2e_8_3_manual_wechat_exchange(h: Harness):
    device_id, token = setup(h)
    case_id = to_resume_linked(h, device_id, token)
    assert only_case(h)["stage"] == "resume_linked"
    assert claim_all(h, device_id, token) == []  # 收到简历后不自动换微信

    resp = wechat(h, case_id, "候选人合适，约面试")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert_shape(body, "ManualCommandCreated")
    manual, record = body["manual_action"], body["command"]
    assert manual["type"] == "request_wechat" and manual["actor"] == "alice"
    assert manual["note"] == "候选人合适，约面试" and manual["target"] == {"kind": "case", "id": case_id}
    command = record["command"]
    assert command["action"] == "request_contact_exchange" and command["payload"] == {"exchange_type": "wechat"}
    assert command["workflow_id"] == case_id and command["execution_mode"] == "execute"
    assert only_case(h)["stage"] == "contact_requested"
    assert only_case(h)["contact_status"] == "not_requested"  # "请求已发送"要等指令成功

    [claimed] = claim_all(h, device_id, token)
    assert claimed["command_id"] == command["command_id"]
    run_command(h, device_id, token, claimed)
    case = only_case(h)
    assert case["stage"] == "contact_requested" and case["contact_status"] == "request_sent"

    # observe 看到候选人同意 → 业务事件，联系方式可用
    send_events(
        h,
        device_id,
        token,
        [make_case_event(h, device_id, "contact_exchange_updated", bucket="2026-10-04T02:00:00Z/3600")],
    )
    case = only_case(h)
    assert case["stage"] == "contact_available" and case["contact_status"] == "available"
    detail = h.get(f"/cases/{case_id}").json()
    assert_shape(detail, "CaseDetail")
    assert [m["type"] for m in detail["manual_actions"]] == ["request_wechat"]


def test_wechat_allowed_before_resume_and_resume_link_does_not_regress(h: Harness):
    device_id, token = setup(h)
    observe(h, device_id, token)
    case_id = only_case(h)["case_id"]
    assert wechat(h, case_id).status_code == 201  # new_application 也可以（0.3.1）
    assert only_case(h)["stage"] == "contact_requested"
    # 问候指令还挂着，但阶段已离开早期阶段：问候成功也不再生成求简历
    greeting = next(c for c in claim_all(h, device_id, token) if c["action"] == "send_greeting")
    run_command(h, device_id, token, greeting)
    assert "request_resume" not in [c["action"] for c in case_commands(h, case_id)]
    # 之后简历邮件才到：关联成功，阶段不回退，时间线记 resume_linked
    assert h.ctx.cases.link_resume(case_id, "doc_late")
    detail = h.ctx.cases.detail(case_id)
    assert detail["stage"] == "contact_requested"
    linked = [t for t in detail["timeline"] if t["type"] == "resume_linked"]
    assert linked and linked[0]["stage_from"] is None and linked[0]["stage_to"] is None


def test_wechat_in_closed_returns_409(h: Harness):
    device_id, token = setup(h)
    observe(h, device_id, token)
    case_id = only_case(h)["case_id"]
    assert h.post(f"/cases/{case_id}:stop", {"note": "不合适"}).status_code == 200
    assert_problem(wechat(h, case_id), 409, "stage_not_allowed")


@pytest.mark.parametrize(
    ("changes", "reason"),
    [
        ({"allowed_actions": ["send_greeting", "request_resume"]}, "not_allowed"),
        ({"paused": True}, "paused"),
        ({"work_hours": {"timezone": "Asia/Shanghai", "windows": []}}, "outside_work_hours"),
        (
            {
                "daily_limits": {
                    "send_greeting": 40,
                    "request_resume": 40,
                    "request_contact_exchange": 0,
                    "search_candidates": 40,
                }
            },
            "daily_limit_reached",
        ),
    ],
)
def test_wechat_blocked_by_policy(h: Harness, changes: dict[str, Any], reason: str):
    device_id, token = setup(h, greeting=False, auto_request_resume=False)
    observe(h, device_id, token)
    case_id = only_case(h)["case_id"]
    set_policy(h, **changes)
    body = assert_problem(wechat(h, case_id), 409, "policy_blocked")
    assert body["errors"][0]["code"] == reason
    assert case_commands(h, case_id) == [] and only_case(h)["stage"] == "new_application"
    assert h.ctx.store.list_manual_actions("case", case_id) == []


def test_wechat_already_requested_returns_409_with_existing(h: Harness):
    device_id, token = setup(h, greeting=False, auto_request_resume=False)
    observe(h, device_id, token)
    case_id = only_case(h)["case_id"]
    first = wechat(h, case_id).json()["command"]
    body = assert_problem(wechat(h, case_id), 409, "already_requested")
    assert body["existing"]["command"]["command_id"] == first["command"]["command_id"]


def test_wechat_again_after_failure_keeps_stage(h: Harness):
    device_id, token = setup(h, greeting=False, auto_request_resume=False)
    observe(h, device_id, token)
    case_id = only_case(h)["case_id"]
    wechat(h, case_id)
    [command] = claim_all(h, device_id, token)
    run_command(h, device_id, token, command, "failed")
    assert only_case(h)["stage"] == "needs_human"
    assert wechat(h, case_id, "再试一次").status_code == 201
    assert only_case(h)["stage"] == "contact_requested"
    [again] = claim_all(h, device_id, token)
    run_command(h, device_id, token, again, "failed")
    assert wechat(h, case_id, "第三次").status_code == 201  # needs_human → contact_requested
    [third] = claim_all(h, device_id, token)
    run_command(h, device_id, token, third, "skipped_precondition")  # 界面已是待同意
    case = only_case(h)
    assert case["stage"] == "contact_requested" and case["contact_status"] == "pending_acceptance"
    # 已在 contact_requested：再请求阶段不变
    assert wechat(h, case_id, "第四次").status_code == 201
    assert only_case(h)["stage"] == "contact_requested"


def test_wechat_unknown_goes_to_human_pending_confirmation(h: Harness):
    device_id, token = setup(h, greeting=False, auto_request_resume=False)
    observe(h, device_id, token)
    case_id = only_case(h)["case_id"]
    wechat(h, case_id)
    [command] = claim_all(h, device_id, token)
    run_command(h, device_id, token, command, "unknown")
    case = only_case(h)
    assert case["stage"] == "needs_human" and case["contact_status"] == "pending_confirmation"
    resp = h.post(f"/commands/{command['command_id']}:confirm-sent", {"note": "手机上看到已发送"})
    assert resp.status_code == 200
    case = only_case(h)
    assert case["stage"] == "contact_requested" and case["contact_status"] == "request_sent"


def test_wechat_errors(h: Harness):
    device_id, token = setup(h)
    observe(h, device_id, token)
    case_id = only_case(h)["case_id"]
    assert_problem(wechat(h, "case_missing"), 404, "not_found")
    assert_problem(h.post(f"/cases/{case_id}:request-wechat", {}), 422, "validation_failed")
    assert_problem(h.post(f"/cases/{case_id}:request-wechat", {"note": ""}), 422, "validation_failed")
    assert_problem(wechat(h, case_id, token=None), 401)
    assert_problem(wechat(h, case_id, key=None), 422)


def test_wechat_idempotent_replay(h: Harness):
    device_id, token = setup(h, greeting=False, auto_request_resume=False)
    observe(h, device_id, token)
    case_id = only_case(h)["case_id"]
    first = wechat(h, case_id, key="click-0001")
    again = wechat(h, case_id, key="click-0001")
    assert first.status_code == again.status_code == 201
    assert first.json() == again.json()
    assert len(case_commands(h, case_id)) == 1
    assert_problem(wechat(h, case_id, "不同说明", key="click-0001"), 422, "idempotency_key_reused")


# ---------------------------------------------------------------------------
# 人工确认已发送
# ---------------------------------------------------------------------------


def unknown_greeting(h: Harness) -> tuple[str, str, dict[str, Any], str]:
    device_id, token = setup(h)
    observe(h, device_id, token)
    [greeting] = claim_all(h, device_id, token)
    run_command(h, device_id, token, greeting, "unknown")
    return device_id, token, greeting, only_case(h)["case_id"]


def test_confirm_sent_advances_without_overwriting_result(h: Harness):
    device_id, token, greeting, case_id = unknown_greeting(h)
    original = h.get(f"/commands/{greeting['command_id']}").json()["result"]
    resp = h.post(f"/commands/{greeting['command_id']}:confirm-sent", {"note": "在手机上看到问候已发出"})
    assert resp.status_code == 200, resp.text
    manual = resp.json()
    assert_shape(manual, "ManualAction")
    assert manual["type"] == "confirm_sent" and manual["actor"] == "alice"
    assert manual["target"] == {"kind": "command", "id": greeting["command_id"]}

    record = h.get(f"/commands/{greeting['command_id']}").json()
    assert record["server_status"] == "unknown" and record["result"] == original  # 原始结果不变
    assert [m["type"] for m in record["manual_actions"]] == ["confirm_sent"]

    assert only_case(h)["stage"] == "greeted"
    [resume] = claim_all(h, device_id, token)
    assert resume["action"] == "request_resume" and resume["depends_on"] is None
    detail = h.get(f"/cases/{case_id}").json()
    assert "confirm_sent" in [m["type"] for m in detail["manual_actions"]]
    assert any(t["type"] == "manual_action" for t in detail["timeline"])


def test_confirm_sent_resume_request_sets_requested(h: Harness):
    device_id, token = setup(h, greeting=False)
    observe(h, device_id, token)
    [resume] = claim_all(h, device_id, token)
    run_command(h, device_id, token, resume, "unknown")
    assert h.post(f"/commands/{resume['command_id']}:confirm-sent", {"note": "已发"}).status_code == 200
    case_id = only_case(h)["case_id"]
    assert only_case(h)["stage"] == "resume_requested"
    assert h.ctx.cases.get(case_id).resume_requested_at is not None


def test_confirm_sent_only_for_unknown(h: Harness):
    device_id, token = setup(h)
    observe(h, device_id, token)
    [greeting] = claim_all(h, device_id, token)
    # 还没有结果
    assert_problem(h.post(f"/commands/{greeting['command_id']}:confirm-sent", {"note": "x"}), 409, "not_unknown")
    run_command(h, device_id, token, greeting)
    assert_problem(h.post(f"/commands/{greeting['command_id']}:confirm-sent", {"note": "x"}), 409, "not_unknown")


def test_confirm_sent_twice_and_errors(h: Harness):
    _, _, greeting, _ = unknown_greeting(h)
    path = f"/commands/{greeting['command_id']}:confirm-sent"
    assert h.post(path, {"note": "第一次"}).status_code == 200
    assert_problem(h.post(path, {"note": "第二次"}), 409, "already_confirmed")
    assert_problem(h.post("/commands/00000000-0000-4000-8000-0000000000ff:confirm-sent", {"note": "x"}), 404)
    assert_problem(h.post(path, {}), 422)
    assert_problem(h.post(path, {"note": "x"}, token=None), 401)


def test_confirm_sent_on_closed_case_only_records(h: Harness):
    _, _, greeting, case_id = unknown_greeting(h)
    h.post(f"/cases/{case_id}:stop", {"note": "停止"})
    assert h.post(f"/commands/{greeting['command_id']}:confirm-sent", {"note": "补记"}).status_code == 200
    assert only_case(h)["stage"] == "closed"


# ---------------------------------------------------------------------------
# 重新检查
# ---------------------------------------------------------------------------


def test_recheck_creates_verify_only_command_ignoring_policy(h: Harness):
    device_id, token, greeting, case_id = unknown_greeting(h)
    set_policy(h, allowed_actions=[], work_hours={"timezone": "Asia/Shanghai", "windows": []})  # 不受白名单与时段约束
    resp = h.post(f"/commands/{greeting['command_id']}:recheck")
    assert resp.status_code == 201, resp.text
    record = resp.json()
    assert_shape(record, "CommandRecord")
    new = record["command"]
    assert new["command_id"] != greeting["command_id"]
    assert new["execution_mode"] == "verify_only" and new["action"] == "send_greeting"
    assert new["target"] == greeting["target"] and new["payload"] == greeting["payload"]
    assert new["depends_on"] is None and record["case_id"] == case_id
    original = h.get(f"/commands/{greeting['command_id']}").json()
    assert [m["type"] for m in original["manual_actions"]] == ["recheck"]

    [claimed] = claim_all(h, device_id, token)
    assert claimed["command_id"] == new["command_id"]
    run_command(h, device_id, token, claimed)  # verify_only 成功：只记录，不改阶段
    case = only_case(h)
    assert case["stage"] == "needs_human" and case["needs_human_reason"] == "unknown_result"
    timeline = h.ctx.cases.detail(case_id)["timeline"]
    assert any("重新检查" in t["summary"] and t["type"] == "command_result" for t in timeline)


def test_recheck_errors(h: Harness):
    device_id, _ = setup(h)
    search = h.create(action="search_candidates")
    assert_problem(h.post(f"/commands/{search['command']['command_id']}:recheck"), 409, "recheck_not_supported")
    assert_problem(h.post("/commands/00000000-0000-4000-8000-0000000000ff:recheck"), 404)
    assert_problem(h.post("/commands/not-a-uuid:recheck"), 422)
    assert_problem(h.post(f"/commands/{search['command']['command_id']}:recheck", token=None), 401)


def test_recheck_command_without_case(h: Harness):
    h.ready_device()
    record = h.create()  # 直接创建、不属于 F2 流程的问候指令
    resp = h.post(f"/commands/{record['command']['command_id']}:recheck")
    assert resp.status_code == 201
    assert resp.json()["command"]["execution_mode"] == "verify_only"


# ---------------------------------------------------------------------------
# 停止流程
# ---------------------------------------------------------------------------


def test_stop_cancels_open_commands_and_closes(h: Harness):
    device_id, token = setup(h, greeting=False, auto_request_resume=False)
    observe(h, device_id, token)
    case_id = only_case(h)["case_id"]
    wechat(h, case_id)
    [claimed] = claim_all(h, device_id, token)  # 已领取
    # 再造一条未领取的：重新检查
    pending = h.post(f"/commands/{claimed['command_id']}:recheck").json()["command"]
    resp = h.post(f"/cases/{case_id}:stop", {"note": "候选人已入职别家"})
    assert resp.status_code == 200, resp.text
    manual = resp.json()
    assert_shape(manual, "ManualAction")
    assert manual["type"] == "stop_case" and manual["target"] == {"kind": "case", "id": case_id}
    assert only_case(h)["stage"] == "closed"
    assert h.get(f"/commands/{pending['command_id']}").json()["server_status"] == "cancelled"
    claimed_record = h.get(f"/commands/{claimed['command_id']}").json()
    assert claimed_record["cancel_requested"] is True and claimed_record["server_status"] == "claimed"
    hb = h.heartbeat(device_id, token).json()
    assert claimed["command_id"] in hb["cancellations"]


def test_stop_twice_and_errors(h: Harness):
    device_id, token = setup(h)
    observe(h, device_id, token)
    case_id = only_case(h)["case_id"]
    assert h.post(f"/cases/{case_id}:stop", {"note": "a"}).status_code == 200
    assert h.post(f"/cases/{case_id}:stop", {"note": "b"}).status_code == 200  # 已关闭：只补记
    assert only_case(h)["stage"] == "closed"
    assert len(h.ctx.store.list_manual_actions("case", case_id)) == 2
    assert_problem(h.post("/cases/nope:stop", {"note": "a"}), 404)
    assert_problem(h.post(f"/cases/{case_id}:stop", {}), 422)
    assert_problem(h.post(f"/cases/{case_id}:stop", {"note": "a"}, token=None), 401)
