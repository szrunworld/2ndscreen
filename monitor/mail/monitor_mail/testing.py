"""测试替身：fake mail 服务、契约形状的 fake 服务端、合成 PDF。

都实现为 ``httpx.MockTransport`` 的处理函数，所以 ``HttpMailApi`` / ``HttpServerApi`` 的
HTTP 解析（信封、错误码、分页、Idempotency-Key）也在测试覆盖之内。M（集成）可以直接复用。
数据全部合成，不含真实姓名、邮箱或密钥。
"""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import parse_qs

import httpx

from monitor_contracts import MAIL_TRANSITIONS, IDEMPOTENCY_KEY_PATTERN, MailState, check, validate_command

from .clock import Clock, parse_time, to_wire_time
from .signature import sign_headers

FAKE_MAIL_BASE = "https://mail.fake.test/api/mail"
FAKE_OBJECT_STORE = "https://objects.fake.test"
FAKE_SERVER_BASE = "https://monitor.fake.test/api/v1"
FAKE_WEBHOOK_SECRET = "test-webhook-secret-not-real"
FAKE_MAIL_KEY = "rdmail_testkey0_not-a-real-key"
FAKE_SERVICE_TOKEN = "test-service-token-not-real"


def _json(status: int, body: Any) -> httpx.Response:
    return httpx.Response(status, json=body)


# ---------------------------------------------------------------------------
# 合成 PDF
# ---------------------------------------------------------------------------


def _pdf(objects: list[bytes]) -> bytes:
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def _stream(data: bytes, extra: str = "") -> bytes:
    return f"<< /Length {len(data)} {extra}>>\nstream\n".encode() + data + b"\nendstream"


def make_text_pdf(pages: list[list[str]]) -> bytes:
    """有文字层的 PDF（ASCII 文本，Helvetica）。每页是若干行。"""
    page_count = len(pages)
    kids = " ".join(f"{4 + 2 * i} 0 R" for i in range(page_count))
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{kids}] /Count {page_count} >>".encode(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    for index, lines in enumerate(pages):
        escaped = [line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") for line in lines]
        content = "BT /F1 12 Tf 14 TL 72 720 Td " + " ".join(f"({t}) Tj T*" for t in escaped) + " ET"
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >>"
            f" /Contents {5 + 2 * index} 0 R >>".encode()
        )
        objects.append(_stream(content.encode("latin-1")))
    return _pdf(objects)


def make_scanned_pdf(page_count: int = 1) -> bytes:
    """只有图像、没有文字层的 PDF（模拟扫描版）。"""
    kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(page_count))
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{kids}] /Count {page_count} >>".encode(),
    ]
    image_obj = 3 + 2 * page_count
    for index in range(page_count):
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 {image_obj} 0 R >> >>"
            f" /Contents {4 + 2 * index} 0 R >>".encode()
        )
        objects.append(_stream(b"q 500 0 0 700 50 50 cm /Im1 Do Q"))
    objects.append(_stream(bytes([0, 128, 255, 64]),
                           "/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 "))
    return _pdf(objects)


def sample_resume_pdf(label: str = "Candidate A") -> bytes:
    return make_text_pdf([[f"{label} resume", "Backend engineer, 5 years of Python and SQL.",
                           "Education: Bachelor of Computer Science.", "Skills: FastAPI, PostgreSQL, Redis."]])


# ---------------------------------------------------------------------------
# fake mail 服务
# ---------------------------------------------------------------------------


@dataclass
class FakeAttachment:
    id: str
    filename: str
    content: bytes
    content_type: str | None = "application/pdf"
    scan_status: str = "clean"
    is_inline: bool = False


@dataclass
class FakeMessage:
    id: str
    subject: str | None
    from_address: str | None
    received_at: datetime
    text: str | None = None
    attachments: list[FakeAttachment] = field(default_factory=list)
    is_auto_reply: bool = False


class FakeMailService:
    """模拟 mail 的 integration API 与预签名下载。可注入的故障：

    - ``api_key``：服务端认的 key；客户端配别的 key 时全部 401（自检失败）。
    - ``scopes`` / ``primary_address``：自检失败的另外两种情形。
    - 附件 ``scan_status != "clean"``：下载接口 409（``not_ready_status`` 可改成 423）。
    - ``expire_next_links``：接下来签发的 N 个下载链接立即过期（对象存储回 403）。
    - ``list_supported``：是否提供 G0 的列出接口（默认没有，回 405）。
    - ``fail_next``：接下来 N 次 integration 请求直接回指定状态码（例如 503）。
    """

    def __init__(self, clock: Clock, *, mailbox_id: str = "mbx_zhaopin", primary_address: str = "zhaopin@remotedesk.io",
                 api_key: str = FAKE_MAIL_KEY, webhook_secret: str = FAKE_WEBHOOK_SECRET) -> None:
        self.clock = clock
        self.mailbox_id = mailbox_id
        self.primary_address = primary_address
        self.api_key = api_key
        self.webhook_secret = webhook_secret
        self.scopes = ["mail.read"]
        self.messages: dict[str, FakeMessage] = {}
        self.links: dict[str, tuple[str, str, datetime]] = {}
        self.link_ttl_seconds = 300
        self.expire_next_links = 0
        self.not_ready_status = 409
        self.list_supported = False
        self.fail_next: list[int] = []
        self.calls: list[str] = []

    # ---- 造数据 ----
    def add_message(self, *, subject: str | None, from_address: str | None, attachments: list[FakeAttachment] | None = None,
                    text: str | None = None, received_at: datetime | None = None, is_auto_reply: bool = False) -> str:
        message_id = str(uuid.uuid4())
        self.messages[message_id] = FakeMessage(
            id=message_id, subject=subject, from_address=from_address, received_at=received_at or self.clock.now(),
            text=text, attachments=list(attachments or []), is_auto_reply=is_auto_reply,
        )
        return message_id

    def webhook(self, message_id: str, *, event: str = "mail.ready", delivery_id: str | None = None,
                timestamp: int | None = None, secret: str | None = None, mailbox_id: str | None = None) -> tuple[bytes, dict[str, str]]:
        """生成一次推送的原始字节与签名头（与 mail 的 payload_for / sign_outbound 一致）。"""
        delivery_id = delivery_id or str(uuid.uuid4())
        message = self.messages.get(message_id)
        payload = {
            "id": delivery_id,
            "event": event,
            "version": 1,
            # mail 的 occurred_at 是投递记录的创建时间（扫描完成后），晚于邮件的 received_at。
            "occurred_at": (message.received_at + timedelta(minutes=2) if message else self.clock.now())
            .replace(tzinfo=None).isoformat(),
            "mailbox_id": mailbox_id or self.mailbox_id,
            "message_id": message_id,
            "thread_id": str(uuid.uuid5(uuid.NAMESPACE_URL, message_id)),
            "direction": "inbound",
            "spam_verdict": "clean",
            "catch_all_reason": None,
            "has_attachments": bool(message and message.attachments),
            "provider_status": None,
        }
        body = json.dumps(payload).encode()
        ts = int(self.clock.now().timestamp()) if timestamp is None else timestamp
        return body, sign_headers(body=body, delivery_id=delivery_id, timestamp=ts, secret=secret or self.webhook_secret)

    # ---- HTTP ----
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def client(self) -> httpx.Client:
        return httpx.Client(transport=self.transport())

    def _detail(self, message: FakeMessage) -> dict[str, Any]:
        return {
            "id": message.id,
            "thread_id": str(uuid.uuid5(uuid.NAMESPACE_URL, message.id)),
            "mailbox_id": self.mailbox_id,
            "subject": message.subject,
            "from_address": message.from_address,
            "from_display_name": None,
            "snippet": (message.text or "")[:80],
            "folder": "inbox",
            "state": "received",
            "direction": "inbound",
            "is_read": False,
            "is_starred": False,
            "has_attachments": bool(message.attachments),
            "received_at": message.received_at.replace(tzinfo=None).isoformat(),
            "spam_verdict": "clean",
            "purged": False,
            "rfc_message_id": f"<{message.id}@mail.fake.test>",
            "text": message.text,
            "attachments": [
                {"id": a.id, "filename": a.filename, "content_type": a.content_type, "byte_size": len(a.content),
                 "scan_status": a.scan_status, "is_inline": a.is_inline, "downloadable": a.scan_status == "clean"}
                for a in message.attachments
            ],
            "raw_sha256": None,
            "is_auto_reply": message.is_auto_reply,
        }

    def handle(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.calls.append(f"{request.method} {request.url.path}")
        if url.startswith(FAKE_OBJECT_STORE):
            token = request.url.path.rsplit("/", 1)[-1]
            entry = self.links.get(token)
            if entry is None or self.clock.now() >= entry[2]:
                return httpx.Response(403, text="<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>")
            message_id, attachment_id = entry[0], entry[1]
            attachment = next(a for a in self.messages[message_id].attachments if a.id == attachment_id)
            return httpx.Response(200, content=attachment.content)
        if not url.startswith(FAKE_MAIL_BASE):
            return _json(404, {"detail": "not found"})
        if self.fail_next:
            return _json(self.fail_next.pop(0), {"detail": "injected failure"})
        if request.headers.get("X-Mail-Api-Key") != self.api_key:
            return _json(401, {"detail": "invalid api key"})
        path = url[len(FAKE_MAIL_BASE):].split("?", 1)[0]
        if request.method == "GET" and path == "/v1/integration/mailbox":
            return _json(200, {"code": 0, "message": "ok", "data": {
                "mailbox_id": self.mailbox_id, "primary_address": self.primary_address,
                "scopes": list(self.scopes), "key_name": "monitor-zhaopin"}})
        if "mail.read" not in self.scopes:
            return _json(403, {"detail": "missing mail.read"})
        if request.method == "GET" and path == "/v1/integration/messages":
            if not self.list_supported:
                return _json(405, {"detail": "Method Not Allowed"})
            since = parse_time(parse_qs(request.url.query.decode())["since"][0])
            items = [{"message_id": m.id, "received_at": m.received_at.isoformat()}
                     for m in self.messages.values() if m.received_at >= since]
            return _json(200, {"code": 0, "message": "ok", "data": {"items": items, "next_cursor": None}})
        match = re.fullmatch(r"/v1/integration/messages/([^/]+)(?:/attachments/([^/]+)/download)?", path)
        if request.method != "GET" or not match:
            return _json(404, {"detail": "not found"})
        message = self.messages.get(match.group(1))
        if message is None:
            return _json(404, {"detail": "not found"})
        if match.group(2) is None:
            return _json(200, {"code": 0, "message": "ok", "data": self._detail(message)})
        attachment = next((a for a in message.attachments if a.id == match.group(2)), None)
        if attachment is None:
            return _json(404, {"detail": "not found"})
        if attachment.scan_status != "clean":
            return _json(self.not_ready_status, {"detail": f"attachment is not downloadable: {attachment.scan_status}"})
        token = uuid.uuid4().hex
        expires = self.clock.now() + timedelta(seconds=self.link_ttl_seconds)
        if self.expire_next_links > 0:
            self.expire_next_links -= 1
            expires = self.clock.now()
        self.links[token] = (message.id, attachment.id, expires)
        return _json(200, {"code": 0, "message": "ok", "data": {
            "url": f"{FAKE_OBJECT_STORE}/dl/{token}", "expires_in_seconds": self.link_ttl_seconds,
            "filename": attachment.filename}})


# ---------------------------------------------------------------------------
# 契约形状的 fake 服务端
# ---------------------------------------------------------------------------


class FakeMonitorServer:
    """按 openapi 0.3.1 的形状实现 G 用到的服务端接口（server 尚未实现这些端点）。

    规则：Idempotency-Key 必填、同键不同体 422；mail_message 校验契约、主键与路径一致、
    不可变字段 409 mail_message_conflict、迁移表外 409 illegal_mail_transition；
    resume_document 按（mail_message_id, sha256）去重；mail_verification 按 id 幂等、不同内容 409。
    ``fail_next``：接下来 N 次请求直接回指定状态码。``page_size`` 控制列表分页。
    """

    def __init__(self, clock: Clock, *, token: str = FAKE_SERVICE_TOKEN) -> None:
        self.clock = clock
        self.token = token
        self.mail_messages: dict[str, dict[str, Any]] = {}
        self.documents: dict[str, dict[str, Any]] = {}
        self.commands: list[dict[str, Any]] = []
        self.verifications: dict[str, dict[str, Any]] = {}
        self.idempotency: dict[str, tuple[str, int, Any]] = {}
        self.fail_next: list[int] = []
        self.page_size = 50
        self.requests: list[tuple[str, str]] = []
        self.on_request: Callable[[httpx.Request], None] | None = None

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def client(self) -> httpx.Client:
        return httpx.Client(transport=self.transport())

    # ---- 造数据 ----
    def add_request_resume(self, *, case_id: str, account_id: str, candidate_name: str, job_title: str,
                           executed_at: datetime, status: str = "succeeded") -> str:
        command_id = str(uuid.uuid4())
        command = {
            "command_id": command_id, "workflow_id": case_id, "account_id": account_id, "action": "request_resume",
            "execution_mode": "execute",
            "target": {"conversation": {"candidate_name": candidate_name, "job_title": job_title, "hints": []}},
            "payload": {}, "issued_at": to_wire_time(executed_at - timedelta(minutes=5)),
            "expires_at": to_wire_time(executed_at + timedelta(minutes=5)), "depends_on": None,
        }
        validate_command(command)
        result = {
            "command_id": command_id, "action": "request_resume", "status": status, "reason": None,
            "observed": {"before": [], "after": [{"code": "resume_request_sent", "detail": "合成"}]},
            "evidence": [], "navigation_performed": True, "outbound_action_performed": True,
            "externally_visible_side_effect": True, "executed_at": to_wire_time(executed_at),
            "reported_at": to_wire_time(executed_at + timedelta(seconds=10)),
        }
        self.commands.append({
            "command": command, "case_id": case_id, "server_status": status, "device_id": "dev_1",
            "created_at": to_wire_time(executed_at - timedelta(minutes=5)), "claimed_at": None, "acked_at": None,
            "cancel_requested": False, "result": result, "manual_actions": [],
        })
        return command_id

    def manual_link(self, mail_message_id: str) -> None:
        """模拟控制台人工关联：needs_review → processed。"""
        record = self.mail_messages[mail_message_id]
        record.update(status="processed", error=None)

    # ---- HTTP ----
    @staticmethod
    def _problem(status: int, code: str, message: str = "", existing: Any = None) -> httpx.Response:
        body: dict[str, Any] = {"code": code, "message": message or code}
        if existing is not None:
            body["existing"] = existing
        return httpx.Response(status, json=body, headers={"content-type": "application/problem+json"})

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = str(request.url).removeprefix(FAKE_SERVER_BASE).split("?", 1)[0]
        self.requests.append((request.method, path))
        if self.on_request:
            self.on_request(request)
        if self.fail_next:
            status = self.fail_next.pop(0)
            return self._problem(status, "injected", "injected failure")
        if request.headers.get("Authorization") != f"Bearer {self.token}":
            return self._problem(401, "unauthorized")
        query = parse_qs(request.url.query.decode())
        if request.method == "GET":
            return self._list(path, query)
        key = request.headers.get("Idempotency-Key")
        if not key or not re.fullmatch(IDEMPOTENCY_KEY_PATTERN, key):
            return self._problem(422, "validation_failed", "Idempotency-Key 缺失或格式错误")
        body = json.loads(request.content or b"null")
        canonical = json.dumps(body, sort_keys=True, ensure_ascii=False)
        scope = f"{request.method} {path} {key}"
        if scope in self.idempotency:
            stored_body, status, response = self.idempotency[scope]
            if stored_body != canonical:
                return self._problem(422, "idempotency_key_reused")
            return httpx.Response(status, json=response)
        if request.method == "PUT" and path.startswith("/mail-messages/"):
            result = self._put_mail_message(path.removeprefix("/mail-messages/"), body)
        elif request.method == "POST" and path == "/resume-documents":
            result = self._create_document(body)
        elif request.method == "POST" and path == "/mail-verifications":
            result = self._post_verification(body)
        else:
            return self._problem(404, "not_found")
        if 200 <= result.status_code < 300:
            self.idempotency[scope] = (canonical, result.status_code, result.json())
        return result

    def _put_mail_message(self, mail_message_id: str, body: dict[str, Any]) -> httpx.Response:
        errors = check("mail_message", body)
        if errors:
            return self._problem(422, "validation_failed", "; ".join(f"{e.path}: {e.message}" for e in errors))
        if body["mail_message_id"] != mail_message_id:
            return self._problem(422, "validation_failed", "路径与请求体的 mail_message_id 不一致")
        existing = self.mail_messages.get(mail_message_id)
        if existing is None:
            self.mail_messages[mail_message_id] = dict(body)
            return httpx.Response(201, json=body)
        for name in ("provider", "provider_message_id", "mailbox", "received_at"):
            if parse_or_same(existing[name]) != parse_or_same(body[name]):
                return self._problem(409, "mail_message_conflict", f"{name} 不可变", existing)
        if existing["sha256"] is not None and body["sha256"] != existing["sha256"]:
            return self._problem(409, "mail_message_conflict", "sha256 不可变", existing)
        if existing["status"] != body["status"] and MailState(body["status"]) not in MAIL_TRANSITIONS[MailState(existing["status"])]:
            return self._problem(409, "illegal_mail_transition", f"{existing['status']} → {body['status']}", existing)
        self.mail_messages[mail_message_id] = dict(body)
        return httpx.Response(200, json=body)

    def _create_document(self, body: dict[str, Any]) -> httpx.Response:
        mail_message_id = body.get("mail_message_id")
        if body.get("variant", "original") != "original" or not body.get("mail") or not body.get("link"):
            return self._problem(422, "validation_failed", "原件必须带 mail_message_id、mail、link")
        if mail_message_id not in self.mail_messages:
            return self._problem(404, "not_found", "mail_message_id 不存在")
        sha = body["attachment"]["sha256"]
        for doc in self.documents.values():
            if doc["mail_message_id"] == mail_message_id and doc["sha256"] == sha:
                return httpx.Response(200, json={**doc, "duplicate": True})
        link = body["link"]
        case_id = link.get("case_id") if link["method"] != "none" else None
        version = 1 + sum(1 for d in self.documents.values() if case_id and d["case_id"] == case_id)
        doc_id = f"doc_{len(self.documents) + 1:04d}"
        parse = body.get("parse") or {}
        doc = {
            "doc_id": doc_id, "case_id": case_id, "variant": "original", "derived_from": None,
            "mail_message_id": mail_message_id,
            "link_status": "linked" if case_id else "needs_manual", "link_method": link["method"],
            "version": version, "sha256": sha, "filename": body["attachment"]["filename"],
            "message_id": body["mail"].get("message_id") or "",
            "parse_status": parse.get("parse_status", "pending"),
            "created_at": to_wire_time(self.clock.now()), "duplicate": False,
            # 以下不是 ResumeDocument 的字段，只给测试检查用
            "_link": link, "_parse": body.get("parse"), "_attachment": body["attachment"],
        }
        self.documents[doc_id] = doc
        return httpx.Response(201, json={k: v for k, v in doc.items() if not k.startswith("_")})

    def _post_verification(self, body: dict[str, Any]) -> httpx.Response:
        errors = check("mail_verification", body)
        if errors:
            return self._problem(422, "validation_failed", "; ".join(f"{e.path}: {e.message}" for e in errors))
        existing = self.verifications.get(body["verification_id"])
        if existing is not None:
            if existing["verification"] != body:
                return self._problem(409, "verification_conflict")
            return httpx.Response(200, json=existing)
        record = {"verification": body, "received_at": to_wire_time(self.clock.now())}
        self.verifications[body["verification_id"]] = record
        return httpx.Response(201, json=record)

    def _page(self, items: list[dict[str, Any]], query: dict[str, list[str]]) -> httpx.Response:
        start = int(query.get("cursor", ["0"])[0])
        limit = min(int(query.get("limit", ["50"])[0]), self.page_size)
        chunk = items[start:start + limit]
        next_cursor = str(start + limit) if start + limit < len(items) else None
        return httpx.Response(200, json={"items": chunk, "next_cursor": next_cursor})

    def _list(self, path: str, query: dict[str, list[str]]) -> httpx.Response:
        if path == "/commands":
            items = self.commands
            if "action" in query:
                items = [c for c in items if c["command"]["action"] == query["action"][0]]
            if "status" in query:
                items = [c for c in items if c["server_status"] in query["status"]]
            if "account_id" in query:
                items = [c for c in items if c["command"]["account_id"] == query["account_id"][0]]
            if "case_id" in query:
                items = [c for c in items if c["case_id"] == query["case_id"][0]]
            if "executed_after" in query:
                after = parse_time(query["executed_after"][0])
                items = [c for c in items if c["result"] and parse_time(c["result"]["executed_at"]) >= after]
            if "executed_before" in query:
                before = parse_time(query["executed_before"][0])
                items = [c for c in items if c["result"] and parse_time(c["result"]["executed_at"]) <= before]
            return self._page(items, query)
        if path == "/mail-messages":
            items = sorted(self.mail_messages.values(), key=lambda m: m["received_at"], reverse=True)
            if "status" in query:
                items = [m for m in items if m["status"] in query["status"]]
            if "mailbox" in query:
                items = [m for m in items if m["mailbox"] == query["mailbox"][0]]
            if "received_after" in query:
                after = parse_time(query["received_after"][0])
                items = [m for m in items if parse_time(m["received_at"]) >= after]
            return self._page(items, query)
        if path == "/resume-documents":
            items = [{k: v for k, v in d.items() if not k.startswith("_")} for d in self.documents.values()]
            if "case_id" in query:
                items = [d for d in items if d["case_id"] == query["case_id"][0]]
            if "mail_message_id" in query:
                items = [d for d in items if d["mail_message_id"] == query["mail_message_id"][0]]
            return self._page(items, query)
        return self._problem(404, "not_found")


def parse_or_same(value: Any) -> Any:
    """时间字段按时刻比较（同一时刻的不同写法不算冲突）。"""
    if isinstance(value, str):
        try:
            return parse_time(value)
        except ValueError:
            return value
    return value

