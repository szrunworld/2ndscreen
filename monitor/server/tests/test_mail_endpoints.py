"""邮件记录（PUT 幂等 upsert、MAIL_TRANSITIONS、不可变字段）、列表过滤、核对结果、策略读取权限。"""

from __future__ import annotations

from typing import Annotated

import pytest
from fastapi import Depends
from server_testkit import (
    CONSOLE_TOKEN,
    SERVICE_TOKEN,
    Harness,
    assert_problem,
    assert_shape,
    mail_body,
    put_mail,
    vector,
)

from app.mail_endpoints import MailMessageStatusChanged, MailVerificationRecorded, is_read_only_principal, require_policy_reader

PMID = "3f6c2a9e-1b4d-4e8a-9c7f-2d5e8b1a0c44"
SHA = "a" * 64


def processed_body(**overrides) -> dict:
    body = mail_body("mail_message_needs_review", status="processed", error=None)
    body.update(overrides)
    return body


def changes(h: Harness) -> list[MailMessageStatusChanged]:
    return [m for m in h.messages if isinstance(m, MailMessageStatusChanged)]


# ---------------------------------------------------------------------------
# PUT /mail-messages/{id}
# ---------------------------------------------------------------------------


def test_put_creates_then_updates(h: Harness):
    body = mail_body()
    resp = put_mail(h, body)
    assert resp.status_code == 201, resp.text
    assert_shape(resp.json(), "MailMessage")
    assert resp.json()["status"] == "pending"
    # 同体换键：200（更新，不是迁移）
    assert put_mail(h, body).status_code == 200
    # 未达上限的失败仍为 pending、attempts +1
    retry = mail_body(attempts=1, error="timeout: 回取超时", updated_at="2026-10-04T10:03:00+08:00")
    resp = put_mail(h, retry)
    assert resp.status_code == 200 and resp.json()["attempts"] == 1
    # pending → needs_review（补齐副本字段）→ processed（人工关联后）
    resp = put_mail(h, mail_body("mail_message_needs_review"))
    assert resp.status_code == 200 and resp.json()["status"] == "needs_review"
    resp = put_mail(h, processed_body())
    assert resp.status_code == 200 and resp.json()["status"] == "processed"
    assert [(c.old_status, c.new_status) for c in changes(h)] == [
        (None, "pending"),
        ("pending", "needs_review"),
        ("needs_review", "processed"),
    ]


def test_put_replay_same_key(h: Harness):
    body = mail_body()
    first = put_mail(h, body, key="mail-key-00001")
    again = put_mail(h, body, key="mail-key-00001")
    assert first.status_code == again.status_code == 201 and first.json() == again.json()
    assert_problem(put_mail(h, mail_body(attempts=1), key="mail-key-00001"), 422, "idempotency_key_reused")


@pytest.mark.parametrize(
    ("start", "target"),
    [
        ("processed", "pending"),
        ("processed", "needs_review"),
        ("ignored", "pending"),
        ("needs_review", "failed"),
        ("failed", "processed"),
    ],
)
def test_illegal_transitions_rejected(h: Harness, start: str, target: str):
    bodies = {
        "pending": mail_body(),
        "processed": processed_body(),
        "needs_review": mail_body("mail_message_needs_review"),
        "ignored": mail_body(status="ignored", error="non_boss_sender"),
        "failed": mail_body(status="failed", attempts=3, error="attachment_download_failed: 403"),
    }
    assert put_mail(h, bodies[start]).status_code == 201
    body = assert_problem(put_mail(h, bodies[target]), 409, "illegal_mail_transition")
    assert body["existing"]["status"] == start
    assert h.ctx.mail.store.get_message(bodies[start]["mail_message_id"])["status"] == start


def test_failed_can_requeue_to_pending(h: Harness):
    put_mail(h, mail_body())
    put_mail(h, mail_body(status="failed", attempts=3, error="x: y"))
    resp = put_mail(h, mail_body(status="pending", attempts=0))
    assert resp.status_code == 200 and resp.json()["status"] == "pending"


@pytest.mark.parametrize(
    "change",
    [
        {"mailbox": "other@remotedesk.io"},
        {"received_at": "2026-10-04T10:01:00+08:00"},
    ],
)
def test_immutable_fields_conflict(h: Harness, change: dict):
    put_mail(h, mail_body())
    body = assert_problem(put_mail(h, mail_body(**change)), 409, "mail_message_conflict")
    assert body["existing"]["mailbox"] == "zhaopin@remotedesk.io"


def test_equivalent_values_are_not_conflicts(h: Harness):
    put_mail(h, mail_body())
    # 同一时刻的不同写法、大小写不同的邮箱不算改动
    resp = put_mail(h, mail_body(received_at="2026-10-04T02:02:00Z", mailbox="ZhaoPin@remotedesk.io"))
    assert resp.status_code == 200


def test_sha256_immutable_once_set(h: Harness):
    put_mail(h, mail_body())
    put_mail(h, mail_body("mail_message_needs_review"))
    body = assert_problem(put_mail(h, processed_body(sha256="c" * 64)), 409, "mail_message_conflict")
    assert body["existing"]["sha256"] == SHA


def test_put_validation_errors(h: Harness):
    body = mail_body()
    other = mail_body(provider_message_id="11111111-2222-4333-8444-555555555555")
    # 路径与请求体不一致
    resp = h.post(f"/mail-messages/{other['mail_message_id']}", body, token=SERVICE_TOKEN, method="PUT")
    assert_problem(resp, 422, "validation_failed")
    # 主键不等于 'mail:' + provider_message_id
    wrong = mail_body(mail_message_id=other["mail_message_id"])
    assert_problem(put_mail(h, wrong), 422, "validation_failed")
    # 契约校验：processed 必须有 sha256
    assert_problem(put_mail(h, mail_body(status="processed")), 422, "validation_failed")
    # 路径格式
    assert_problem(h.post("/mail-messages/bogus", body, token=SERVICE_TOKEN, method="PUT"), 422)
    assert_problem(put_mail(h, body, key=None), 422)


def test_put_requires_service_token(h: Harness):
    assert_problem(put_mail(h, mail_body(), token=None), 401)
    assert_problem(put_mail(h, mail_body(), token=CONSOLE_TOKEN), 401)


# ---------------------------------------------------------------------------
# GET /mail-messages
# ---------------------------------------------------------------------------


def seed_messages(h: Harness) -> list[str]:
    ids = []
    for i, (status, hour) in enumerate([("pending", 1), ("needs_review", 3), ("failed", 2)]):
        pmid = f"00000000-0000-4000-8000-00000000000{i}"
        body = mail_body(
            "mail_message_needs_review" if status == "needs_review" else "mail_message_pending",
            provider_message_id=pmid,
            received_at=f"2026-10-04T0{hour}:00:00Z",
            updated_at=f"2026-10-04T0{hour}:00:01Z",
            message_id=f"<m{i}@x>",
        )
        if status == "failed":
            body.update(status="failed", attempts=3, error="x: y")
        assert put_mail(h, body).status_code == 201, put_mail(h, body).text
        ids.append(body["mail_message_id"])
    return ids


def ids_of(resp) -> list[str]:
    assert resp.status_code == 200, resp.text
    return [m["mail_message_id"] for m in resp.json()["items"]]


def test_list_filters_and_order(h: Harness):
    pending, review, failed = seed_messages(h)
    assert ids_of(h.get("/mail-messages")) == [review, failed, pending]  # received_at 倒序
    assert ids_of(h.get("/mail-messages", params=[("status", "needs_review"), ("status", "failed")])) == [review, failed]
    assert ids_of(h.get("/mail-messages", params={"status": "needs_review"}, token=SERVICE_TOKEN)) == [review]
    assert ids_of(h.get("/mail-messages", params={"mailbox": "ZHAOPIN@remotedesk.io"})) == [review, failed, pending]
    assert ids_of(h.get("/mail-messages", params={"mailbox": "x@remotedesk.io"})) == []
    assert ids_of(h.get("/mail-messages", params={"message_id": "<m0@x>"})) == [pending]
    assert ids_of(h.get("/mail-messages", params={"received_after": "2026-10-04T02:00:00Z"})) == [review, failed]
    assert ids_of(h.get("/mail-messages", params={"received_before": "2026-10-04T10:30:00+08:00"})) == [failed, pending]
    for item in h.get("/mail-messages").json()["items"]:
        assert_shape(item, "MailMessage")


def test_list_paging_and_errors(h: Harness):
    pending, review, failed = seed_messages(h)
    page1 = h.get("/mail-messages", params={"limit": 2}).json()
    assert [m["mail_message_id"] for m in page1["items"]] == [review, failed]
    page2 = h.get("/mail-messages", params={"limit": 2, "cursor": page1["next_cursor"]}).json()
    assert [m["mail_message_id"] for m in page2["items"]] == [pending] and page2["next_cursor"] is None
    assert_problem(h.get("/mail-messages", params={"status": "bogus"}), 422)
    assert_problem(h.get("/mail-messages", params={"received_after": "2026-10-04T02:00:00"}), 422)
    assert_problem(h.get("/mail-messages", params={"cursor": "x"}), 422)
    assert_problem(h.get("/mail-messages", token=None), 401)


# ---------------------------------------------------------------------------
# 核对结果
# ---------------------------------------------------------------------------


def post_verification(h: Harness, body: dict, **kw):
    return h.post("/mail-verifications", body, token=kw.pop("token", SERVICE_TOKEN), **kw)


def test_verification_idempotent_by_id(h: Harness):
    body = vector("mail_verification_issues")
    resp = post_verification(h, body)
    assert resp.status_code == 201, resp.text
    assert_shape(resp.json(), "MailVerificationRecord")
    received_at = resp.json()["received_at"]
    h.clock.advance(30)
    again = post_verification(h, body)  # 新键、同内容：200 + 首次接收时间
    assert again.status_code == 200 and again.json()["received_at"] == received_at
    changed = dict(body, purged_copies=9)
    conflict = assert_problem(post_verification(h, changed), 409, "verification_conflict")
    assert conflict["existing"]["verification"]["purged_copies"] == 0
    recorded = [m for m in h.messages if isinstance(m, MailVerificationRecorded)]
    assert [(m.verification_id, m.outcome) for m in recorded] == [("verify-20261004T1100", "issues_found")]


def test_verification_errors(h: Harness):
    bad = vector("mail_verification_ok_with_overdue")
    bad["checks"] = bad["checks"][:-1]  # ok 时 8 个检查项必须齐
    assert_problem(post_verification(h, bad), 422, "validation_failed")
    assert_problem(post_verification(h, vector("mail_verification_failed"), token=CONSOLE_TOKEN), 401)
    assert_problem(post_verification(h, vector("mail_verification_failed"), key=None), 422)


def test_list_verifications(h: Harness):
    ok_body = vector("mail_verification_ok_with_overdue")
    ok_body["verification_id"] = "verify-a"
    issues = vector("mail_verification_issues")
    issues["verification_id"] = "verify-b"
    issues["finished_at"] = "2026-10-04T12:00:12+08:00"
    issues["started_at"] = "2026-10-04T12:00:00+08:00"
    failed = vector("mail_verification_failed")
    failed["verification_id"] = "verify-c"
    failed["started_at"], failed["finished_at"] = "2026-10-04T10:00:00+08:00", "2026-10-04T10:00:05+08:00"
    for body in (ok_body, issues, failed):
        assert post_verification(h, body).status_code == 201
    items = h.get("/mail-verifications").json()["items"]
    assert items[0]["verification"]["verification_id"] == "verify-b"  # finished_at 最新
    for item in items:
        assert_shape(item, "MailVerificationRecord")
    only = h.get("/mail-verifications", params={"outcome": "ok"}, token=SERVICE_TOKEN).json()["items"]
    assert [i["verification"]["verification_id"] for i in only] == ["verify-a"]
    assert len(h.get("/mail-verifications", params={"mailbox": "zhaopin@remotedesk.io"}).json()["items"]) == 3
    page = h.get("/mail-verifications", params={"limit": 1}).json()
    assert len(page["items"]) == 1 and page["next_cursor"] == "1"
    assert_problem(h.get("/mail-verifications", params={"outcome": "bogus"}), 422)
    assert_problem(h.get("/mail-verifications", token=None), 401)


# ---------------------------------------------------------------------------
# 策略读取权限（serviceToken 只读）
# ---------------------------------------------------------------------------


@pytest.fixture
def reader(h: Harness) -> Harness:
    @h.app.get("/test/policy-reader")
    def _probe(principal: Annotated[str, Depends(require_policy_reader)]):
        return {"principal": principal}

    return h


def test_policy_reader_accepts_console_device_service(reader: Harness):
    h = reader
    device_id, token = h.register()
    probe = lambda tok: h.client.get("/test/policy-reader", headers=h.auth(tok))  # noqa: E731
    assert probe(CONSOLE_TOKEN).json() == {"principal": "console:alice"}
    assert probe(SERVICE_TOKEN).json() == {"principal": "service:mail-ingest"}
    assert probe(token).json() == {"principal": f"device:{device_id}"}
    assert probe(None).status_code == 401
    assert probe("bogus").status_code == 401
    h.post(f"/devices/{device_id}:revoke")
    assert probe(token).status_code == 401


def test_read_only_principals():
    assert is_read_only_principal("service:mail-ingest")
    assert is_read_only_principal("device:dev_1")
    assert not is_read_only_principal("console:alice")
