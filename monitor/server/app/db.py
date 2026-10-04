"""存储层：时钟、行模型、存储接口（Store Protocol）与 SQLite 实现。

业务层只依赖 ``Store`` Protocol。每个会改状态的方法在实现内部是原子的
（SQLite 用 ``BEGIN IMMEDIATE`` + 进程内锁；换 PostgreSQL 时用事务 +
``SELECT ... FOR UPDATE SKIP LOCKED`` 实现同样的语义）。

时间一律以 UTC ISO 字符串（固定格式）落库，字符串比较即时间比较。
"""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Callable, Iterator, Sequence
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol

# ---------------------------------------------------------------------------
# 时钟
# ---------------------------------------------------------------------------


class Clock(Protocol):
    def now(self) -> datetime:
        """返回带时区的当前时间。"""
        ...


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(UTC)


class FakeClock:
    """可控时钟：测试里用 advance() 推进时间，不用 sleep。"""

    def __init__(self, start: datetime | None = None):
        self._now = start or datetime(2026, 10, 4, 1, 0, 0, tzinfo=UTC)
        self._lock = threading.Lock()

    def now(self) -> datetime:
        with self._lock:
            return self._now

    def advance(self, seconds: float) -> datetime:
        with self._lock:
            self._now = self._now + timedelta(seconds=seconds)
            return self._now


def to_db_time(value: datetime) -> str:
    """带时区时间 → 落库字符串（UTC，微秒，固定宽度，可按字典序比较）。"""
    if value.tzinfo is None:
        raise ValueError("时间必须带时区")
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f+00:00")


def parse_time(value: str) -> datetime:
    """解析线上 RFC 3339 时间（允许 Z 结尾）。"""
    return datetime.fromisoformat(value.replace("Z", "+00:00").replace("z", "+00:00"))


def from_db_time(value: str | None) -> datetime | None:
    return None if value is None else datetime.fromisoformat(value)


def wire_time(value: str | None) -> str | None:
    """落库字符串 → 线上 RFC 3339（UTC，Z 结尾）。"""
    if value is None:
        return None
    return datetime.fromisoformat(value).isoformat().replace("+00:00", "Z")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


# ---------------------------------------------------------------------------
# 行模型（存储层与业务层之间的数据形状，与具体数据库无关）
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EnrollmentRow:
    code_hash: str
    mode: str
    note: str | None
    created_by: str
    created_at: str
    expires_at: str
    used_at: str | None = None
    device_id: str | None = None


@dataclass(frozen=True)
class DeviceRow:
    device_id: str
    device_name: str
    mode: str
    platform: dict[str, Any]
    monitor_version: str
    contracts_version: str
    capabilities: list[str]
    token_hash: str
    registered_at: str
    revoked: bool = False
    revoked_at: str | None = None
    paused: bool = False
    pause_note: str | None = None
    last_heartbeat: dict[str, Any] | None = None
    last_heartbeat_at: str | None = None


@dataclass(frozen=True)
class BindingRow:
    device_id: str
    account_id: str
    bound_at: str
    confirmed_by: str
    note: str | None = None


@dataclass(frozen=True)
class CommandRow:
    command_id: str
    account_id: str
    action: str
    command: dict[str, Any]
    expires_at: str
    created_at: str
    server_status: str = "pending"
    case_id: str | None = None
    device_id: str | None = None  # 指定设备；None 表示该账户下任何已绑定设备都可领取
    depends_on: str | None = None
    claimed_by: str | None = None
    claimed_at: str | None = None
    lease_expires_at: str | None = None
    acked_at: str | None = None
    cancel_requested: bool = False
    result: dict[str, Any] | None = None
    result_recorded_at: str | None = None
    executed_at: str | None = None
    seq: int | None = None


@dataclass(frozen=True)
class EventRow:
    event_id: str
    device_id: str
    account_id: str | None
    kind: str
    event: dict[str, Any]
    observed_at: str
    received_at: str
    case_id: str | None = None
    seq: int | None = None


@dataclass(frozen=True)
class ManualActionRow:
    manual_action_id: str
    type: str
    actor: str
    at: str
    note: str
    target_kind: str
    target_id: str


@dataclass(frozen=True)
class IdempotencyRow:
    principal: str
    method: str
    path: str
    key: str
    request_hash: str
    status_code: int
    body: Any
    created_at: str


@dataclass(frozen=True)
class CommandFilter:
    case_id: str | None = None
    account_id: str | None = None
    action: str | None = None
    statuses: Sequence[str] = ()
    executed_after: str | None = None
    executed_before: str | None = None


@dataclass(frozen=True)
class EventFilter:
    account_id: str | None = None
    case_id: str | None = None
    kind: str | None = None


@dataclass
class Page:
    items: list[Any] = field(default_factory=list)
    next_cursor: str | None = None


# ---------------------------------------------------------------------------
# 存储接口
# ---------------------------------------------------------------------------


class Store(Protocol):
    """服务端存储接口。F2/F3 需要新表时在各自模块扩展，不改本接口已有方法的语义。"""

    # 注册码与设备
    def insert_enrollment(self, row: EnrollmentRow) -> None: ...
    def get_enrollment(self, code_hash: str) -> EnrollmentRow | None: ...
    def register_device(self, code_hash: str, device: DeviceRow, used_at: str) -> bool:
        """原子地消费注册码并插入设备；注册码已被使用时返回 False 且不插入。"""
        ...

    def get_device(self, device_id: str) -> DeviceRow | None: ...
    def get_device_by_token_hash(self, token_hash: str) -> DeviceRow | None: ...
    def list_devices(self) -> list[DeviceRow]: ...
    def update_device(self, device_id: str, **fields: Any) -> DeviceRow | None: ...
    def set_binding(self, row: BindingRow) -> None: ...
    def get_binding(self, device_id: str) -> BindingRow | None: ...

    # 指令
    def insert_command(self, row: CommandRow) -> bool:
        """按 command_id 幂等插入；已存在返回 False。"""
        ...

    def get_command(self, command_id: str) -> CommandRow | None: ...
    def list_commands(self, flt: CommandFilter, cursor: str | None, limit: int) -> Page: ...
    def claim_commands(
        self, device_id: str, account_id: str, now: str, lease_until: str, max_commands: int
    ) -> list[CommandRow]:
        """原子领取：归还过期租约、把从未领取且已过期的指令置 expired，再选出可领取指令并加租约。"""
        ...

    def ack_command(self, command_id: str, device_id: str, now: str) -> bool:
        """仅当指令由该设备领取且尚无结果时记为 acked（已 ack 或已终态时不改，也返回 True）。"""
        ...

    def record_result(
        self, command_id: str, device_id: str, result: dict[str, Any], status: str, executed_at: str | None, now: str
    ) -> bool:
        """仅当尚无结果且指令由该设备领取过时写入结果；返回是否写入。"""
        ...

    def request_cancel(self, command_id: str, now: str) -> bool:
        """尚无结果且处于 pending/claimed/acked 时登记取消；返回是否登记成功。"""
        ...

    def cancellations_for(self, device_id: str) -> list[str]: ...

    # 事件
    def insert_event(self, row: EventRow) -> bool:
        """按 event_id 幂等插入；已存在返回 False。"""
        ...

    def get_event(self, event_id: str) -> EventRow | None: ...
    def list_events(self, flt: EventFilter, cursor: str | None, limit: int) -> Page: ...
    def set_event_case(self, event_id: str, case_id: str) -> bool: ...

    # 人工处理
    def insert_manual_action(self, row: ManualActionRow) -> None: ...
    def list_manual_actions(self, target_kind: str, target_id: str) -> list[ManualActionRow]: ...

    # 幂等
    def get_idempotency(self, principal: str, method: str, path: str, key: str) -> IdempotencyRow | None: ...
    def put_idempotency(self, row: IdempotencyRow) -> None: ...
    def purge_idempotency(self, older_than: str) -> int: ...

    # 调用方事务（F2b）
    def transaction(self) -> AbstractContextManager[None]:
        """块内的写方法加入同一个事务，一起提交或一起回滚（可嵌套）。"""
        ...


# ---------------------------------------------------------------------------
# SQLite 实现
# ---------------------------------------------------------------------------

# 迁移按顺序追加，永不修改已发布的条目；PRAGMA user_version 记录已应用的版本。
MIGRATIONS: list[str] = [
    # v1：F1 基础表
    """
    CREATE TABLE enrollments (
        code_hash   TEXT PRIMARY KEY,
        mode        TEXT NOT NULL CHECK (mode IN ('local', 'remote')),
        note        TEXT,
        created_by  TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        used_at     TEXT,
        device_id   TEXT
    );
    CREATE TABLE devices (
        device_id         TEXT PRIMARY KEY,
        device_name       TEXT NOT NULL,
        mode              TEXT NOT NULL CHECK (mode IN ('local', 'remote')),
        platform_json     TEXT NOT NULL,
        monitor_version   TEXT NOT NULL,
        contracts_version TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        token_hash        TEXT NOT NULL UNIQUE,
        registered_at     TEXT NOT NULL,
        revoked           INTEGER NOT NULL DEFAULT 0,
        revoked_at        TEXT,
        paused            INTEGER NOT NULL DEFAULT 0,
        pause_note        TEXT,
        last_heartbeat_json TEXT,
        last_heartbeat_at TEXT
    );
    CREATE TABLE account_bindings (
        device_id    TEXT PRIMARY KEY REFERENCES devices(device_id),
        account_id   TEXT NOT NULL,
        bound_at     TEXT NOT NULL,
        confirmed_by TEXT NOT NULL,
        note         TEXT
    );
    CREATE TABLE commands (
        seq                INTEGER PRIMARY KEY AUTOINCREMENT,
        command_id         TEXT NOT NULL UNIQUE,
        case_id            TEXT,
        account_id         TEXT NOT NULL,
        action             TEXT NOT NULL,
        device_id          TEXT,
        command_json       TEXT NOT NULL,
        expires_at         TEXT NOT NULL,
        depends_on         TEXT,
        server_status      TEXT NOT NULL,
        claimed_by         TEXT,
        claimed_at         TEXT,
        lease_expires_at   TEXT,
        acked_at           TEXT,
        cancel_requested   INTEGER NOT NULL DEFAULT 0,
        result_json        TEXT,
        result_recorded_at TEXT,
        executed_at        TEXT,
        created_at         TEXT NOT NULL
    );
    CREATE INDEX commands_claim ON commands (account_id, server_status, seq);
    CREATE INDEX commands_case ON commands (case_id);
    CREATE TABLE events (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id    TEXT NOT NULL UNIQUE,
        device_id   TEXT NOT NULL,
        account_id  TEXT,
        kind        TEXT NOT NULL,
        case_id     TEXT,
        event_json  TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        received_at TEXT NOT NULL
    );
    CREATE INDEX events_account ON events (account_id, seq);
    CREATE INDEX events_case ON events (case_id);
    CREATE TABLE manual_actions (
        seq              INTEGER PRIMARY KEY AUTOINCREMENT,
        manual_action_id TEXT NOT NULL UNIQUE,
        type             TEXT NOT NULL,
        actor            TEXT NOT NULL,
        at               TEXT NOT NULL,
        note             TEXT NOT NULL,
        target_kind      TEXT NOT NULL,
        target_id        TEXT NOT NULL
    );
    CREATE INDEX manual_actions_target ON manual_actions (target_kind, target_id);
    CREATE TABLE idempotency_keys (
        principal    TEXT NOT NULL,
        method       TEXT NOT NULL,
        path         TEXT NOT NULL,
        key          TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status_code  INTEGER NOT NULL,
        body_json    TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (principal, method, path, key)
    );
    """,
    # v2：F2 招聘流程、时间线、策略、自动流程指令登记、简历关联摘要
    """
    CREATE TABLE recruitment_cases (
        seq                    INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id                TEXT NOT NULL UNIQUE,
        account_id             TEXT NOT NULL,
        candidate_name         TEXT NOT NULL,
        job_title              TEXT NOT NULL,
        conversation_hints_json TEXT NOT NULL,
        stage                  TEXT NOT NULL,
        needs_human_reason     TEXT,
        contact_status         TEXT NOT NULL DEFAULT 'not_requested',
        next_action            TEXT,
        next_depends_on        TEXT,
        blocked_reason         TEXT,
        resume_requested_at    TEXT,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL,
        UNIQUE (account_id, candidate_name, job_title)
    );
    CREATE INDEX recruitment_cases_account ON recruitment_cases (account_id, seq);
    CREATE INDEX recruitment_cases_next ON recruitment_cases (next_action);
    CREATE TABLE case_timeline (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id    TEXT NOT NULL,
        at         TEXT NOT NULL,
        type       TEXT NOT NULL,
        ref_id     TEXT NOT NULL,
        stage_from TEXT,
        stage_to   TEXT,
        summary    TEXT NOT NULL
    );
    CREATE INDEX case_timeline_case ON case_timeline (case_id, seq);
    CREATE INDEX case_timeline_at ON case_timeline (type, at);
    CREATE TABLE case_commands (
        command_id TEXT PRIMARY KEY,
        case_id    TEXT NOT NULL,
        origin     TEXT NOT NULL CHECK (origin IN ('auto', 'manual', 'recheck')),
        created_at TEXT NOT NULL
    );
    CREATE INDEX case_commands_case ON case_commands (case_id);
    CREATE TABLE case_resume_links (
        doc_id    TEXT PRIMARY KEY,
        case_id   TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        parsed_at TEXT
    );
    CREATE INDEX case_resume_links_case ON case_resume_links (case_id);
    CREATE TABLE policies (
        account_id     TEXT PRIMARY KEY,
        policy_version INTEGER NOT NULL,
        policy_json    TEXT NOT NULL,
        updated_at     TEXT NOT NULL
    );
    """,
]

SCHEMA_VERSION = len(MIGRATIONS)

_DEVICE_COLUMNS = {
    "device_name": "device_name",
    "mode": "mode",
    "monitor_version": "monitor_version",
    "contracts_version": "contracts_version",
    "token_hash": "token_hash",
    "revoked": "revoked",
    "revoked_at": "revoked_at",
    "paused": "paused",
    "pause_note": "pause_note",
    "last_heartbeat": "last_heartbeat_json",
    "last_heartbeat_at": "last_heartbeat_at",
    "capabilities": "capabilities_json",
    "platform": "platform_json",
}
_JSON_DEVICE_FIELDS = {"last_heartbeat", "capabilities", "platform"}


def migrate(conn: sqlite3.Connection, migrations: Sequence[str] = MIGRATIONS) -> int:
    """把数据库升级到最新版本，返回升级后的版本号。已是最新时不做任何事。"""
    current = conn.execute("PRAGMA user_version").fetchone()[0]
    if current > len(migrations):
        raise RuntimeError(f"数据库版本 {current} 高于代码支持的 {len(migrations)}，拒绝降级")
    for version in range(current + 1, len(migrations) + 1):
        # executescript 会先提交挂起的事务；每个版本在一个事务里执行并写 user_version，失败整体回滚
        try:
            conn.executescript(f"BEGIN;\n{migrations[version - 1]}\nPRAGMA user_version = {version};\nCOMMIT;")
        except sqlite3.Error:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
    return conn.execute("PRAGMA user_version").fetchone()[0]


class SqliteStore:
    """Store 的 SQLite 实现。一个连接 + 进程内可重入锁；写操作用 BEGIN IMMEDIATE。"""

    def __init__(self, path: str | Path = ":memory:"):
        self._conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        self._depth = 0  # 当前线程（持有 _lock 者）的事务嵌套层数
        with self._lock:
            if str(path) != ":memory:":
                self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA foreign_keys=ON")
            self._conn.execute("PRAGMA busy_timeout=5000")
            migrate(self._conn)

    @property
    def schema_version(self) -> int:
        with self._lock:
            return self._conn.execute("PRAGMA user_version").fetchone()[0]

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        """写事务。已在 transaction() / _tx() 内时以 SAVEPOINT 嵌套：内层失败只回滚内层，
        外层失败整体回滚；只有最外层提交时才真正落盘。"""
        with self._lock:
            if self._depth == 0:
                self._conn.execute("BEGIN IMMEDIATE")
                begin, rollback, commit = None, "ROLLBACK", "COMMIT"
            else:
                name = f"sp_{self._depth}"
                begin, rollback, commit = f"SAVEPOINT {name}", f"ROLLBACK TO {name}; RELEASE {name}", f"RELEASE {name}"
            if begin is not None:
                self._conn.execute(begin)
            self._depth += 1
            try:
                yield self._conn
            except BaseException:
                self._depth -= 1
                for stmt in rollback.split("; "):
                    self._conn.execute(stmt)
                raise
            self._depth -= 1
            self._conn.execute(commit)

    @contextmanager
    def transaction(self) -> Iterator[None]:
        """调用方事务：块内调用的所有写方法（insert_command、insert_manual_action 等，以及
        F2 的流程表写入）加入同一个事务，块正常结束时一起提交，抛异常时一起回滚。
        块内持有存储锁，其他线程的读写会等待，块要尽量短。"""
        with self._tx():
            yield

    def _one(self, sql: str, args: Sequence[Any] = ()) -> sqlite3.Row | None:
        with self._lock:
            return self._conn.execute(sql, args).fetchone()

    def _all(self, sql: str, args: Sequence[Any] = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, args).fetchall()

    # -- 注册码与设备 ---------------------------------------------------------

    def insert_enrollment(self, row: EnrollmentRow) -> None:
        with self._tx() as c:
            c.execute(
                "INSERT INTO enrollments (code_hash, mode, note, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?)",
                (row.code_hash, row.mode, row.note, row.created_by, row.created_at, row.expires_at),
            )

    def get_enrollment(self, code_hash: str) -> EnrollmentRow | None:
        r = self._one("SELECT * FROM enrollments WHERE code_hash = ?", (code_hash,))
        return None if r is None else EnrollmentRow(**dict(r))

    def register_device(self, code_hash: str, device: DeviceRow, used_at: str) -> bool:
        with self._tx() as c:
            cur = c.execute(
                "UPDATE enrollments SET used_at = ?, device_id = ? WHERE code_hash = ? AND used_at IS NULL",
                (used_at, device.device_id, code_hash),
            )
            if cur.rowcount != 1:
                return False
            c.execute(
                """INSERT INTO devices (device_id, device_name, mode, platform_json, monitor_version,
                       contracts_version, capabilities_json, token_hash, registered_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (
                    device.device_id,
                    device.device_name,
                    device.mode,
                    canonical_json(device.platform),
                    device.monitor_version,
                    device.contracts_version,
                    canonical_json(device.capabilities),
                    device.token_hash,
                    device.registered_at,
                ),
            )
            return True

    @staticmethod
    def _device(r: sqlite3.Row | None) -> DeviceRow | None:
        if r is None:
            return None
        return DeviceRow(
            device_id=r["device_id"],
            device_name=r["device_name"],
            mode=r["mode"],
            platform=json.loads(r["platform_json"]),
            monitor_version=r["monitor_version"],
            contracts_version=r["contracts_version"],
            capabilities=json.loads(r["capabilities_json"]),
            token_hash=r["token_hash"],
            registered_at=r["registered_at"],
            revoked=bool(r["revoked"]),
            revoked_at=r["revoked_at"],
            paused=bool(r["paused"]),
            pause_note=r["pause_note"],
            last_heartbeat=None if r["last_heartbeat_json"] is None else json.loads(r["last_heartbeat_json"]),
            last_heartbeat_at=r["last_heartbeat_at"],
        )

    def get_device(self, device_id: str) -> DeviceRow | None:
        return self._device(self._one("SELECT * FROM devices WHERE device_id = ?", (device_id,)))

    def get_device_by_token_hash(self, token_hash: str) -> DeviceRow | None:
        return self._device(self._one("SELECT * FROM devices WHERE token_hash = ?", (token_hash,)))

    def list_devices(self) -> list[DeviceRow]:
        return [self._device(r) for r in self._all("SELECT * FROM devices ORDER BY registered_at, device_id")]  # type: ignore[misc]

    def update_device(self, device_id: str, **fields: Any) -> DeviceRow | None:
        sets, args = [], []
        for name, value in fields.items():
            column = _DEVICE_COLUMNS[name]  # 未知字段直接 KeyError，防止拼错列名
            if name in _JSON_DEVICE_FIELDS and value is not None:
                value = canonical_json(value)
            elif isinstance(value, bool):
                value = int(value)
            sets.append(f"{column} = ?")
            args.append(value)
        if sets:
            with self._tx() as c:
                c.execute(f"UPDATE devices SET {', '.join(sets)} WHERE device_id = ?", (*args, device_id))
        return self.get_device(device_id)

    def set_binding(self, row: BindingRow) -> None:
        with self._tx() as c:
            c.execute(
                """INSERT INTO account_bindings (device_id, account_id, bound_at, confirmed_by, note)
                   VALUES (?,?,?,?,?)
                   ON CONFLICT(device_id) DO UPDATE SET account_id = excluded.account_id,
                       bound_at = excluded.bound_at, confirmed_by = excluded.confirmed_by, note = excluded.note""",
                (row.device_id, row.account_id, row.bound_at, row.confirmed_by, row.note),
            )

    def get_binding(self, device_id: str) -> BindingRow | None:
        r = self._one("SELECT * FROM account_bindings WHERE device_id = ?", (device_id,))
        return None if r is None else BindingRow(**dict(r))

    # -- 指令 ---------------------------------------------------------------

    @staticmethod
    def _command(r: sqlite3.Row | None) -> CommandRow | None:
        if r is None:
            return None
        return CommandRow(
            seq=r["seq"],
            command_id=r["command_id"],
            case_id=r["case_id"],
            account_id=r["account_id"],
            action=r["action"],
            device_id=r["device_id"],
            command=json.loads(r["command_json"]),
            expires_at=r["expires_at"],
            depends_on=r["depends_on"],
            server_status=r["server_status"],
            claimed_by=r["claimed_by"],
            claimed_at=r["claimed_at"],
            lease_expires_at=r["lease_expires_at"],
            acked_at=r["acked_at"],
            cancel_requested=bool(r["cancel_requested"]),
            result=None if r["result_json"] is None else json.loads(r["result_json"]),
            result_recorded_at=r["result_recorded_at"],
            executed_at=r["executed_at"],
            created_at=r["created_at"],
        )

    def insert_command(self, row: CommandRow) -> bool:
        with self._tx() as c:
            cur = c.execute(
                """INSERT OR IGNORE INTO commands (command_id, case_id, account_id, action, device_id, command_json,
                       expires_at, depends_on, server_status, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (
                    row.command_id,
                    row.case_id,
                    row.account_id,
                    row.action,
                    row.device_id,
                    canonical_json(row.command),
                    row.expires_at,
                    row.depends_on,
                    row.server_status,
                    row.created_at,
                ),
            )
            return cur.rowcount == 1

    def get_command(self, command_id: str) -> CommandRow | None:
        return self._command(self._one("SELECT * FROM commands WHERE command_id = ?", (command_id,)))

    def list_commands(self, flt: CommandFilter, cursor: str | None, limit: int) -> Page:
        where, args = [], []
        for column, value in (("case_id", flt.case_id), ("account_id", flt.account_id), ("action", flt.action)):
            if value is not None:
                where.append(f"{column} = ?")
                args.append(value)
        if flt.statuses:
            where.append(f"server_status IN ({','.join('?' * len(flt.statuses))})")
            args.extend(flt.statuses)
        if flt.executed_after is not None:
            where.append("executed_at IS NOT NULL AND executed_at >= ?")
            args.append(flt.executed_after)
        if flt.executed_before is not None:
            where.append("executed_at IS NOT NULL AND executed_at < ?")
            args.append(flt.executed_before)
        return self._page("commands", where, args, cursor, limit, self._command)

    def _page(
        self,
        table: str,
        where: list[str],
        args: list[Any],
        cursor: str | None,
        limit: int,
        conv: Callable[[sqlite3.Row], Any],
    ) -> Page:
        # 新的在前；游标是上一页最后一条的 seq（不透明字符串）
        if cursor is not None:
            where = [*where, "seq < ?"]
            args = [*args, int(cursor)]
        sql = f"SELECT * FROM {table}"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY seq DESC LIMIT ?"
        rows = self._all(sql, (*args, limit + 1))
        items = [conv(r) for r in rows[:limit]]
        next_cursor = str(rows[limit - 1]["seq"]) if len(rows) > limit else None
        return Page(items=items, next_cursor=next_cursor)

    def claim_commands(
        self, device_id: str, account_id: str, now: str, lease_until: str, max_commands: int
    ) -> list[CommandRow]:
        with self._tx() as c:
            # 租约过期且未 ack：回到 pending（保留 claimed_by 作为最近一次领取者）
            c.execute(
                "UPDATE commands SET server_status = 'pending' WHERE server_status = 'claimed' AND lease_expires_at <= ?",
                (now,),
            )
            # 从未被领取且已过期：服务端直接置 expired（被领取过的以设备回报为准）
            c.execute(
                """UPDATE commands SET server_status = 'expired'
                   WHERE server_status = 'pending' AND claimed_by IS NULL AND result_json IS NULL AND expires_at <= ?""",
                (now,),
            )
            rows = c.execute(
                """SELECT c.command_id FROM commands c
                   LEFT JOIN commands d ON d.command_id = c.depends_on
                   WHERE c.account_id = ? AND (c.device_id IS NULL OR c.device_id = ?)
                     AND c.server_status = 'pending' AND c.cancel_requested = 0 AND c.result_json IS NULL
                     AND c.expires_at > ?
                     AND (c.depends_on IS NULL OR d.server_status = 'succeeded')
                     -- issued_at 还没到的指令（例如工作时段外人工换微信，顺延到下一个工作时段）暂不下发
                     AND julianday(json_extract(c.command_json, '$.issued_at')) <= julianday(?)
                   ORDER BY c.seq LIMIT ?""",
                (account_id, device_id, now, now, max_commands),
            ).fetchall()
            ids = [r["command_id"] for r in rows]
            for command_id in ids:
                c.execute(
                    """UPDATE commands SET server_status = 'claimed', claimed_by = ?, claimed_at = ?, lease_expires_at = ?
                       WHERE command_id = ?""",
                    (device_id, now, lease_until, command_id),
                )
            return [
                self._command(c.execute("SELECT * FROM commands WHERE command_id = ?", (i,)).fetchone())  # type: ignore[misc]
                for i in ids
            ]

    def ack_command(self, command_id: str, device_id: str, now: str) -> bool:
        with self._tx() as c:
            r = c.execute(
                "SELECT claimed_by, server_status, result_json FROM commands WHERE command_id = ?", (command_id,)
            ).fetchone()
            if r is None or r["claimed_by"] != device_id:
                return False
            if r["result_json"] is None and r["server_status"] in ("claimed", "pending"):
                c.execute(
                    "UPDATE commands SET server_status = 'acked', acked_at = COALESCE(acked_at, ?) WHERE command_id = ?",
                    (now, command_id),
                )
            else:
                c.execute(
                    "UPDATE commands SET acked_at = COALESCE(acked_at, ?) WHERE command_id = ?", (now, command_id)
                )
            return True

    def record_result(
        self, command_id: str, device_id: str, result: dict[str, Any], status: str, executed_at: str | None, now: str
    ) -> bool:
        with self._tx() as c:
            cur = c.execute(
                """UPDATE commands SET result_json = ?, server_status = ?, executed_at = ?, result_recorded_at = ?
                   WHERE command_id = ? AND claimed_by = ? AND result_json IS NULL""",
                (canonical_json(result), status, executed_at, now, command_id, device_id),
            )
            return cur.rowcount == 1

    def request_cancel(self, command_id: str, now: str) -> bool:
        with self._tx() as c:
            cur = c.execute(
                """UPDATE commands SET cancel_requested = 1,
                       server_status = CASE WHEN server_status = 'pending' THEN 'cancelled' ELSE server_status END
                   WHERE command_id = ? AND result_json IS NULL AND server_status IN ('pending', 'claimed', 'acked')""",
                (command_id,),
            )
            return cur.rowcount == 1

    def cancellations_for(self, device_id: str) -> list[str]:
        rows = self._all(
            """SELECT command_id FROM commands
               WHERE claimed_by = ? AND cancel_requested = 1 AND result_json IS NULL ORDER BY seq""",
            (device_id,),
        )
        return [r["command_id"] for r in rows]

    # -- 事件 ---------------------------------------------------------------

    @staticmethod
    def _event(r: sqlite3.Row | None) -> EventRow | None:
        if r is None:
            return None
        return EventRow(
            seq=r["seq"],
            event_id=r["event_id"],
            device_id=r["device_id"],
            account_id=r["account_id"],
            kind=r["kind"],
            case_id=r["case_id"],
            event=json.loads(r["event_json"]),
            observed_at=r["observed_at"],
            received_at=r["received_at"],
        )

    def insert_event(self, row: EventRow) -> bool:
        with self._tx() as c:
            cur = c.execute(
                """INSERT OR IGNORE INTO events (event_id, device_id, account_id, kind, case_id, event_json,
                       observed_at, received_at) VALUES (?,?,?,?,?,?,?,?)""",
                (
                    row.event_id,
                    row.device_id,
                    row.account_id,
                    row.kind,
                    row.case_id,
                    canonical_json(row.event),
                    row.observed_at,
                    row.received_at,
                ),
            )
            return cur.rowcount == 1

    def get_event(self, event_id: str) -> EventRow | None:
        return self._event(self._one("SELECT * FROM events WHERE event_id = ?", (event_id,)))

    def list_events(self, flt: EventFilter, cursor: str | None, limit: int) -> Page:
        where, args = [], []
        for column, value in (("account_id", flt.account_id), ("case_id", flt.case_id), ("kind", flt.kind)):
            if value is not None:
                where.append(f"{column} = ?")
                args.append(value)
        return self._page("events", where, args, cursor, limit, self._event)

    def set_event_case(self, event_id: str, case_id: str) -> bool:
        with self._tx() as c:
            return c.execute("UPDATE events SET case_id = ? WHERE event_id = ?", (case_id, event_id)).rowcount == 1

    # -- 人工处理 ------------------------------------------------------------

    def insert_manual_action(self, row: ManualActionRow) -> None:
        with self._tx() as c:
            c.execute(
                """INSERT INTO manual_actions (manual_action_id, type, actor, at, note, target_kind, target_id)
                   VALUES (?,?,?,?,?,?,?)""",
                (row.manual_action_id, row.type, row.actor, row.at, row.note, row.target_kind, row.target_id),
            )

    def list_manual_actions(self, target_kind: str, target_id: str) -> list[ManualActionRow]:
        rows = self._all(
            """SELECT manual_action_id, type, actor, at, note, target_kind, target_id FROM manual_actions
               WHERE target_kind = ? AND target_id = ? ORDER BY seq""",
            (target_kind, target_id),
        )
        return [ManualActionRow(**dict(r)) for r in rows]

    # -- 幂等 ---------------------------------------------------------------

    def get_idempotency(self, principal: str, method: str, path: str, key: str) -> IdempotencyRow | None:
        r = self._one(
            "SELECT * FROM idempotency_keys WHERE principal = ? AND method = ? AND path = ? AND key = ?",
            (principal, method, path, key),
        )
        if r is None:
            return None
        return IdempotencyRow(
            principal=r["principal"],
            method=r["method"],
            path=r["path"],
            key=r["key"],
            request_hash=r["request_hash"],
            status_code=r["status_code"],
            body=json.loads(r["body_json"]),
            created_at=r["created_at"],
        )

    def put_idempotency(self, row: IdempotencyRow) -> None:
        # 同键已有记录时覆盖（调用方只在记录不存在或已超过保存期时写入）
        with self._tx() as c:
            c.execute(
                """INSERT OR REPLACE INTO idempotency_keys
                       (principal, method, path, key, request_hash, status_code, body_json, created_at)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (
                    row.principal,
                    row.method,
                    row.path,
                    row.key,
                    row.request_hash,
                    row.status_code,
                    canonical_json(row.body),
                    row.created_at,
                ),
            )

    def purge_idempotency(self, older_than: str) -> int:
        with self._tx() as c:
            return c.execute("DELETE FROM idempotency_keys WHERE created_at < ?", (older_than,)).rowcount
