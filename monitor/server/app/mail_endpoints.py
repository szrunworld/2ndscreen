"""公司邮箱邮件记录与核对结果（邮件接入 G 调用，控制台展示）。

- ``PUT /mail-messages/{mail_message_id}``：serviceToken，幂等 upsert。首次 201，之后 200；
  状态只按 ``monitor_contracts.MAIL_TRANSITIONS`` 前进，同状态写入是更新；provider、provider_message_id、
  mailbox、received_at 写入后不可变，sha256 一旦非空也不可变（409 mail_message_conflict）；
  迁移表外的状态变化 409 illegal_mail_transition。两种 409 都在 existing 里附当前记录。
- ``GET /mail-messages``：控制台或 serviceToken，按 received_at 倒序；status 可重复。
- ``POST /mail-verifications``：serviceToken，按 verification_id 幂等，内容不同 409。
- ``GET /mail-verifications``：控制台或 serviceToken，按 finished_at 倒序。

另外登记"谁能读策略"的权限规则 ``require_policy_reader``：G 需要读 ``mail_retention_days`` 与
``resume_mail_timeout_days``，所以 serviceToken 对 ``GET /accounts/{account_id}/policy`` 只读。
策略路由由 F2 实现（policy.py），getPolicy 直接以本函数为认证依赖（契约 0.3.2 起 yaml 也列出 serviceToken）。

状态变化在提交后经 ``ctx.bus`` 发布 ``MailMessageStatusChanged``（notify 据此对 failed 发通知），
核对结果首次记录时发布 ``MailVerificationRecorded``。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Annotated, Any, Literal

from fastapi import APIRouter, Body, Depends, Path, Query, Request, Security
from pydantic import BaseModel, Field

from monitor_contracts import (
    MAIL_MESSAGE_ID_PATTERN,
    MAIL_TRANSITIONS,
    MailState,
    check,
    compute_mail_message_id,
    normalize_mailbox,
    validate_mail_message,
    validate_mail_verification,
)

from .db import Page, SqliteStore, canonical_json, parse_time, to_db_time, wire_time
from .main import (
    ApiError,
    ApiModel,
    BearerCred,
    ConsoleOrService,
    Ctx,
    IdempotencyKeyHeader,
    console_bearer,
    contract_ref,
    device_bearer,
    get_ctx,
    hash_token,
    ok,
    problem_responses,
    run_idempotent,
    service_bearer,
    validation_failed,
)

if TYPE_CHECKING:
    from .main import AppContext

MailMessageJson = Annotated[dict[str, Any], contract_ref("./schemas/mail_message.json")]
MailVerificationJson = Annotated[dict[str, Any], contract_ref("./schemas/mail_verification.json")]
MailStatusLiteral = Literal["pending", "processed", "needs_review", "failed", "ignored"]
VerificationOutcome = Literal["ok", "issues_found", "failed"]
IMMUTABLE_FIELDS = ("provider", "provider_message_id", "mailbox", "received_at")


# ---------------------------------------------------------------------------
# 内部消息
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MailMessageStatusChanged:
    """邮件记录的状态变化（含首次写入：old_status=None）。record 为当前记录（mail_message 线上形状）。"""

    mail_message_id: str
    old_status: str | None
    new_status: str
    record: dict[str, Any]


@dataclass(frozen=True)
class MailVerificationRecorded:
    """一次核对结果首次被记录。"""

    verification_id: str
    outcome: str
    verification: dict[str, Any]


# ---------------------------------------------------------------------------
# HTTP 形状
# ---------------------------------------------------------------------------


class MailMessageList(BaseModel):
    items: list[MailMessageJson]
    next_cursor: str | None


class MailVerificationRecord(ApiModel):
    verification: MailVerificationJson
    received_at: str = Field(json_schema_extra={"format": "date-time"})


class MailVerificationList(BaseModel):
    items: list[MailVerificationRecord]
    next_cursor: str | None


# ---------------------------------------------------------------------------
# 存储
# ---------------------------------------------------------------------------


def offset_page(store: SqliteStore, sql: str, args: list[Any], cursor: str | None, limit: int, conv: Any) -> Page:
    """按 SQL 自带的 ORDER BY 分页；游标是偏移量（不透明字符串）。"""
    offset = int(cursor) if cursor is not None else 0
    rows = store._all(f"{sql} LIMIT ? OFFSET ?", (*args, limit + 1, offset))
    items = [conv(r) for r in rows[:limit]]
    return Page(items=items, next_cursor=str(offset + limit) if len(rows) > limit else None)


class MailStore:
    def __init__(self, store: SqliteStore):
        self._s = store

    def get_message(self, mail_message_id: str) -> dict[str, Any] | None:
        r = self._s._one("SELECT record_json FROM mail_messages WHERE mail_message_id = ?", (mail_message_id,))
        return None if r is None else _loads(r["record_json"])

    def upsert_message(
        self, record: dict[str, Any], now: str, decide: Any
    ) -> tuple[int, dict[str, Any], str | None]:
        """在一个事务里读当前记录、由 decide(existing) 判定（抛 ApiError 即拒绝），再写入。

        返回 (状态码, 记录, 旧状态)。
        """
        mail_message_id = record["mail_message_id"]
        with self._s._tx() as c:
            r = c.execute("SELECT record_json FROM mail_messages WHERE mail_message_id = ?", (mail_message_id,)).fetchone()
            existing = None if r is None else _loads(r["record_json"])
            decide(existing)
            args = (
                normalize_mailbox(record["mailbox"]),
                record.get("message_id"),
                to_db_time(parse_time(record["received_at"])),
                record["status"],
                canonical_json(record),
                now,
            )
            if existing is None:
                c.execute(
                    """INSERT INTO mail_messages (mailbox, message_id, received_at, status, record_json, updated_at,
                           mail_message_id, created_at) VALUES (?,?,?,?,?,?,?,?)""",
                    (*args, mail_message_id, now),
                )
                return 201, record, None
            c.execute(
                """UPDATE mail_messages SET mailbox = ?, message_id = ?, received_at = ?, status = ?, record_json = ?,
                       updated_at = ? WHERE mail_message_id = ?""",
                (*args, mail_message_id),
            )
            return 200, record, existing["status"]

    def set_status(self, mail_message_id: str, expected: str, record: dict[str, Any], now: str) -> bool:
        """服务端内部推进状态（例如人工关联后 needs_review → processed）；当前状态不是 expected 时不改。"""
        with self._s._tx() as c:
            cur = c.execute(
                "UPDATE mail_messages SET status = ?, record_json = ?, updated_at = ? WHERE mail_message_id = ? AND status = ?",
                (record["status"], canonical_json(record), now, mail_message_id, expected),
            )
            return cur.rowcount == 1

    def list_messages(
        self,
        statuses: list[str],
        mailbox: str | None,
        message_id: str | None,
        received_after: str | None,
        received_before: str | None,
        cursor: str | None,
        limit: int,
    ) -> Page:
        where, args = ["1 = 1"], []
        if statuses:
            where.append(f"status IN ({','.join('?' * len(statuses))})")
            args.extend(statuses)
        for clause, value in (
            ("mailbox = ?", None if mailbox is None else normalize_mailbox(mailbox)),
            ("message_id = ?", message_id),
            ("received_at >= ?", received_after),
            ("received_at < ?", received_before),
        ):
            if value is not None:
                where.append(clause)
                args.append(value)
        sql = f"SELECT record_json FROM mail_messages WHERE {' AND '.join(where)} ORDER BY received_at DESC, seq DESC"
        return offset_page(self._s, sql, args, cursor, limit, lambda r: _loads(r["record_json"]))

    def get_verification(self, verification_id: str) -> dict[str, Any] | None:
        r = self._s._one("SELECT * FROM mail_verifications WHERE verification_id = ?", (verification_id,))
        return None if r is None else _verification_record(r)

    def insert_verification(self, verification: dict[str, Any], now: str) -> bool:
        with self._s._tx() as c:
            cur = c.execute(
                """INSERT OR IGNORE INTO mail_verifications (verification_id, mailbox, outcome, finished_at,
                       verification_json, received_at) VALUES (?,?,?,?,?,?)""",
                (
                    verification["verification_id"],
                    normalize_mailbox(verification["mailbox"]),
                    verification["outcome"],
                    to_db_time(parse_time(verification["finished_at"])),
                    canonical_json(verification),
                    now,
                ),
            )
            return cur.rowcount == 1

    def list_verifications(self, mailbox: str | None, outcome: str | None, cursor: str | None, limit: int) -> Page:
        where, args = ["1 = 1"], []
        if mailbox is not None:
            where.append("mailbox = ?")
            args.append(normalize_mailbox(mailbox))
        if outcome is not None:
            where.append("outcome = ?")
            args.append(outcome)
        sql = f"SELECT * FROM mail_verifications WHERE {' AND '.join(where)} ORDER BY finished_at DESC, seq DESC"
        return offset_page(self._s, sql, args, cursor, limit, _verification_record)


def _loads(text: str) -> dict[str, Any]:
    return json.loads(text)


def _verification_record(r: Any) -> dict[str, Any]:
    return {"verification": _loads(r["verification_json"]), "received_at": wire_time(r["received_at"])}


def _err(path: str, message: str, code: str) -> dict[str, str]:
    return {"path": path, "message": message, "code": code}


# ---------------------------------------------------------------------------
# 业务
# ---------------------------------------------------------------------------


class MailService:
    def __init__(self, ctx: AppContext):
        self.ctx = ctx
        self.store = MailStore(ctx.store)  # type: ignore[arg-type]

    def _now(self) -> str:
        return to_db_time(self.ctx.clock.now())

    def put_message(self, mail_message_id: str, body: Any) -> tuple[int, dict[str, Any]]:
        errors = check("mail_message", body)
        if errors:
            raise validation_failed(errors)
        record = validate_mail_message(body).to_wire()
        if record["mail_message_id"] != mail_message_id:
            raise validation_failed([_err("mail_message_id", "请求体 mail_message_id 与路径不一致", "path_mismatch")])
        if compute_mail_message_id(record["provider_message_id"]) != mail_message_id:
            raise validation_failed(
                [_err("mail_message_id", "mail_message_id 必须等于 'mail:' + provider_message_id", "mail_id_mismatch")]
            )

        def decide(existing: dict[str, Any] | None) -> None:
            if existing is None:
                return
            # 先判状态迁移（例如 processed → pending 的请求体 sha256 往往为空，报迁移错误更有用），再判不可变字段
            old, new = existing["status"], record["status"]
            if old != new and MailState(new) not in MAIL_TRANSITIONS[MailState(old)]:
                raise ApiError(409, "illegal_mail_transition", f"不允许 {old} → {new}", existing=existing)
            for name in IMMUTABLE_FIELDS:
                if _field_value(name, existing[name]) != _field_value(name, record[name]):
                    raise ApiError(409, "mail_message_conflict", f"{name} 写入后不可变", existing=existing)
            if existing.get("sha256") is not None and record.get("sha256") != existing["sha256"]:
                raise ApiError(409, "mail_message_conflict", "sha256 一旦非空不可变", existing=existing)

        status, stored, old_status = self.store.upsert_message(record, self._now(), decide)
        if old_status != stored["status"]:
            self.ctx.bus.publish(  # type: ignore[arg-type]
                MailMessageStatusChanged(mail_message_id, old_status, stored["status"], stored)
            )
        return status, stored

    def mark_processed_after_link(self, mail_message_id: str) -> bool:
        """人工关联后把 needs_review 的邮件记录推进为 processed（MAIL_TRANSITIONS：needs_review → processed）。"""
        current = self.store.get_message(mail_message_id)
        if current is None or current["status"] != "needs_review":
            return False
        now = self._now()
        record = {**current, "status": "processed", "error": None, "updated_at": wire_time(now)}
        if not self.store.set_status(mail_message_id, "needs_review", record, now):
            return False
        self.ctx.bus.publish(  # type: ignore[arg-type]
            MailMessageStatusChanged(mail_message_id, "needs_review", "processed", record)
        )
        return True

    def post_verification(self, body: Any) -> tuple[int, dict[str, Any]]:
        errors = check("mail_verification", body)
        if errors:
            raise validation_failed(errors)
        verification = validate_mail_verification(body).to_wire()
        verification_id = verification["verification_id"]
        if self.store.insert_verification(verification, self._now()):
            record = self.store.get_verification(verification_id)
            assert record is not None
            self.ctx.bus.publish(  # type: ignore[arg-type]
                MailVerificationRecorded(verification_id, verification["outcome"], verification)
            )
            return 201, record
        existing = self.store.get_verification(verification_id)
        assert existing is not None
        if canonical_json(existing["verification"]) != canonical_json(verification):
            raise ApiError(409, "verification_conflict", "verification_id 已存在且内容不同", existing=existing)
        return 200, existing


def _field_value(name: str, value: Any) -> Any:
    if name == "received_at":
        return parse_time(value)
    if name == "mailbox":
        return normalize_mailbox(value)
    if name == "provider_message_id":
        return str(value).lower()
    return value


def query_time(name: str, value: str | None) -> str | None:
    if value is None:
        return None
    try:
        parsed = parse_time(value)
    except ValueError:
        parsed = None
    if parsed is None or parsed.tzinfo is None:
        raise validation_failed([_err(f"query.{name}", "应为带时区的 RFC 3339 时间", "format")])
    return to_db_time(parsed)


def check_offset_cursor(cursor: str | None) -> str | None:
    if cursor is not None and not cursor.isdigit():
        raise validation_failed([_err("query.cursor", "游标无效", "invalid_cursor")])
    return cursor


# ---------------------------------------------------------------------------
# 策略读取权限（serviceToken 只读）
# ---------------------------------------------------------------------------

# 能读 GET /accounts/{account_id}/policy 的身份：控制台（读写）、设备（只读，仅自己绑定的账户）、
# 服务令牌（只读，邮件接入读取 mail_retention_days 与 resume_mail_timeout_days）。
POLICY_READ_PRINCIPALS = ("console", "device", "service")


def require_policy_reader(
    request: Request,
    console: Annotated[BearerCred, Security(console_bearer)],
    device: Annotated[BearerCred, Security(device_bearer)],
    service: Annotated[BearerCred, Security(service_bearer)],
) -> str:
    """读策略的认证依赖：返回 ``console:<actor>`` / ``device:<device_id>`` / ``service:<actor>``。

    三种令牌共用 Authorization 头，依次按控制台、服务令牌、设备令牌识别；都无效时 401。
    设备只能读自己绑定账户的策略由路由自己判断（F2 已实现）；服务令牌可读任何账户（只读）。
    """
    ctx = get_ctx(request)
    cred = console or device or service
    if cred is None:
        raise ApiError(401, "unauthorized", "未认证或令牌已吊销")
    token = cred.credentials
    actor = ctx.console_auth.authenticate(token)
    if actor is not None:
        return f"console:{actor}"
    service_actor = ctx.service_auth.authenticate(token)
    if service_actor is not None:
        return f"service:{service_actor}"
    row = ctx.store.get_device_by_token_hash(hash_token(token))
    if row is not None and not row.revoked:
        return f"device:{row.device_id}"
    raise ApiError(401, "unauthorized", "未认证或令牌已吊销")


def is_read_only_principal(principal: str) -> bool:
    """设备与服务令牌只能读策略；PUT 只接受控制台。"""
    return not principal.startswith("console:")


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------

router = APIRouter(tags=["mail"])


def require_service(request: Request, cred: Annotated[BearerCred, Security(service_bearer)]) -> str:
    """服务令牌认证（邮件接入），返回 actor。"""
    if cred is None:
        raise ApiError(401, "unauthorized", "未认证或令牌已吊销")
    actor = get_ctx(request).service_auth.authenticate(cred.credentials)
    if actor is None:
        raise ApiError(401, "unauthorized", "未认证或令牌已吊销")
    return actor


@router.put(
    "/mail-messages/{mail_message_id}",
    operation_id="putMailMessage",
    summary="邮件接入写入或更新一封邮件的记录（幂等 upsert）",
    response_model=MailMessageJson,
    responses={
        201: {"description": "已创建", "content": {"application/json": {"schema": {"x-contract-ref": "./schemas/mail_message.json"}}}},
        **problem_responses(401, 409, 422),
    },
)
def put_mail_message(
    request: Request,
    ctx: Ctx,
    mail_message_id: Annotated[str, Path(pattern=MAIL_MESSAGE_ID_PATTERN)],
    actor: Annotated[str, Depends(require_service)],
    idempotency_key: IdempotencyKeyHeader,
    body: Annotated[MailMessageJson, Body()],
):
    return run_idempotent(
        ctx,
        request,
        f"service:{actor}",
        idempotency_key,
        body,
        lambda: ctx.mail.put_message(mail_message_id, body),
    )


@router.get(
    "/mail-messages",
    operation_id="listMailMessages",
    summary="公司邮箱邮件记录列表（控制台展示与人工队列；核对任务也可读取）",
    response_model=MailMessageList,
    responses=problem_responses(401, 422),
)
def list_mail_messages(
    ctx: Ctx,
    _actor: ConsoleOrService,
    status: Annotated[list[MailStatusLiteral] | None, Query(description="可重复")] = None,
    mailbox: Annotated[str | None, Query(json_schema_extra={"format": "email"})] = None,
    message_id: str | None = None,
    received_after: Annotated[str | None, Query(json_schema_extra={"format": "date-time"})] = None,
    received_before: Annotated[str | None, Query(json_schema_extra={"format": "date-time"})] = None,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
):
    page = ctx.mail.store.list_messages(
        list(status or ()),
        mailbox,
        message_id,
        query_time("received_after", received_after),
        query_time("received_before", received_before),
        check_offset_cursor(cursor),
        limit,
    )
    return ok({"items": page.items, "next_cursor": page.next_cursor})


@router.post(
    "/mail-verifications",
    operation_id="postMailVerification",
    summary="邮件接入提交一次邮箱核对结果",
    response_model=MailVerificationRecord,
    responses={201: {"description": "已记录", "model": MailVerificationRecord}, **problem_responses(401, 409, 422)},
)
def post_mail_verification(
    request: Request,
    ctx: Ctx,
    actor: Annotated[str, Depends(require_service)],
    idempotency_key: IdempotencyKeyHeader,
    body: Annotated[MailVerificationJson, Body()],
):
    return run_idempotent(
        ctx, request, f"service:{actor}", idempotency_key, body, lambda: ctx.mail.post_verification(body)
    )


@router.get(
    "/mail-verifications",
    operation_id="listMailVerifications",
    summary="最近的邮箱核对结果（按 finished_at 倒序）",
    response_model=MailVerificationList,
    responses=problem_responses(401, 422),
)
def list_mail_verifications(
    ctx: Ctx,
    _actor: ConsoleOrService,
    mailbox: Annotated[str | None, Query(json_schema_extra={"format": "email"})] = None,
    outcome: VerificationOutcome | None = None,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
):
    page = ctx.mail.store.list_verifications(mailbox, outcome, check_offset_cursor(cursor), limit)
    return ok({"items": page.items, "next_cursor": page.next_cursor})


__all__ = [
    "MailMessageStatusChanged",
    "MailService",
    "MailStore",
    "MailVerificationRecorded",
    "POLICY_READ_PRINCIPALS",
    "is_read_only_principal",
    "offset_page",
    "query_time",
    "require_policy_reader",
    "require_service",
    "router",
]
