"""设备：注册码、注册与令牌、心跳、绑定、暂停、吊销；以及存储层迁移、幂等键与认证公共行为。"""

from __future__ import annotations

import sqlite3

import pytest
from server_testkit import ACCOUNT, CONSOLE_TOKEN, SERVICE_TOKEN, Harness, assert_problem, assert_shape

import monitor_contracts as mc

from app.db import MIGRATIONS, SqliteStore, migrate
from app.devices import contracts_compatible, new_enrollment_code
from app.main import Settings, StaticTokenAuthenticator, hash_token

# ---------------------------------------------------------------------------
# 注册码
# ---------------------------------------------------------------------------


def test_enrollment_created(h: Harness):
    resp = h.post("/device-enrollments", {"mode": "remote", "note": "前台 Mac mini"})
    assert resp.status_code == 201
    body = resp.json()
    assert_shape(body, "Enrollment")
    assert body["mode"] == "remote"
    assert body["enrollment_code"].startswith("ENR-")
    # 注册码只存哈希
    row = h.store.get_enrollment(hash_token(body["enrollment_code"]))
    assert row is not None and row.mode == "remote" and row.created_by == "alice"


def test_enrollment_requires_console_session(h: Harness):
    assert_problem(h.post("/device-enrollments", {"mode": "local"}, token=None), 401, "unauthorized")
    assert_problem(h.post("/device-enrollments", {"mode": "local"}, token="wrong"), 401, "unauthorized")
    # 服务令牌不能当控制台会话用
    assert_problem(h.post("/device-enrollments", {"mode": "local"}, token=SERVICE_TOKEN), 401)


def test_enrollment_rejects_bad_body(h: Harness):
    body = assert_problem(h.post("/device-enrollments", {"mode": "cloud"}), 422, "validation_failed")
    assert [e["path"] for e in body["errors"]] == ["mode"]
    body = assert_problem(h.post("/device-enrollments", {"mode": "local", "extra": 1}), 422)
    assert "extra" in [e["path"] for e in body["errors"]]


def test_new_enrollment_code_is_random_and_contract_sized():
    codes = {new_enrollment_code() for _ in range(50)}
    assert len(codes) == 50
    assert all(6 <= len(c) <= 64 for c in codes)


# ---------------------------------------------------------------------------
# 注册与令牌
# ---------------------------------------------------------------------------


def test_register_device_returns_token_once_and_stores_hash(h: Harness):
    code = h.enroll("local")
    resp = h.post("/devices", h.registration(code), token=None)
    assert resp.status_code == 201
    body = resp.json()
    assert_shape(body, "DeviceRegistered")
    token = body["device_token"]
    device = h.store.get_device(body["device_id"])
    assert device is not None and device.token_hash == hash_token(token) and device.mode == "local"
    # 明文令牌不在库里任何地方（包括幂等记录）
    dump = "\n".join(h.store._conn.iterdump())
    assert token not in dump
    # 令牌可用
    assert h.heartbeat(body["device_id"], token).status_code == 200


def test_enrollment_code_is_single_use(h: Harness):
    code = h.enroll()
    assert h.post("/devices", h.registration(code), token=None).status_code == 201
    assert_problem(
        h.post("/devices", h.registration(code, device_name="另一台"), token=None), 403, "enrollment_invalid"
    )


def test_register_rejects_unknown_and_expired_codes(h: Harness):
    assert_problem(h.post("/devices", h.registration("ENR-NOT-A-CODE"), token=None), 403, "enrollment_invalid")
    code = h.enroll()
    h.clock.advance(Settings().enrollment_ttl.total_seconds() + 1)
    assert_problem(h.post("/devices", h.registration(code), token=None), 403, "enrollment_invalid")


def test_register_rejects_mode_mismatch(h: Harness):
    code = h.enroll("remote")
    assert_problem(h.post("/devices", h.registration(code, "local"), token=None), 403, "enrollment_mode_mismatch")


def test_register_rejects_incompatible_contracts_without_consuming_code(h: Harness):
    code = h.enroll()
    assert_problem(
        h.post("/devices", h.registration(code, contracts_version="9.9.0"), token=None),
        409,
        "contracts_version_unsupported",
    )
    # 注册码没有被消费，升级后可以继续用
    assert h.post("/devices", h.registration(code), token=None).status_code == 201


def test_register_validates_body_with_field_paths(h: Harness):
    code = h.enroll()
    body = h.registration(code, capabilities=["observe", "login_relay"])  # 本机模式不得声明 login_relay
    problem = assert_problem(h.post("/devices", body, token=None), 422, "validation_failed")
    assert "capabilities" in [e["path"] for e in problem["errors"]]
    body = h.registration(code)
    del body["device_name"]
    problem = assert_problem(h.post("/devices", body, token=None), 422)
    assert [e["path"] for e in problem["errors"]] == ["device_name"]


def test_register_replay_reissues_token_and_invalidates_previous(h: Harness):
    code = h.enroll()
    body = h.registration(code)
    first = h.post("/devices", body, token=None, key="register-attempt-1")
    replay = h.post("/devices", body, token=None, key="register-attempt-1")
    assert first.status_code == replay.status_code == 201
    assert replay.json()["device_id"] == first.json()["device_id"]
    assert replay.json()["device_token"] != first.json()["device_token"]
    device_id = first.json()["device_id"]
    assert_problem(h.heartbeat(device_id, first.json()["device_token"]), 401)
    assert h.heartbeat(device_id, replay.json()["device_token"]).status_code == 200
    assert len(h.store.list_devices()) == 1


def test_contracts_compatible():
    assert contracts_compatible("0.1.0", "0.1.1")
    assert not contracts_compatible("0.2.0", "0.1.1")
    assert not contracts_compatible("1.1.1", "0.1.1")


# ---------------------------------------------------------------------------
# 设备卡片
# ---------------------------------------------------------------------------


def test_list_and_get_devices(h: Harness):
    device_id, token = h.ready_device()
    resp = h.get("/devices")
    assert resp.status_code == 200
    items = resp.json()["items"]
    assert len(items) == 1
    assert_shape(items[0], "Device")
    one = h.get(f"/devices/{device_id}").json()
    assert_shape(one, "Device")
    assert one["status"] == "online"
    assert one["account_binding"]["account_id"] == ACCOUNT
    assert one["account_binding"]["confirmed_by"] == "alice"
    assert one["last_heartbeat"]["account_id"] == ACCOUNT
    assert one["login_qr_active"] is False


def test_get_device_not_found_and_auth(h: Harness):
    assert_problem(h.get("/devices/dev_missing"), 404, "not_found")
    assert_problem(h.get("/devices", token=None), 401)


def test_device_status_offline_needs_login_paused_revoked(h: Harness):
    device_id, token = h.register()
    assert h.get(f"/devices/{device_id}").json()["status"] == "offline"  # 还没心跳
    h.heartbeat(device_id, token)
    assert h.get(f"/devices/{device_id}").json()["status"] == "online"
    h.clock.advance(91)
    assert h.get(f"/devices/{device_id}").json()["status"] == "offline"
    h.heartbeat(device_id, token, client_state="login_required")
    assert h.get(f"/devices/{device_id}").json()["status"] == "needs_login"
    h.post(f"/devices/{device_id}:pause")
    assert h.get(f"/devices/{device_id}").json()["status"] == "paused"
    h.post(f"/devices/{device_id}:revoke")
    assert h.get(f"/devices/{device_id}").json()["status"] == "revoked"


def test_login_qr_probe_is_injectable():
    harness = Harness()
    harness.ctx.login_qr_active = lambda device_id: True
    device_id, _ = harness.register("remote")
    assert harness.get(f"/devices/{device_id}").json()["login_qr_active"] is True


# ---------------------------------------------------------------------------
# 吊销、绑定、暂停
# ---------------------------------------------------------------------------


def test_revoke_makes_token_unusable(h: Harness):
    device_id, token = h.ready_device()
    resp = h.post(f"/devices/{device_id}:revoke")
    assert resp.status_code == 200
    assert_shape(resp.json(), "Device")
    assert resp.json()["revoked"] is True
    assert_problem(h.heartbeat(device_id, token), 401, "unauthorized")
    assert_problem(h.claim(device_id, token), 401)
    # 再次吊销保持幂等
    assert h.post(f"/devices/{device_id}:revoke").json()["revoked"] is True


def test_revoke_unknown_device(h: Harness):
    assert_problem(h.post("/devices/dev_missing:revoke"), 404)


def test_account_binding(h: Harness):
    device_id, _ = h.register()
    resp = h.bind(device_id, "acct_other")
    assert resp.status_code == 200
    assert_shape(resp.json(), "AccountBinding")
    assert resp.json()["account_id"] == "acct_other"
    assert_problem(h.bind("dev_missing"), 404)
    assert_problem(h.post(f"/devices/{device_id}/account-binding", {"account_id": ""}, method="PUT"), 422)


def test_pause_and_resume(h: Harness):
    device_id, token = h.ready_device()
    resp = h.post(f"/devices/{device_id}:pause", {"note": "午休"})
    assert resp.status_code == 200 and resp.json()["paused"] is True
    ack = h.heartbeat(device_id, token).json()
    assert ack["paused"] is True
    resp = h.post(f"/devices/{device_id}:resume")
    assert resp.status_code == 200 and resp.json()["paused"] is False
    assert h.heartbeat(device_id, token).json()["paused"] is False
    assert_problem(h.post("/devices/dev_missing:pause"), 404)
    assert_problem(h.post(f"/devices/{device_id}:pause", {"note": "x" * 501}), 422)


# ---------------------------------------------------------------------------
# 心跳
# ---------------------------------------------------------------------------


def test_heartbeat_ack_shape_and_account_confirmation(h: Harness):
    device_id, token = h.register()
    ack = h.heartbeat(device_id, token).json()
    assert_shape(ack, "HeartbeatAck")
    assert ack["account_confirmed"] is False  # 未绑定
    assert ack["policy_version"] is None
    h.bind(device_id)
    assert h.heartbeat(device_id, token).json()["account_confirmed"] is True
    assert h.heartbeat(device_id, token, account_id="acct_switched").json()["account_confirmed"] is False
    assert h.heartbeat(device_id, token, account_id=None).json()["account_confirmed"] is False


def test_heartbeat_ack_binding_null_while_unbound(h: Harness):
    """契约 0.3.3（M-1）：控制台未确认绑定时 account_binding 为 null，无论心跳报的是什么账户。"""
    device_id, token = h.register()
    for account_id in (None, ACCOUNT):
        ack = h.heartbeat(device_id, token, account_id=account_id).json()
        assert mc.check("heartbeat_ack", ack) == []
        assert ack["account_binding"] is None
        assert ack["account_confirmed"] is False
        assert ack["policy_version"] is None


def test_heartbeat_ack_carries_confirmed_binding_before_device_knows_it(h: Harness):
    """设备本机还没有绑定（心跳 account_id=null）时，回执已给出控制台确认的绑定，设备据此写入本机。"""
    device_id, token = h.register()
    h.clock.advance(60)
    assert h.bind(device_id).status_code == 200
    h.clock.advance(30)
    ack = h.heartbeat(device_id, token, account_id=None).json()
    assert mc.check("heartbeat_ack", ack) == []
    assert ack["account_binding"] == {"account_id": ACCOUNT, "bound_at": "2026-10-04T01:31:00Z", "confirmed_by": "alice"}
    assert ack["account_confirmed"] is False and ack["policy_version"] is None
    # 设备改报绑定账户后确认，开始下发策略版本；绑定记录不变
    ack = h.heartbeat(device_id, token, account_id=ACCOUNT).json()
    assert mc.check("heartbeat_ack", ack) == []
    assert ack["account_confirmed"] is True and ack["policy_version"] is not None
    assert ack["account_binding"]["account_id"] == ACCOUNT
    assert ack["account_binding"]["bound_at"] == "2026-10-04T01:31:00Z"


def test_heartbeat_ack_reflects_binding_change(h: Harness):
    """控制台把绑定改到另一个账户：下一次回执如实返回新账户，设备改报之前不算确认、领取为空。"""
    device_id, token = h.ready_device()
    h.clock.advance(120)
    assert h.bind(device_id, "acct_other").status_code == 200
    ack = h.heartbeat(device_id, token, account_id=ACCOUNT).json()
    assert mc.check("heartbeat_ack", ack) == []
    assert ack["account_binding"] == {"account_id": "acct_other", "bound_at": "2026-10-04T01:32:00Z", "confirmed_by": "alice"}
    assert ack["account_confirmed"] is False and ack["policy_version"] is None
    h.create(account_id="acct_other")
    for account_id in (ACCOUNT, "acct_other"):
        claim = h.claim(device_id, token, account_id)
        assert claim.status_code == 200 and claim.json()["commands"] == []
    # 设备按回执写入新绑定、改报新账户后确认，可以领取新账户的指令
    ack = h.heartbeat(device_id, token, account_id="acct_other").json()
    assert ack["account_confirmed"] is True
    assert ack["account_binding"]["account_id"] == "acct_other"
    assert len(h.claim(device_id, token, "acct_other").json()["commands"]) == 1


def test_heartbeat_ack_binding_is_per_device(h: Harness):
    a_id, a_token = h.ready_device()
    b_id, b_token = h.register()
    assert h.heartbeat(b_id, b_token, account_id=None).json()["account_binding"] is None
    assert h.heartbeat(a_id, a_token).json()["account_binding"]["account_id"] == ACCOUNT


def test_suspended_client_state_is_shown_as_reported(h: Harness):
    """契约 0.3.3：client_state=suspended（窗口已归还用户）如实记录并显示；设备仍在线，不算需要登录。"""
    device_id, token = h.ready_device()
    assert h.heartbeat(device_id, token, client_state="suspended").status_code == 200
    device = h.get(f"/devices/{device_id}").json()
    assert device["last_heartbeat"]["client_state"] == "suspended"
    assert device["status"] == "online"
    listed = {d["device_id"]: d for d in h.get("/devices").json()["items"]}
    assert listed[device_id]["last_heartbeat"]["client_state"] == "suspended"
    h.clock.advance(91)
    assert h.get(f"/devices/{device_id}").json()["status"] == "offline"


def test_heartbeat_policy_version_is_injected():
    harness = Harness()
    harness.ctx.policy_version = lambda account_id: 7 if account_id == ACCOUNT else None
    device_id, token = harness.ready_device()
    assert harness.heartbeat(device_id, token).json()["policy_version"] == 7


def test_heartbeat_updates_mode_and_last_heartbeat(h: Harness):
    device_id, token = h.register("local")
    h.heartbeat(device_id, token, mode="remote")
    device = h.get(f"/devices/{device_id}").json()
    assert device["mode"] == "remote"
    assert device["last_heartbeat_at"] == "2026-10-04T01:30:00Z"


def test_heartbeat_errors(h: Harness):
    a_id, a_token = h.register()
    b_id, _ = h.register()
    assert_problem(h.heartbeat(a_id, None), 401)
    # 路径中的设备不是令牌所属设备
    body = h.heartbeat_body(b_id)
    assert_problem(h.post(f"/devices/{b_id}/heartbeat", body, token=a_token), 403, "device_mismatch")
    # 请求体 device_id 与令牌不符
    body = h.heartbeat_body(b_id)
    problem = assert_problem(h.post(f"/devices/{a_id}/heartbeat", body, token=a_token), 422)
    assert problem["errors"][0]["path"] == "device_id"
    # 契约校验：paused=true 时必须给 pause_reason
    problem = assert_problem(h.heartbeat(a_id, a_token, paused=True, pause_reason=None), 422)
    assert problem["errors"]


# ---------------------------------------------------------------------------
# Idempotency-Key 公共行为
# ---------------------------------------------------------------------------


def test_idempotency_key_required_and_formatted(h: Harness):
    problem = assert_problem(h.post("/device-enrollments", {"mode": "local"}, key=None), 422, "validation_failed")
    assert problem["errors"][0]["path"] == "header.Idempotency-Key"
    assert_problem(h.post("/device-enrollments", {"mode": "local"}, key="short"), 422)
    assert_problem(h.post("/device-enrollments", {"mode": "local"}, key="has space in key"), 422)


def test_idempotency_replay_and_reuse(h: Harness):
    first = h.post("/device-enrollments", {"mode": "local"}, key="enroll-click-1")
    again = h.post("/device-enrollments", {"mode": "local"}, key="enroll-click-1")
    assert first.status_code == again.status_code == 201
    assert first.json() == again.json()  # 双击不会生成两个注册码
    assert_problem(
        h.post("/device-enrollments", {"mode": "remote"}, key="enroll-click-1"), 422, "idempotency_key_reused"
    )


def test_idempotency_record_expires_after_ttl(h: Harness):
    first = h.post("/device-enrollments", {"mode": "local"}, key="enroll-click-2").json()
    h.clock.advance(Settings().idempotency_ttl.total_seconds() + 1)
    later = h.post("/device-enrollments", {"mode": "local"}, key="enroll-click-2").json()
    assert later["enrollment_code"] != first["enrollment_code"]


def test_idempotency_is_scoped_by_principal(h: Harness):
    h.ctx.console_auth = StaticTokenAuthenticator({CONSOLE_TOKEN: "alice", "bob-token": "bob"})
    a = h.post("/device-enrollments", {"mode": "local"}, key="same-key-123").json()
    b = h.post("/device-enrollments", {"mode": "local"}, token="bob-token", key="same-key-123").json()
    assert a["enrollment_code"] != b["enrollment_code"]


def test_unknown_route_is_problem(h: Harness):
    assert_problem(h.get("/nope"), 404, "not_found")


# ---------------------------------------------------------------------------
# 存储层迁移
# ---------------------------------------------------------------------------


def test_migrate_from_empty_and_is_idempotent(tmp_path):
    conn = sqlite3.connect(tmp_path / "s.db", isolation_level=None)
    assert migrate(conn) == len(MIGRATIONS)
    assert migrate(conn) == len(MIGRATIONS)  # 已是最新时不做任何事
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"devices", "account_bindings", "commands", "events", "manual_actions", "idempotency_keys"} <= tables


def test_migrate_upgrades_previous_version(tmp_path):
    conn = sqlite3.connect(tmp_path / "s.db", isolation_level=None)
    extra = "CREATE TABLE future_table (id INTEGER PRIMARY KEY);"
    assert migrate(conn, MIGRATIONS) == len(MIGRATIONS)
    assert migrate(conn, [*MIGRATIONS, extra]) == len(MIGRATIONS) + 1
    assert conn.execute("SELECT count(*) FROM future_table").fetchone()[0] == 0


def test_migrate_refuses_downgrade(tmp_path):
    conn = sqlite3.connect(tmp_path / "s.db", isolation_level=None)
    conn.execute("PRAGMA user_version = 99")
    with pytest.raises(RuntimeError):
        migrate(conn)


def test_failed_migration_rolls_back(tmp_path):
    conn = sqlite3.connect(tmp_path / "s.db", isolation_level=None)
    migrate(conn)
    broken = "CREATE TABLE half_done (id INTEGER); THIS IS NOT SQL;"
    with pytest.raises(sqlite3.Error):
        migrate(conn, [*MIGRATIONS, broken])
    assert not conn.in_transaction
    assert conn.execute("PRAGMA user_version").fetchone()[0] == len(MIGRATIONS)
    assert conn.execute("SELECT count(*) FROM sqlite_master WHERE name='half_done'").fetchone()[0] == 0


def test_file_store_persists_across_reopen(tmp_path):
    path = tmp_path / "server.db"
    harness_store = SqliteStore(path)
    assert harness_store.schema_version == len(MIGRATIONS)
    harness_store.close()
    reopened = SqliteStore(path)
    assert reopened.schema_version == len(MIGRATIONS)
    reopened.close()
