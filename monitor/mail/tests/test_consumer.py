"""消费者：回取、白名单、去重、关联、写服务端、失败计数、崩溃重领。"""

from __future__ import annotations

import httpx
import pytest

from mail_testkit import BOSS_SENDER
from monitor_mail.testing import FakeAttachment, make_scanned_pdf, sample_resume_pdf


def _process(env, message_id: str):
    env.deliver(message_id)
    report = env.ingest.run_cycle()
    return report, env.store.get_task(f"mail:{message_id}")


def _docs(env, message_id: str):
    return [d for d in env.server.documents.values() if d["mail_message_id"] == f"mail:{message_id}"]


# ---- 正常路径 ----------------------------------------------------------------


def test_unique_match_is_linked_and_processed(env):
    command_id = env.request_resume()
    message_id = env.boss_mail()
    report, task = _process(env, message_id)
    assert report.registered == 1
    assert task.status == "processed" and task.error is None and task.sha256
    [doc] = _docs(env, message_id)
    assert doc["case_id"] == "case_1" and doc["link_method"] == "resume_request"
    assert doc["_link"]["command_id"] == command_id
    assert doc["parse_status"] == "parsed" and doc["_parse"]["page_count"] == 1
    record = env.server.mail_messages[f"mail:{message_id}"]
    assert record["status"] == "processed" and record["sha256"] == task.sha256
    assert record["webhook_delivery_id"] and record["subject"] == "候选人A 的简历（后端工程师）"
    # 我方副本、附件、解析文本都在存储里
    assert env.storage.get(task.raw_storage_uri) is not None
    [attachment] = env.store.list_attachments(task.mail_message_id)
    assert env.storage.get(attachment.storage_uri) == sample_resume_pdf()
    assert b"Candidate A resume" in env.storage.get(attachment.text_storage_uri)
    assert attachment.doc_id == doc["doc_id"]


def test_pending_is_registered_before_processing(env):
    env.request_resume()
    message_id = env.boss_mail()
    _process(env, message_id)
    puts = [(m, p) for m, p in env.server.requests if m == "PUT"]
    assert puts[0] == ("PUT", f"/mail-messages/mail:{message_id}")
    first_key_body = env.store.get_request(f"mail:{message_id}:pending:0")
    assert first_key_body.body["status"] == "pending" and first_key_body.body["sha256"] is None


def test_replayed_webhook_after_processing_does_not_duplicate(env):
    env.request_resume()
    message_id = env.boss_mail()
    _process(env, message_id)
    status, content = env.deliver(message_id, delivery_id="replay-1")
    assert status == 200 and content["duplicate"] is True
    report = env.ingest.run_cycle()
    assert report.outcomes == []
    assert len(_docs(env, message_id)) == 1
    assert env.mail.calls.count(f"GET /api/mail/v1/integration/messages/{message_id}") == 1


# ---- 白名单 ------------------------------------------------------------------


def test_non_boss_sender_is_ignored_without_downloading(env):
    message_id = env.boss_mail(from_address="someone@other.example")
    _, task = _process(env, message_id)
    assert task.status == "ignored" and task.error == "non_boss_sender"
    assert _docs(env, message_id) == []
    assert not any("download" in c for c in env.mail.calls)
    assert env.server.mail_messages[f"mail:{message_id}"]["status"] == "ignored"


def test_exact_address_allowlist(env):
    env = env.rebuild(boss_sender_allowlist=(BOSS_SENDER,))
    env.request_resume()
    message_id = env.boss_mail()
    assert _process(env, message_id)[1].status == "processed"
    other = env.boss_mail(from_address="another@zhipin.example")
    assert _process(env, other)[1].status == "ignored"


def test_empty_allowlist_goes_to_review_without_guessing(env):
    env = env.rebuild(boss_sender_allowlist=())
    env.request_resume()
    message_id = env.boss_mail()
    _, task = _process(env, message_id)
    assert task.status == "needs_review" and task.error == "sender_unverified"
    [doc] = _docs(env, message_id)
    # 写了文档供人工关联，但不自动关联；唯一命中的流程作为建议列出
    assert doc["case_id"] is None and doc["link_method"] == "none"
    assert doc["_link"]["candidate_case_ids"] == ["case_1"]


# ---- 关联歧义 ----------------------------------------------------------------


def test_same_name_multiple_candidates_needs_review(env):
    env.request_resume(case_id="case_1", account_id="acct_1")
    env.request_resume(case_id="case_2", account_id="acct_2")
    message_id = env.boss_mail()
    _, task = _process(env, message_id)
    assert task.status == "needs_review" and task.error == "ambiguous_cases"
    [doc] = _docs(env, message_id)
    assert doc["link_method"] == "none" and sorted(doc["_link"]["candidate_case_ids"]) == ["case_1", "case_2"]
    assert env.server.mail_messages[f"mail:{message_id}"]["status"] == "needs_review"


def test_account_alias_disambiguates(env):
    env = env.rebuild(account_aliases={"招聘账户甲": "acct_1", "招聘账户乙": "acct_2"})
    env.request_resume(case_id="case_1", account_id="acct_1")
    env.request_resume(case_id="case_2", account_id="acct_2")
    message_id = env.boss_mail(text="来自 招聘账户乙 的候选人简历")
    _, task = _process(env, message_id)
    assert task.status == "processed"
    assert _docs(env, message_id)[0]["case_id"] == "case_2"


def test_two_requests_in_same_case_still_unique(env):
    env.request_resume(case_id="case_1", days_ago=2)
    latest = env.request_resume(case_id="case_1", days_ago=1)
    message_id = env.boss_mail()
    _, task = _process(env, message_id)
    assert task.status == "processed"
    assert _docs(env, message_id)[0]["_link"]["command_id"] == latest


@pytest.mark.parametrize(
    ("setup", "reason"),
    [
        (lambda env: None, "no_resume_request"),
        (lambda env: env.request_resume(job="前端工程师"), "job_mismatch"),
        (lambda env: env.request_resume(days_ago=45), "no_resume_request"),
    ],
)
def test_no_unique_match_needs_review(env, setup, reason):
    setup(env)
    message_id = env.boss_mail()
    _, task = _process(env, message_id)
    assert task.status == "needs_review" and task.error == reason


def test_unparseable_subject_needs_review(env):
    env.request_resume()
    message_id = env.boss_mail(subject="您有一份新简历")
    _, task = _process(env, message_id)
    assert task.status == "needs_review" and task.error == "hints_missing"


def test_request_after_mail_arrival_is_not_used(env):
    env.request_resume(days_ago=-0.5)  # 求简历在收信之后
    message_id = env.boss_mail()
    assert _process(env, message_id)[1].status == "needs_review"


# ---- 附件 --------------------------------------------------------------------


def test_two_attachments_two_documents(env):
    env.request_resume()
    message_id = env.boss_mail(attachments=[
        FakeAttachment("att1", "简历.pdf", sample_resume_pdf("Candidate A")),
        FakeAttachment("att2", "作品集.pdf", sample_resume_pdf("Portfolio")),
    ])
    _, task = _process(env, message_id)
    docs = _docs(env, message_id)
    assert task.status == "processed" and len(docs) == 2
    assert {d["case_id"] for d in docs} == {"case_1"}
    assert sorted(d["version"] for d in docs) == [1, 2]


def test_identical_attachments_deduplicated_by_sha256(env):
    env.request_resume()
    pdf = sample_resume_pdf()
    message_id = env.boss_mail(attachments=[FakeAttachment("att1", "a.pdf", pdf), FakeAttachment("att2", "b.pdf", pdf)])
    _process(env, message_id)
    [doc] = _docs(env, message_id)
    assert {a.doc_id for a in env.store.list_attachments(f"mail:{message_id}")} == {doc["doc_id"]}


def test_inline_and_non_resume_attachments_skipped(env):
    env.request_resume()
    message_id = env.boss_mail(attachments=[
        FakeAttachment("logo", "logo.png", b"\x89PNG", content_type="image/png", is_inline=True),
        FakeAttachment("att1", "简历.pdf", sample_resume_pdf()),
    ])
    _process(env, message_id)
    assert len(_docs(env, message_id)) == 1
    assert not any("/attachments/logo/" in c for c in env.mail.calls)


def test_no_resume_attachment_needs_review(env):
    env.request_resume()
    message_id = env.boss_mail(attachments=[])
    _, task = _process(env, message_id)
    assert task.status == "needs_review" and task.error == "no_resume_attachment"
    assert task.sha256 is not None  # needs_review 也必须有副本


def test_scanned_pdf_is_flagged_not_ocred(env):
    env.request_resume()
    message_id = env.boss_mail(attachments=[FakeAttachment("att1", "扫描件.pdf", make_scanned_pdf())])
    _, task = _process(env, message_id)
    [doc] = _docs(env, message_id)
    assert task.status == "processed"
    assert doc["parse_status"] == "suspected_scanned" and doc["_parse"]["text_storage_uri"] is None


def test_docx_attachment_written_without_parse(env):
    env.request_resume()
    message_id = env.boss_mail(attachments=[FakeAttachment(
        "att1", "简历.docx", b"PK\x03\x04fake-docx",
        content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document")])
    _process(env, message_id)
    [doc] = _docs(env, message_id)
    assert doc["_parse"] is None and doc["parse_status"] == "pending"


@pytest.mark.parametrize("not_ready_status", [409, 423])
def test_attachment_not_scanned_retries_then_succeeds(env, not_ready_status):
    env.mail.not_ready_status = not_ready_status
    env.request_resume()
    message_id = env.boss_mail(attachments=[FakeAttachment("att1", "简历.pdf", sample_resume_pdf(), scan_status="pending")])
    report, task = _process(env, message_id)
    assert task.status == "pending" and task.attempts == 1 and task.error.startswith("attachment_not_ready")
    assert env.server.mail_messages[f"mail:{message_id}"]["attempts"] == 1
    # 退避期内不重领
    assert env.ingest.run_cycle().outcomes == []
    env.mail.messages[message_id].attachments[0].scan_status = "clean"
    env.clock.advance(61)
    env.ingest.run_cycle()
    task = env.store.get_task(f"mail:{message_id}")
    assert task.status == "processed" and task.attempts == 1
    assert len(_docs(env, message_id)) == 1


def test_three_failures_mark_failed(env):
    message_id = env.boss_mail(attachments=[FakeAttachment("att1", "简历.pdf", sample_resume_pdf(), scan_status="pending")])
    env.deliver(message_id)
    for _ in range(3):
        env.ingest.run_cycle()
        env.clock.advance(3600)
    task = env.store.get_task(f"mail:{message_id}")
    assert task.status == "failed" and task.attempts == 3 and task.error
    record = env.server.mail_messages[f"mail:{message_id}"]
    assert record["status"] == "failed" and record["error"] and record["attempts"] == 3
    env.clock.advance(3600)
    assert env.ingest.run_cycle().outcomes == []  # failed 不再被领取


def test_failed_can_be_requeued_manually(env):
    env.request_resume()
    message_id = env.boss_mail(attachments=[FakeAttachment("att1", "简历.pdf", sample_resume_pdf(), scan_status="pending")])
    env.deliver(message_id)
    for _ in range(3):
        env.ingest.run_cycle()
        env.clock.advance(3600)
    assert env.ingest.requeue(f"mail:{message_id}") is True
    assert env.server.mail_messages[f"mail:{message_id}"]["status"] == "pending"
    env.mail.messages[message_id].attachments[0].scan_status = "clean"
    env.ingest.run_cycle()
    assert env.store.get_task(f"mail:{message_id}").status == "processed"
    assert env.ingest.requeue(f"mail:{message_id}") is False  # processed 不能重试
    assert env.ingest.requeue("mail:00000000-0000-4000-8000-000000000000") is False


def test_expired_download_link_is_refetched(env):
    env.request_resume()
    env.mail.expire_next_links = 1
    message_id = env.boss_mail()
    _, task = _process(env, message_id)
    assert task.status == "processed"
    assert sum("download" in c for c in env.mail.calls) == 2


def test_link_expired_twice_counts_as_failure(env):
    env.request_resume()
    env.mail.expire_next_links = 2
    message_id = env.boss_mail()
    _, task = _process(env, message_id)
    assert task.status == "pending" and task.attempts == 1 and task.error.startswith("download_link_expired")


def test_wrong_api_key_counts_as_failure(env):
    env = env.rebuild(mail_api_key="rdmail_wrongkey_not-real")
    message_id = env.boss_mail()
    _, task = _process(env, message_id)
    assert task.status == "pending" and task.attempts == 1 and task.error.startswith("mail_auth_failed")


def test_mail_5xx_counts_as_failure(env):
    message_id = env.boss_mail()
    env.mail.fail_next = [503]
    _, task = _process(env, message_id)
    assert task.attempts == 1 and task.error.startswith("mail_unavailable")


def test_server_outage_does_not_burn_attempts(env):
    env.request_resume()
    message_id = env.boss_mail()
    env.deliver(message_id)
    env.server.fail_next = [503] * 3
    report = env.ingest.run_cycle()
    task = env.store.get_task(f"mail:{message_id}")
    assert task.status == "pending" and task.attempts == 0
    assert report.outcomes == [] or report.outcomes[0].error.startswith("server_unavailable")
    env.clock.advance(61)
    env.ingest.run_cycle()
    env.clock.advance(61)
    env.ingest.run_cycle()
    assert env.store.get_task(f"mail:{message_id}").status == "processed"
    assert len(_docs(env, message_id)) == 1


# ---- 崩溃与重领 --------------------------------------------------------------


class Crash(Exception):
    pass


def _crash_after(env, method: str, path_prefix: str):
    """服务端照常处理请求，但调用方在拿到响应前"崩溃"（模拟进程被杀）。"""
    def handler(request: httpx.Request) -> httpx.Response:
        response = env.server.handle(request)
        if request.method == method and request.url.path.removeprefix("/api/v1").startswith(path_prefix):
            raise Crash(path_prefix)
        return response
    return handler


@pytest.mark.parametrize(
    ("method", "path"),
    [("POST", "/resume-documents"), ("PUT", "/mail-messages/")],
)
def test_crash_and_reclaim_does_not_duplicate(env, method, path):
    env.request_resume()
    message_id = env.boss_mail(attachments=[
        FakeAttachment("att1", "简历.pdf", sample_resume_pdf("Candidate A")),
        FakeAttachment("att2", "作品集.pdf", sample_resume_pdf("Portfolio")),
    ])
    env.deliver(message_id)
    env.ingest.consumer.register_pending()
    crashing = env.with_server_handler(_crash_after(env, method, path))
    with pytest.raises(Crash):
        crashing.consumer.process_next()
    # 租约未过期时别的进程领不到
    restarted = env.rebuild().ingest
    assert restarted.consumer.process_next() is None
    env.clock.advance(env.settings.lease_seconds + 1)
    outcome = restarted.consumer.process_next()
    assert outcome.status == "processed"
    assert len(_docs(env, message_id)) == 2
    assert env.server.mail_messages[f"mail:{message_id}"]["status"] == "processed"
    # 副本只取了一次：重领直接用已存的副本
    assert env.mail.calls.count(f"GET /api/mail/v1/integration/messages/{message_id}") == 1


def test_lost_lease_abandons_processing(env):
    env.request_resume()
    message_id = env.boss_mail()
    env.deliver(message_id)
    consumer = env.ingest.consumer
    task = env.store.claim(owner="someone-else", now=env.clock.now(), lease_seconds=10)
    env.clock.advance(11)
    stolen = consumer.store.claim(owner=consumer.owner, now=env.clock.now(), lease_seconds=300)
    # 原持有者的租约已被接手
    assert stolen.mail_message_id == task.mail_message_id
    other = env.rebuild().ingest.consumer
    outcome = other.process(task)
    assert outcome.error == "lease_lost"
    assert consumer.process(stolen).status == "processed"


def test_manual_review_resolution_on_server_is_respected(env):
    """服务端已被人工推进时，消费者以服务端状态为准（409 illegal_mail_transition）。"""
    env.request_resume()
    message_id = env.boss_mail()
    env.deliver(message_id)
    env.ingest.consumer.register_pending()
    env.server.mail_messages[f"mail:{message_id}"]["status"] = "ignored"
    outcome = env.ingest.consumer.process_next()
    assert outcome.status == "ignored"


def test_overlong_header_fields_are_clipped_to_contract(env):
    env.request_resume()
    sender = "x" * 300 + "@zhipin.example"
    message_id = env.boss_mail(from_address=sender, subject="候选人A 的简历（后端工程师）" + "备注" * 400)
    _, task = _process(env, message_id)
    record = env.server.mail_messages[f"mail:{message_id}"]
    assert task.status == "processed"
    assert len(record["from_address"]) == 254 and len(record["subject"]) == 500
