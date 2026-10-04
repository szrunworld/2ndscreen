"""指令队列：创建、领取（账户/依赖/有效期/原子/租约/长轮询）、ack、结果幂等、取消、查询。"""

from __future__ import annotations

import threading
import time
import uuid

import pytest
from server_testkit import ACCOUNT, SERVICE_TOKEN, Harness, assert_problem, assert_shape, iso

from app.commands import CommandCreateError, CommandNotifier
from app.events import CommandResultRecorded
from app.main import Settings


def claimed_ids(resp) -> list[str]:
    assert resp.status_code == 200, resp.text
    assert_shape(resp.json(), "ClaimResponse")
    return [c["command_id"] for c in resp.json()["commands"]]


def wait_until(predicate, timeout: float = 5.0) -> None:
    """轮询等待状态成立（以状态为准，不用固定 sleep 代替）。"""
    deadline = time.monotonic() + timeout
    tick = threading.Event()
    while not predicate():
        assert time.monotonic() < deadline, "等待的状态没有出现"
        tick.wait(0.005)


# ---------------------------------------------------------------------------
# 创建（Python 接口，供 F2/F3）
# ---------------------------------------------------------------------------


def test_create_command_returns_record(h: Harness):
    record = h.create()
    assert_shape(record, "CommandRecord")
    assert record["server_status"] == "pending"
    assert record["case_id"] == "case_001"  # 默认取 workflow_id
    assert record["result"] is None and record["manual_actions"] == []


def test_create_command_is_idempotent_by_command_id(h: Harness):
    command = h.command()
    first = h.ctx.commands.create_command(command)
    again = h.ctx.commands.create_command(command)
    assert first == again
    changed = dict(command, payload={"text": "另一段问候"})
    with pytest.raises(CommandCreateError) as exc:
        h.ctx.commands.create_command(changed)
    assert exc.value.code == "command_conflict"


def test_create_command_rejects_invalid_and_unknown_dependency(h: Harness):
    bad = h.command()
    bad["payload"] = {}
    with pytest.raises(CommandCreateError) as exc:
        h.ctx.commands.create_command(bad)
    assert exc.value.code == "validation_failed" and "payload.text" in [e.path for e in exc.value.errors]
    with pytest.raises(CommandCreateError) as exc:
        h.ctx.commands.create_command(h.command(depends_on=str(uuid.uuid4())))
    assert exc.value.code == "dependency_not_found"
    other = h.create(account_id="acct_other")
    with pytest.raises(CommandCreateError):
        h.ctx.commands.create_command(h.command(depends_on=other["command"]["command_id"]))


# ---------------------------------------------------------------------------
# 领取
# ---------------------------------------------------------------------------


def test_claim_returns_command_and_leases_it(h: Harness):
    device_id, token = h.ready_device()
    cid = h.create()["command"]["command_id"]
    resp = h.claim(device_id, token)
    assert claimed_ids(resp) == [cid]
    assert resp.json()["lease_seconds"] == Settings().lease_seconds
    record = h.get(f"/commands/{cid}").json()
    assert record["server_status"] == "claimed" and record["device_id"] == device_id
    assert record["claimed_at"] == "2026-10-04T01:30:00Z"
    # 已在租约中，不会再交给任何设备
    assert claimed_ids(h.claim(device_id, token)) == []


def test_claim_respects_max_commands_and_order(h: Harness):
    device_id, token = h.ready_device()
    ids = [h.create()["command"]["command_id"] for _ in range(3)]
    assert claimed_ids(h.claim(device_id, token, max_commands=2)) == ids[:2]
    assert claimed_ids(h.claim(device_id, token, max_commands=2)) == ids[2:]


def test_claim_only_for_bound_account(h: Harness):
    device_id, token = h.ready_device(ACCOUNT)
    h.create(account_id="acct_other")
    # 请求别的账户：绑定不符，返回空
    assert claimed_ids(h.claim(device_id, token, "acct_other")) == []
    assert claimed_ids(h.claim(device_id, token, ACCOUNT)) == []


def test_claim_empty_until_binding_confirmed_and_heartbeat_matches(h: Harness):
    device_id, token = h.register()
    h.create()
    h.heartbeat(device_id, token)
    assert claimed_ids(h.claim(device_id, token)) == []  # 未确认绑定
    h.bind(device_id)
    h.heartbeat(device_id, token, account_id="acct_switched")
    assert claimed_ids(h.claim(device_id, token)) == []  # 心跳账户与绑定不一致
    h.heartbeat(device_id, token)
    assert len(claimed_ids(h.claim(device_id, token))) == 1


def test_claim_empty_without_any_heartbeat(h: Harness):
    device_id, token = h.register()
    h.bind(device_id)
    h.create()
    assert claimed_ids(h.claim(device_id, token)) == []


def test_claim_empty_when_paused_or_needs_baseline(h: Harness):
    device_id, token = h.ready_device()
    h.create()
    h.post(f"/devices/{device_id}:pause")
    assert claimed_ids(h.claim(device_id, token)) == []
    h.post(f"/devices/{device_id}:resume")
    h.heartbeat(device_id, token, needs_baseline=True)
    assert claimed_ids(h.claim(device_id, token)) == []
    h.heartbeat(device_id, token, needs_baseline=False)
    assert len(claimed_ids(h.claim(device_id, token))) == 1


def test_expired_command_is_not_claimed_and_marked_expired(h: Harness):
    device_id, token = h.ready_device()
    cid = h.create(expires_in=60)["command"]["command_id"]
    h.clock.advance(60)
    h.heartbeat(device_id, token)
    assert claimed_ids(h.claim(device_id, token)) == []
    assert h.get(f"/commands/{cid}").json()["server_status"] == "expired"


def test_dependency_must_succeed_before_claim(h: Harness):
    device_id, token = h.ready_device()
    first = h.create()["command"]
    second = h.create(action="request_resume", depends_on=first["command_id"])["command"]
    assert claimed_ids(h.claim(device_id, token, max_commands=5)) == [first["command_id"]]
    assert claimed_ids(h.claim(device_id, token, max_commands=5)) == []  # 依赖还没 succeeded
    assert h.report(first, token).status_code == 200
    assert claimed_ids(h.claim(device_id, token, max_commands=5)) == [second["command_id"]]


@pytest.mark.parametrize("status", ["failed", "unknown"])
def test_dependency_not_succeeded_blocks_dependent(h: Harness, status: str):
    device_id, token = h.ready_device()
    first = h.create()["command"]
    h.create(action="request_resume", depends_on=first["command_id"])
    claimed_ids(h.claim(device_id, token))
    assert h.report(first, token, status).status_code == 200
    assert claimed_ids(h.claim(device_id, token, max_commands=5)) == []


def test_command_targeted_at_device(h: Harness):
    a_id, a_token = h.ready_device()
    b_id, b_token = h.ready_device()
    cid = h.create(device_id=b_id)["command"]["command_id"]
    assert claimed_ids(h.claim(a_id, a_token)) == []
    assert claimed_ids(h.claim(b_id, b_token)) == [cid]


def test_concurrent_claims_succeed_only_once(h: Harness):
    devices = [h.ready_device() for _ in range(6)]
    cid = h.create()["command"]["command_id"]
    barrier = threading.Barrier(len(devices) * 2)
    results: list[list[str]] = []
    lock = threading.Lock()

    def worker(device_id: str, token: str) -> None:
        barrier.wait()
        ids = claimed_ids(h.claim(device_id, token))
        with lock:
            results.append(ids)

    # 每台设备两个并发请求（不同幂等键），共 12 个
    threads = [threading.Thread(target=worker, args=d) for d in devices for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert len(results) == 12
    winners = [ids for ids in results if ids]
    assert winners == [[cid]]


def test_lease_expiry_allows_reclaim_with_same_command_id(h: Harness):
    a_id, a_token = h.ready_device()
    b_id, b_token = h.ready_device()
    cid = h.create()["command"]["command_id"]
    assert claimed_ids(h.claim(a_id, a_token)) == [cid]
    h.clock.advance(Settings().lease_seconds)
    h.heartbeat(b_id, b_token)
    assert claimed_ids(h.claim(b_id, b_token)) == [cid]
    # A 迟到的 ack 不能把别人领走的指令抢回来
    assert_problem(h.ack(cid, a_id, a_token), 409, "command_not_owned")


def test_acked_command_is_not_reclaimed_after_lease(h: Harness):
    a_id, a_token = h.ready_device()
    b_id, b_token = h.ready_device()
    cid = h.create()["command"]["command_id"]
    claimed_ids(h.claim(a_id, a_token))
    assert h.ack(cid, a_id, a_token).status_code == 200
    h.clock.advance(Settings().lease_seconds * 10)
    h.heartbeat(b_id, b_token)
    assert claimed_ids(h.claim(b_id, b_token)) == []


def test_claim_replay_with_same_key_returns_same_batch(h: Harness):
    device_id, token = h.ready_device()
    cid = h.create()["command"]["command_id"]
    first = h.claim(device_id, token, key="claim:attempt-1")
    again = h.claim(device_id, token, key="claim:attempt-1")
    assert claimed_ids(first) == claimed_ids(again) == [cid]
    assert first.json() == again.json()


def test_claim_errors(h: Harness):
    a_id, a_token = h.ready_device()
    b_id, _ = h.ready_device()
    assert_problem(h.claim(b_id, a_token), 403, "device_mismatch")
    assert_problem(h.claim(a_id, None), 401)
    assert_problem(h.claim(a_id, a_token, wait_seconds=31), 422)
    body = {"account_id": ACCOUNT, "max_commands": 1, "wait_seconds": 0, "extra": True}
    problem = assert_problem(h.post(f"/devices/{a_id}/commands:claim", body, token=a_token), 422)
    assert problem["errors"][0]["path"] == "extra"


def test_long_poll_wakes_up_when_command_created(h: Harness):
    device_id, token = h.ready_device()
    out: dict[str, list[str]] = {}

    def poll() -> None:
        out["ids"] = claimed_ids(h.claim(device_id, token, wait_seconds=20))

    t = threading.Thread(target=poll)
    t.start()
    wait_until(lambda: h.ctx.notifier.waiting >= 1)
    cid = h.create()["command"]["command_id"]
    t.join(10)
    assert not t.is_alive()
    assert out["ids"] == [cid]


def test_long_poll_returns_empty_after_wait(h: Harness):
    device_id, token = h.ready_device()
    assert claimed_ids(h.claim(device_id, token, wait_seconds=1)) == []


def test_notifier_wait_times_out_and_wakes():
    n = CommandNotifier()
    assert n.wait(n.generation, 0.01) is False
    since = n.generation
    n.notify()
    assert n.wait(since, 5) is True


# ---------------------------------------------------------------------------
# ack
# ---------------------------------------------------------------------------


def test_ack_marks_acked_and_is_repeatable(h: Harness):
    device_id, token = h.ready_device()
    cid = h.create()["command"]["command_id"]
    claimed_ids(h.claim(device_id, token))
    resp = h.ack(cid, device_id, token)
    assert resp.status_code == 200
    assert_shape(resp.json(), "CommandRecord")
    assert resp.json()["server_status"] == "acked" and resp.json()["acked_at"] == "2026-10-04T01:30:00Z"
    h.clock.advance(5)
    again = h.ack(cid, device_id, token, ledger_state="running")
    assert again.status_code == 200 and again.json()["acked_at"] == "2026-10-04T01:30:00Z"


def test_ack_after_own_lease_expired_still_accepted(h: Harness):
    device_id, token = h.ready_device()
    cid = h.create()["command"]["command_id"]
    claimed_ids(h.claim(device_id, token))
    h.clock.advance(Settings().lease_seconds + 1)
    h.heartbeat(device_id, token)
    claimed_ids(h.claim(device_id, token))  # 触发租约归还；同一设备重新领到同一条
    assert h.ack(cid, device_id, token).json()["server_status"] == "acked"


def test_ack_errors(h: Harness):
    a_id, a_token = h.ready_device()
    b_id, b_token = h.ready_device()
    cid = h.create()["command"]["command_id"]
    assert_problem(h.ack(str(uuid.uuid4()), a_id, a_token), 404)
    assert_problem(h.ack(cid, a_id, a_token), 409)  # 还没被领取
    claimed_ids(h.claim(a_id, a_token))
    assert_problem(h.ack(cid, b_id, b_token), 409, "command_not_owned")
    assert_problem(h.ack(cid, b_id, a_token), 403, "device_mismatch")  # 请求体 device_id 与令牌不符
    assert_problem(h.ack(cid, a_id, None), 401)
    assert_problem(h.ack(cid, a_id, a_token, ledger_state="bogus"), 422)


# ---------------------------------------------------------------------------
# 结果回报
# ---------------------------------------------------------------------------


def _claimed(h: Harness) -> tuple[str, str, dict]:
    device_id, token = h.ready_device()
    command = h.create()["command"]
    claimed_ids(h.claim(device_id, token))
    h.ack(command["command_id"], device_id, token)
    return device_id, token, command


def test_report_result_records_and_publishes(h: Harness):
    _, token, command = _claimed(h)
    resp = h.report(command, token)
    assert resp.status_code == 200
    assert_shape(resp.json(), "ResultAccepted")
    assert resp.json()["duplicate"] is False
    record = h.get(f"/commands/{command['command_id']}").json()
    assert record["server_status"] == "succeeded" and record["result"]["status"] == "succeeded"
    published = [m for m in h.messages if isinstance(m, CommandResultRecorded)]
    assert len(published) == 1 and published[0].status == "succeeded" and published[0].case_id == "case_001"
    assert_shape(published[0].record, "CommandRecord")


def test_duplicate_result_returns_first(h: Harness):
    _, token, command = _claimed(h)
    body = h.result_body(command)
    first = h.post(f"/commands/{command['command_id']}/result", body, token=token)
    # 换一个幂等键重发同样的结果：业务层按 command_id 幂等
    again = h.post(f"/commands/{command['command_id']}/result", body, token=token)
    assert again.status_code == 200 and again.json()["duplicate"] is True
    assert again.json()["recorded_result"] == first.json()["recorded_result"]
    # 同一个幂等键重放：原样返回首次响应
    key = "result:" + command["command_id"]
    h2_first = h.post(f"/commands/{command['command_id']}/result", body, token=token, key=key)
    h2_again = h.post(f"/commands/{command['command_id']}/result", body, token=token, key=key)
    assert h2_first.json() == h2_again.json()
    assert len([m for m in h.messages if isinstance(m, CommandResultRecorded)]) == 1


def test_duplicate_result_equivalent_after_normalisation(h: Harness):
    _, token, command = _claimed(h)
    body = h.result_body(command)
    h.post(f"/commands/{command['command_id']}/result", body, token=token)
    same = dict(body, command_id=command["command_id"].upper(), execution_mode="execute")
    resp = h.post(f"/commands/{command['command_id']}/result", same, token=token)
    assert resp.status_code == 200 and resp.json()["duplicate"] is True


def test_conflicting_result_returns_409_with_existing(h: Harness):
    _, token, command = _claimed(h)
    h.report(command, token)
    problem = assert_problem(h.report(command, token, "failed"), 409, "result_conflict")
    assert problem["existing"]["status"] == "succeeded"


def test_report_result_errors(h: Harness):
    device_id, token, command = _claimed(h)
    other = h.create()["command"]
    cid = command["command_id"]
    # 路径与请求体不一致
    body = h.result_body(other)
    problem = assert_problem(h.post(f"/commands/{cid}/result", body, token=token), 422)
    assert problem["errors"][0]["path"] == "command_id"
    # 契约校验失败（succeeded 不能带 reason）
    problem = assert_problem(h.report(command, token, reason="timeout"), 422, "validation_failed")
    assert "reason" in [e["path"] for e in problem["errors"]]
    # 动作与指令不一致
    problem = assert_problem(h.report(command, token, action="request_resume"), 422)
    assert problem["errors"][0]["path"] == "action"
    # 不存在 / 未被该设备领取 / 未认证
    missing = dict(command, command_id=str(uuid.uuid4()))
    assert_problem(h.report(missing, token), 404)
    assert_problem(h.report(other, token), 409, "command_not_owned")
    b_id, b_token = h.ready_device()
    assert_problem(h.report(command, b_token), 409, "command_not_owned")
    assert_problem(h.report(command, None), 401)


def test_result_from_device_overrides_server_side_expiry(h: Harness):
    """被领取过的指令以设备回报为准（例如租约过期后设备仍回报了实际结果）。"""
    device_id, token = h.ready_device()
    command = h.create(expires_in=30)["command"]
    claimed_ids(h.claim(device_id, token))
    h.clock.advance(120)
    h.heartbeat(device_id, token)
    claimed_ids(h.claim(device_id, token))
    resp = h.report(command, token, "unknown")
    assert resp.status_code == 200
    assert h.get(f"/commands/{command['command_id']}").json()["server_status"] == "unknown"


# ---------------------------------------------------------------------------
# 取消
# ---------------------------------------------------------------------------


def test_cancel_pending_command(h: Harness):
    device_id, token = h.ready_device()
    cid = h.create()["command"]["command_id"]
    resp = h.post(f"/commands/{cid}:cancel", {"note": "候选人已入职"})
    assert resp.status_code == 200
    record = resp.json()
    assert_shape(record, "CommandRecord")
    assert record["server_status"] == "cancelled" and record["cancel_requested"] is True
    assert record["manual_actions"][0]["type"] == "cancel_command"
    assert record["manual_actions"][0]["actor"] == "alice"
    assert record["manual_actions"][0]["note"] == "候选人已入职"
    assert claimed_ids(h.claim(device_id, token)) == []
    # 再次取消：返回当前记录，不重复记人工处理
    again = h.post(f"/commands/{cid}:cancel")
    assert again.status_code == 200 and len(again.json()["manual_actions"]) == 1


def test_cancel_claimed_command_notifies_device(h: Harness):
    device_id, token, command = _claimed(h)
    cid = command["command_id"]
    resp = h.post(f"/commands/{cid}:cancel")
    assert resp.json()["server_status"] == "acked" and resp.json()["cancel_requested"] is True
    assert h.heartbeat(device_id, token).json()["cancellations"] == [cid]
    assert h.claim(device_id, token).json()["cancellations"] == [cid]
    assert h.report(command, token, "cancelled").status_code == 200
    assert h.get(f"/commands/{cid}").json()["server_status"] == "cancelled"
    assert h.heartbeat(device_id, token).json()["cancellations"] == []


def test_cancel_after_action_happened_keeps_device_result(h: Harness):
    device_id, token, command = _claimed(h)
    h.post(f"/commands/{command['command_id']}:cancel")
    assert h.report(command, token, "succeeded").status_code == 200  # 动作已经发生：回报实际结果
    assert h.get(f"/commands/{command['command_id']}").json()["server_status"] == "succeeded"


def test_cancel_errors(h: Harness):
    _, token, command = _claimed(h)
    h.report(command, token)
    assert_problem(h.post(f"/commands/{command['command_id']}:cancel"), 409, "command_final")
    assert_problem(h.post(f"/commands/{uuid.uuid4()}:cancel"), 404)
    assert_problem(h.post(f"/commands/{command['command_id']}:cancel", token=None), 401)
    assert_problem(h.post(f"/commands/{command['command_id']}:cancel", {"note": 1}), 422)


def test_cancel_expired_command_is_final(h: Harness):
    device_id, token = h.ready_device()
    cid = h.create(expires_in=10)["command"]["command_id"]
    h.clock.advance(11)
    h.heartbeat(device_id, token)
    h.claim(device_id, token)
    assert_problem(h.post(f"/commands/{cid}:cancel"), 409)


# ---------------------------------------------------------------------------
# 查询
# ---------------------------------------------------------------------------


def test_list_commands_filters_and_pagination(h: Harness):
    device_id, token = h.ready_device()
    done = h.create()["command"]
    claimed_ids(h.claim(device_id, token))
    h.report(done, token)
    pending = [h.create(account_id="acct_other")["command"]["command_id"] for _ in range(3)]

    resp = h.get("/commands", params={"limit": 2})
    assert resp.status_code == 200
    page1 = resp.json()
    assert len(page1["items"]) == 2 and page1["next_cursor"] is not None
    for item in page1["items"]:
        assert_shape(item, "CommandRecord")
    page2 = h.get("/commands", params={"limit": 2, "cursor": page1["next_cursor"]}).json()
    seen = [i["command"]["command_id"] for i in page1["items"] + page2["items"]]
    assert sorted(seen) == sorted([done["command_id"], *pending]) and page2["next_cursor"] is None

    ids = lambda r: [i["command"]["command_id"] for i in r.json()["items"]]  # noqa: E731
    assert ids(h.get("/commands", params={"status": ["succeeded", "unknown"]})) == [done["command_id"]]
    assert len(ids(h.get("/commands", params={"account_id": "acct_other"}))) == 3
    assert ids(h.get("/commands", params={"action": "send_greeting", "status": "pending"})) == pending[::-1]


def test_list_commands_by_executed_window_for_mail_ingest(h: Harness):
    device_id, token = h.ready_device()
    command = h.create()["command"]
    claimed_ids(h.claim(device_id, token))
    h.report(command, token)
    params = {
        "status": "succeeded",
        "executed_after": iso(h.clock.now()),
        "executed_before": "2026-10-04T02:00:00+00:00",
    }
    resp = h.get("/commands", token=SERVICE_TOKEN, params=params)  # 邮件接入用服务令牌
    assert [i["command"]["command_id"] for i in resp.json()["items"]] == [command["command_id"]]
    params["executed_after"] = "2026-10-04T01:30:01Z"
    assert h.get("/commands", token=SERVICE_TOKEN, params=params).json()["items"] == []


def test_list_and_get_command_errors(h: Harness):
    assert_problem(h.get("/commands", token=None), 401)
    assert_problem(h.get("/commands", params={"cursor": "abc"}), 422)
    assert_problem(h.get("/commands", params={"limit": 0}), 422)
    assert_problem(h.get("/commands", params={"status": "bogus"}), 422)
    assert_problem(h.get("/commands", params={"executed_after": "yesterday"}), 422)
    assert_problem(h.get(f"/commands/{uuid.uuid4()}"), 404)
    assert_problem(h.get("/commands/not-a-uuid"), 422)
    # 详情只给控制台
    assert_problem(h.get(f"/commands/{uuid.uuid4()}", token=SERVICE_TOKEN), 401)
