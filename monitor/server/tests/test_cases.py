"""招聘流程：事件建 case 与去重合并、状态机迁移、简历关联、GET /cases 与 GET /cases/{id}。"""

from __future__ import annotations

from typing import Any

import pytest
from server_testkit import (
    SERVICE_TOKEN,
    Harness,
    assert_problem,
    assert_shape,
    auto_policy,
    claim_all,
    conversation,
    make_case_event,
    observe,
    only_case,
    run_command,
    send_events,
)

from app.cases import StageNotAllowed, normalize_text

pytestmark = pytest.mark.usefixtures("no_subscriber_errors")


def setup(h: Harness, **policy: Any) -> tuple[str, str]:
    device_id, token = h.ready_device()
    auto_policy(h, greeting=False, auto_request_resume=False, **policy)
    return device_id, token


# ---------------------------------------------------------------------------
# 建立与去重
# ---------------------------------------------------------------------------


def test_application_creates_case_and_links_event(h: Harness):
    device_id, token = setup(h)
    event = observe(h, device_id, token)
    case = only_case(h)
    assert_shape(case, "CaseSummary")
    assert case["stage"] == "new_application" and case["needs_human"] is False
    assert (case["candidate_name"], case["job_title"]) == ("候选人A", "后端工程师")
    assert case["conversation_hints"] == ["本科", "上海"] and case["contact_status"] == "not_requested"
    assert h.store.get_event(event["event_id"]).case_id == case["case_id"]
    resp = h.get("/events", params={"kind": "application_observed"}).json()
    assert resp["items"][0]["case_id"] == case["case_id"]


def test_duplicate_event_does_not_create_duplicate_case(h: Harness):
    device_id, token = setup(h)
    event = observe(h, device_id, token)
    case_id = only_case(h)["case_id"]
    before = h.ctx.cases.detail(case_id)["timeline"]
    results = send_events(h, device_id, token, [event])
    assert results[0]["status"] == "duplicate"
    only_case(h)
    assert h.ctx.cases.detail(case_id)["timeline"] == before  # 重复事件不再产生任何处理


def test_same_application_with_new_bucket_merges_into_one_case(h: Harness):
    device_id, token = h.ready_device()
    auto_policy(h, greeting=True)
    e1 = observe(h, device_id, token)
    h.clock.advance(3600)
    e2 = observe(h, device_id, token, conversation("  候选人A ", "后端工程师"), bucket="2026-10-04T02:00:00Z/3600")
    assert e1["event_id"] != e2["event_id"]
    case = only_case(h)
    assert h.store.get_event(e2["event_id"]).case_id == case["case_id"]
    assert len(claim_all(h, device_id, token)) == 1  # 合并后不重复下发问候


def test_different_job_or_account_is_a_separate_case(h: Harness):
    device_id, token = setup(h)
    observe(h, device_id, token)
    observe(h, device_id, token, conversation(job="前端工程师"))
    other_device, other_token = h.ready_device("acct_other")
    observe(h, other_device, other_token, account_id="acct_other")
    items = h.get("/cases").json()["items"]
    assert len(items) == 3
    assert {(c["account_id"], c["job_title"]) for c in items} == {
        ("acct_demo", "后端工程师"),
        ("acct_demo", "前端工程师"),
        ("acct_other", "后端工程师"),
    }


def test_open_case_is_idempotent(h: Harness):
    setup(h)
    svc = h.ctx.cases
    a, created_a = svc.open_case("acct_demo", conversation(), "ev1")
    b, created_b = svc.open_case("acct_demo", conversation(" 候选人A"), "ev2")
    assert created_a and not created_b and a.case_id == b.case_id


def test_normalize_text():
    assert normalize_text("  é ") == "é"


def test_conversation_ambiguous_goes_to_human(h: Harness):
    device_id, token = setup(h)
    send_events(h, device_id, token, [make_case_event(h, device_id, "conversation_ambiguous")])
    case = only_case(h)
    assert case["stage"] == "needs_human" and case["needs_human_reason"] == "conversation_ambiguous"


def test_attachment_event_marks_resume_received(h: Harness):
    device_id, token = setup(h)
    observe(h, device_id, token)
    send_events(h, device_id, token, [make_case_event(h, device_id, "attachment_available")])
    assert only_case(h)["stage"] == "resume_received"


def test_events_for_unknown_conversation_do_not_create_cases(h: Harness):
    device_id, token = setup(h)
    send_events(
        h,
        device_id,
        token,
        [
            make_case_event(h, device_id, "attachment_available"),
            make_case_event(h, device_id, "contact_exchange_updated"),
        ],
    )
    assert h.get("/cases").json()["items"] == []


@pytest.mark.parametrize(
    ("state", "status"),
    [("pending_acceptance", "pending_acceptance"), ("refused", "refused"), ("unknown", "pending_confirmation")],
)
def test_contact_exchange_event_updates_status_only(h: Harness, state: str, status: str):
    device_id, token = setup(h)
    observe(h, device_id, token)
    payload = {"exchange_type": "wechat", "exchange_state": state, "evidence": []}
    send_events(h, device_id, token, [make_case_event(h, device_id, "contact_exchange_updated", payload=payload)])
    case = only_case(h)
    assert case["contact_status"] == status and case["stage"] == "new_application"


# ---------------------------------------------------------------------------
# 状态机
# ---------------------------------------------------------------------------


def test_transition_follows_contract_table(h: Harness):
    device_id, token = setup(h)
    observe(h, device_id, token)
    svc, case_id = h.ctx.cases, only_case(h)["case_id"]
    with pytest.raises(StageNotAllowed):
        svc.transition(case_id, "contact_available", ref_id="x", summary="非法")
    with pytest.raises(StageNotAllowed):
        svc.transition(case_id, "new_application", ref_id="x", summary="自迁移")
    svc.transition(case_id, "closed", ref_id="x", summary="关闭")
    assert not svc.to_needs_human(case_id, "test", ref_id="x", summary="已关闭不能转人工")
    assert only_case(h)["stage"] == "closed"


def test_needs_human_reason_updates_and_clears(h: Harness):
    device_id, token = setup(h)
    observe(h, device_id, token)
    svc, case_id = h.ctx.cases, only_case(h)["case_id"]
    assert svc.to_needs_human(case_id, "a", ref_id="x", summary="一")
    assert svc.to_needs_human(case_id, "b", ref_id="x", summary="二")
    assert only_case(h)["needs_human_reason"] == "b"
    svc.transition(case_id, "greeted", ref_id="x", summary="人工处理后")
    assert only_case(h)["needs_human_reason"] is None


def test_require_unknown_case(h: Harness):
    from app.main import ApiError

    with pytest.raises(ApiError):
        h.ctx.cases.require("case_nope")


# ---------------------------------------------------------------------------
# 简历关联（任务 G 调用）
# ---------------------------------------------------------------------------


def test_link_resume_from_new_application_goes_through_received(h: Harness):
    device_id, token = setup(h)
    observe(h, device_id, token)
    svc, case_id = h.ctx.cases, only_case(h)["case_id"]
    assert svc.link_resume(case_id, "doc_1")
    assert not svc.link_resume(case_id, "doc_1")  # 同一文档重复关联
    detail = svc.detail(case_id)
    assert detail["stage"] == "resume_linked"
    assert [t["stage_to"] for t in detail["timeline"] if t["stage_to"]][-2:] == ["resume_received", "resume_linked"]
    assert svc.mark_resume_parsed("doc_1")
    assert svc.mark_resume_parsed("doc_1")  # 已标记：仍返回 True，不重复记
    assert not svc.mark_resume_parsed("doc_unknown")


def test_link_resume_second_version_keeps_stage(h: Harness):
    device_id, token = setup(h)
    observe(h, device_id, token)
    svc, case_id = h.ctx.cases, only_case(h)["case_id"]
    svc.link_resume(case_id, "doc_1")
    assert svc.link_resume(case_id, "doc_2")
    assert only_case(h)["stage"] == "resume_linked"


def test_link_resume_unknown_case(h: Harness):
    from app.main import ApiError

    with pytest.raises(ApiError):
        h.ctx.cases.link_resume("case_nope", "doc_1")


def test_resume_documents_provider_used_in_detail(h: Harness):
    device_id, token = setup(h)
    observe(h, device_id, token)
    case_id = only_case(h)["case_id"]
    doc = {
        "doc_id": "doc_1",
        "case_id": case_id,
        "variant": "original",
        "derived_from": None,
        "mail_message_id": "mail:0f8fad5b-d9cb-469f-a165-70867728950e",
        "link_status": "linked",
        "link_method": "resume_request",
        "version": 1,
        "sha256": "0" * 64,
        "filename": "简历.pdf",
        "parse_status": "parsed",
        "created_at": "2026-10-04T01:30:00Z",
        "duplicate": False,
    }
    h.ctx.cases.resume_documents_provider = lambda cid: [doc] if cid == case_id else []
    detail = h.get(f"/cases/{case_id}").json()
    assert_shape(detail, "CaseDetail")
    assert detail["resume_documents"] == [doc]


# ---------------------------------------------------------------------------
# GET /cases、GET /cases/{id}
# ---------------------------------------------------------------------------


def test_list_filters_and_pagination(h: Harness):
    device_id, token = setup(h)
    for name in ("张三", "李四", "王五"):
        observe(h, device_id, token, conversation(name))
    observe(h, device_id, token, conversation("赵六", "前端工程师"))
    zhang = next(c for c in h.get("/cases").json()["items"] if c["candidate_name"] == "张三")
    h.ctx.cases.to_needs_human(zhang["case_id"], "test", ref_id="x", summary="转人工")

    def names(**params: Any) -> list[str]:
        resp = h.get("/cases", params=params)
        assert resp.status_code == 200, resp.text
        return [c["candidate_name"] for c in resp.json()["items"]]

    assert names() == ["赵六", "王五", "李四", "张三"]  # 新的在前
    assert names(needs_human=True) == ["张三"]
    assert names(needs_human=False) == ["赵六", "王五", "李四"]
    assert names(stage=["needs_human", "new_application"]) == ["赵六", "王五", "李四", "张三"]
    assert names(stage="needs_human") == ["张三"]
    assert names(job_title="前端工程师") == ["赵六"]
    assert names(q="李") == ["李四"]
    assert names(q="前端") == ["赵六"]
    assert names(account_id="acct_other") == []

    page1 = h.get("/cases", params={"limit": 3}).json()
    assert len(page1["items"]) == 3 and page1["next_cursor"]
    page2 = h.get("/cases", params={"limit": 3, "cursor": page1["next_cursor"]}).json()
    assert [c["candidate_name"] for c in page2["items"]] == ["张三"] and page2["next_cursor"] is None


def test_list_errors(h: Harness):
    assert_problem(h.get("/cases", token=None), 401)
    assert_problem(h.get("/cases", params={"cursor": "abc"}), 422)
    assert_problem(h.get("/cases", params={"limit": 0}), 422)
    assert_problem(h.get("/cases", params={"stage": "bogus"}), 422)


def test_detail_contents_and_auth(h: Harness):
    device_id, token = h.ready_device()
    auto_policy(h)
    observe(h, device_id, token)
    [greeting] = claim_all(h, device_id, token)
    run_command(h, device_id, token, greeting, "unknown")
    case_id = only_case(h)["case_id"]
    h.post(f"/commands/{greeting['command_id']}:recheck")
    resp = h.get(f"/cases/{case_id}", token=SERVICE_TOKEN)  # 邮件接入也可读
    assert resp.status_code == 200
    detail = resp.json()
    assert_shape(detail, "CaseDetail")
    assert [c["command"]["execution_mode"] for c in detail["commands"]] == ["execute", "verify_only"]
    assert detail["latest_command"]["command"]["execution_mode"] == "verify_only"
    assert [m["type"] for m in detail["manual_actions"]] == ["recheck"]
    types = [t["type"] for t in detail["timeline"]]
    for expected in ("stage_change", "command", "command_result", "manual_action"):
        assert expected in types
    assert_problem(h.get("/cases/case_nope"), 404, "not_found")
    assert_problem(h.get(f"/cases/{case_id}", token=None), 401)


def test_summary_paused_reflects_policy(h: Harness):
    device_id, token = setup(h, paused=True)
    observe(h, device_id, token)
    assert only_case(h)["paused"] is True
