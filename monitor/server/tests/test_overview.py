"""总览 GET /overview：今日新投递、已请求简历、收到简历、解析完成、待人工处理、unknown 结果分别计数。"""

from __future__ import annotations

import pytest
from server_testkit import (
    Harness,
    assert_problem,
    assert_shape,
    auto_policy,
    claim_all,
    conversation,
    observe,
    run_command,
)

pytestmark = pytest.mark.usefixtures("no_subscriber_errors")


def test_counts_are_separate(h: Harness):
    device_id, token = h.ready_device()
    auto_policy(h, greeting=False)
    for name in ("张三", "李四", "王五"):
        observe(h, device_id, token, conversation(name))
    commands = {c["target"]["conversation"]["candidate_name"]: c for c in claim_all(h, device_id, token)}
    run_command(h, device_id, token, commands["张三"])  # 已请求简历
    run_command(h, device_id, token, commands["李四"])  # 已请求简历 → 收到 → 解析
    run_command(h, device_id, token, commands["王五"], "unknown")  # 待人工 + unknown
    cases = {c["candidate_name"]: c["case_id"] for c in h.get("/cases").json()["items"]}
    h.ctx.cases.link_resume(cases["李四"], "doc_1")
    h.ctx.cases.mark_resume_parsed("doc_1")

    resp = h.get("/overview", params={"account_id": "acct_demo"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert_shape(body, "Overview")
    assert body["date"] == "2026-10-04"
    assert {k: body[k] for k in body if k not in ("date", "devices")} == {
        "new_applications": 3,
        "resume_requested": 2,
        "resume_received": 1,
        "resume_parsed": 1,
        "needs_human": 1,
        "unknown_results": 1,
    }
    assert [d["device_id"] for d in body["devices"]] == [device_id]

    # 不指定账户：全部账户；另一账户没有数据
    assert h.get("/overview").json()["new_applications"] == 3
    other = h.get("/overview", params={"account_id": "acct_other"}).json()
    assert other["new_applications"] == 0 and other["devices"] == []


def test_counts_are_per_local_day(h: Harness):
    device_id, token = h.ready_device()
    auto_policy(h, greeting=False, auto_request_resume=False)
    observe(h, device_id, token)
    h.clock.advance(86400)
    observe(h, device_id, token, conversation("第二天"))
    today = h.get("/overview", params={"account_id": "acct_demo"}).json()
    assert today["date"] == "2026-10-05" and today["new_applications"] == 1
    yesterday = h.get("/overview", params={"account_id": "acct_demo", "date": "2026-10-04"}).json()
    assert yesterday["new_applications"] == 1
    assert h.get("/overview", params={"date": "2026-10-01"}).json()["new_applications"] == 0


def test_overview_errors(h: Harness):
    assert_problem(h.get("/overview", token=None), 401)
    assert_problem(h.get("/overview", params={"date": "昨天"}), 422)


def test_overview_unknown_account_uses_default_timezone(h: Harness):
    body = h.get("/overview", params={"account_id": "acct_nobody"}).json()
    assert body["date"] == "2026-10-04" and body["needs_human"] == 0
