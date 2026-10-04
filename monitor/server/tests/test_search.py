"""搜索任务：创建（白名单、暂停、上限、间隔）、快照存储、三种结局、列表与详情。"""

from __future__ import annotations

import uuid

import pytest
from server_testkit import ACCOUNT, Harness, assert_problem, assert_shape, search_policy, vector

from app.commands import CommandCreateError
from app.db import FakeClock, SqliteStore, parse_time
from app.main import StaticTokenAuthenticator, create_app
from app.search import HARD_DAILY_CAP, MIN_INTERVAL_FLOOR_SECONDS


def allow(h: Harness, **overrides) -> dict:
    policy = search_policy(**overrides)
    h.ctx.search.policy_lookup = lambda account_id: policy if account_id == ACCOUNT else None
    return policy


def create(h: Harness, **body):
    payload = {"account_id": ACCOUNT, "query": "golang 后端", "max_results": 20, **body}
    return h.post("/search-runs", payload)


def snapshot_result(command: dict, name: str) -> dict:
    """把契约结果向量改成本次搜索的 command_id / search_id / result_ref。"""
    body = vector(name)
    search_id = command["payload"]["search_id"]
    body["command_id"] = command["command_id"]
    snap = body["output"]["snapshot"]
    snap["search_id"] = search_id
    snap["query"] = command["payload"]["query"]
    for item in snap["items"]:
        item["result_ref"] = f"{search_id}:item_{item['position']}"
    return body


def run_search(h: Harness, result_name: str) -> dict:
    """创建搜索 → 设备领取 → 回报结果向量，返回 GET 详情。"""
    device_id, token = h.ready_device()
    run = create(h).json()
    claimed = h.claim(device_id, token).json()["commands"]
    assert [c["command_id"] for c in claimed] == [run["command_id"]]
    body = snapshot_result(claimed[0], result_name)
    resp = h.post(f"/commands/{run['command_id']}/result", body, token=token)
    assert resp.status_code == 200, resp.text
    detail = h.get(f"/search-runs/{run['search_id']}")
    assert detail.status_code == 200
    assert_shape(detail.json(), "SearchRun")
    return detail.json()


# ---------------------------------------------------------------------------
# 创建
# ---------------------------------------------------------------------------


def test_create_search_run_generates_command(h: Harness):
    allow(h)
    resp = create(h)
    assert resp.status_code == 201, resp.text
    run = resp.json()
    assert_shape(run, "SearchRun")
    assert run["status"] == "pending" and run["outcome"] is None and run["snapshot"] is None
    cmd = h.ctx.commands.get(run["command_id"])
    assert cmd["command"]["action"] == "search_candidates"
    assert cmd["command"]["workflow_id"] is None
    assert cmd["command"]["target"] == {"scope": "current_page"}
    assert cmd["command"]["payload"] == {"search_id": run["search_id"], "query": "golang 后端", "max_results": 20}
    # 有效期默认 600 秒
    assert (parse_time(run["expires_at"]) - h.clock.now()).total_seconds() == 600
    assert parse_time(cmd["command"]["expires_at"]) == parse_time(run["expires_at"])


def test_create_search_run_custom_ttl_and_replay(h: Harness):
    allow(h)
    key = "search-key-0001"
    first = h.post("/search-runs", {"account_id": ACCOUNT, "query": "java", "max_results": 5, "ttl_seconds": 120}, key=key)
    again = h.post("/search-runs", {"account_id": ACCOUNT, "query": "java", "max_results": 5, "ttl_seconds": 120}, key=key)
    assert first.status_code == again.status_code == 201
    assert first.json() == again.json()  # 同键重放不新建任务与指令
    assert (parse_time(first.json()["expires_at"]) - h.clock.now()).total_seconds() == 120
    assert len(h.get("/search-runs").json()["items"]) == 1


@pytest.mark.parametrize(
    ("setup", "code"),
    [
        (lambda h: None, "action_not_allowed"),  # 没有策略：白名单默认全部关闭
        (lambda h: allow(h, allowed_actions=["send_greeting"]), "action_not_allowed"),
        (lambda h: allow(h, paused=True), "paused"),
    ],
)
def test_create_blocked_by_policy(h: Harness, setup, code: str):
    setup(h)
    body = assert_problem(create(h), 409, "policy_blocked")
    assert code in [e["code"] for e in body["errors"]]
    assert h.get("/search-runs").json()["items"] == []


def test_create_blocked_when_all_devices_paused(h: Harness):
    allow(h)
    device_id, _ = h.ready_device()
    assert h.post(f"/devices/{device_id}:pause", {"note": "午休"}).status_code == 200
    body = assert_problem(create(h), 409, "policy_blocked")
    assert [e["code"] for e in body["errors"]] == ["device_paused"]
    assert h.post(f"/devices/{device_id}:resume").status_code == 200
    assert create(h).status_code == 201


def test_daily_limit_and_min_interval(h: Harness):
    policy = allow(h)
    policy["daily_limits"]["search_candidates"] = 2
    policy["min_interval_seconds"]["search_candidates"] = 60
    assert create(h).status_code == 201
    body = assert_problem(create(h), 409, "policy_blocked")  # 间隔不足
    assert [e["code"] for e in body["errors"]] == ["rate_limited"]
    h.clock.advance(60)
    assert create(h).status_code == 201
    h.clock.advance(60)
    body = assert_problem(create(h), 409, "policy_blocked")
    assert [e["code"] for e in body["errors"]] == ["daily_limit_reached"]
    h.clock.advance(24 * 3600)  # 第二天（策略时区）重新计数
    assert create(h).status_code == 201


def test_server_limits_never_looser_than_monitor_floor(h: Harness):
    """策略只能更严：间隔低于下限按下限，上限高于硬上限按硬上限。"""
    policy = allow(h)
    policy["daily_limits"]["search_candidates"] = 1000
    policy["min_interval_seconds"]["search_candidates"] = 1
    policy["work_hours"]["timezone"] = "UTC"
    assert create(h).status_code == 201
    h.clock.advance(MIN_INTERVAL_FLOOR_SECONDS - 1)
    assert [e["code"] for e in create(h).json()["errors"]] == ["rate_limited"]
    for _ in range(HARD_DAILY_CAP - 1):
        h.clock.advance(MIN_INTERVAL_FLOOR_SECONDS)
        assert create(h).status_code == 201
    h.clock.advance(MIN_INTERVAL_FLOOR_SECONDS)
    assert [e["code"] for e in create(h).json()["errors"]] == ["daily_limit_reached"]


@pytest.mark.parametrize(
    "body",
    [
        {"query": ""},
        {"query": "x" * 101},
        {"max_results": 0},
        {"max_results": 101},
        {"ttl_seconds": 59},
        {"ttl_seconds": 3601},
        {"extra": 1},
        {"account_id": ""},
    ],
)
def test_create_validation(h: Harness, body: dict):
    allow(h)
    assert_problem(create(h, **body), 422, "validation_failed")


def test_create_requires_console_and_key(h: Harness):
    allow(h)
    body = {"account_id": ACCOUNT, "query": "go", "max_results": 1}
    assert_problem(h.post("/search-runs", body, token=None), 401)
    assert_problem(h.post("/search-runs", body, token="service-token-mail"), 401)
    assert_problem(h.post("/search-runs", body, key=None), 422)


# ---------------------------------------------------------------------------
# 快照与三种结局
# ---------------------------------------------------------------------------


def test_outcome_results_keeps_card_shape(h: Harness):
    allow(h)
    run = run_search(h, "result_search_complete")
    assert run["status"] == "completed" and run["outcome"] == "results"
    items = run["snapshot"]["items"]
    assert [i["masked_name"] for i in items] == ["王**", "李**"]
    assert items[0]["fields"][5] == {"label": "期望", "text": "北京 · Go 开发 · 25-35K"}
    assert items[0]["prop_card_texts"] == ["使用道具查看"] and items[1]["prop_card_texts"] == []
    assert "display_name" not in items[0] and "stable_candidate_id" not in items[0]


def test_outcome_no_results(h: Harness):
    allow(h)
    run = run_search(h, "result_search_empty_confirmed")
    assert run["status"] == "completed" and run["outcome"] == "no_results"
    assert run["snapshot"]["coverage"] == "empty_confirmed" and run["snapshot"]["items"] == []


def test_outcome_unreadable_is_not_empty_result(h: Harness):
    allow(h)
    run = run_search(h, "result_search_unreadable")
    # 读不出不是"没有结果"：status=failed、outcome=unreadable，与 no_results 分开
    assert run["status"] == "failed" and run["outcome"] == "unreadable"
    assert run["snapshot"]["coverage"] == "unreadable" and run["snapshot"]["unreadable_reason"] == "results_are_image"


def test_failed_without_snapshot_has_no_outcome(h: Harness):
    allow(h)
    device_id, token = h.ready_device()
    run = create(h).json()
    claimed = h.claim(device_id, token).json()["commands"]
    body = h.result_body(claimed[0], "failed")  # target_not_found，没有快照
    body["output"] = None
    assert h.post(f"/commands/{run['command_id']}/result", body, token=token).status_code == 200
    detail = h.get(f"/search-runs/{run['search_id']}").json()
    assert detail["status"] == "failed" and detail["outcome"] is None and detail["snapshot"] is None


def test_snapshot_for_other_search_is_not_stored(h: Harness):
    allow(h)
    run = create(h).json()
    result = vector("result_search_complete")  # search_id = s_42，不是本任务
    assert h.ctx.search.store_snapshot(run["command_id"], result) is None
    assert h.ctx.search.store_snapshot(str(uuid.uuid4()), result) is None  # 不是搜索任务的指令
    assert h.ctx.search.store_snapshot(run["command_id"], None) is None
    assert h.get(f"/search-runs/{run['search_id']}").json()["snapshot"] is None


def test_status_follows_command_and_expiry(h: Harness):
    allow(h)
    device_id, token = h.ready_device()
    run = create(h, ttl_seconds=60).json()
    h.claim(device_id, token)
    assert h.get(f"/search-runs/{run['search_id']}").json()["status"] == "running"
    other = create(h, ttl_seconds=60)
    assert other.status_code == 409  # 间隔不足
    h.clock.advance(60)  # 策略间隔 60 秒
    pending = create(h, ttl_seconds=60).json()
    h.clock.advance(61)
    assert h.get(f"/search-runs/{pending['search_id']}").json()["status"] == "expired"


def test_cancelled_search(h: Harness):
    allow(h)
    run = create(h).json()
    assert h.post(f"/commands/{run['command_id']}:cancel", {"note": "不搜了"}).status_code == 200
    assert h.get(f"/search-runs/{run['search_id']}").json()["status"] == "cancelled"


def test_search_result_cannot_be_command_target(h: Harness):
    """搜索结果不能作为问候目标：会话目标里带 result_ref 会被契约拒绝。"""
    cmd = h.command(action="send_greeting")
    cmd["target"]["result_ref"] = "s_42:item_1"
    with pytest.raises(CommandCreateError) as exc:
        h.ctx.commands.create_command(cmd)
    assert exc.value.code == "validation_failed"


# ---------------------------------------------------------------------------
# 列表与详情
# ---------------------------------------------------------------------------


def test_list_filter_and_paging(h: Harness):
    allow(h)
    other = search_policy("acct_other")
    policies = {ACCOUNT: search_policy(), "acct_other": other}
    h.ctx.search.policy_lookup = policies.get
    ids = []
    for _ in range(3):
        ids.append(create(h).json()["search_id"])
        h.clock.advance(MIN_INTERVAL_FLOOR_SECONDS * 2)
    assert h.post("/search-runs", {"account_id": "acct_other", "query": "x", "max_results": 1}).status_code == 201
    page1 = h.get("/search-runs", params={"account_id": ACCOUNT, "limit": 2}).json()
    assert [r["search_id"] for r in page1["items"]] == ids[::-1][:2]
    page2 = h.get("/search-runs", params={"account_id": ACCOUNT, "limit": 2, "cursor": page1["next_cursor"]}).json()
    assert [r["search_id"] for r in page2["items"]] == [ids[0]] and page2["next_cursor"] is None
    assert len(h.get("/search-runs").json()["items"]) == 4
    assert_problem(h.get("/search-runs", params={"cursor": "abc"}), 422)
    assert_problem(h.get("/search-runs", params={"limit": 0}), 422)
    assert_problem(h.get("/search-runs", token=None), 401)


def test_get_search_run_errors(h: Harness):
    assert_problem(h.get("/search-runs/s_missing"), 404, "not_found")
    assert_problem(h.get("/search-runs/bad%20id"), 422)
    assert_problem(h.get("/search-runs/s_x", token=None), 401)


def test_create_app_wires_policy_lookup():
    policy = search_policy()
    app = create_app(
        store=SqliteStore(),
        clock=FakeClock(),
        console_auth=StaticTokenAuthenticator({"t": "bob"}),
        policy_lookup=lambda account_id: policy,
    )
    assert app.state.ctx.search.policy_lookup(ACCOUNT) is policy
    assert app.state.ctx.search.blocked_reasons(ACCOUNT, app.state.ctx.clock.now()) == []
