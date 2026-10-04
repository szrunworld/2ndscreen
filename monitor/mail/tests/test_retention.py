"""我方副本保留期清理：删副本与解析文本，保留元数据与清理记录；不碰 mail 里的邮件。"""

from __future__ import annotations

import pytest

from monitor_mail.retention import purge_expired_copies, purge_key
from monitor_mail.testing import FakeAttachment, sample_resume_pdf


def _processed(env) -> str:
    env.request_resume()
    message_id = env.boss_mail()
    env.deliver(message_id)
    env.ingest.run_cycle()
    return f"mail:{message_id}"


def _purge(env, days=30):
    return purge_expired_copies(store=env.store, storage=env.storage, writer=env.ingest.consumer.writer,
                                clock=env.clock, retention_days=days)


def test_copies_kept_within_retention(env):
    mail_message_id = _processed(env)
    env.clock.advance(days=29)
    assert _purge(env) == 0
    assert env.store.get_task(mail_message_id).raw_storage_uri is not None


def test_expired_copies_purged_metadata_kept(env):
    mail_message_id = _processed(env)
    task = env.store.get_task(mail_message_id)
    [attachment] = env.store.list_attachments(mail_message_id)
    uris = [task.raw_storage_uri, attachment.storage_uri, attachment.text_storage_uri]
    mail_calls_before = list(env.mail.calls)
    env.clock.advance(days=30, seconds=1)
    assert _purge(env) == 1
    assert all(env.storage.get(uri) is None for uri in uris)
    purged = env.store.get_task(mail_message_id)
    assert purged.raw_storage_uri is None and purged.copy_purged_at is not None
    assert purged.sha256 == task.sha256 and purged.status == "processed"
    [kept] = env.store.list_attachments(mail_message_id)
    assert kept.doc_id == attachment.doc_id and kept.sha256 == attachment.sha256 and kept.purged_at
    [log] = env.store.list_purges()
    assert log["mail_message_id"] == mail_message_id and log["blobs_deleted"] == 3 and log["retention_days"] == 30
    record = env.server.mail_messages[mail_message_id]
    assert record["copy_purged_at"] is not None and record["raw_storage_uri"] is None
    assert record["sha256"] == task.sha256
    assert env.store.get_request(purge_key(mail_message_id, "processed", 0)).sent
    # 不调用 mail 的任何接口（不删除、不移动 mail 里的邮件）
    assert env.mail.calls == mail_calls_before
    # 再跑一次不重复清理
    assert _purge(env) == 0


def test_pending_tasks_not_purged(env):
    message_id = env.boss_mail(attachments=[FakeAttachment("att1", "a.pdf", sample_resume_pdf(), scan_status="pending")])
    env.deliver(message_id)
    env.ingest.run_cycle()
    env.clock.advance(days=40)
    assert _purge(env) == 0
    assert env.store.get_task(f"mail:{message_id}").raw_storage_uri is not None


def test_policy_callable_and_bounds(env):
    _processed(env)
    env.clock.advance(days=8)
    assert _purge(env, days=lambda: 7) == 1
    with pytest.raises(ValueError):
        _purge(env, days=0)
    with pytest.raises(ValueError):
        _purge(env, days=366)


def test_purge_after_manual_link_follows_server_status(env):
    """needs_review 的邮件被人工关联（服务端 processed）后清理：以服务端状态回报。"""
    message_id = env.boss_mail()
    env.deliver(message_id)
    env.ingest.run_cycle()
    mail_message_id = f"mail:{message_id}"
    assert env.store.get_task(mail_message_id).status == "needs_review"
    env.server.manual_link(mail_message_id)
    env.clock.advance(days=31)
    assert _purge(env) == 1
    assert env.store.get_task(mail_message_id).status == "processed"
    record = env.server.mail_messages[mail_message_id]
    assert record["status"] == "processed" and record["copy_purged_at"] is not None


def test_purge_report_survives_server_outage(env):
    mail_message_id = _processed(env)
    env.clock.advance(days=31)
    env.server.fail_next = [503]
    assert _purge(env) == 1
    assert env.server.mail_messages[mail_message_id]["copy_purged_at"] is None
    sent, remaining = env.ingest.consumer.writer.flush()
    assert (sent, remaining) == (1, 0)
    assert env.server.mail_messages[mail_message_id]["copy_purged_at"] is not None
