"""策略：GET/PUT（If-Match 乐观锁、412）、硬上限校验、判定函数（工作时段、岗位范围、限额）。"""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any

import pytest
from server_testkit import (
    ACCOUNT,
    API,
    CONSOLE_TOKEN,
    Harness,
    assert_problem,
    auto_policy,
    observe,
    policy_body,
    set_policy,
)

from app.policy import (
    HARD_DAILY_CAPS,
    MIN_INTERVAL_FLOORS,
    default_policy,
    effective_daily_limit,
    in_work_hours,
    job_in_scope,
    local_day_bounds,
    normalize_if_match,
    policy_errors,
    render_greeting,
)

pytestmark = pytest.mark.usefixtures("no_subscriber_errors")

NOW = datetime(2026, 10, 4, 1, 30, tzinfo=UTC)  # 上海 09:30，周日


def put(h: Harness, body: dict[str, Any], if_match: str | None, *, account_id: str = ACCOUNT, key: str | None = None):
    headers = {**h.auth(CONSOLE_TOKEN), "Idempotency-Key": key or h.key()}
    if if_match is not None:
        headers["If-Match"] = if_match
    return h.client.put(f"{API}/accounts/{account_id}/policy", json=body, headers=headers)


# ---------------------------------------------------------------------------
# GET
# ---------------------------------------------------------------------------


def test_default_policy_for_bound_account_is_all_off(h: Harness):
    h.ready_device()
    resp = h.get(f"/accounts/{ACCOUNT}/policy")
    assert resp.status_code == 200
    body = resp.json()
    assert resp.headers["ETag"] == "1" and body["policy_version"] == 1
    assert body["allowed_actions"] == [] and body["after_resume_received"]["action"] == "none"
    assert body["daily_limits"] == dict(HARD_DAILY_CAPS)
    assert body["company_mailbox"] == "zhaopin@remotedesk.io"
    assert policy_errors(body) == []


def test_get_policy_errors(h: Harness):
    assert_problem(h.get("/accounts/acct_unknown/policy"), 404, "not_found")
    assert_problem(h.get(f"/accounts/{ACCOUNT}/policy", token=None), 401)
    assert_problem(h.get(f"/accounts/{ACCOUNT}/policy", token="bogus"), 401)


def test_device_reads_only_its_bound_account(h: Harness):
    device_id, token = h.ready_device()
    assert h.get(f"/accounts/{ACCOUNT}/policy", token=token).status_code == 200
    other_device, other_token = h.ready_device("acct_other")
    assert_problem(h.get(f"/accounts/{ACCOUNT}/policy", token=other_token), 404)
    h.post(f"/devices/{device_id}:revoke")
    assert_problem(h.get(f"/accounts/{ACCOUNT}/policy", token=token), 401)


def test_heartbeat_reports_policy_version(h: Harness):
    device_id, token = h.ready_device()
    assert h.heartbeat(device_id, token).json()["policy_version"] == 1
    set_policy(h, paused=True)
    assert h.heartbeat(device_id, token).json()["policy_version"] == 2


# ---------------------------------------------------------------------------
# PUT
# ---------------------------------------------------------------------------


def test_put_increments_version_and_overrides_server_fields(h: Harness):
    h.ready_device()
    body = policy_body(h)
    body.update(
        allowed_actions=["send_greeting"],
        company_mailbox="evil@example.com",
        updated_by="mallory",
        policy_version=99,
    )
    h.clock.advance(60)
    resp = put(h, body, "1")
    assert resp.status_code == 200, resp.text
    saved = resp.json()
    assert resp.headers["ETag"] == "2"
    assert saved["policy_version"] == 2 and saved["updated_by"] == "alice"
    assert saved["company_mailbox"] == "zhaopin@remotedesk.io"
    assert saved["updated_at"] == "2026-10-04T01:31:00Z"
    assert saved["allowed_actions"] == ["send_greeting"]
    assert policy_body(h) == saved


def test_put_accepts_quoted_etag(h: Harness):
    h.ready_device()
    assert put(h, policy_body(h), '"1"').status_code == 200
    assert put(h, policy_body(h), 'W/"2"').status_code == 200


def test_put_stale_if_match_returns_412(h: Harness):
    h.ready_device()
    body = policy_body(h)
    assert put(h, body, "1").status_code == 200
    problem = assert_problem(put(h, body, "1"), 412, "policy_version_mismatch")
    assert problem["existing"]["policy_version"] == 2


def test_put_missing_if_match_is_422(h: Harness):
    h.ready_device()
    assert_problem(put(h, policy_body(h), None), 422)


@pytest.mark.parametrize(
    ("path", "value", "code"),
    [
        ("daily_limits.send_greeting", 41, "exceeds_hard_limit"),
        ("daily_limits.request_contact_exchange", 100, "exceeds_hard_limit"),
        ("min_interval_seconds.request_resume", 10, "below_floor"),
        ("min_interval_seconds.request_contact_exchange", 59, "below_floor"),
        ("work_hours.timezone", "Mars/Olympus", "invalid_timezone"),
    ],
)
def test_put_rejects_looser_than_local_limits(h: Harness, path: str, value: Any, code: str):
    h.ready_device()
    body = policy_body(h)
    section, name = path.split(".")
    body[section][name] = value
    problem = assert_problem(put(h, body, "1"), 422, "validation_failed")
    assert [(e["path"], e["code"]) for e in problem["errors"]] == [(path, code)]
    assert policy_body(h)["policy_version"] == 1  # 没有保存


@pytest.mark.parametrize(
    "mutate",
    [
        lambda b: b["after_resume_received"].update(action="request_contact_exchange"),
        lambda b: b.update(pause_on_anomaly=False),
        lambda b: b.update(extra_field=1),
        lambda b: b["work_hours"]["windows"].append({"days": [1], "start": "18:00", "end": "09:00"}),
        lambda b: b.update(account_id="acct_other"),
    ],
)
def test_put_rejects_invalid_policy(h: Harness, mutate):
    h.ready_device()
    body = policy_body(h)
    mutate(body)
    assert_problem(put(h, body, "1"), 422, "validation_failed")


def test_put_errors_auth_and_unknown_account(h: Harness):
    h.ready_device()
    body = policy_body(h)
    assert_problem(put(h, {**body, "account_id": "acct_x"}, "1", account_id="acct_x"), 404)
    resp = h.client.put(
        f"{API}/accounts/{ACCOUNT}/policy", json=body, headers={"If-Match": "1", "Idempotency-Key": h.key()}
    )
    assert_problem(resp, 401)


def test_put_idempotent_replay(h: Harness):
    h.ready_device()
    body = policy_body(h)
    first = put(h, body, "1", key="policy-save-1")
    again = put(h, body, "1", key="policy-save-1")
    assert first.status_code == again.status_code == 200
    assert first.json() == again.json() and again.headers["ETag"] == "2"
    assert policy_body(h)["policy_version"] == 2


# ---------------------------------------------------------------------------
# 纯函数
# ---------------------------------------------------------------------------


def base() -> dict[str, Any]:
    return default_policy(ACCOUNT, NOW, "zhaopin@remotedesk.io")


def test_hard_limits_match_monitor_client():
    limits = pytest.importorskip("monitor.core.limits")
    assert dict(HARD_DAILY_CAPS) == dict(limits.HARD_DAILY_CAPS)
    assert dict(MIN_INTERVAL_FLOORS) == dict(limits.MIN_INTERVAL_FLOORS)


def test_in_work_hours():
    p = base()  # 周一至周五 09:00–18:00（上海）
    assert not in_work_hours(p, NOW)  # 周日
    monday = datetime(2026, 10, 5, 1, 0, tzinfo=UTC)  # 周一 09:00
    assert in_work_hours(p, monday)
    assert not in_work_hours(p, datetime(2026, 10, 5, 0, 59, tzinfo=UTC))  # 08:59
    assert not in_work_hours(p, datetime(2026, 10, 5, 10, 0, tzinfo=UTC))  # 18:00 不含
    p["work_hours"]["windows"] = []
    assert not in_work_hours(p, monday)
    p["work_hours"] = {"timezone": "UTC", "windows": [{"days": [7], "start": "01:00", "end": "02:00"}]}
    assert in_work_hours(p, NOW)


def test_job_in_scope():
    p = base()
    assert job_in_scope(p, "任何岗位")
    p["job_scope"] = {"mode": "listed", "job_titles": ["后端工程师"]}
    assert job_in_scope(p, " 后端工程师 ")
    assert not job_in_scope(p, "前端工程师")


def test_render_greeting_only_known_placeholders():
    assert render_greeting("{candidate_name}好，{job_title}；{other}", "张三", "后端") == "张三好，后端；{other}"
    assert render_greeting("你好", "张三", "后端") == "你好"


def test_effective_daily_limit_and_day_bounds():
    p = base()
    p["daily_limits"]["send_greeting"] = 5
    assert effective_daily_limit(p, "send_greeting") == 5
    p["daily_limits"]["send_greeting"] = 1000  # 只可能来自旧数据；判定时仍按硬上限
    assert effective_daily_limit(p, "send_greeting") == 40
    start, end = local_day_bounds(p, date(2026, 10, 4))
    assert start == datetime(2026, 10, 3, 16, 0, tzinfo=UTC) and end == datetime(2026, 10, 4, 16, 0, tzinfo=UTC)


def test_normalize_if_match():
    assert normalize_if_match(' W/"3" ') == "3"
    assert normalize_if_match("3") == "3"


def test_policy_errors_valid_and_invalid():
    assert policy_errors(base()) == []
    assert policy_errors({"account_id": ACCOUNT})  # 契约层错误
    bad = base()
    bad["daily_limits"]["search_candidates"] = 41
    assert [e["code"] for e in policy_errors(bad)] == ["exceeds_hard_limit"]


def test_gate_reasons(h: Harness):
    device_id, token = h.ready_device()
    svc = h.ctx.policies
    p = auto_policy(h)
    assert svc.gate(p, "send_greeting").allowed
    assert svc.gate({**p, "allowed_actions": []}, "send_greeting").reason == "not_allowed"
    assert svc.gate({**p, "paused": True}, "send_greeting").reason == "paused"
    off_hours = {**p, "work_hours": {"timezone": "Asia/Shanghai", "windows": []}}
    assert svc.gate(off_hours, "send_greeting").reason == "outside_work_hours"
    capped = {**p, "daily_limits": {**p["daily_limits"], "send_greeting": 1}}
    observe(h, device_id, token)  # 生成一条问候
    assert svc.gate(capped, "send_greeting").reason == "daily_limit_reached"
    assert svc.gate(capped, "request_resume").allowed
    with pytest.raises(ValueError):
        svc.gate(p, "provide_input")
    h.post(f"/devices/{device_id}:pause", {"note": "x"})
    assert svc.gate(p, "send_greeting").reason == "devices_paused"


def test_version_none_for_unknown_account(h: Harness):
    assert h.ctx.policies.version("acct_nobody") is None
