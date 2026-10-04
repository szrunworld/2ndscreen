"""POST /webhooks/mail：验签、只接 mail.ready、两层幂等、快速 2xx。"""

from __future__ import annotations

import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

from monitor_mail.signature import sign_headers
from monitor_mail.testing import FAKE_WEBHOOK_SECRET
from monitor_mail.webhook import create_webhook_router, handle_delivery


def _client(env) -> TestClient:
    app = FastAPI()
    app.include_router(env.ingest.webhook_router())
    return TestClient(app)


def test_mail_ready_creates_pending_task(env):
    message_id = env.boss_mail()
    body, headers = env.mail.webhook(message_id, delivery_id="dlv-1")
    response = _client(env).post("/webhooks/mail", content=body, headers=headers)
    assert response.status_code == 200
    assert response.json() == {"accepted": True, "mail_message_id": f"mail:{message_id}", "duplicate": False}
    task = env.store.get_task(f"mail:{message_id}")
    assert task.status == "pending" and task.webhook_delivery_id == "dlv-1" and task.attempts == 0
    # 收推送时不做任何网络调用：mail 与服务端都没被访问
    assert env.mail.calls == [] and env.server.requests == []


def test_wrong_signature_is_401_and_not_recorded(env):
    message_id = env.boss_mail()
    body, headers = env.mail.webhook(message_id, secret="forged-secret")
    response = _client(env).post("/webhooks/mail", content=body, headers=headers)
    assert response.status_code == 401
    assert response.json()["reason"] == "signature_mismatch"
    assert env.store.list_tasks() == []


def test_expired_timestamp_is_401(env):
    message_id = env.boss_mail()
    stale = int(env.clock.now().timestamp()) - 301
    body, headers = env.mail.webhook(message_id, timestamp=stale)
    response = _client(env).post("/webhooks/mail", content=body, headers=headers)
    assert response.status_code == 401
    assert response.json()["reason"] == "timestamp_out_of_tolerance"
    assert env.store.list_tasks() == []


def test_duplicate_delivery_is_idempotent(env):
    message_id = env.boss_mail()
    body, headers = env.mail.webhook(message_id, delivery_id="dlv-1")
    client = _client(env)
    first = client.post("/webhooks/mail", content=body, headers=headers)
    second = client.post("/webhooks/mail", content=body, headers=headers)
    assert first.status_code == second.status_code == 200
    assert second.json()["duplicate"] is True
    assert len(env.store.list_tasks()) == 1
    assert len(env.store.list_deliveries()) == 1


def test_redelivery_with_new_id_maps_to_same_task(env):
    """重放 / 作业重入产生新的投递 id：按 message_id 仍是同一个任务，投递台账多一行。"""
    message_id = env.boss_mail()
    assert env.deliver(message_id, delivery_id="dlv-1")[1]["duplicate"] is False
    assert env.deliver(message_id, delivery_id="dlv-2")[1]["duplicate"] is True
    assert len(env.store.list_tasks()) == 1
    assert [d["delivery_id"] for d in env.store.list_deliveries()] == ["dlv-1", "dlv-2"]
    assert env.store.get_task(f"mail:{message_id}").webhook_delivery_id == "dlv-1"


def test_other_events_are_acknowledged_and_ignored(env):
    message_id = env.boss_mail()
    for event in ("mail.received", "mail.bounced"):
        status, content = env.deliver(message_id, event=event)
        assert status == 200 and content["ignored"] is True
    assert env.store.list_tasks() == []


def test_other_mailbox_ignored_when_mailbox_id_configured(env):
    env = env.rebuild(expected_mailbox_id="mbx_zhaopin")
    message_id = env.boss_mail()
    status, content = env.deliver(message_id, mailbox_id="mbx_other")
    assert status == 200 and content["reason"] == "other_mailbox"
    status, content = env.deliver(message_id)
    assert status == 200 and content["accepted"] is True


def test_signed_but_malformed_body_is_400(env):
    for body in (b"not json", b"[]", json.dumps({"id": "dlv-x", "event": "mail.ready", "message_id": "nope"}).encode()):
        headers = sign_headers(body=body, delivery_id="dlv-x", timestamp=int(env.clock.now().timestamp()),
                               secret=FAKE_WEBHOOK_SECRET)
        status, content = handle_delivery(body=body, headers=headers, store=env.store, settings=env.settings,
                                          clock=env.clock)
        assert status == 400 and content["reason"] == "malformed_body"
    assert env.store.list_tasks() == []


def test_body_id_must_match_signed_header(env):
    message_id = env.boss_mail()
    body, headers = env.mail.webhook(message_id, delivery_id="dlv-1")
    headers = sign_headers(body=body, delivery_id="dlv-other", timestamp=int(env.clock.now().timestamp()),
                           secret=FAKE_WEBHOOK_SECRET)
    status, content = handle_delivery(body=body, headers=headers, store=env.store, settings=env.settings, clock=env.clock)
    assert status == 400 and content["reason"] == "delivery_id_mismatch"


def test_router_path_is_configurable(env):
    app = FastAPI()
    app.include_router(create_webhook_router(store=env.store, settings=env.settings, clock=env.clock,
                                             path="/hooks/zhaopin"))
    message_id = env.boss_mail()
    body, headers = env.mail.webhook(message_id)
    assert TestClient(app).post("/hooks/zhaopin", content=body, headers=headers).status_code == 200
