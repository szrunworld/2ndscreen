"""核对任务：8 个检查项、超时提醒、清理数量、自检失败。"""

from __future__ import annotations

from datetime import timedelta

import pytest

from monitor_contracts import validate_mail_verification
from monitor_mail.mail_api import DeliveryRecord, MailUnavailable
from monitor_mail.testing import FakeAttachment, sample_resume_pdf
from monitor_mail.verify import LEDGER_UNAVAILABLE, UPSTREAM_UNAVAILABLE, SelfCheckError, Verifier, self_check


def _checks(body):
    return {c["code"]: c for c in body["checks"]}


def _processed(env, **kwargs) -> str:
    env.request_resume(**kwargs)
    message_id = env.boss_mail()
    env.deliver(message_id)
    env.ingest.run_cycle()
    return f"mail:{message_id}"


def test_clean_state_is_ok_and_submitted(env):
    _processed(env)
    body = env.ingest.verify()
    validate_mail_verification(body)
    assert body["outcome"] == "ok" and body["purged_copies"] == 0
    checks = _checks(body)
    assert len(checks) == 8
    assert checks["upstream_missing"] == {"code": "upstream_missing", "count": None, "refs": [],
                                          "unavailable_reason": UPSTREAM_UNAVAILABLE}
    assert checks["webhook_delivery_failed"]["count"] is None
    assert checks["webhook_delivery_failed"]["unavailable_reason"] == LEDGER_UNAVAILABLE
    assert all(c["count"] == 0 for code, c in checks.items() if code not in ("upstream_missing", "webhook_delivery_failed"))
    assert env.server.verifications[body["verification_id"]]["verification"] == body


def test_pending_backlog_over_30_minutes(env):
    message_id = env.boss_mail(attachments=[FakeAttachment("att1", "a.pdf", sample_resume_pdf(), scan_status="pending")])
    env.deliver(message_id)
    env.clock.advance(minutes=29)
    assert _checks(env.ingest.verify())["pending_backlog"]["count"] == 0
    env.clock.advance(minutes=2)
    body = env.ingest.verify()
    assert body["outcome"] == "issues_found"
    assert _checks(body)["pending_backlog"] == {"code": "pending_backlog", "count": 1, "refs": [f"mail:{message_id}"],
                                                "unavailable_reason": None}


def test_copy_missing_and_document_without_copy(env):
    mail_message_id = _processed(env)
    [attachment] = env.store.list_attachments(mail_message_id)
    env.storage.delete(attachment.storage_uri)
    checks = _checks(env.ingest.verify())
    assert checks["copy_missing"]["count"] == 1
    assert checks["document_without_copy"]["refs"] == [attachment.doc_id]


def test_hash_mismatch(env):
    mail_message_id = _processed(env)
    task = env.store.get_task(mail_message_id)
    path = task.raw_storage_uri.removeprefix("file://")
    with open(path, "ab") as handle:
        handle.write(b" ")
    checks = _checks(env.ingest.verify())
    assert checks["hash_mismatch"]["refs"] == [mail_message_id]
    assert checks["copy_missing"]["count"] == 0


def test_purged_copies_are_not_reported_missing(env):
    _processed(env)
    env.clock.advance(days=31)
    body = env.ingest.verify()
    assert body["purged_copies"] == 1
    assert body["outcome"] == "ok"
    assert env.ingest.verify()["purged_copies"] == 0


def test_needs_review_mismatch_and_manual_resolution(env):
    message_id = env.boss_mail()
    env.deliver(message_id)
    env.ingest.run_cycle()
    mail_message_id = f"mail:{message_id}"
    # 人工关联后服务端 processed：同步本地，不算不一致
    env.server.manual_link(mail_message_id)
    checks = _checks(env.ingest.verify())
    assert checks["needs_review_mismatch"]["count"] == 0
    assert env.store.get_task(mail_message_id).status == "processed"
    # 服务端队列里有、我方没有
    stray = dict(env.server.mail_messages[mail_message_id], status="needs_review",
                 mail_message_id="mail:00000000-0000-4000-8000-0000000000aa",
                 provider_message_id="00000000-0000-4000-8000-0000000000aa")
    env.server.mail_messages[stray["mail_message_id"]] = stray
    checks = _checks(env.ingest.verify())
    assert checks["needs_review_mismatch"]["refs"] == [stray["mail_message_id"]]


def test_failed_mismatch(env):
    message_id = env.boss_mail(attachments=[FakeAttachment("att1", "a.pdf", sample_resume_pdf(), scan_status="pending")])
    env.deliver(message_id)
    for _ in range(3):
        env.ingest.run_cycle()
        env.clock.advance(hours=1)
    assert _checks(env.ingest.verify())["failed_mismatch"]["count"] == 0
    env.server.mail_messages[f"mail:{message_id}"]["status"] = "pending"  # 服务端被人改回 pending
    assert _checks(env.ingest.verify())["failed_mismatch"]["refs"] == [f"mail:{message_id}"]


def test_upstream_missing_when_listing_available(env):
    env.mail.list_supported = True
    _processed(env)
    never_pushed = env.boss_mail()  # mail 里有，推送丢了
    body = env.ingest.verify()
    assert _checks(body)["upstream_missing"] == {"code": "upstream_missing", "count": 1,
                                                 "refs": [f"mail:{never_pushed}"], "unavailable_reason": None}
    assert body["outcome"] == "issues_found"


class FakeLedger:
    def __init__(self, records, fail=False):
        self.records = records
        self.fail = fail
        self.replays = []

    def list_deliveries(self, *, since):
        if self.fail:
            raise MailUnavailable("ledger down")
        return self.records

    def replay_window(self, *, since, until):
        self.replays.append((since, until))


def _verifier(env, **kwargs) -> Verifier:
    return Verifier(store=env.store, mail=env.ingest.mail, server=env.ingest.server, storage=env.storage,
                    settings=kwargs.pop("settings", env.settings), clock=env.clock, **kwargs)


def test_webhook_delivery_failures_from_ledger_and_replay(env):
    ledger = FakeLedger([
        DeliveryRecord("dlv-dead", "mail.ready", "dead", "m1"),
        DeliveryRecord("dlv-ok", "mail.ready", "succeeded", "m2"),
        DeliveryRecord("dlv-other", "mail.received", "failed", "m3"),
    ])
    settings = env.rebuild(auto_replay_dead_deliveries=True).settings
    body = _verifier(env, ledger=ledger, settings=settings).run()
    assert _checks(body)["webhook_delivery_failed"]["refs"] == ["dlv-dead"]
    assert len(ledger.replays) == 1
    body = _verifier(env, ledger=FakeLedger([], fail=True)).run()
    check = _checks(body)["webhook_delivery_failed"]
    assert check["count"] is None and "mail_unavailable" in check["unavailable_reason"]


def test_overdue_resume_requests(env):
    env.request_resume(case_id="case_late", name="候选人C", days_ago=4)
    env.request_resume(case_id="case_recent", name="候选人B", days_ago=1)
    _processed(env, case_id="case_done", name="候选人A", days_ago=5)
    body = env.ingest.verify()
    assert [o["case_id"] for o in body["overdue_resume_requests"]] == ["case_late"]
    assert body["overdue_resume_requests"][0]["days_waiting"] == 4
    assert body["outcome"] == "ok"  # 只是提醒，不影响 outcome
    body = _verifier(env, resume_mail_timeout_days=lambda: 5).run()
    assert body["overdue_resume_requests"] == []


def test_wrong_key_fails_verification(env):
    env = env.rebuild(mail_api_key="rdmail_wrongkey_not-real")
    body = env.ingest.verify()
    assert body["outcome"] == "failed" and body["checks"] == []
    assert "mail_auth_failed" in body["error"]
    assert env.server.verifications[body["verification_id"]]


def test_server_unavailable_fails_verification_and_is_retried(env):
    env.server.fail_next = [503, 503]  # 列表接口失败 → outcome=failed；提交也失败 → 留在 outbox
    from monitor_mail.server_api import ServerApiError

    with pytest.raises(ServerApiError):
        env.ingest.verify()
    assert env.server.verifications == {}
    env.ingest.consumer.writer.flush()
    [record] = env.server.verifications.values()
    assert record["verification"]["outcome"] == "failed"


def test_self_check(env):
    assert self_check(env.ingest.mail, env.settings) == "mbx_zhaopin"
    env.mail.scopes = ["mail.send"]
    with pytest.raises(SelfCheckError, match="mail.read"):
        self_check(env.ingest.mail, env.settings)
    env.mail.scopes = ["mail.read"]
    env.mail.primary_address = "other@remotedesk.io"
    with pytest.raises(SelfCheckError, match="other@remotedesk.io"):
        self_check(env.ingest.mail, env.settings)
    env.mail.primary_address = "bosszhipin@remotedesk.io"  # 别名配置后接受
    with pytest.raises(SelfCheckError):
        self_check(env.ingest.mail, env.settings)
    assert self_check(env.ingest.mail, env.rebuild(mailbox_aliases=("BossZhipin@remotedesk.io",)).settings)
    with pytest.raises(SelfCheckError, match="mailbox_id"):
        self_check(env.ingest.mail, env.rebuild(expected_mailbox_id="mbx_other",
                                               mailbox_aliases=("bosszhipin@remotedesk.io",)).settings)


def test_verification_id_is_deterministic_per_run(env):
    first = env.ingest.verify()
    env.clock.advance(timedelta(hours=1).total_seconds())
    second = env.ingest.verify()
    assert first["verification_id"] != second["verification_id"]
    assert len(env.server.verifications) == 2
