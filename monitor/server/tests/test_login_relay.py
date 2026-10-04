"""登录接力：二维码上传、读取（no-store、查看记录、过期 410）、撤下、login_ok 自动撤下；
human_input_required → POST /input-requests/{id}/response → provide_input 指令，值不进日志与事件。"""

from __future__ import annotations

import logging
import uuid
from datetime import timedelta

import pytest
from server_testkit import (
    CONSOLE_TOKEN,
    Harness,
    assert_problem,
    assert_shape,
    iso,
    login_ok_event,
    make_event,
    post_events,
    vector,
)

from app.login_relay import REDACTED

INPUT_ID = "00000000-0000-4000-8000-000000000070"


def qr_body(h: Harness, device_id: str, seq: int = 1, ttl: int = 120, payload: str = "https://example.invalid/qr?k=abc") -> dict:
    body = vector("login_qr_first")
    now = h.clock.now()
    body.update(device_id=device_id, qr_seq=seq, qr_payload=payload, captured_at=iso(now), expires_at=iso(now + timedelta(seconds=ttl)))
    return body


def upload(h: Harness, device_id: str, token: str, **kw):
    return h.post("/login-qr", qr_body(h, device_id, **kw), token=token)


@pytest.fixture
def remote(h: Harness) -> tuple[str, str]:
    return h.register("remote")


# ---------------------------------------------------------------------------
# 上传
# ---------------------------------------------------------------------------


def test_upload_and_view_with_no_store_and_viewer_log(h: Harness, remote):
    device_id, token = remote
    resp = upload(h, device_id, token)
    assert resp.status_code == 201, resp.text
    assert_shape(resp.json(), "LoginQrAccepted")
    assert resp.json()["qr_seq"] == 1
    view = h.get(f"/devices/{device_id}/login-qr")
    assert view.status_code == 200
    assert view.headers["cache-control"] == "no-store"
    assert_shape(view.json(), "LoginQrView")
    assert view.json()["qr_payload"] == "https://example.invalid/qr?k=abc"
    h.clock.advance(5)
    h.get(f"/devices/{device_id}/login-qr")
    views = h.get(f"/devices/{device_id}/login-qr/views").json()
    for item in views["items"]:
        assert_shape(item, "LoginQrViewRecord")
    assert [(v["viewer"], v["qr_seq"]) for v in views["items"]] == [("alice", 1), ("alice", 1)]
    assert views["items"][1]["viewed_at"] > views["items"][0]["viewed_at"]
    # 设备卡片显示有有效二维码
    assert h.get(f"/devices/{device_id}").json()["login_qr_active"] is True


def test_expired_qr_returns_410_and_drops_content(h: Harness, remote):
    device_id, token = remote
    upload(h, device_id, token, ttl=60)
    h.clock.advance(60)
    assert_problem(h.get(f"/devices/{device_id}/login-qr"), 410, "qr_expired")
    assert h.ctx.login_relay.store.get_qr(device_id)["qr_payload"] is None  # 过期即删内容
    assert h.get(f"/devices/{device_id}/login-qr/views").json()["items"] == []  # 410 不记查看
    assert h.get(f"/devices/{device_id}").json()["login_qr_active"] is False


def test_newer_seq_replaces_and_older_is_ignored(h: Harness, remote):
    device_id, token = remote
    upload(h, device_id, token, seq=1, payload="qr-one")
    resp = upload(h, device_id, token, seq=2, payload="qr-two")
    assert resp.json()["qr_seq"] == 2
    late = upload(h, device_id, token, seq=1, payload="qr-late")
    assert late.status_code == 201 and late.json()["qr_seq"] == 2  # 迟到的旧码不覆盖
    assert h.get(f"/devices/{device_id}/login-qr").json()["qr_payload"] == "qr-two"


def test_upload_errors(h: Harness, remote):
    device_id, token = remote
    local_id, local_token = h.register("local")
    assert_problem(upload(h, local_id, local_token), 403, "local_mode")
    assert_problem(h.post("/login-qr", qr_body(h, local_id), token=token), 403, "device_mismatch")
    bad = qr_body(h, device_id)
    bad["expires_at"] = bad["captured_at"]  # 必须晚于 captured_at
    assert_problem(h.post("/login-qr", bad, token=token), 422, "validation_failed")
    assert_problem(h.post("/login-qr", qr_body(h, device_id), token=None), 401)
    assert_problem(h.post("/login-qr", qr_body(h, device_id), token=CONSOLE_TOKEN), 401)
    assert_problem(h.post("/login-qr", qr_body(h, device_id), token=token, key=None), 422)


def test_view_errors(h: Harness, remote):
    device_id, _ = remote
    assert_problem(h.get("/devices/dev_missing/login-qr"), 404)
    assert_problem(h.get(f"/devices/{device_id}/login-qr"), 404)  # 从未上传
    assert_problem(h.get(f"/devices/{device_id}/login-qr", token=None), 401)
    assert_problem(h.get("/devices/dev_missing/login-qr/views"), 404)
    assert_problem(h.get(f"/devices/{device_id}/login-qr/views", token=None), 401)


# ---------------------------------------------------------------------------
# 撤下
# ---------------------------------------------------------------------------


def test_withdraw_by_device_and_console(h: Harness, remote):
    device_id, token = remote
    upload(h, device_id, token)
    resp = h.post(f"/devices/{device_id}/login-qr:withdraw", token=token)
    assert resp.status_code == 204 and resp.content == b""
    assert_problem(h.get(f"/devices/{device_id}/login-qr"), 410, "qr_withdrawn")
    assert h.post(f"/devices/{device_id}/login-qr:withdraw", token=token).status_code == 204  # 重复调用
    assert h.ctx.login_relay.store.get_qr(device_id)["qr_payload"] is None
    # 新码上传后重新可读；控制台也能撤下
    upload(h, device_id, token, seq=2)
    assert h.get(f"/devices/{device_id}/login-qr").status_code == 200
    assert h.post(f"/devices/{device_id}/login-qr:withdraw").status_code == 204
    assert h.ctx.login_relay.store.get_qr(device_id)["withdrawn_by"] == "console:alice"


def test_withdraw_errors(h: Harness, remote):
    device_id, token = remote
    other_id, other_token = h.register("remote")
    assert_problem(h.post(f"/devices/{device_id}/login-qr:withdraw", token=other_token), 403, "device_mismatch")
    assert_problem(h.post("/devices/dev_missing/login-qr:withdraw"), 404)
    assert_problem(h.post(f"/devices/{device_id}/login-qr:withdraw", token=None), 401)
    assert_problem(h.post(f"/devices/{device_id}/login-qr:withdraw", token="bogus"), 401)
    assert_problem(h.post(f"/devices/{device_id}/login-qr:withdraw", key=None), 422)
    assert other_id != device_id


def test_login_ok_event_withdraws_qr(h: Harness, remote):
    device_id, token = remote
    upload(h, device_id, token)
    post_events(h, device_id, token, [login_ok_event(device_id)])
    assert_problem(h.get(f"/devices/{device_id}/login-qr"), 410, "qr_withdrawn")
    assert h.ctx.login_relay.store.get_qr(device_id)["withdrawn_by"] == "event:login_ok"
    assert h.ctx.login_relay.is_active(device_id) is False


def test_purge_expired(h: Harness, remote):
    device_id, token = remote
    upload(h, device_id, token, ttl=60)
    from app.db import to_db_time

    assert h.ctx.login_relay.store.purge_expired(to_db_time(h.clock.now())) == 0
    h.clock.advance(61)
    assert h.ctx.login_relay.store.purge_expired(to_db_time(h.clock.now())) == 1
    assert h.ctx.login_relay.store.get_qr(device_id)["qr_payload"] is None


# ---------------------------------------------------------------------------
# 人工输入
# ---------------------------------------------------------------------------


def raise_input_request(h: Harness, device_id: str, token: str, **payload) -> dict:
    event = make_event(device_id, "event_human_input", **payload)
    post_events(h, device_id, token, [event])
    return event


def respond(h: Harness, value: str = "123456", input_id: str = INPUT_ID, **kw):
    return h.post(f"/input-requests/{input_id}/response", {"value": value}, **kw)


def test_response_creates_provide_input_command(h: Harness, caplog):
    caplog.set_level(logging.DEBUG)
    device_id, token = h.ready_device(mode="remote")
    event = raise_input_request(h, device_id, token)
    resp = respond(h, "654321")
    assert resp.status_code == 201, resp.text
    record = resp.json()
    assert_shape(record, "CommandRecord")
    assert record["command"]["action"] == "provide_input"
    assert record["command"]["target"] == {"input_request_id": INPUT_ID}
    assert record["command"]["payload"]["value"] == REDACTED  # 响应打码
    assert record["device_id"] == device_id
    # 设备领取到的是真实值
    claimed = h.claim(device_id, token).json()["commands"]
    assert claimed[0]["payload"]["value"] == "654321"
    # 值不进日志、不进事件表
    assert "654321" not in caplog.text
    stored_event = h.store.get_event(event["event_id"])
    assert "654321" not in str(stored_event.event)
    # 有结果后服务端抹掉库里的值
    result = h.result_body(claimed[0])
    result["output"] = None
    assert h.post(f"/commands/{claimed[0]['command_id']}/result", result, token=token).status_code == 200
    assert h.store.get_command(claimed[0]["command_id"]).command["payload"]["value"] == REDACTED
    assert "654321" not in str(h.get(f"/commands/{claimed[0]['command_id']}").json())


def test_response_replay_and_second_response(h: Harness):
    device_id, token = h.ready_device(mode="remote")
    raise_input_request(h, device_id, token)
    first = respond(h, key="input-key-0001")
    again = respond(h, key="input-key-0001")
    assert first.status_code == again.status_code == 201 and first.json() == again.json()
    assert_problem(respond(h, "000000"), 409, "input_already_responded")
    assert_problem(respond(h, "999999", key="input-key-0001"), 422, "idempotency_key_reused")


def test_response_errors(h: Harness):
    device_id, token = h.ready_device(mode="remote")
    assert_problem(respond(h), 404)
    # can_fill=false 的请求（滑块）不能代填
    other = "00000000-0000-4000-8000-000000000071"
    raise_input_request(h, device_id, token, input_request_id=other, input_kind="slider", can_fill=False, bucket="2026-10-04T03:00:00Z/3600")
    assert_problem(respond(h, input_id=other), 409, "input_not_fillable")
    raise_input_request(h, device_id, token)
    assert_problem(respond(h, ""), 422)
    assert_problem(respond(h, "x" * 65), 422)
    assert_problem(respond(h, token=None), 401)
    assert_problem(respond(h, input_id="not-a-uuid"), 422)
    h.clock.advance(601)  # 请求 10 分钟后过期
    assert_problem(respond(h), 409, "input_request_expired")


def test_response_requires_bound_account(h: Harness):
    device_id, token = h.register("remote")  # 未绑定账户，事件 account_id 为 null
    raise_input_request(h, device_id, token)
    assert_problem(respond(h), 409, "account_unbound")
    assert h.ctx.login_relay.store.get_input_request(INPUT_ID)["command_id"] is None  # 没有占用请求


def test_scrub_finished_inputs_on_expiry(h: Harness):
    device_id, token = h.ready_device(mode="remote")
    raise_input_request(h, device_id, token)
    command_id = respond(h).json()["command"]["command_id"]
    assert h.ctx.login_relay.scrub_finished_inputs() == 0  # 未结束不抹
    assert h.store.get_command(command_id).command["payload"]["value"] == "123456"
    h.clock.advance(601)
    assert h.ctx.login_relay.scrub_finished_inputs() == 1
    assert h.store.get_command(command_id).command["payload"]["value"] == REDACTED
    assert h.ctx.login_relay.scrub_finished_inputs() == 0  # 已抹过


def test_duplicate_human_input_event_does_not_reset_request(h: Harness):
    device_id, token = h.ready_device(mode="remote")
    raise_input_request(h, device_id, token)
    respond(h)
    raise_input_request(h, device_id, token, bucket="2026-10-04T02:00:00Z/3600")  # 同一 input_request_id 再报一次
    assert h.ctx.login_relay.store.get_input_request(INPUT_ID)["command_id"] is not None


def test_redact_helper_leaves_other_commands():
    from app.login_relay import redact_command_record

    record = {"command": {"action": "send_greeting", "payload": {"text": "hi"}}}
    assert redact_command_record(record) is record
    assert uuid.UUID(INPUT_ID)
