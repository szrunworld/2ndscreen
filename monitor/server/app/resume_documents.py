"""简历文档：邮件接入（G）写入附件简历、回报解析结果；控制台查看与人工关联。

- ``POST /resume-documents``（serviceToken）：
  - 原件 ``variant=original``（默认）：必须带 mail_message_id、mail、link，按 (mail_message_id, sha256) 去重，
    重复返回 200 + ``duplicate=true``。mail_message_id 必须已经登记（``PUT /mail-messages``），否则 404。
    ``link.method`` 优先级 reliable_id → resume_request → name_match → none：非 none 必须给 case_id；
    resume_request 必须给 command_id，且它是该流程已成功的 request_resume；none 时 case_id 为 null，
    文档进入人工关联队列（link_status=needs_manual），candidate_case_ids 保存供人工选择。
    同一流程下的多份原件按 version 递增保留，不覆盖。
  - 品牌化版本 ``variant=branded``（任务 R）：必须带 derived_from（原件 doc_id），不带 mail 与 link，
    流程、mail_message_id、version 继承原件；按 (derived_from, sha256) 去重。原件始终保留。
- ``GET /resume-documents``、``GET /resume-documents/{doc_id}``：列表（含待人工关联队列）与详情。
- ``POST /resume-documents/{doc_id}/parse-result``（serviceToken）：回报 PDF 文本解析结果。
- ``POST /resume-documents/{doc_id}:link``（控制台）：人工关联，记录 manual_action（actor、时间、说明），
  原始的关联判定不覆盖（link_json 保留）；来源邮件若处于 needs_review 且其原件都已关联，推进为 processed。

原件唯一关联到流程时（自动或人工）经 ``ctx.bus`` 发布 ``ResumeDocumentLinked``，供 F2 推进 resume_linked；
解析结果记录后发布 ``ResumeDocumentParsed``。附件哈希只用于文件去重，不作为候选人身份。
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Annotated, Any, Literal

from fastapi import APIRouter, Body, Depends, Path, Query, Request
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from pydantic.json_schema import SkipJsonSchema

from monitor_contracts import MAIL_MESSAGE_ID_PATTERN

from .commands import ManualAction, manual_action_record
from .db import ManualActionRow, SqliteStore, canonical_json, parse_time, to_db_time, wire_time
from .mail_endpoints import require_service
from .main import (
    ApiError,
    ApiModel,
    ConsoleActor,
    ConsoleOrService,
    Ctx,
    IdempotencyKeyHeader,
    check_cursor,
    contract_ref,
    not_found,
    ok,
    problem_responses,
    run_idempotent,
    validation_failed,
)

if TYPE_CHECKING:
    from .main import AppContext

DateTimeStr = Annotated[str, Field(json_schema_extra={"format": "date-time"})]
MailMessageIdStr = Annotated[
    str,
    StringConstraints(pattern=MAIL_MESSAGE_ID_PATTERN),
    contract_ref("./schemas/mail_message.json#/properties/mail_message_id"),
]
MailMessageIdRef = Annotated[str, contract_ref("./schemas/mail_message.json#/properties/mail_message_id")]
LinkStatus = Literal["linked", "needs_manual", "unlinked"]
ResumeVariant = Literal["original", "branded"]
LinkMethod = Literal["reliable_id", "resume_request", "name_match", "none"]
ParseStatus = Literal["pending", "parsed", "suspected_scanned", "failed"]


# ---------------------------------------------------------------------------
# 内部消息（F2 订阅）
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ResumeDocumentLinked:
    """一份原件唯一关联到了流程（自动：link.method ≠ none；人工：:link）。

    - link_method：reliable_id / resume_request / name_match / manual
    - command_id：method=resume_request 时为对应的 request_resume 指令，其他为 None
    - actor：人工关联的操作者（console actor），自动关联为 None
    - record：ResumeDocument 线上形状
    F2 据此把流程推进到 resume_linked（换微信之后才到的邮件阶段不回退，只记时间线）。
    """

    doc_id: str
    case_id: str
    link_method: str
    mail_message_id: str | None
    command_id: str | None
    version: int
    actor: str | None
    record: dict[str, Any]


@dataclass(frozen=True)
class ResumeDocumentParsed:
    """解析结果已记录（创建时随附或 parse-result 回报）。"""

    doc_id: str
    case_id: str | None
    parse_status: str
    record: dict[str, Any]


# ---------------------------------------------------------------------------
# HTTP 形状（与 openapi.yaml components 对齐）
# ---------------------------------------------------------------------------


class ResumeMail(ApiModel):
    mailbox: str
    message_id: str | None
    received_at: DateTimeStr
    subject: Annotated[str, Field(max_length=500)] | None = None
    from_address: str | None = None
    raw_storage_uri: str | None = None


class ResumeAttachment(ApiModel):
    filename: Annotated[str, Field(max_length=255)]
    sha256: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
    size_bytes: Annotated[int, Field(ge=0)]
    content_type: str
    storage_uri: str


class LinkDecision(ApiModel):
    method: LinkMethod
    case_id: str | None
    command_id: Annotated[str, Field(json_schema_extra={"format": "uuid"})] | None = None
    candidate_case_ids: list[str] = Field(default_factory=list)


class ParseResult(ApiModel):
    parse_status: ParseStatus
    text_storage_uri: str | None = None
    page_count: Annotated[int, Field(ge=0)] | None = None
    error: str | None = None


# openapi.yaml 中 ResumeDocumentCreate 的条件规则（原样复制；运行时由 ResumeDocumentService._check_variant 执行）
_VARIANT_RULE: dict[str, Any] = {
    "if": {"properties": {"variant": {"const": "branded"}}, "required": ["variant"]},
    "then": {
        "required": ["derived_from"],
        "properties": {"derived_from": {"type": "string"}, "mail": False, "link": False},
    },
    "else": {"required": ["mail_message_id", "mail", "link"], "properties": {"derived_from": {"type": "null"}}},
}


class ResumeDocumentCreate(ApiModel):
    model_config = ConfigDict(extra="forbid", json_schema_extra={"allOf": [_VARIANT_RULE]})

    variant: ResumeVariant = "original"
    mail_message_id: MailMessageIdStr | SkipJsonSchema[None] = None
    derived_from: Annotated[str, Field(min_length=1)] | None = None
    mail: ResumeMail | SkipJsonSchema[None] = None
    attachment: ResumeAttachment
    link: LinkDecision | SkipJsonSchema[None] = None
    parse: ParseResult | None = None


class ResumeDocument(BaseModel):
    doc_id: str
    variant: ResumeVariant
    derived_from: str | None
    mail_message_id: MailMessageIdRef | None
    case_id: str | None
    link_status: LinkStatus
    link_method: Literal["reliable_id", "resume_request", "name_match", "manual", "none"]
    version: Annotated[int, Field(ge=1)]
    sha256: str
    filename: str
    message_id: str | SkipJsonSchema[None] = None
    parse_status: ParseStatus
    created_at: DateTimeStr
    duplicate: bool


class ResumeDocumentList(BaseModel):
    items: list[ResumeDocument]
    next_cursor: str | None


class LinkRequest(ApiModel):
    case_id: Annotated[str, Field(min_length=1)]
    note: Annotated[str, Field(min_length=1, max_length=500)]


# ---------------------------------------------------------------------------
# 存储
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DocRow:
    doc_id: str
    variant: str
    derived_from: str | None
    mail_message_id: str | None
    case_id: str | None
    link_status: str
    link_method: str
    link: dict[str, Any] | None
    version: int
    sha256: str
    filename: str
    message_id: str | None
    mail: dict[str, Any] | None
    attachment: dict[str, Any]
    parse: dict[str, Any] | None
    parse_status: str
    created_at: str
    updated_at: str


def _j(value: Any) -> str | None:
    return None if value is None else canonical_json(value)


def _l(text: str | None) -> Any:
    return None if text is None else json.loads(text)


def _doc(r: sqlite3.Row | None) -> DocRow | None:
    if r is None:
        return None
    return DocRow(
        doc_id=r["doc_id"],
        variant=r["variant"],
        derived_from=r["derived_from"],
        mail_message_id=r["mail_message_id"],
        case_id=r["case_id"],
        link_status=r["link_status"],
        link_method=r["link_method"],
        link=_l(r["link_json"]),
        version=r["version"],
        sha256=r["sha256"],
        filename=r["filename"],
        message_id=r["message_id"],
        mail=_l(r["mail_json"]),
        attachment=json.loads(r["attachment_json"]),
        parse=_l(r["parse_json"]),
        parse_status=r["parse_status"],
        created_at=r["created_at"],
        updated_at=r["updated_at"],
    )


class ResumeDocumentStore:
    def __init__(self, store: SqliteStore):
        self._s = store

    def get(self, doc_id: str) -> DocRow | None:
        return _doc(self._s._one("SELECT * FROM resume_documents WHERE doc_id = ?", (doc_id,)))

    def find_original(self, mail_message_id: str, sha256: str) -> DocRow | None:
        return _doc(
            self._s._one(
                "SELECT * FROM resume_documents WHERE variant = 'original' AND mail_message_id = ? AND sha256 = ?",
                (mail_message_id, sha256),
            )
        )

    def find_branded(self, derived_from: str, sha256: str) -> DocRow | None:
        return _doc(
            self._s._one(
                "SELECT * FROM resume_documents WHERE variant = 'branded' AND derived_from = ? AND sha256 = ?",
                (derived_from, sha256),
            )
        )

    def insert(self, row: DocRow) -> bool:
        """插入；违反去重唯一约束时返回 False（并发重复提交）。version 为 0 时在事务里按流程取下一个版本号。"""
        try:
            with self._s._tx() as c:
                version = row.version or self._next_version(c, row.case_id)
                c.execute(
                    """INSERT INTO resume_documents (doc_id, variant, derived_from, mail_message_id, case_id,
                           link_status, link_method, link_json, version, sha256, filename, message_id, mail_json,
                           attachment_json, parse_json, parse_status, created_at, updated_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        row.doc_id,
                        row.variant,
                        row.derived_from,
                        row.mail_message_id,
                        row.case_id,
                        row.link_status,
                        row.link_method,
                        _j(row.link),
                        version,
                        row.sha256,
                        row.filename,
                        row.message_id,
                        _j(row.mail),
                        canonical_json(row.attachment),
                        _j(row.parse),
                        row.parse_status,
                        row.created_at,
                        row.updated_at,
                    ),
                )
            return True
        except sqlite3.IntegrityError:
            return False

    @staticmethod
    def _next_version(c: sqlite3.Connection, case_id: str | None) -> int:
        if case_id is None:
            return 1
        r = c.execute(
            "SELECT COALESCE(MAX(version), 0) AS v FROM resume_documents WHERE variant = 'original' AND case_id = ?",
            (case_id,),
        ).fetchone()
        return int(r["v"]) + 1

    def link_manual(self, doc_id: str, case_id: str, now: str) -> bool:
        """把尚未关联的原件关联到流程（method=manual），派生的品牌化版本随之继承；已关联返回 False。"""
        with self._s._tx() as c:
            version = self._next_version(c, case_id)
            cur = c.execute(
                """UPDATE resume_documents SET case_id = ?, link_status = 'linked', link_method = 'manual',
                       version = ?, updated_at = ?
                   WHERE doc_id = ? AND variant = 'original' AND link_status != 'linked'""",
                (case_id, version, now, doc_id),
            )
            if cur.rowcount != 1:
                return False
            c.execute(
                """UPDATE resume_documents SET case_id = ?, link_status = 'linked', link_method = 'manual',
                       version = ?, updated_at = ? WHERE derived_from = ? AND variant = 'branded'""",
                (case_id, version, now, doc_id),
            )
            return True

    def set_parse(self, doc_id: str, parse: dict[str, Any], now: str) -> bool:
        with self._s._tx() as c:
            cur = c.execute(
                "UPDATE resume_documents SET parse_json = ?, parse_status = ?, updated_at = ? WHERE doc_id = ?",
                (canonical_json(parse), parse["parse_status"], now, doc_id),
            )
            return cur.rowcount == 1

    def originals_of_message(self, mail_message_id: str) -> list[DocRow]:
        rows = self._s._all(
            "SELECT * FROM resume_documents WHERE variant = 'original' AND mail_message_id = ? ORDER BY seq",
            (mail_message_id,),
        )
        return [_doc(r) for r in rows]  # type: ignore[misc]

    def list(
        self,
        link_status: str | None,
        case_id: str | None,
        variant: str | None,
        mail_message_id: str | None,
        cursor: str | None,
        limit: int,
    ) -> Any:
        where, args = [], []
        for column, value in (
            ("link_status", link_status),
            ("case_id", case_id),
            ("variant", variant),
            ("mail_message_id", mail_message_id),
        ):
            if value is not None:
                where.append(f"{column} = ?")
                args.append(value)
        return self._s._page("resume_documents", where, args, cursor, limit, _doc)


# ---------------------------------------------------------------------------
# 业务
# ---------------------------------------------------------------------------


def document_record(row: DocRow, duplicate: bool = False) -> dict[str, Any]:
    """组装 openapi ResumeDocument。"""
    record: dict[str, Any] = {
        "doc_id": row.doc_id,
        "variant": row.variant,
        "derived_from": row.derived_from,
        "mail_message_id": row.mail_message_id,
        "case_id": row.case_id,
        "link_status": row.link_status,
        "link_method": row.link_method,
        "version": row.version,
        "sha256": row.sha256,
        "filename": row.filename,
        "parse_status": row.parse_status,
        "created_at": wire_time(row.created_at),
        "duplicate": duplicate,
    }
    if row.message_id is not None:
        record["message_id"] = row.message_id
    return record


def _err(path: str, message: str, code: str) -> dict[str, str]:
    return {"path": path, "message": message, "code": code}


class ResumeDocumentService:
    """case_exists(case_id) 由装配方注入（F2 合并后接 recruitment_cases）；默认认为流程存在。"""

    def __init__(self, ctx: AppContext, case_exists: Callable[[str], bool] | None = None):
        self.ctx = ctx
        self.store = ResumeDocumentStore(ctx.store)  # type: ignore[arg-type]
        self.case_exists: Callable[[str], bool] = case_exists or (lambda case_id: True)

    def _now(self) -> str:
        return to_db_time(self.ctx.clock.now())

    def get(self, doc_id: str) -> dict[str, Any] | None:
        row = self.store.get(doc_id)
        return None if row is None else document_record(row)

    # -- 写入 -----------------------------------------------------------------

    def create(self, body: ResumeDocumentCreate) -> tuple[int, dict[str, Any]]:
        self._check_variant(body)
        if body.variant == "branded":
            return self._create_branded(body)
        return self._create_original(body)

    @staticmethod
    def _check_variant(body: ResumeDocumentCreate) -> None:
        given = body.model_fields_set
        errors: list[dict[str, str]] = []
        if body.variant == "branded":
            if body.derived_from is None:
                errors.append(_err("derived_from", "品牌化版本必须带 derived_from", "required"))
            for name in ("mail", "link"):
                if name in given:
                    errors.append(_err(name, "品牌化版本不带 mail 与 link（继承原件）", "not_allowed"))
        else:
            for name in ("mail_message_id", "mail", "link"):
                if getattr(body, name) is None:
                    errors.append(_err(name, "原件必须带 mail_message_id、mail、link", "required"))
            if body.derived_from is not None:
                errors.append(_err("derived_from", "原件的 derived_from 必须为 null", "not_allowed"))
        if body.mail is not None:
            try:
                parsed = parse_time(body.mail.received_at)
            except ValueError:
                parsed = None
            if parsed is None or parsed.tzinfo is None:
                errors.append(_err("mail.received_at", "应为带时区的 RFC 3339 时间", "format"))
        if errors:
            raise validation_failed(errors)

    def _check_link(self, link: LinkDecision) -> None:
        errors: list[dict[str, str]] = []
        if link.method == "none":
            if link.case_id is not None:
                errors.append(_err("link.case_id", "method=none 时 case_id 必须为 null", "not_allowed"))
        else:
            if link.case_id is None:
                errors.append(_err("link.case_id", f"method={link.method} 必须给出 case_id", "required"))
            elif not self.case_exists(link.case_id):
                errors.append(_err("link.case_id", f"流程 {link.case_id} 不存在", "unknown_case"))
        if link.method == "resume_request":
            errors.extend(self._check_resume_request(link))
        elif link.command_id is not None:
            errors.append(_err("link.command_id", "只有 method=resume_request 才带 command_id", "not_allowed"))
        if errors:
            raise validation_failed(errors)

    def _check_resume_request(self, link: LinkDecision) -> list[dict[str, str]]:
        if link.command_id is None:
            return [_err("link.command_id", "method=resume_request 必须给出 request_resume 指令", "required")]
        try:
            command_id = str(uuid.UUID(link.command_id))
        except ValueError:
            return [_err("link.command_id", "不是合法 UUID", "format")]
        cmd = self.ctx.store.get_command(command_id)
        if cmd is None or cmd.action != "request_resume" or cmd.server_status != "succeeded":
            return [_err("link.command_id", "不是已成功的 request_resume 指令", "link_command_invalid")]
        if link.case_id is not None and cmd.case_id is not None and cmd.case_id != link.case_id:
            return [_err("link.command_id", "该 request_resume 指令属于其他流程", "link_command_invalid")]
        return []

    def _create_original(self, body: ResumeDocumentCreate) -> tuple[int, dict[str, Any]]:
        assert body.mail_message_id is not None and body.mail is not None and body.link is not None
        if self.ctx.mail.store.get_message(body.mail_message_id) is None:
            raise not_found(f"邮件记录 {body.mail_message_id}")
        sha = body.attachment.sha256
        existing = self.store.find_original(body.mail_message_id, sha)
        if existing is not None:
            return 200, document_record(existing, duplicate=True)
        link = body.link
        self._check_link(link)
        linked = link.method != "none"
        now = self._now()
        parse = None if body.parse is None else body.parse.model_dump(mode="json")
        row = DocRow(
            doc_id=_new_doc_id(),
            variant="original",
            derived_from=None,
            mail_message_id=body.mail_message_id,
            case_id=link.case_id if linked else None,
            link_status="linked" if linked else "needs_manual",
            link_method=link.method,
            link=link.model_dump(mode="json"),
            version=0,  # 由存储层按流程分配
            sha256=sha,
            filename=body.attachment.filename,
            message_id=body.mail.message_id,
            mail=body.mail.model_dump(mode="json"),
            attachment=body.attachment.model_dump(mode="json"),
            parse=parse,
            parse_status="pending" if parse is None else parse["parse_status"],
            created_at=now,
            updated_at=now,
        )
        if not self.store.insert(row):
            dup = self.store.find_original(body.mail_message_id, sha)
            assert dup is not None
            return 200, document_record(dup, duplicate=True)
        stored = self.store.get(row.doc_id)
        assert stored is not None
        record = document_record(stored)
        if linked:
            assert stored.case_id is not None
            self.ctx.bus.publish(  # type: ignore[arg-type]
                ResumeDocumentLinked(
                    stored.doc_id,
                    stored.case_id,
                    stored.link_method,
                    stored.mail_message_id,
                    None if link.command_id is None else str(uuid.UUID(link.command_id)),
                    stored.version,
                    None,
                    record,
                )
            )
        if parse is not None:
            self.ctx.bus.publish(ResumeDocumentParsed(stored.doc_id, stored.case_id, stored.parse_status, record))  # type: ignore[arg-type]
        return 201, record

    def _create_branded(self, body: ResumeDocumentCreate) -> tuple[int, dict[str, Any]]:
        assert body.derived_from is not None
        original = self.store.get(body.derived_from)
        if original is None:
            raise not_found(f"原件 {body.derived_from}")
        if original.variant != "original":
            raise validation_failed([_err("derived_from", "只能从原件派生品牌化版本", "not_original")])
        if body.mail_message_id is not None and body.mail_message_id != original.mail_message_id:
            raise validation_failed([_err("mail_message_id", "与原件的 mail_message_id 不一致", "mismatch")])
        sha = body.attachment.sha256
        existing = self.store.find_branded(original.doc_id, sha)
        if existing is not None:
            return 200, document_record(existing, duplicate=True)
        now = self._now()
        parse = None if body.parse is None else body.parse.model_dump(mode="json")
        row = DocRow(
            doc_id=_new_doc_id(),
            variant="branded",
            derived_from=original.doc_id,
            mail_message_id=original.mail_message_id,
            case_id=original.case_id,
            link_status=original.link_status,
            link_method=original.link_method,
            link=None,
            version=original.version,
            sha256=sha,
            filename=body.attachment.filename,
            message_id=original.message_id,
            mail=None,
            attachment=body.attachment.model_dump(mode="json"),
            parse=parse,
            parse_status="pending" if parse is None else parse["parse_status"],
            created_at=now,
            updated_at=now,
        )
        if not self.store.insert(row):
            dup = self.store.find_branded(original.doc_id, sha)
            assert dup is not None
            return 200, document_record(dup, duplicate=True)
        stored = self.store.get(row.doc_id)
        assert stored is not None
        return 201, document_record(stored)

    def record_parse(self, doc_id: str, parse: ParseResult) -> dict[str, Any]:
        data = parse.model_dump(mode="json")
        if not self.store.set_parse(doc_id, data, self._now()):
            raise not_found("简历文档")
        stored = self.store.get(doc_id)
        assert stored is not None
        record = document_record(stored)
        self.ctx.bus.publish(ResumeDocumentParsed(doc_id, stored.case_id, stored.parse_status, record))  # type: ignore[arg-type]
        return record

    def link(self, doc_id: str, case_id: str, note: str, actor: str) -> dict[str, Any]:
        """控制台人工关联。已关联到其他流程 409；已关联到同一流程只补记人工处理，不重复发布。"""
        row = self.store.get(doc_id)
        if row is None:
            raise not_found("简历文档")
        if row.variant != "original":
            raise ApiError(409, "not_original", "品牌化版本随原件关联，请关联原件", existing=document_record(row))
        if not self.case_exists(case_id):
            raise not_found(f"流程 {case_id}")
        now = self._now()
        changed = False
        if row.link_status == "linked":
            if row.case_id != case_id:
                raise ApiError(409, "already_linked", "文档已关联到其他流程", existing=document_record(row))
        else:
            changed = self.store.link_manual(doc_id, case_id, now)
            if not changed:
                current = self.store.get(doc_id)
                assert current is not None
                if current.case_id != case_id:
                    raise ApiError(409, "already_linked", "文档已关联到其他流程", existing=document_record(current))
        manual = ManualActionRow(
            manual_action_id=f"ma_{uuid.uuid4().hex}",
            type="link_resume",
            actor=actor,
            at=now,
            note=note,
            target_kind="resume_document",
            target_id=doc_id,
        )
        self.ctx.store.insert_manual_action(manual)
        if changed:
            stored = self.store.get(doc_id)
            assert stored is not None and stored.case_id is not None
            self.ctx.bus.publish(  # type: ignore[arg-type]
                ResumeDocumentLinked(
                    doc_id, stored.case_id, "manual", stored.mail_message_id, None, stored.version, actor,
                    document_record(stored),
                )
            )
            if stored.mail_message_id is not None and all(
                d.link_status == "linked" for d in self.store.originals_of_message(stored.mail_message_id)
            ):
                self.ctx.mail.mark_processed_after_link(stored.mail_message_id)
        return manual_action_record(manual)


def _new_doc_id() -> str:
    return f"doc_{uuid.uuid4().hex[:20]}"


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------

router = APIRouter(tags=["resume-documents"])
DocIdPath = Annotated[str, Path(min_length=1)]


@router.post(
    "/resume-documents",
    operation_id="createResumeDocument",
    summary="邮件接入写入一份简历附件",
    response_model=ResumeDocument,
    responses={201: {"description": "已创建", "model": ResumeDocument}, **problem_responses(401, 404, 422)},
)
def create_resume_document(
    request: Request,
    ctx: Ctx,
    actor: Annotated[str, Depends(require_service)],
    idempotency_key: IdempotencyKeyHeader,
    body: Annotated[ResumeDocumentCreate, Body()],
):
    return run_idempotent(
        ctx,
        request,
        f"service:{actor}",
        idempotency_key,
        body.model_dump(mode="json", exclude_unset=True),
        lambda: ctx.resume_documents.create(body),
    )


@router.get(
    "/resume-documents",
    operation_id="listResumeDocuments",
    summary="简历文档列表（含待人工关联队列）",
    response_model=ResumeDocumentList,
    responses=problem_responses(401, 422),
)
def list_resume_documents(
    ctx: Ctx,
    _actor: ConsoleOrService,
    link_status: LinkStatus | None = None,
    case_id: str | None = None,
    variant: ResumeVariant | None = None,
    mail_message_id: Annotated[str | None, Query(pattern=MAIL_MESSAGE_ID_PATTERN)] = None,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
):
    page = ctx.resume_documents.store.list(link_status, case_id, variant, mail_message_id, check_cursor(cursor), limit)
    return ok({"items": [document_record(r) for r in page.items], "next_cursor": page.next_cursor})


@router.get(
    "/resume-documents/{doc_id}",
    operation_id="getResumeDocument",
    summary="简历文档详情",
    response_model=ResumeDocument,
    responses=problem_responses(401, 404),
)
def get_resume_document(ctx: Ctx, _actor: ConsoleOrService, doc_id: DocIdPath):
    record = ctx.resume_documents.get(doc_id)
    if record is None:
        raise not_found("简历文档")
    return ok(record)


@router.post(
    "/resume-documents/{doc_id}/parse-result",
    operation_id="postParseResult",
    summary="邮件接入回报 PDF 文本解析结果",
    response_model=ResumeDocument,
    responses=problem_responses(401, 404, 422),
)
def post_parse_result(
    request: Request,
    ctx: Ctx,
    doc_id: DocIdPath,
    actor: Annotated[str, Depends(require_service)],
    idempotency_key: IdempotencyKeyHeader,
    body: Annotated[ParseResult, Body()],
):
    return run_idempotent(
        ctx,
        request,
        f"service:{actor}",
        idempotency_key,
        body.model_dump(mode="json"),
        lambda: (200, ctx.resume_documents.record_parse(doc_id, body)),
    )


@router.post(
    "/resume-documents/{doc_id}:link",
    operation_id="linkResumeDocument",
    summary="人工关联简历到招聘流程",
    response_model=ManualAction,
    responses=problem_responses(401, 404, 409),
)
def link_resume_document(
    request: Request,
    ctx: Ctx,
    doc_id: DocIdPath,
    actor: ConsoleActor,
    idempotency_key: IdempotencyKeyHeader,
    body: Annotated[LinkRequest, Body()],
):
    return run_idempotent(
        ctx,
        request,
        f"console:{actor}",
        idempotency_key,
        body.model_dump(mode="json"),
        lambda: (200, ctx.resume_documents.link(doc_id, body.case_id, body.note, actor)),
    )


__all__ = [
    "DocRow",
    "LinkDecision",
    "ParseResult",
    "ResumeDocumentCreate",
    "ResumeDocumentLinked",
    "ResumeDocumentParsed",
    "ResumeDocumentService",
    "ResumeDocumentStore",
    "document_record",
    "router",
]
