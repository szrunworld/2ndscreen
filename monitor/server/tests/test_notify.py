"""通知：事件 → 控制台待办 + Webhook 推送；去重、失败记录、签名、标记已处理。"""

from __future__ import annotations

import hashlib
import hmac
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from server_testkit import (
    ACCOUNT,
    SERVICE_TOKEN,
    Harness,
    make_event,
    mail_body,
    post_events,
    put_mail,
    vector,
)

from app.db import FakeClock, SqliteStore
from app.main import create_app
from app.notify import CaseNeedsHuman, Notification, WebhookError, WebhookNotifier, urllib_post


class FakePost:
    """记录 Webhook 请求；statuses 依次返回（耗尽后返回最后一个），值为异常时抛出。"""

    def __init__(self, *statuses):
        self.statuses = list(statuses) or [200]
        self.calls: list[tuple[str, bytes, dict]] = []

    def __call__(self, url, body, headers, timeout):
        self.calls.append((url, body, headers))
        status = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
        if isinstance(status, Exception):
            raise status
        return status


def with_webhook(h: Harness, *statuses, secret: str | None = "s3cret") -> FakePost:
    post = FakePost(*statuses)
    h.ctx.notifications.notifiers.append(WebhookNotifier("https://hooks.example.invalid/x", secret=secret, post=post))
    return post


def todos(h: Harness) -> list[dict]:
    return h.ctx.notifications.console.list_open().items


# ---------------------------------------------------------------------------
# 触发
# ---------------------------------------------------------------------------


def test_login_required_creates_todo_and_push_once(h: Harness):
    post = with_webhook(h)
    device_id, token = h.register()
    event = make_event(device_id, "event_login_required")
    post_events(h, device_id, token, [event])
    post_events(h, device_id, token, [event])  # 重复事件不重复通知
    items = todos(h)
    assert len(items) == 1
    todo = items[0]
    assert (todo["kind"], todo["severity"], todo["device_id"], todo["account_id"]) == (
        "login_required", "critical", device_id, ACCOUNT,
    )
    assert todo["body"] == "请在本机 BOSS 客户端完成登录"  # local 模式
    assert todo["ref"] == {"kind": "device", "id": device_id}
    assert len(post.calls) == 1
    url, body, headers = post.calls[0]
    payload = json.loads(body)
    assert payload["notification_id"] == todo["notification_id"] == headers["X-Monitor-Notification-Id"]
    expected = "sha256=" + hmac.new(b"s3cret", body, hashlib.sha256).hexdigest()
    assert headers["X-Monitor-Signature"] == expected
    deliveries = h.ctx.notifications.store.deliveries(todo["notification_id"])
    assert [(d["channel"], d["status"], d["attempts"]) for d in deliveries] == [("webhook", "delivered", 1)]


def test_remote_login_required_and_login_qr(h: Harness):
    device_id, token = h.register("remote")
    post_events(
        h,
        device_id,
        token,
        [make_event(device_id, "event_login_required", mode="remote"), make_event(device_id, "event_login_qr")],
    )
    kinds = {t["kind"]: t for t in todos(h)}
    assert "扫码" in kinds["login_required"]["body"]
    assert kinds["login_qr"]["title"] == "设备需要登录"
    assert "https://" not in json.dumps(kinds["login_qr"])  # 不含二维码内容


def test_blocked_by_dialog(h: Harness):
    device_id, token = h.register()
    post_events(h, device_id, token, [make_event(device_id, "event_blocked_by_dialog")])
    (todo,) = todos(h)
    assert todo["kind"] == "blocked_by_dialog" and "操作过于频繁" in todo["body"]
    assert "候选人A" not in json.dumps(todo)  # 通知里不放候选人姓名


def test_unrelated_events_do_not_notify(h: Harness):
    device_id, token = h.register()
    post_events(h, device_id, token, [make_event(device_id, "event_application_observed")])
    assert todos(h) == []


def test_case_needs_human_from_f2(h: Harness):
    post = with_webhook(h)
    h.ctx.bus.publish(CaseNeedsHuman("case_9", ACCOUNT, "resume_mail_timeout", "tl_1"))
    h.ctx.bus.publish(CaseNeedsHuman("case_9", ACCOUNT, "resume_mail_timeout", "tl_1"))
    h.ctx.bus.publish(CaseNeedsHuman("case_9", ACCOUNT, "result_unknown", "tl_2"))
    items = todos(h)
    assert [(t["kind"], t["ref"]["id"]) for t in items] == [("case_needs_human", "case_9")] * 2
    assert len(post.calls) == 2


def test_mail_failed_and_verification_alerts(h: Harness):
    put_mail(h, mail_body("mail_message_failed"))  # 首次写入即 failed
    issues = vector("mail_verification_issues")
    assert h.post("/mail-verifications", issues, token=SERVICE_TOKEN).status_code == 201
    ok_body = vector("mail_verification_ok_with_overdue")
    ok_body["verification_id"] = "verify-ok"
    assert h.post("/mail-verifications", ok_body, token=SERVICE_TOKEN).status_code == 201
    failed = vector("mail_verification_failed")
    failed["verification_id"] = "verify-failed"
    assert h.post("/mail-verifications", failed, token=SERVICE_TOKEN).status_code == 201
    by_kind = sorted((t["kind"], t["title"]) for t in todos(h))
    assert by_kind == [
        ("mail_failed", "简历邮件处理失败"),
        ("mail_verification", "邮箱核对发现问题"),
        ("mail_verification", "邮箱核对失败"),
    ]
    issue = next(t for t in todos(h) if t["ref"]["id"] == "verify-20261004T1100")
    assert issue["body"] == "发现问题：webhook_delivery_failed=2"


def test_mail_pending_does_not_notify(h: Harness):
    put_mail(h, mail_body())
    assert todos(h) == []


# ---------------------------------------------------------------------------
# 适配器
# ---------------------------------------------------------------------------


def test_webhook_failure_is_recorded_and_todo_kept(h: Harness):
    failing = with_webhook(h, 500)
    working = with_webhook(h, ConnectionError("down"), 204, secret=None)
    h.ctx.bus.publish(CaseNeedsHuman("case_1", ACCOUNT, "x", "1"))
    (todo,) = todos(h)
    assert len(failing.calls) == 3  # 立即重试到上限
    assert "X-Monitor-Signature" not in working.calls[0][2]
    deliveries = h.ctx.notifications.store.deliveries(todo["notification_id"])
    assert [(d["status"], d["attempts"]) for d in deliveries] == [("failed", 3), ("delivered", 2)]
    assert "HTTP 500" in deliveries[0]["last_error"]


def test_webhook_notifier_direct():
    n = Notification("ntf_1", "login_required", "critical", "t", "b", None, "dev_1", "device", "dev_1", "2026-10-04T01:00:00Z")
    ok = FakePost(201)
    WebhookNotifier("https://x.invalid", post=ok).send(n)
    assert json.loads(ok.calls[0][1])["kind"] == "login_required"
    with pytest.raises(WebhookError):
        WebhookNotifier("https://x.invalid", post=FakePost(RuntimeError("boom")), max_attempts=2).send(n)
    with pytest.raises(ValueError):
        WebhookNotifier("")
    with pytest.raises(ValueError):
        WebhookNotifier("https://x.invalid", max_attempts=0)


def test_urllib_post_against_local_server():
    received: list[bytes] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            received.append(self.rfile.read(int(self.headers["Content-Length"])))
            self.send_response(202)
            self.end_headers()

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.handle_request)
    thread.start()
    try:
        url = f"http://127.0.0.1:{server.server_port}/hook"
        assert urllib_post(url, b'{"a":1}', {"Content-Type": "application/json"}, 5) == 202
    finally:
        thread.join(5)
        server.server_close()
    assert received == [b'{"a":1}']
    with pytest.raises(OSError):
        urllib_post(f"http://127.0.0.1:{server.server_port}/hook", b"{}", {}, 1)  # 已关闭：连接被拒


def test_resolve_todo(h: Harness):
    h.ctx.bus.publish(CaseNeedsHuman("case_1", ACCOUNT, "x", "1"))
    (todo,) = todos(h)
    console = h.ctx.notifications.console
    assert console.resolve(todo["notification_id"], "alice") is True
    assert console.resolve(todo["notification_id"], "alice") is False
    assert console.resolve("ntf_missing", "alice") is False
    assert todos(h) == []
    (done,) = console.list_all().items
    assert done["resolved_by"] == "alice" and done["resolved_at"] is not None
    assert console.list_all(account_id="acct_other").items == []


def test_create_app_accepts_notifiers():
    post = FakePost()
    app = create_app(
        store=SqliteStore(), clock=FakeClock(), notifiers=[WebhookNotifier("https://x.invalid", post=post)]
    )
    ctx = app.state.ctx
    ctx.bus.publish(CaseNeedsHuman("case_1", ACCOUNT, "x", "1"))
    assert len(post.calls) == 1
    ctx.notifications.close()
    ctx.bus.publish(CaseNeedsHuman("case_2", ACCOUNT, "x", "1"))
    assert len(post.calls) == 1  # 取消订阅后不再触发
