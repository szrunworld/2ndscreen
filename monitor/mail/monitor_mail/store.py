"""任务表（代替 MQ）：SQLite 存邮件任务、投递台账、附件、待发请求与清理记录。

- 一封邮件一行 ``mail_tasks``，主键 mail_message_id（= "mail:" + mail 的 message_id），
  所以重复投递只会多一行投递记录，不会多一个任务。
- 消费者按租约领取：``BEGIN IMMEDIATE`` 下选出一条 pending 并写入租约，租约过期后可被重领。
  所有对服务端的写都经 ``outbox``：请求体在第一次发送前落库，重试复用同一个键与同一个请求体，
  所以崩溃重领不会因为"同键不同体"被服务端拒绝，也不会重复入库。
- 时间统一存为定宽 UTC 字符串（``%Y-%m-%dT%H:%M:%S.%fZ``），可以直接按字符串比较。
"""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, fields
from datetime import UTC, datetime, timedelta
from typing import Any

_TIME_FMT = "%Y-%m-%dT%H:%M:%S.%fZ"

MIGRATIONS: tuple[str, ...] = (
    """
    CREATE TABLE mail_tasks (
        mail_message_id TEXT PRIMARY KEY,
        provider_message_id TEXT NOT NULL,
        webhook_delivery_id TEXT,
        mailbox TEXT NOT NULL,
        received_at TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        attempt_limit INTEGER NOT NULL,
        error TEXT,
        next_attempt_at TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        message_id TEXT,
        from_address TEXT,
        subject TEXT,
        sha256 TEXT,
        raw_storage_uri TEXT,
        copy_stored_at TEXT,
        copy_purged_at TEXT,
        has_attachments INTEGER,
        link_json TEXT,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX mail_tasks_status ON mail_tasks(status, next_attempt_at);
    CREATE TABLE webhook_deliveries (
        delivery_id TEXT PRIMARY KEY,
        mail_message_id TEXT NOT NULL,
        event TEXT NOT NULL,
        occurred_at TEXT,
        received_at TEXT NOT NULL
    );
    CREATE TABLE mail_attachments (
        mail_message_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        content_type TEXT,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        storage_uri TEXT,
        text_storage_uri TEXT,
        parse_status TEXT,
        page_count INTEGER,
        doc_id TEXT,
        purged_at TEXT,
        PRIMARY KEY (mail_message_id, attachment_id)
    );
    CREATE INDEX mail_attachments_sha ON mail_attachments(mail_message_id, sha256);
    CREATE TABLE outbox (
        idem_key TEXT PRIMARY KEY,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        body_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sent_at TEXT,
        response_json TEXT
    );
    CREATE TABLE purge_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mail_message_id TEXT NOT NULL,
        purged_at TEXT NOT NULL,
        retention_days INTEGER NOT NULL,
        blobs_deleted INTEGER NOT NULL
    );
    """,
)


def db_time(value: datetime) -> str:
    if value.tzinfo is None:
        raise ValueError("时间必须带时区")
    return value.astimezone(UTC).strftime(_TIME_FMT)


def from_db_time(value: str | None) -> datetime | None:
    if value is None:
        return None
    return datetime.strptime(value, _TIME_FMT).replace(tzinfo=UTC)


@dataclass(frozen=True)
class TaskRow:
    mail_message_id: str
    provider_message_id: str
    webhook_delivery_id: str | None
    mailbox: str
    received_at: str
    registered_at: str
    status: str
    attempts: int
    attempt_limit: int
    error: str | None
    next_attempt_at: str | None
    lease_owner: str | None
    lease_expires_at: str | None
    message_id: str | None
    from_address: str | None
    subject: str | None
    sha256: str | None
    raw_storage_uri: str | None
    copy_stored_at: str | None
    copy_purged_at: str | None
    has_attachments: int | None
    link_json: str | None
    updated_at: str


@dataclass(frozen=True)
class AttachmentRow:
    mail_message_id: str
    attachment_id: str
    filename: str
    content_type: str | None
    size_bytes: int
    sha256: str
    storage_uri: str | None
    text_storage_uri: str | None
    parse_status: str | None
    page_count: int | None
    doc_id: str | None
    purged_at: str | None


@dataclass(frozen=True)
class OutboxRow:
    idem_key: str
    method: str
    path: str
    body: dict[str, Any]
    sent: bool
    response: dict[str, Any] | None


_TASK_COLUMNS = tuple(f.name for f in fields(TaskRow))
_ATTACHMENT_COLUMNS = tuple(f.name for f in fields(AttachmentRow))
_TASK_MUTABLE = frozenset(_TASK_COLUMNS) - {"mail_message_id", "provider_message_id", "mailbox", "registered_at"}


class MailStore:
    """SQLite 任务表。一个连接 + 进程内锁；会改状态的操作都在 ``BEGIN IMMEDIATE`` 事务里。"""

    def __init__(self, path: str = ":memory:") -> None:
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        self._migrate()

    def close(self) -> None:
        self._conn.close()

    def _migrate(self) -> None:
        with self._tx():
            version = self._conn.execute("PRAGMA user_version").fetchone()[0]
            if version > len(MIGRATIONS):
                raise RuntimeError(f"数据库版本 {version} 高于代码支持的 {len(MIGRATIONS)}，拒绝降级")
            for index in range(version, len(MIGRATIONS)):
                for statement in MIGRATIONS[index].split(";"):
                    if statement.strip():
                        self._conn.execute(statement)
                self._conn.execute(f"PRAGMA user_version = {index + 1}")

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield self._conn
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
            self._conn.execute("COMMIT")

    # ---- 推送登记 -------------------------------------------------------------

    def record_delivery(
        self,
        *,
        delivery_id: str,
        event: str,
        mail_message_id: str,
        provider_message_id: str,
        mailbox: str,
        occurred_at: datetime | None,
        has_attachments: bool | None,
        now: datetime,
        attempt_limit: int,
    ) -> tuple[bool, bool]:
        """登记一次推送。返回 (投递是否重复, 是否新建了任务)。两层幂等：投递 id、mail_message_id。"""
        now_s = db_time(now)
        with self._tx() as conn:
            dup_delivery = conn.execute(
                "SELECT 1 FROM webhook_deliveries WHERE delivery_id = ?", (delivery_id,)
            ).fetchone() is not None
            if not dup_delivery:
                conn.execute(
                    "INSERT INTO webhook_deliveries(delivery_id, mail_message_id, event, occurred_at, received_at)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (delivery_id, mail_message_id, event, db_time(occurred_at) if occurred_at else None, now_s),
                )
            exists = conn.execute(
                "SELECT 1 FROM mail_tasks WHERE mail_message_id = ?", (mail_message_id,)
            ).fetchone() is not None
            if not exists:
                conn.execute(
                    "INSERT INTO mail_tasks(mail_message_id, provider_message_id, webhook_delivery_id, mailbox,"
                    " received_at, registered_at, status, attempts, attempt_limit, has_attachments, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)",
                    (
                        mail_message_id,
                        provider_message_id,
                        delivery_id,
                        mailbox,
                        db_time(occurred_at or now),
                        now_s,
                        attempt_limit,
                        None if has_attachments is None else int(has_attachments),
                        now_s,
                    ),
                )
            return dup_delivery, not exists

    def list_deliveries(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute("SELECT * FROM webhook_deliveries ORDER BY received_at").fetchall()
        return [dict(r) for r in rows]

    # ---- 任务 ---------------------------------------------------------------

    def get_task(self, mail_message_id: str) -> TaskRow | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM mail_tasks WHERE mail_message_id = ?", (mail_message_id,)).fetchone()
        return TaskRow(**dict(row)) if row else None

    def list_tasks(self, statuses: Sequence[str] | None = None) -> list[TaskRow]:
        sql = "SELECT * FROM mail_tasks"
        args: tuple[Any, ...] = ()
        if statuses:
            sql += f" WHERE status IN ({','.join('?' * len(statuses))})"
            args = tuple(statuses)
        with self._lock:
            rows = self._conn.execute(sql + " ORDER BY registered_at, mail_message_id", args).fetchall()
        return [TaskRow(**dict(r)) for r in rows]

    def claim(self, *, owner: str, now: datetime, lease_seconds: int) -> TaskRow | None:
        """按租约领取一条可处理的 pending 任务（原子）。崩溃留下的过期租约可以被重领。"""
        now_s = db_time(now)
        expires = db_time(now + timedelta(seconds=lease_seconds))
        with self._tx() as conn:
            row = conn.execute(
                "SELECT mail_message_id FROM mail_tasks WHERE status = 'pending'"
                " AND (lease_expires_at IS NULL OR lease_expires_at <= ?)"
                " AND (next_attempt_at IS NULL OR next_attempt_at <= ?)"
                " ORDER BY registered_at, mail_message_id LIMIT 1",
                (now_s, now_s),
            ).fetchone()
            if row is None:
                return None
            conn.execute(
                "UPDATE mail_tasks SET lease_owner = ?, lease_expires_at = ? WHERE mail_message_id = ?",
                (owner, expires, row["mail_message_id"]),
            )
            full = conn.execute("SELECT * FROM mail_tasks WHERE mail_message_id = ?", (row["mail_message_id"],)).fetchone()
        return TaskRow(**dict(full))

    def holds_lease(self, mail_message_id: str, owner: str, now: datetime) -> bool:
        task = self.get_task(mail_message_id)
        return bool(
            task
            and task.lease_owner == owner
            and task.lease_expires_at is not None
            and task.lease_expires_at > db_time(now)
        )

    def update_task(self, mail_message_id: str, *, owner: str | None = None, **changes: Any) -> bool:
        """更新任务字段。给了 owner 时只有仍持有租约才更新（返回 False 表示租约已丢）。"""
        bad = set(changes) - _TASK_MUTABLE
        if bad:
            raise ValueError(f"不可修改的字段：{sorted(bad)}")
        if not changes:
            return True
        assignments = ", ".join(f"{k} = ?" for k in changes)
        sql = f"UPDATE mail_tasks SET {assignments} WHERE mail_message_id = ?"
        args: list[Any] = [*changes.values(), mail_message_id]
        if owner is not None:
            sql += " AND lease_owner = ?"
            args.append(owner)
        with self._tx() as conn:
            return conn.execute(sql, args).rowcount == 1

    # ---- 附件 ---------------------------------------------------------------

    def upsert_attachment(self, row: AttachmentRow) -> AttachmentRow:
        """按 (mail_message_id, attachment_id) 写入；已存在时保留已有的 doc_id 与解析结果（重领幂等）。"""
        with self._tx() as conn:
            existing = conn.execute(
                "SELECT * FROM mail_attachments WHERE mail_message_id = ? AND attachment_id = ?",
                (row.mail_message_id, row.attachment_id),
            ).fetchone()
            if existing is None:
                conn.execute(
                    f"INSERT INTO mail_attachments({','.join(_ATTACHMENT_COLUMNS)})"
                    f" VALUES ({','.join('?' * len(_ATTACHMENT_COLUMNS))})",
                    tuple(getattr(row, c) for c in _ATTACHMENT_COLUMNS),
                )
                return row
            if existing["sha256"] != row.sha256:
                # mail 里附件内容不可变；哈希变了说明上游异常，按新内容覆盖并清掉旧结论。
                conn.execute(
                    "UPDATE mail_attachments SET sha256 = ?, size_bytes = ?, storage_uri = ?, doc_id = NULL,"
                    " parse_status = NULL, text_storage_uri = NULL, page_count = NULL"
                    " WHERE mail_message_id = ? AND attachment_id = ?",
                    (row.sha256, row.size_bytes, row.storage_uri, row.mail_message_id, row.attachment_id),
                )
            else:
                conn.execute(
                    "UPDATE mail_attachments SET storage_uri = ? WHERE mail_message_id = ? AND attachment_id = ?",
                    (row.storage_uri, row.mail_message_id, row.attachment_id),
                )
            current = conn.execute(
                "SELECT * FROM mail_attachments WHERE mail_message_id = ? AND attachment_id = ?",
                (row.mail_message_id, row.attachment_id),
            ).fetchone()
        return AttachmentRow(**dict(current))

    def update_attachment(self, mail_message_id: str, attachment_id: str, **changes: Any) -> None:
        bad = set(changes) - set(_ATTACHMENT_COLUMNS[2:])
        if bad:
            raise ValueError(f"不可修改的字段：{sorted(bad)}")
        assignments = ", ".join(f"{k} = ?" for k in changes)
        with self._tx() as conn:
            conn.execute(
                f"UPDATE mail_attachments SET {assignments} WHERE mail_message_id = ? AND attachment_id = ?",
                (*changes.values(), mail_message_id, attachment_id),
            )

    def list_attachments(self, mail_message_id: str | None = None) -> list[AttachmentRow]:
        sql, args = "SELECT * FROM mail_attachments", ()
        if mail_message_id is not None:
            sql, args = sql + " WHERE mail_message_id = ?", (mail_message_id,)
        with self._lock:
            rows = self._conn.execute(sql + " ORDER BY mail_message_id, attachment_id", args).fetchall()
        return [AttachmentRow(**dict(r)) for r in rows]

    # ---- 待发请求（outbox）----------------------------------------------------

    def prepare_request(self, *, idem_key: str, method: str, path: str, body: dict[str, Any], now: datetime) -> OutboxRow:
        """第一次准备时落库请求体；之后同一个键返回已落库的请求体（重试复用，保证同键同体）。"""
        with self._tx() as conn:
            row = conn.execute("SELECT * FROM outbox WHERE idem_key = ?", (idem_key,)).fetchone()
            if row is None:
                conn.execute(
                    "INSERT INTO outbox(idem_key, method, path, body_json, created_at) VALUES (?, ?, ?, ?, ?)",
                    (idem_key, method, path, json.dumps(body, ensure_ascii=False, sort_keys=True), db_time(now)),
                )
                row = conn.execute("SELECT * FROM outbox WHERE idem_key = ?", (idem_key,)).fetchone()
        return _outbox_row(row)

    def mark_sent(self, idem_key: str, response: dict[str, Any], now: datetime) -> None:
        with self._tx() as conn:
            conn.execute(
                "UPDATE outbox SET sent_at = ?, response_json = ? WHERE idem_key = ?",
                (db_time(now), json.dumps(response, ensure_ascii=False), idem_key),
            )

    def get_request(self, idem_key: str) -> OutboxRow | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM outbox WHERE idem_key = ?", (idem_key,)).fetchone()
        return _outbox_row(row) if row else None

    def unsent_requests(self) -> list[OutboxRow]:
        with self._lock:
            rows = self._conn.execute("SELECT * FROM outbox WHERE sent_at IS NULL ORDER BY created_at, idem_key").fetchall()
        return [_outbox_row(r) for r in rows]

    # ---- 清理记录 -------------------------------------------------------------

    def log_purge(self, *, mail_message_id: str, purged_at: datetime, retention_days: int, blobs_deleted: int) -> None:
        with self._tx() as conn:
            conn.execute(
                "INSERT INTO purge_log(mail_message_id, purged_at, retention_days, blobs_deleted) VALUES (?, ?, ?, ?)",
                (mail_message_id, db_time(purged_at), retention_days, blobs_deleted),
            )

    def list_purges(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute("SELECT * FROM purge_log ORDER BY id").fetchall()
        return [dict(r) for r in rows]


def _outbox_row(row: sqlite3.Row) -> OutboxRow:
    return OutboxRow(
        idem_key=row["idem_key"],
        method=row["method"],
        path=row["path"],
        body=json.loads(row["body_json"]),
        sent=row["sent_at"] is not None,
        response=json.loads(row["response_json"]) if row["response_json"] else None,
    )
