"""CommandClient：HTTP 形状（路径、请求体、头）、错误分类、幂等键、退避。"""

from __future__ import annotations

import json
from datetime import timedelta
from uuid import UUID

import httpx
import pytest
from monitor_contracts import validate_command, validate_command_result, validate_device_heartbeat

from monitor.core.client import (
    Backoff,
    CommandClient,
    RequestRejected,
    ServerUnavailable,
    Unauthorized,
    parse_recorded_result,
)
from monitor.core.clock import ManualClock
from monitor.core.events import make_event
from monitor.core.testing import ACCOUNT, BASE_URL, DEVICE, TOKEN, FakeServer, make_command, make_policy


@pytest.fixture
def clock():
    return ManualClock()


@pytest.fixture
def server(clock):
    return FakeServer(device_id=DEVICE, token=TOKEN, clock=clock, policy=make_policy())


def _client(server, clock, **kw):
    return CommandClient(
        base_url=BASE_URL, device_id=DEVICE, token=kw.pop("token", TOKEN), transport=server.transport(), now=clock.now, **kw
    )


def _hb(clock, **over):
    data = {
        "device_id": DEVICE,
        "sent_at": clock.now().isoformat(),
        "mode": "local",
        "account_id": ACCOUNT,
        "client_state": "running",
        "paused": False,
        "needs_baseline": False,
        "current_action": None,
        "queue": {"queued_commands": 0, "undelivered_results": 0, "outbox_events": 0},
        "monitor_version": "0.1.0",
    }
    data.update(over)
    return validate_device_heartbeat(data)


def _result(cmd, clock):
    return validate_command_result(
        {
            "command_id": cmd["command_id"],
            "action": cmd["action"],
            "status": "succeeded",
            "reason": None,
            "observed": {"before": [], "after": []},
            "evidence": [],
            "navigation_performed": True,
            "outbound_action_performed": True,
            "externally_visible_side_effect": True,
            "executed_at": clock.now().isoformat(),
            "reported_at": clock.now().isoformat(),
        }
    )


def test_heartbeat_shape_and_ack(server, clock):
    contacts = []
    server.paused = True
    server.cancellations.add("00000000-0000-4000-8000-0000000000aa")
    c = _client(server, clock, on_contact=contacts.append)
    ack = c.heartbeat(_hb(clock))
    req = server.requests[-1]
    assert req.path == "/api/v1/devices/dev_test/heartbeat"
    assert req.headers["authorization"] == f"Bearer {TOKEN}"
    assert req.headers["idempotency-key"].startswith("hb:dev_test:")
    assert ack.paused is True and ack.policy_version == 1 and ack.account_confirmed is True
    assert ack.cancellations == (UUID("00000000-0000-4000-8000-0000000000aa"),)
    assert contacts == [clock.now()] and c.last_contact_at == clock.now()


def test_heartbeat_rejects_foreign_device_id(server, clock):
    c = _client(server, clock)
    with pytest.raises(ValueError):
        c.heartbeat(_hb(clock, device_id="other"))


def test_claim_shape_validates_commands_and_reuses_key_on_retry(server, clock):
    attempts = iter([UUID(int=1), UUID(int=2)])
    c = _client(server, clock, new_attempt_id=lambda: next(attempts))
    cmd = make_command(clock=clock)
    server.enqueue(cmd)
    server.fail("claim", 0)  # 第一次网络错误
    with pytest.raises(ServerUnavailable):
        c.claim(account_id=ACCOUNT, wait_seconds=99)
    resp = c.claim(account_id=ACCOUNT, wait_seconds=99)
    reqs = [r for r in server.requests if r.route == "claim"]
    assert reqs[0].headers["idempotency-key"] == reqs[1].headers["idempotency-key"] == f"claim:{DEVICE}:{UUID(int=1)}"
    assert reqs[1].body == {"account_id": ACCOUNT, "max_commands": 1, "wait_seconds": 30}  # 截到 30
    assert [str(x.command_id) for x in resp.commands] == [cmd["command_id"]]
    assert resp.lease_seconds == 60
    # 成功后下一次领取换新的 attempt id
    c.claim(account_id=ACCOUNT, wait_seconds=0)
    assert server.requests[-1].headers["idempotency-key"].endswith(str(UUID(int=2)))


def test_claim_rejects_bad_max_commands(server, clock):
    with pytest.raises(ValueError):
        _client(server, clock).claim(account_id=ACCOUNT, max_commands=11)


def test_claim_reports_invalid_commands_without_raising(clock):
    bad = make_command(clock=clock)
    bad["payload"] = {"text": ""}  # 违反契约

    def handler(request):
        return httpx.Response(
            200,
            json={"commands": [bad], "cancellations": [], "lease_seconds": 30, "server_time": clock.now().isoformat()},
        )

    c = CommandClient(base_url=BASE_URL, device_id=DEVICE, token=TOKEN, transport=httpx.MockTransport(handler), now=clock.now)
    resp = c.claim(account_id=ACCOUNT)
    assert resp.commands == ()
    assert resp.invalid[0].command_id == bad["command_id"]
    assert any(e.path.startswith("payload") for e in resp.invalid[0].errors)


def test_ack_shape(server, clock):
    c = _client(server, clock)
    cid = UUID("00000000-0000-4000-8000-000000000001")
    c.ack(cid, ledger_state="queued", received_at=clock.now())
    req = server.requests[-1]
    assert req.path == f"/api/v1/commands/{cid}/ack"
    assert req.headers["idempotency-key"] == f"ack:{cid}"
    assert req.body == {"device_id": DEVICE, "ledger_state": "queued", "received_at": clock.now().isoformat()}


def test_report_result_duplicate_and_conflict(server, clock):
    c = _client(server, clock)
    cmd = make_command(clock=clock)
    res = _result(cmd, clock)
    first = c.report_result(res)
    assert first.duplicate is False and first.conflict is False
    again = c.report_result(res)
    assert again.duplicate is True
    other = res.model_copy(update={"reason_detail": "不同"})
    conflict = c.report_result(other)
    assert conflict.conflict is True
    assert parse_recorded_result(conflict.recorded) == res


def test_report_result_validation_error_is_rejected(clock):
    def handler(request):
        return httpx.Response(422, json={"code": "validation_failed", "message": "x"})

    c = CommandClient(base_url=BASE_URL, device_id=DEVICE, token=TOKEN, transport=httpx.MockTransport(handler), now=clock.now)
    with pytest.raises(RequestRejected) as ei:
        c.report_result(_result(make_command(clock=clock), clock))
    assert ei.value.status == 422 and ei.value.code == "validation_failed"


@pytest.mark.parametrize("status,exc", [(500, ServerUnavailable), (503, ServerUnavailable), (429, ServerUnavailable), (401, Unauthorized), (404, RequestRejected)])
def test_error_classification(server, clock, status, exc):
    server.fail("heartbeat", status)
    with pytest.raises(exc):
        _client(server, clock).heartbeat(_hb(clock))


def test_wrong_token_is_unauthorized(server, clock):
    with pytest.raises(Unauthorized):
        _client(server, clock, token="nope_wrong").heartbeat(_hb(clock))


def test_empty_token_refused(server, clock):
    with pytest.raises(ValueError):
        _client(server, clock, token="")


def test_post_events_statuses(server, clock):
    c = _client(server, clock)
    e1 = make_event("device_paused", device_id=DEVICE, account_id=ACCOUNT, payload={"reason": "user_request", "by": "user"}, observed_at=clock.now())
    e2 = make_event("device_paused", device_id=DEVICE, account_id=ACCOUNT, payload={"reason": "anomaly", "by": "monitor"}, observed_at=clock.now() + timedelta(minutes=5))
    server.reject_event_ids.add(e2.event_id)
    reps = c.post_events([e1, e2])
    assert [(r.event_id, r.status) for r in reps] == [(e1.event_id, "accepted"), (e2.event_id, "rejected")]
    assert c.post_events([e1])[0].status == "duplicate"
    req = server.requests[-1]
    assert req.path == "/api/v1/events" and set(req.body) == {"device_id", "events"}
    assert req.headers["idempotency-key"].startswith("events:")
    with pytest.raises(ValueError):
        c.post_events([])


def test_get_policy(server, clock):
    c = _client(server, clock)
    p = c.get_policy(ACCOUNT)
    assert p.policy_version == 1
    assert server.requests[-1].method == "GET" and "idempotency-key" not in server.requests[-1].headers
    with pytest.raises(RequestRejected):
        c.get_policy("acct_other")


def test_backoff_exponential_capped_and_reset(clock):
    b = Backoff(base_seconds=1, factor=2, max_seconds=10, jitter=0.5, rng=lambda: 0.0)
    assert b.ready(clock.now()) and b.delay() == 0
    delays = []
    for _ in range(6):
        b.failure(clock.now())
        delays.append(b.delay())
    assert delays == [1, 2, 4, 8, 10, 10]
    assert not b.ready(clock.now())
    clock.advance(10)
    assert b.ready(clock.now())
    b.success()
    assert b.failures == 0 and b.next_at is None


def test_backoff_jitter_shortens_delay(clock):
    b = Backoff(base_seconds=4, jitter=0.5, rng=lambda: 1.0)
    b.failure(clock.now())
    assert b.delay() == 2.0


def test_parse_recorded_result_handles_garbage():
    assert parse_recorded_result(None) is None
    assert parse_recorded_result({"command_id": "x"}) is None


def test_fake_server_rejects_missing_idempotency_key(server, clock):
    c = _client(server, clock)
    resp = c._http.post(f"/devices/{DEVICE}/heartbeat", content=json.dumps(_hb(clock).to_wire()))
    assert resp.status_code == 422


def test_claim_command_roundtrip_matches_contract(server, clock):
    cmd = make_command("request_contact_exchange", clock=clock)
    server.enqueue(cmd)
    resp = _client(server, clock).claim(account_id=ACCOUNT)
    assert resp.commands[0] == validate_command(cmd)
