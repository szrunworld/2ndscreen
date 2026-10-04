"""各模块的单元测试：PDF、关联、任务表、存储、mail 与服务端访问、配置、装配。"""

from __future__ import annotations

import sqlite3
import threading
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from mail_testkit import default_settings
from monitor_mail.clock import FakeClock, parse_time, to_wire_time
from monitor_mail.config import ConfigError, MailSettings
from monitor_mail.mail_api import (
    AttachmentNotReady,
    DownloadLinkExpired,
    HttpMailApi,
    MailApiError,
    MailAuthError,
    MailNotFound,
    MailUnavailable,
    MessageDetail,
    UpstreamListingUnavailable,
)
from monitor_mail.matching import LinkDecision, decide_link, extract_hints, normalize_text
from monitor_mail.pdf_text import extract_pdf_text, is_pdf
from monitor_mail.server_api import HttpServerApi, ServerApiError
from monitor_mail.service import MailIngest
from monitor_mail.storage import LocalDirStorage, StorageError
from monitor_mail.store import MIGRATIONS, AttachmentRow, MailStore, db_time
from monitor_mail.testing import (
    FAKE_SERVER_BASE,
    FAKE_SERVICE_TOKEN,
    FakeMonitorServer,
    make_scanned_pdf,
    make_text_pdf,
    sample_resume_pdf,
)

T0 = datetime(2026, 10, 4, 2, 0, tzinfo=UTC)


# ---- 时钟 --------------------------------------------------------------------


def test_clock_and_time_helpers():
    clock = FakeClock(T0)
    assert clock.advance(minutes=5) == T0 + timedelta(minutes=5)
    with pytest.raises(ValueError):
        clock.advance(-1)
    with pytest.raises(ValueError):
        FakeClock(datetime(2026, 1, 1))
    assert parse_time("2026-09-18T18:40:00") == datetime(2026, 9, 18, 18, 40, tzinfo=UTC)  # mail 的无时区时间按 UTC
    assert parse_time("2026-10-04T10:00:00+08:00") == T0
    assert to_wire_time(T0) == "2026-10-04T02:00:00+00:00"
    with pytest.raises(ValueError):
        to_wire_time(datetime(2026, 1, 1))


# ---- PDF ---------------------------------------------------------------------


def test_pdf_text_layer_extracted():
    result = extract_pdf_text(make_text_pdf([["Page one has enough text to count as parsed."],
                                             ["Page two also has a reasonable amount of text."]]))
    assert result.parse_status == "parsed" and result.page_count == 2 and "Page two" in result.text


def test_pdf_scanned_flagged():
    result = extract_pdf_text(make_scanned_pdf(3))
    assert (result.parse_status, result.page_count, result.error) == ("suspected_scanned", 3, None)


def test_pdf_sparse_text_counts_as_scanned():
    assert extract_pdf_text(make_text_pdf([["p. 1"]])).parse_status == "suspected_scanned"


@pytest.mark.parametrize(("data", "error"), [(b"PK\x03\x04docx", "not_a_pdf"), (b"%PDF-1.4\ngarbage", "pdf_unreadable")])
def test_pdf_failures_do_not_raise(data, error):
    result = extract_pdf_text(data)
    assert result.parse_status == "failed" and result.error.startswith(error)


def test_is_pdf_uses_magic_bytes():
    assert is_pdf(sample_resume_pdf()) and not is_pdf(b"hello.pdf")


# ---- 关联 --------------------------------------------------------------------


def test_extract_hints_default_patterns():
    settings = default_settings()
    hints = extract_hints("候选人A 的简历（后端工程师）", None, settings)
    assert (hints.candidate_name, hints.job_title, hints.account_id) == ("候选人A", "后端工程师", None)
    hints = extract_hints("【数据分析师】候选人B | 3年经验", None, settings)
    assert (hints.candidate_name, hints.job_title) == ("候选人B", "数据分析师")
    hints = extract_hints("您有一份新简历", None, settings)
    assert hints.candidate_name is None and hints.job_title is None


def test_extract_hints_accounts():
    settings = default_settings(account_aliases={"账户甲": "acct_1", "账户乙": "acct_2", "账户乙分部": "acct_3"})
    assert extract_hints("x", "来自账户甲", settings).account_id == "acct_1"
    conflict = extract_hints("账户甲", "账户乙", settings)
    assert conflict.account_id is None and conflict.account_conflict


def test_normalize_text():
    assert normalize_text("  候选人　A  ") == "候选人 A"
    assert normalize_text(None) == ""


class _Commands:
    def __init__(self, records):
        self.records = records
        self.calls = []

    def list_commands(self, **kwargs):
        self.calls.append(kwargs)
        return iter(self.records)


def _record(case_id, name, job, executed_at, account="acct_1", status="succeeded", action="request_resume"):
    server = FakeMonitorServer(FakeClock(T0))
    server.add_request_resume(case_id=case_id, account_id=account, candidate_name=name, job_title=job,
                              executed_at=executed_at)
    record = server.commands[0]
    record["command"]["action"] = action
    record["result"]["status"] = status
    return record


def test_decide_link_unique_and_filters():
    settings = default_settings()
    hints = extract_hints("候选人A 的简历（后端工程师）", None, settings)
    records = [
        _record("case_1", "候选人A", "后端工程师", T0 - timedelta(days=1)),
        _record("case_x", "候选人A", "后端工程师", T0 - timedelta(days=1), status="failed"),
        _record("case_y", "候选人A", "后端工程师", T0 - timedelta(days=1), action="send_greeting"),
        _record("case_z", "候选人A", "后端工程师", T0 + timedelta(hours=1)),
    ]
    server = _Commands(records)
    decision = decide_link(hints, received_at=T0, server=server, settings=settings)
    assert decision.method == "resume_request" and decision.case_id == "case_1" and decision.linked
    assert server.calls[0]["executed_before"] == T0
    assert server.calls[0]["executed_after"] == T0 - timedelta(days=settings.request_window_days)
    assert decision.to_wire() == {"method": "resume_request", "case_id": "case_1", "command_id": decision.command_id}


def test_decide_link_account_conflict_is_unlinked():
    settings = default_settings(account_aliases={"账户甲": "acct_1", "账户乙": "acct_2"})
    hints = extract_hints("候选人A 的简历（后端工程师）", "账户甲 账户乙", settings)
    decision = decide_link(hints, received_at=T0, server=_Commands([_record("case_1", "候选人A", "后端工程师",
                                                                            T0 - timedelta(days=1))]),
                           settings=settings)
    assert decision.method == "none" and decision.reason == "account_ambiguous"
    assert decision.to_wire()["candidate_case_ids"] == ["case_1"]


def test_link_decision_unlinked_dedupes_candidates():
    assert LinkDecision.unlinked("x", ["b", "a", "b"]).candidate_case_ids == ("a", "b")


# ---- 任务表 ------------------------------------------------------------------


def _record_delivery(store, delivery_id="d1", message="00000000-0000-4000-8000-000000000001", now=T0):
    return store.record_delivery(delivery_id=delivery_id, event="mail.ready", mail_message_id=f"mail:{message}",
                                 provider_message_id=message, mailbox="zhaopin@remotedesk.io", occurred_at=now,
                                 has_attachments=True, now=now, attempt_limit=3)


def test_store_claim_lease_and_reclaim():
    store = MailStore()
    assert _record_delivery(store) == (False, True)
    task = store.claim(owner="a", now=T0, lease_seconds=60)
    assert task.lease_owner == "a"
    assert store.claim(owner="b", now=T0 + timedelta(seconds=59), lease_seconds=60) is None
    assert store.holds_lease(task.mail_message_id, "a", T0 + timedelta(seconds=59))
    again = store.claim(owner="b", now=T0 + timedelta(seconds=60), lease_seconds=60)
    assert again.lease_owner == "b"
    assert store.update_task(task.mail_message_id, owner="a", error="x") is False
    assert store.update_task(task.mail_message_id, owner="b", error="x") is True
    with pytest.raises(ValueError):
        store.update_task(task.mail_message_id, mailbox="other@x")


def test_store_concurrent_claims_succeed_once():
    store = MailStore()
    _record_delivery(store)
    barrier = threading.Barrier(8)
    results = []

    def worker(name):
        barrier.wait()
        results.append(store.claim(owner=name, now=T0, lease_seconds=60))

    threads = [threading.Thread(target=worker, args=(f"w{i}",)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sum(r is not None for r in results) == 1


def test_store_next_attempt_delays_claim():
    store = MailStore()
    _record_delivery(store)
    store.update_task("mail:00000000-0000-4000-8000-000000000001", next_attempt_at=db_time(T0 + timedelta(minutes=1)))
    assert store.claim(owner="a", now=T0, lease_seconds=60) is None
    assert store.claim(owner="a", now=T0 + timedelta(minutes=1), lease_seconds=60) is not None


def test_store_outbox_reuses_first_body():
    store = MailStore()
    first = store.prepare_request(idem_key="k1", method="PUT", path="/x", body={"a": 1}, now=T0)
    second = store.prepare_request(idem_key="k1", method="PUT", path="/x", body={"a": 2}, now=T0)
    assert first.body == second.body == {"a": 1} and not second.sent
    store.mark_sent("k1", {"ok": True}, T0)
    assert store.get_request("k1").response == {"ok": True}
    assert store.unsent_requests() == []
    assert store.get_request("missing") is None


def test_store_attachment_upsert_keeps_doc():
    store = MailStore()
    row = AttachmentRow("mail:m", "a1", "a.pdf", "application/pdf", 3, "s" * 64, "file:///x", None, None, None, None, None)
    store.upsert_attachment(row)
    store.update_attachment("mail:m", "a1", doc_id="doc_1")
    assert store.upsert_attachment(row).doc_id == "doc_1"
    changed = store.upsert_attachment(AttachmentRow(**{**row.__dict__, "sha256": "t" * 64}))
    assert changed.doc_id is None and changed.sha256 == "t" * 64
    with pytest.raises(ValueError):
        store.update_attachment("mail:m", "a1", no_such_column="x")


def test_store_migrations_and_downgrade_refused(tmp_path):
    path = str(tmp_path / "m.db")
    MailStore(path).close()
    MailStore(path).close()  # 重开不重复迁移
    conn = sqlite3.connect(path)
    conn.execute(f"PRAGMA user_version = {len(MIGRATIONS) + 1}")
    conn.close()
    with pytest.raises(RuntimeError, match="拒绝降级"):
        MailStore(path)


def test_db_time_requires_timezone():
    with pytest.raises(ValueError):
        db_time(datetime(2026, 1, 1))


# ---- 存储 --------------------------------------------------------------------


def test_local_storage_roundtrip(tmp_path):
    storage = LocalDirStorage(tmp_path)
    uri = storage.put("messages/a.json", b"data")
    assert uri.startswith("file://") and storage.get(uri) == b"data"
    assert storage.put("messages/a.json", b"new") == uri and storage.get(uri) == b"new"
    assert storage.delete(uri) is True and storage.delete(uri) is False
    assert storage.get(uri) is None


@pytest.mark.parametrize("key", ["../escape", "/abs", "a/../../b", "空格 key"])
def test_local_storage_rejects_bad_keys(tmp_path, key):
    with pytest.raises(StorageError):
        LocalDirStorage(tmp_path).put(key, b"x")


def test_local_storage_rejects_foreign_uris(tmp_path):
    storage = LocalDirStorage(tmp_path / "root")
    with pytest.raises(StorageError):
        storage.get("s3://bucket/key")
    with pytest.raises(StorageError):
        storage.get((tmp_path / "elsewhere").as_uri())


# ---- mail 访问 ---------------------------------------------------------------


def _mail_api(handler) -> HttpMailApi:
    return HttpMailApi(base_url="https://mail.test/api/mail", api_key="k",
                       client=httpx.Client(transport=httpx.MockTransport(handler)))


@pytest.mark.parametrize(
    ("status", "error"),
    [(401, MailAuthError), (403, MailAuthError), (404, MailNotFound), (409, AttachmentNotReady),
     (423, AttachmentNotReady), (429, MailUnavailable), (503, MailUnavailable), (400, MailApiError)],
)
def test_mail_api_error_mapping(status, error):
    api = _mail_api(lambda r: httpx.Response(status, json={"detail": "x"}))
    with pytest.raises(error) as exc:
        api.get_message("m1")
    assert exc.value.status == status


def test_mail_api_network_error_is_transient():
    def boom(request):
        raise httpx.ConnectError("refused")
    with pytest.raises(MailUnavailable) as exc:
        _mail_api(boom).get_mailbox()
    assert exc.value.transient


@pytest.mark.parametrize("body", [{"no": "envelope"}, {"code": 1, "message": "bad", "data": {}}, [1]])
def test_mail_api_envelope_required(body):
    with pytest.raises(MailApiError):
        _mail_api(lambda r: httpx.Response(200, json=body)).get_mailbox()


def test_mail_api_sends_key_and_unwraps_envelope():
    seen = {}

    def handler(request):
        seen["key"] = request.headers.get("X-Mail-Api-Key")
        seen["path"] = request.url.path
        return httpx.Response(200, json={"code": 0, "message": "ok", "data": {
            "mailbox_id": "mbx", "primary_address": "zhaopin@remotedesk.io", "scopes": ["mail.read"], "key_name": "k"}})

    info = _mail_api(handler).get_mailbox()
    assert info.scopes == ("mail.read",) and seen == {"key": "k", "path": "/api/mail/v1/integration/mailbox"}


def test_mail_api_download_does_not_leak_key_and_maps_expiry():
    seen = {}

    def handler(request):
        seen["key"] = request.headers.get("X-Mail-Api-Key")
        return httpx.Response(403, text="expired")

    with pytest.raises(DownloadLinkExpired):
        _mail_api(handler).download("https://objects.test/x")
    assert seen["key"] is None
    with pytest.raises(MailUnavailable):
        _mail_api(lambda r: httpx.Response(502)).download("https://objects.test/x")
    with pytest.raises(MailApiError):
        _mail_api(lambda r: httpx.Response(404)).download("https://objects.test/x")


@pytest.mark.parametrize("status", [404, 405])
def test_mail_api_listing_unavailable(status):
    with pytest.raises(UpstreamListingUnavailable):
        _mail_api(lambda r: httpx.Response(status, json={"detail": "x"})).list_messages(since=T0)


def test_mail_api_listing_parses_items():
    api = _mail_api(lambda r: httpx.Response(200, json={"code": 0, "message": "ok", "data": {
        "items": [{"message_id": "m1", "received_at": "2026-10-04T02:00:00"}], "next_cursor": "c2"}}))
    page = api.list_messages(since=T0, cursor="c1")
    assert page.items[0].message_id == "m1" and page.next_cursor == "c2"


def test_message_detail_rejects_bad_shape():
    with pytest.raises(MailApiError):
        MessageDetail.from_data({"subject": "no id"})


def test_mail_api_requires_config():
    with pytest.raises(ValueError):
        HttpMailApi(base_url="", api_key="k")


# ---- 服务端访问 --------------------------------------------------------------


def test_server_api_pages_through_lists():
    server = FakeMonitorServer(FakeClock(T0))
    server.page_size = 2
    for i in range(5):
        server.add_request_resume(case_id=f"case_{i}", account_id="acct_1", candidate_name=f"候选人{i}",
                                  job_title="后端工程师", executed_at=T0 - timedelta(hours=i))
    api = HttpServerApi(base_url=FAKE_SERVER_BASE, service_token=FAKE_SERVICE_TOKEN, client=server.client())
    items = list(api.list_commands(action="request_resume", statuses=["succeeded"],
                                   executed_after=T0 - timedelta(hours=3), executed_before=T0))
    assert sorted(i["case_id"] for i in items) == ["case_0", "case_1", "case_2", "case_3"]


def test_server_api_problem_parsing():
    server = FakeMonitorServer(FakeClock(T0))
    api = HttpServerApi(base_url=FAKE_SERVER_BASE, service_token="wrong", client=server.client())
    with pytest.raises(ServerApiError) as exc:
        list(api.list_mail_messages(statuses=["failed"]))
    assert exc.value.status == 401 and exc.value.code == "unauthorized" and not exc.value.transient
    server.fail_next = [503]
    good = HttpServerApi(base_url=FAKE_SERVER_BASE, service_token=FAKE_SERVICE_TOKEN, client=server.client())
    with pytest.raises(ServerApiError) as exc:
        list(good.list_resume_documents(case_id="c"))
    assert exc.value.transient


def test_server_api_network_error_is_transient():
    def boom(request):
        raise httpx.ReadTimeout("slow")
    api = HttpServerApi(base_url=FAKE_SERVER_BASE, service_token="t",
                        client=httpx.Client(transport=httpx.MockTransport(boom)))
    with pytest.raises(ServerApiError) as exc:
        api.post_mail_verification({}, "verify:abcdefgh")
    assert exc.value.transient and exc.value.status is None
    with pytest.raises(ValueError):
        HttpServerApi(base_url="", service_token="t")


def test_fake_server_rejects_reused_idempotency_key():
    server = FakeMonitorServer(FakeClock(T0))
    api = HttpServerApi(base_url=FAKE_SERVER_BASE, service_token=FAKE_SERVICE_TOKEN, client=server.client())
    body = {"mail_message_id": "mail:00000000-0000-4000-8000-000000000001", "provider": "remotedesk-mail",
            "provider_message_id": "00000000-0000-4000-8000-000000000001", "mailbox": "zhaopin@remotedesk.io",
            "message_id": None, "received_at": "2026-10-04T02:00:00+00:00", "sha256": None, "status": "pending",
            "updated_at": "2026-10-04T02:00:00+00:00"}
    api.put_mail_message(body["mail_message_id"], body, "mail:k1:pending:0")
    with pytest.raises(ServerApiError) as exc:
        api.put_mail_message(body["mail_message_id"], {**body, "subject": "x"}, "mail:k1:pending:0")
    assert exc.value.code == "idempotency_key_reused"


# ---- 配置与装配 --------------------------------------------------------------


def test_settings_validation():
    with pytest.raises(ConfigError):
        MailSettings(max_attempts=0)
    with pytest.raises(ConfigError):
        MailSettings(subject_patterns=(r"(?P<name>.+)",))
    with pytest.raises(ConfigError):
        MailSettings(boss_sender_allowlist=("zhipin.example",))
    with pytest.raises(ConfigError, match="webhook_secret"):
        MailSettings().require_secrets()
    settings = MailSettings(mailbox=" ZhaoPin@RemoteDesk.io ", boss_sender_allowlist=("@ZHIPIN.example",))
    assert settings.mailbox == "zhaopin@remotedesk.io" and settings.boss_sender_allowlist == ("@zhipin.example",)


def test_settings_from_env():
    settings = MailSettings.from_env({
        "MONITOR_MAIL_WEBHOOK_SECRET": "s", "MONITOR_MAIL_API_BASE_URL": "https://m/api/mail",
        "MONITOR_MAIL_API_KEY": "k", "MONITOR_MAIL_MAILBOX_ALIASES": "bosszhipin@remotedesk.io",
        "MONITOR_MAIL_BOSS_SENDERS": "@zhipin.example, a@b.example",
        "MONITOR_MAIL_ACCOUNT_ALIASES": "账户甲=acct_1",
        "MONITOR_MAIL_SUBJECT_PATTERNS": r"^(?P<name>\S+)-(?P<job>\S+)$",
    })
    settings.require_secrets()
    assert settings.mailbox_addresses == {"zhaopin@remotedesk.io", "bosszhipin@remotedesk.io"}
    assert settings.boss_sender_allowlist == ("@zhipin.example", "a@b.example")
    assert settings.account_aliases == {"账户甲": "acct_1"}
    assert extract_hints("甲-工程师", None, settings).job_title == "工程师"
    with pytest.raises(ConfigError):
        MailSettings.from_env({"MONITOR_MAIL_ACCOUNT_ALIASES": "no-equals"})


def test_from_settings_requires_secrets(tmp_path):
    server = FakeMonitorServer(FakeClock(T0))
    api = HttpServerApi(base_url=FAKE_SERVER_BASE, service_token=FAKE_SERVICE_TOKEN, client=server.client())
    with pytest.raises(ConfigError):
        MailIngest.from_settings(MailSettings(), db_path=tmp_path / "m.db", storage_root=tmp_path, server=api)
    ingest = MailIngest.from_settings(default_settings(), db_path=tmp_path / "m.db", storage_root=tmp_path / "b",
                                      server=api)
    assert ingest.store.list_tasks() == []


def test_run_forever_stops(env):
    stop = threading.Event()
    calls = []
    original = env.ingest.run_cycle

    def cycle(*args, **kwargs):
        calls.append(1)
        if len(calls) == 2:
            stop.set()
        if len(calls) == 1:
            raise RuntimeError("一次异常不能让循环退出")
        return original(*args, **kwargs)

    env.ingest.run_cycle = cycle
    env.ingest.run_forever(stop, idle_seconds=0)
    assert len(calls) == 2
    assert env.ingest.startup_check() == "mbx_zhaopin"
