"""招聘流程 recruitment_case：存储、状态机迁移、时间线，以及 GET /cases、GET /cases/{id}。

- 一个 case = 账户 + 候选人 + 岗位（姓名与岗位按 NFC + 去首尾空白规范化后唯一）。同一新投递因为
  bucket 不同算出两个 event_id 时，按这三者合并到同一个 case，不重复建（contracts.md 9.1）。
- 阶段迁移只走 ``monitor_contracts.require_transition("case", …)``，不另写迁移表；每次迁移在同一个
  事务里写一条 stage_change 时间线，并用"当前阶段 = 预期阶段"做比较交换，防止并发覆盖。
- needs_human 是阶段；needs_human_reason 记录原因（unknown_result、command_failed、
  conversation_ambiguous、resume_mail_timeout、resume_link_ambiguous 等），离开 needs_human 时清空。
- 简历文档由任务 G 写入；G 关联成功后调用 ``CaseService.link_resume``，解析完成后调用
  ``CaseService.mark_resume_parsed``。详情里的简历文件由 ``resume_documents_provider`` 提供
  （G 实现前为空列表）。关联独立于阶段：已在 contact_requested 等阶段时只记时间线、阶段不回退。
"""

from __future__ import annotations

import json
import sqlite3
import threading
import unicodedata
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Annotated, Any, Literal

from fastapi import APIRouter, Path, Query
from pydantic import BaseModel, ConfigDict, Field
from pydantic.json_schema import SkipJsonSchema

from monitor_contracts import CaseStage, IllegalTransition, require_transition

from .commands import CommandRecord, DateTimeStr, ManualAction, manual_action_record
from .db import canonical_json, to_db_time, wire_time
from .main import (
    ConsoleActor,
    ConsoleOrService,
    Ctx,
    check_cursor,
    contract_ref,
    not_found,
    ok,
    problem_responses,
)

if TYPE_CHECKING:
    from .db import SqliteStore
    from .main import AppContext

CASE_STAGES = tuple(s.value for s in CaseStage)
CONTACT_STATUSES = (
    "not_requested",
    "request_sent",
    "pending_acceptance",
    "available",
    "refused",
    "pending_confirmation",
)
TIMELINE_TYPES = (
    "event",
    "command",
    "command_result",
    "resume_document",
    "resume_linked",
    "manual_action",
    "stage_change",
)

STAGE_TEXT = {
    "new_application": "新投递",
    "greeted": "已问候",
    "resume_requested": "简历请求已发送",
    "resume_received": "已看到附件简历",
    "resume_linked": "简历已关联",
    "contact_requested": "已请求换微信",
    "contact_available": "微信可用",
    "closed": "已关闭",
    "needs_human": "待人工处理",
}


def normalize_text(value: str) -> str:
    """与 event_id 的会话身份规范化一致：NFC + 去首尾空白。"""
    return unicodedata.normalize("NFC", value.strip())


def new_case_id() -> str:
    return f"case_{uuid.uuid4().hex}"


# ---------------------------------------------------------------------------
# 行模型与存储
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CaseRow:
    case_id: str
    account_id: str
    candidate_name: str
    job_title: str
    conversation_hints: list[str]
    stage: str
    created_at: str
    updated_at: str
    needs_human_reason: str | None = None
    contact_status: str = "not_requested"
    next_action: str | None = None
    next_depends_on: str | None = None
    blocked_reason: str | None = None
    resume_requested_at: str | None = None
    seq: int | None = None

    @property
    def conversation(self) -> dict[str, Any]:
        return {"candidate_name": self.candidate_name, "job_title": self.job_title, "hints": self.conversation_hints}


@dataclass(frozen=True)
class TimelineRow:
    case_id: str
    at: str
    type: str
    ref_id: str
    summary: str
    stage_from: str | None = None
    stage_to: str | None = None
    seq: int | None = None


@dataclass(frozen=True)
class CaseFilter:
    account_id: str | None = None
    stages: Sequence[str] = ()
    job_title: str | None = None
    needs_human: bool | None = None
    q: str | None = None


_CASE_MUTABLE = {
    "conversation_hints",
    "needs_human_reason",
    "contact_status",
    "next_action",
    "next_depends_on",
    "blocked_reason",
    "resume_requested_at",
}


class CaseStore:
    """recruitment_cases / case_timeline / case_commands / case_resume_links 的 SQLite 实现。

    与 F1 的 SqliteStore 共用同一个连接与锁（表在 db.MIGRATIONS v2），所以写 case 与写时间线
    在同一个事务里。换 PostgreSQL 时按同样的语义另写实现。
    """

    def __init__(self, store: SqliteStore):
        self._s = store

    @staticmethod
    def _case(r: sqlite3.Row | None) -> CaseRow | None:
        if r is None:
            return None
        return CaseRow(
            seq=r["seq"],
            case_id=r["case_id"],
            account_id=r["account_id"],
            candidate_name=r["candidate_name"],
            job_title=r["job_title"],
            conversation_hints=json.loads(r["conversation_hints_json"]),
            stage=r["stage"],
            needs_human_reason=r["needs_human_reason"],
            contact_status=r["contact_status"],
            next_action=r["next_action"],
            next_depends_on=r["next_depends_on"],
            blocked_reason=r["blocked_reason"],
            resume_requested_at=r["resume_requested_at"],
            created_at=r["created_at"],
            updated_at=r["updated_at"],
        )

    def get(self, case_id: str) -> CaseRow | None:
        return self._case(self._s._one("SELECT * FROM recruitment_cases WHERE case_id = ?", (case_id,)))

    def find(self, account_id: str, candidate_name: str, job_title: str) -> CaseRow | None:
        return self._case(
            self._s._one(
                "SELECT * FROM recruitment_cases WHERE account_id = ? AND candidate_name = ? AND job_title = ?",
                (account_id, candidate_name, job_title),
            )
        )

    def insert(self, row: CaseRow, timeline: TimelineRow) -> bool:
        """按（账户, 姓名, 岗位）幂等插入并写第一条时间线；已存在返回 False 且不写。"""
        with self._s._tx() as c:
            cur = c.execute(
                """INSERT OR IGNORE INTO recruitment_cases (case_id, account_id, candidate_name, job_title,
                       conversation_hints_json, stage, contact_status, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (
                    row.case_id,
                    row.account_id,
                    row.candidate_name,
                    row.job_title,
                    canonical_json(row.conversation_hints),
                    row.stage,
                    row.contact_status,
                    row.created_at,
                    row.updated_at,
                ),
            )
            if cur.rowcount != 1:
                return False
            self._insert_timeline(c, timeline)
            return True

    def set_stage(
        self, case_id: str, expected: str, stage: str, reason: str | None, now: str, timeline: TimelineRow
    ) -> bool:
        """比较交换：当前阶段等于 expected 时改为 stage，并写一条时间线。"""
        with self._s._tx() as c:
            cur = c.execute(
                """UPDATE recruitment_cases SET stage = ?, needs_human_reason = ?, updated_at = ?
                   WHERE case_id = ? AND stage = ?""",
                (stage, reason, now, case_id, expected),
            )
            if cur.rowcount != 1:
                return False
            self._insert_timeline(c, timeline)
            return True

    def update(self, case_id: str, now: str, **fields: Any) -> None:
        sets, args = ["updated_at = ?"], [now]
        for name, value in fields.items():
            if name not in _CASE_MUTABLE:
                raise KeyError(name)
            column = "conversation_hints_json" if name == "conversation_hints" else name
            sets.append(f"{column} = ?")
            args.append(canonical_json(value) if name == "conversation_hints" else value)
        with self._s._tx() as c:
            c.execute(f"UPDATE recruitment_cases SET {', '.join(sets)} WHERE case_id = ?", (*args, case_id))

    def list(self, flt: CaseFilter, cursor: str | None, limit: int) -> tuple[list[CaseRow], str | None]:
        where: list[str] = []
        args: list[Any] = []
        if flt.account_id is not None:
            where.append("account_id = ?")
            args.append(flt.account_id)
        if flt.stages:
            where.append(f"stage IN ({','.join('?' * len(flt.stages))})")
            args.extend(flt.stages)
        if flt.job_title is not None:
            where.append("job_title = ?")
            args.append(normalize_text(flt.job_title))
        if flt.needs_human is not None:
            where.append("stage = 'needs_human'" if flt.needs_human else "stage != 'needs_human'")
        if flt.q:
            where.append("(instr(candidate_name, ?) > 0 OR instr(job_title, ?) > 0)")
            q = normalize_text(flt.q)
            args.extend([q, q])
        if cursor is not None:
            where.append("seq < ?")
            args.append(int(cursor))
        sql = "SELECT * FROM recruitment_cases"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY seq DESC LIMIT ?"
        rows = self._s._all(sql, (*args, limit + 1))
        items = [self._case(r) for r in rows[:limit]]
        next_cursor = str(rows[limit - 1]["seq"]) if len(rows) > limit else None
        return [i for i in items if i is not None], next_cursor

    def cases_with_next_action(self) -> list[CaseRow]:
        rows = self._s._all("SELECT * FROM recruitment_cases WHERE next_action IS NOT NULL ORDER BY seq")
        return [r for r in (self._case(x) for x in rows) if r is not None]

    def cases_in_stage(self, stage: str) -> list[CaseRow]:
        rows = self._s._all("SELECT * FROM recruitment_cases WHERE stage = ? ORDER BY seq", (stage,))
        return [r for r in (self._case(x) for x in rows) if r is not None]

    # -- 时间线 ---------------------------------------------------------------

    @staticmethod
    def _insert_timeline(c: sqlite3.Connection, t: TimelineRow) -> None:
        if t.type not in TIMELINE_TYPES:
            raise ValueError(f"未知时间线类型 {t.type}")
        c.execute(
            """INSERT INTO case_timeline (case_id, at, type, ref_id, stage_from, stage_to, summary)
               VALUES (?,?,?,?,?,?,?)""",
            (t.case_id, t.at, t.type, t.ref_id, t.stage_from, t.stage_to, t.summary),
        )

    def add_timeline(self, t: TimelineRow) -> None:
        with self._s._tx() as c:
            self._insert_timeline(c, t)

    def timeline(self, case_id: str) -> list[TimelineRow]:
        rows = self._s._all("SELECT * FROM case_timeline WHERE case_id = ? ORDER BY seq", (case_id,))
        return [TimelineRow(**dict(r)) for r in rows]

    # -- 指令登记 -------------------------------------------------------------

    def register_command(self, command_id: str, case_id: str, origin: str, now: str) -> None:
        with self._s._tx() as c:
            c.execute(
                "INSERT OR IGNORE INTO case_commands (command_id, case_id, origin, created_at) VALUES (?,?,?,?)",
                (command_id, case_id, origin, now),
            )

    def command_origin(self, command_id: str) -> str | None:
        r = self._s._one("SELECT origin FROM case_commands WHERE command_id = ?", (command_id,))
        return None if r is None else r["origin"]

    def case_command_ids(self, case_id: str) -> list[str]:
        rows = self._s._all("SELECT command_id FROM commands WHERE case_id = ? ORDER BY seq", (case_id,))
        return [r["command_id"] for r in rows]

    def latest_command_id(self, case_id: str) -> str | None:
        r = self._s._one("SELECT command_id FROM commands WHERE case_id = ? ORDER BY seq DESC LIMIT 1", (case_id,))
        return None if r is None else r["command_id"]

    # -- 简历关联 -------------------------------------------------------------

    def link_resume(self, doc_id: str, case_id: str, now: str) -> bool:
        with self._s._tx() as c:
            return (
                c.execute(
                    "INSERT OR IGNORE INTO case_resume_links (doc_id, case_id, linked_at) VALUES (?,?,?)",
                    (doc_id, case_id, now),
                ).rowcount
                == 1
            )

    def resume_link(self, doc_id: str) -> dict[str, Any] | None:
        r = self._s._one("SELECT * FROM case_resume_links WHERE doc_id = ?", (doc_id,))
        return None if r is None else dict(r)

    def mark_parsed(self, doc_id: str, now: str) -> bool:
        with self._s._tx() as c:
            return (
                c.execute(
                    "UPDATE case_resume_links SET parsed_at = ? WHERE doc_id = ? AND parsed_at IS NULL", (now, doc_id)
                ).rowcount
                == 1
            )

    def has_linked_resume(self, case_id: str) -> bool:
        return self._s._one("SELECT 1 FROM case_resume_links WHERE case_id = ? LIMIT 1", (case_id,)) is not None


# ---------------------------------------------------------------------------
# 业务
# ---------------------------------------------------------------------------


class StageNotAllowed(Exception):
    """迁移不合法或阶段已被并发修改。"""


@dataclass
class CaseService:
    ctx: AppContext
    repo: CaseStore = field(init=False)
    # 所有改 case 的操作串行执行（事件订阅、结果订阅、人工处理、定时推进共用）
    lock: threading.RLock = field(default_factory=threading.RLock)
    # 简历文件来源（任务 G 注入）：case_id → openapi ResumeDocument 列表
    resume_documents_provider: Callable[[str], list[dict[str, Any]]] = field(default=lambda case_id: [])

    def __post_init__(self) -> None:
        self.repo = CaseStore(self.ctx.store)  # type: ignore[arg-type]

    def _now(self) -> str:
        return to_db_time(self.ctx.clock.now())

    def get(self, case_id: str) -> CaseRow | None:
        return self.repo.get(case_id)

    def require(self, case_id: str) -> CaseRow:
        row = self.repo.get(case_id)
        if row is None:
            raise not_found("流程")
        return row

    def find(self, account_id: str, conversation: dict[str, Any]) -> CaseRow | None:
        return self.repo.find(
            account_id, normalize_text(conversation["candidate_name"]), normalize_text(conversation["job_title"])
        )

    def open_case(self, account_id: str, conversation: dict[str, Any], event_id: str) -> tuple[CaseRow, bool]:
        """按（账户, 姓名, 岗位）找到或建立 case，返回 (case, 是否新建)。"""
        with self.lock:
            existing = self.find(account_id, conversation)
            if existing is not None:
                return existing, False
            now = self._now()
            name = normalize_text(conversation["candidate_name"])
            job = normalize_text(conversation["job_title"])
            row = CaseRow(
                case_id=new_case_id(),
                account_id=account_id,
                candidate_name=name,
                job_title=job,
                conversation_hints=list(conversation.get("hints") or []),
                stage=CaseStage.NEW_APPLICATION.value,
                created_at=now,
                updated_at=now,
            )
            created = self.repo.insert(
                row,
                TimelineRow(row.case_id, now, "stage_change", event_id, "新投递，建立流程", None, row.stage),
            )
            stored = self.find(account_id, conversation)
            assert stored is not None
            return stored, created

    def transition(self, case_id: str, to: str, *, ref_id: str, summary: str, reason: str | None = None) -> CaseRow:
        """按契约迁移表迁移阶段，写 stage_change 时间线。不合法抛 StageNotAllowed。"""
        with self.lock:
            row = self.require(case_id)
            try:
                require_transition("case", row.stage, to)
            except IllegalTransition as exc:
                raise StageNotAllowed(str(exc)) from exc
            now = self._now()
            reason = reason if to == CaseStage.NEEDS_HUMAN.value else None
            ok_ = self.repo.set_stage(
                case_id, row.stage, to, reason, now, TimelineRow(case_id, now, "stage_change", ref_id, summary, row.stage, to)
            )
            if not ok_:
                raise StageNotAllowed("流程阶段已被并发修改")
            if to not in (CaseStage.NEW_APPLICATION.value, CaseStage.GREETED.value):
                # 离开早期阶段后不再自动推进（自动流程只到"简历请求已发送"）
                self.repo.update(case_id, now, next_action=None, next_depends_on=None, blocked_reason=None)
            return self.require(case_id)

    def try_transition(self, case_id: str, to: str, *, ref_id: str, summary: str, reason: str | None = None) -> bool:
        """能迁移就迁移；不合法时只记一条时间线说明，返回 False。"""
        try:
            self.transition(case_id, to, ref_id=ref_id, summary=summary, reason=reason)
            return True
        except StageNotAllowed:
            return False

    def to_needs_human(self, case_id: str, reason: str, *, ref_id: str, summary: str) -> bool:
        """转人工；已在 needs_human 时只更新原因并记时间线；closed / contact_available 不能转人工。"""
        with self.lock:
            row = self.require(case_id)
            if row.stage == CaseStage.NEEDS_HUMAN.value:
                self.repo.update(case_id, self._now(), needs_human_reason=reason)
                self.note(case_id, "stage_change", ref_id, summary)
                return True
            return self.try_transition(case_id, CaseStage.NEEDS_HUMAN.value, ref_id=ref_id, summary=summary, reason=reason)

    def note(self, case_id: str, type_: str, ref_id: str, summary: str) -> None:
        self.repo.add_timeline(TimelineRow(case_id, self._now(), type_, ref_id, summary))

    def update(self, case_id: str, **fields: Any) -> None:
        with self.lock:
            self.repo.update(case_id, self._now(), **fields)

    # -- 简历（任务 G 调用） -----------------------------------------------------

    def link_resume(self, case_id: str, doc_id: str) -> bool:
        """简历文档已唯一关联到本流程。返回是否首次关联。

        resume_requested / resume_received / greeted / new_application → resume_linked；
        needs_human（例如超时转人工后邮件才到、或人工关联）→ resume_linked；
        其他阶段（contact_requested 等）阶段不回退，只记 resume_linked 时间线。
        """
        with self.lock:
            row = self.require(case_id)
            if not self.repo.link_resume(doc_id, case_id, self._now()):
                return False
            self.note(case_id, "resume_linked", doc_id, "简历已关联到本流程")
            if row.stage in (
                CaseStage.NEW_APPLICATION.value,
                CaseStage.GREETED.value,
                CaseStage.RESUME_REQUESTED.value,
                CaseStage.RESUME_RECEIVED.value,
                CaseStage.NEEDS_HUMAN.value,
            ):
                # new_application / greeted 没有直达 resume_linked 的边，先经 resume_received
                if row.stage in (CaseStage.NEW_APPLICATION.value, CaseStage.GREETED.value):
                    self.transition(
                        case_id, CaseStage.RESUME_RECEIVED.value, ref_id=doc_id, summary="收到简历邮件"
                    )
                self.transition(case_id, CaseStage.RESUME_LINKED.value, ref_id=doc_id, summary="简历已关联")
            return True

    def mark_resume_parsed(self, doc_id: str) -> bool:
        """简历解析完成（用于总览"解析完成"计数）。未关联的文档返回 False。"""
        with self.lock:
            link = self.repo.resume_link(doc_id)
            if link is None:
                return False
            if self.repo.mark_parsed(doc_id, self._now()):
                self.note(link["case_id"], "resume_document", doc_id, "简历解析完成")
            return True

    # -- 展示 -----------------------------------------------------------------

    def summary(self, row: CaseRow) -> dict[str, Any]:
        policy = self.ctx.policies.get(row.account_id)
        latest = self.repo.latest_command_id(row.case_id)
        out: dict[str, Any] = {
            "case_id": row.case_id,
            "account_id": row.account_id,
            "candidate_name": row.candidate_name,
            "job_title": row.job_title,
            "conversation_hints": row.conversation_hints,
            "stage": row.stage,
            "paused": bool(policy and policy["paused"]),
            "needs_human": row.stage == CaseStage.NEEDS_HUMAN.value,
            "needs_human_reason": row.needs_human_reason,
            "contact_status": row.contact_status,
            "latest_command": None if latest is None else self.ctx.commands.get(latest),
            "created_at": wire_time(row.created_at),
            "updated_at": wire_time(row.updated_at),
        }
        return out

    def detail(self, case_id: str) -> dict[str, Any]:
        row = self.require(case_id)
        command_ids = self.repo.case_command_ids(case_id)
        commands = [c for c in (self.ctx.commands.get(i) for i in command_ids) if c is not None]
        manual = list(self.ctx.store.list_manual_actions("case", case_id))
        for command_id in command_ids:
            manual.extend(self.ctx.store.list_manual_actions("command", command_id))
        manual.sort(key=lambda m: (m.at, m.manual_action_id))

        return {
            **self.summary(row),
            "timeline": [
                {
                    "at": wire_time(t.at),
                    "type": t.type,
                    "ref_id": t.ref_id,
                    "stage_from": t.stage_from,
                    "stage_to": t.stage_to,
                    "summary": t.summary,
                }
                for t in self.repo.timeline(case_id)
            ],
            "resume_documents": list(self.resume_documents_provider(case_id)),
            "commands": commands,
            "manual_actions": [manual_action_record(m) for m in manual],
        }

    def list(self, flt: CaseFilter, cursor: str | None, limit: int) -> dict[str, Any]:
        rows, next_cursor = self.repo.list(flt, cursor, limit)
        return {"items": [self.summary(r) for r in rows], "next_cursor": next_cursor}


# ---------------------------------------------------------------------------
# HTTP 形状（用于生成 openapi，与 contracts/openapi.yaml 对齐；响应体由业务层组装）
# ---------------------------------------------------------------------------

CaseStageLit = Literal[
    "new_application",
    "greeted",
    "resume_requested",
    "resume_received",
    "resume_linked",
    "contact_requested",
    "contact_available",
    "closed",
    "needs_human",
]
ContactStatusLit = Literal[
    "not_requested", "request_sent", "pending_acceptance", "available", "refused", "pending_confirmation"
]


class CaseSummary(BaseModel):
    case_id: str
    account_id: str
    candidate_name: str
    job_title: str
    conversation_hints: list[str] | SkipJsonSchema[None] = None
    stage: CaseStageLit
    paused: bool
    needs_human: bool
    needs_human_reason: str | None = None
    contact_status: ContactStatusLit | SkipJsonSchema[None] = None
    latest_command: CommandRecord | None = None
    created_at: DateTimeStr | SkipJsonSchema[None] = None
    updated_at: DateTimeStr


class CaseList(BaseModel):
    items: list[CaseSummary]
    next_cursor: str | None


class TimelineEntry(BaseModel):
    at: DateTimeStr
    type: Literal[
        "event", "command", "command_result", "resume_document", "resume_linked", "manual_action", "stage_change"
    ]
    ref_id: str
    stage_from: CaseStageLit | None = None
    stage_to: CaseStageLit | None = None
    summary: str


class ResumeDocument(BaseModel):
    """简历文档（任务 G 写入；这里只用于生成 CaseDetail 的文档形状）。"""

    doc_id: str
    variant: Literal["original", "branded"]
    derived_from: str | None
    mail_message_id: (
        Annotated[str, contract_ref("./schemas/mail_message.json#/properties/mail_message_id")] | None
    )
    case_id: str | None
    link_status: Literal["linked", "needs_manual", "unlinked"]
    link_method: Literal["reliable_id", "resume_request", "name_match", "manual", "none"]
    version: Annotated[int, Field(ge=1)]
    sha256: str
    filename: str
    message_id: str | SkipJsonSchema[None] = None
    parse_status: Literal["pending", "parsed", "suspected_scanned", "failed"]
    created_at: DateTimeStr
    duplicate: bool


_DETAIL_FIELDS = ("timeline", "resume_documents", "commands", "manual_actions")


def _detail_schema(schema: dict[str, Any]) -> None:
    """openapi.yaml 中 CaseDetail 是 allOf [CaseSummary, 详情字段]，这里按同样写法输出。"""
    props = schema.get("properties", {})
    detail = {name: props[name] for name in _DETAIL_FIELDS}
    schema.clear()
    schema["allOf"] = [
        {"$ref": "#/components/schemas/CaseSummary"},
        {"type": "object", "required": list(_DETAIL_FIELDS), "properties": detail},
    ]


class CaseDetail(CaseSummary):
    model_config = ConfigDict(json_schema_extra=lambda schema, _cls: _detail_schema(schema))
    timeline: list[TimelineEntry]
    resume_documents: list[ResumeDocument]
    commands: list[CommandRecord]
    manual_actions: list[ManualAction]


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------

router = APIRouter(tags=["cases"])


@router.get(
    "/cases",
    operation_id="listCases",
    summary="招聘流程列表（以 recruitment_case 为行）",
    response_model=CaseList,
    responses=problem_responses(401, 422),
)
def list_cases(
    ctx: Ctx,
    _actor: ConsoleActor,
    account_id: str | None = None,
    stage: Annotated[list[CaseStageLit] | None, Query()] = None,
    job_title: str | None = None,
    needs_human: bool | None = None,
    q: Annotated[str | None, Query(max_length=64, description="姓名或岗位关键字")] = None,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
):
    flt = CaseFilter(
        account_id=account_id,
        stages=tuple(stage or ()),
        job_title=job_title,
        needs_human=needs_human,
        q=q,
    )
    return ok(ctx.cases.list(flt, check_cursor(cursor), limit))


@router.get(
    "/cases/{case_id}",
    operation_id="getCase",
    summary="流程详情（时间线、简历文件、最近操作、人工处理记录）",
    response_model=CaseDetail,
    responses=problem_responses(401, 404, 422),
)
def get_case(ctx: Ctx, _actor: ConsoleOrService, case_id: Annotated[str, Path(min_length=1)]):
    return ok(ctx.cases.detail(case_id))


__all__ = [
    "CASE_STAGES",
    "CONTACT_STATUSES",
    "CaseDetail",
    "CaseFilter",
    "CaseRow",
    "CaseService",
    "CaseStore",
    "CaseSummary",
    "ResumeDocument",
    "STAGE_TEXT",
    "StageNotAllowed",
    "TimelineEntry",
    "TimelineRow",
    "normalize_text",
    "router",
]
