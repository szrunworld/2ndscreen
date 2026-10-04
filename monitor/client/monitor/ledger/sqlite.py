"""Ledger Protocol 的 SQLite 实现（只用标准库 sqlite3）。

- 每个公开方法在一个 BEGIN IMMEDIATE 事务里完成；任何异常（包括 KeyboardInterrupt 等
  BaseException）都会回滚，库里只会出现完整的方法效果。
- WAL + synchronous=FULL：core 先把指令落成 running 再调处理器，这一步必须在断电后
  依然存在，否则重启会把已点过的指令当成 queued 重做。
- 迁移规则统一调用 monitor_contracts.require_transition；记录形状由契约的 LedgerCommand /
  OutboxEntry / MonitorState 校验，不另写一份规则。
- 读出的对象都是新构造的，调用方修改它们不会影响账本。
"""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID

from monitor_contracts import (
    AccountBinding,
    Baseline,
    Command,
    CommandModel,
    CommandResult,
    CommandState,
    DeliveryState,
    Event,
    EventModel,
    LedgerCommand,
    MonitorState,
    OutboxEntry,
    require_transition,
)
from pydantic import TypeAdapter

from .schema import migrate

_COMMAND = TypeAdapter(Command)
_EVENT = TypeAdapter(Event)
_NON_TERMINAL = (CommandState.QUEUED, CommandState.RUNNING)


def _dumps(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def _require_aware(name: str, value: datetime) -> None:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{name} 必须是带时区的 datetime")


_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


def _epoch_us(value: datetime) -> int:
    """排序用的整数时间（微秒），避免按不同时区的 ISO 字符串排序出错。"""
    return (value - _EPOCH) // timedelta(microseconds=1)


def _check_limit(limit: int) -> None:
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
        raise ValueError(f"limit 必须是正整数，实际为 {limit!r}")


class SqliteLedger:
    """本地 SQLite 账本。线程安全（内部串行化），但设计上只给单个 Monitor 进程使用。"""

    def __init__(self, path: Path | str) -> None:
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        # isolation_level=None：由本类显式 BEGIN / COMMIT，不让 sqlite3 模块隐式开事务
        self._conn = sqlite3.connect(self._path, isolation_level=None, check_same_thread=False, timeout=5.0)
        self._lock = threading.RLock()
        try:
            mode = self._conn.execute("PRAGMA journal_mode=WAL").fetchone()[0]
            if str(mode).lower() != "wal":
                raise sqlite3.OperationalError(f"无法启用 WAL（journal_mode={mode}）")
            self._conn.execute("PRAGMA synchronous=FULL")
            self._conn.execute("PRAGMA foreign_keys=ON")
            migrate(self._conn)
        except BaseException:
            self._conn.close()
            raise

    @property
    def path(self) -> Path:
        return self._path

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def __enter__(self) -> SqliteLedger:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    @contextmanager
    def _tx(self, *, write: bool = True) -> Iterator[sqlite3.Connection]:
        """一个事务（写事务立即取写锁）。异常时回滚并原样抛出。"""
        with self._lock:
            conn = self._conn
            conn.execute("BEGIN IMMEDIATE" if write else "BEGIN DEFERRED")
            try:
                yield conn
                conn.execute("COMMIT")
            except BaseException:
                if conn.in_transaction:
                    conn.rollback()
                raise

    # 指令 ---------------------------------------------------------------

    def put_command(self, command: CommandModel, *, received_at: datetime) -> tuple[LedgerCommand, bool]:
        _require_aware("received_at", received_at)
        with self._tx() as conn:
            row = self._select_command(conn, command.command_id)
            if row is not None:
                return self._to_ledger_command(row), False
            rec = LedgerCommand(
                command=command, state=CommandState.QUEUED, received_at=received_at, updated_at=received_at
            )
            conn.execute(
                "INSERT INTO command_ledger (command_id, action, command_json, state, received_at, "
                "received_at_us, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    str(command.command_id),
                    command.action,
                    _dumps(command.to_wire()),
                    rec.state.value,
                    received_at.isoformat(),
                    _epoch_us(received_at),
                    received_at.isoformat(),
                ),
            )
            return rec.model_copy(deep=True), True

    def get_command(self, command_id: UUID) -> LedgerCommand | None:
        with self._tx(write=False) as conn:
            row = self._select_command(conn, command_id)
            return None if row is None else self._to_ledger_command(row)

    def list_commands(self, *, states: Iterable[CommandState] | None = None) -> list[LedgerCommand]:
        sql = f"SELECT {self._COLUMNS} FROM command_ledger"
        params: list[str] = []
        if states is not None:
            wanted = sorted({CommandState(s).value for s in states})
            if not wanted:
                return []
            sql += f" WHERE state IN ({','.join('?' * len(wanted))})"
            params = wanted
        sql += " ORDER BY received_at_us, rowid"
        with self._tx(write=False) as conn:
            return [self._to_ledger_command(r) for r in conn.execute(sql, params).fetchall()]

    def transition_command(
        self,
        command_id: UUID,
        to: CommandState,
        *,
        at: datetime,
        result: CommandResult | None = None,
    ) -> LedgerCommand:
        to = CommandState(to)
        _require_aware("at", at)
        with self._tx() as conn:
            row = self._select_command(conn, command_id)
            if row is None:
                raise KeyError(f"账本中没有指令 {command_id}")
            rec = self._to_ledger_command(row)
            require_transition("command", rec.state, to)
            terminal = to not in _NON_TERMINAL
            if terminal and result is None:
                raise ValueError("迁移到终态必须给出 result")
            if not terminal and result is not None:
                raise ValueError("非终态不能带 result")
            if result is not None and (result.command_id != rec.command.command_id or result.action != rec.command.action):
                raise ValueError("result 的 command_id / action 与账本中的指令不一致")
            # 契约模型负责"result.status 与 state 一致"等形状规则
            new = LedgerCommand(
                command=rec.command,
                state=to,
                result=result,
                delivery=DeliveryState.PENDING if terminal else None,
                received_at=rec.received_at,
                updated_at=at,
            )
            finished_seq = None
            if terminal:
                finished_seq = conn.execute(
                    "SELECT COALESCE(MAX(finished_seq), 0) + 1 FROM command_ledger"
                ).fetchone()[0]
            conn.execute(
                "UPDATE command_ledger SET state = ?, result_json = ?, delivery = ?, updated_at = ?, "
                "finished_seq = ? WHERE command_id = ?",
                (
                    new.state.value,
                    None if result is None else _dumps(result.to_wire()),
                    None if new.delivery is None else new.delivery.value,
                    at.isoformat(),
                    finished_seq,
                    str(command_id),
                ),
            )
            return new.model_copy(deep=True)

    # 结果回传 -----------------------------------------------------------

    def pending_results(self, *, limit: int = 100) -> list[CommandResult]:
        _check_limit(limit)
        with self._tx(write=False) as conn:
            rows = conn.execute(
                "SELECT result_json FROM command_ledger WHERE delivery = 'pending' "
                "ORDER BY finished_seq LIMIT ?",
                (limit,),
            ).fetchall()
            return [CommandResult.model_validate(json.loads(r[0])) for r in rows]

    def mark_result_delivered(self, command_id: UUID) -> None:
        with self._tx() as conn:
            row = conn.execute(
                "SELECT delivery FROM command_ledger WHERE command_id = ?", (str(command_id),)
            ).fetchone()
            if row is None or row[0] is None:
                raise KeyError(f"指令 {command_id} 没有待回传结果")
            current = DeliveryState(row[0])
            if current == DeliveryState.DELIVERED:
                return
            require_transition("delivery", current, DeliveryState.DELIVERED)
            conn.execute(
                "UPDATE command_ledger SET delivery = ? WHERE command_id = ?",
                (DeliveryState.DELIVERED.value, str(command_id)),
            )

    # 事件 outbox --------------------------------------------------------

    def append_event(self, event: EventModel, *, at: datetime) -> bool:
        _require_aware("at", at)
        with self._tx() as conn:
            cur = conn.execute(
                "INSERT INTO event_outbox (event_id, kind, event_json, delivery, enqueued_at) "
                "VALUES (?, ?, ?, ?, ?) ON CONFLICT (event_id) DO NOTHING",
                (event.event_id, event.kind, _dumps(event.to_wire()), DeliveryState.PENDING.value, at.isoformat()),
            )
            return cur.rowcount == 1

    def pending_events(self, *, after_seq: int = 0, limit: int = 100) -> list[OutboxEntry]:
        _check_limit(limit)
        with self._tx(write=False) as conn:
            rows = conn.execute(
                "SELECT seq, event_json, delivery, enqueued_at FROM event_outbox "
                "WHERE seq > ? AND delivery = 'pending' ORDER BY seq LIMIT ?",
                (after_seq, limit),
            ).fetchall()
            return [
                OutboxEntry(
                    seq=seq,
                    event=_EVENT.validate_python(json.loads(event_json)),
                    delivery=DeliveryState(delivery),
                    enqueued_at=datetime.fromisoformat(enqueued_at),
                )
                for seq, event_json, delivery, enqueued_at in rows
            ]

    def mark_events_delivered(self, event_ids: Iterable[str]) -> None:
        # 先物化：event_ids 可能是一次性迭代器，也不能在事务里执行调用方代码
        ids = [(str(i),) for i in dict.fromkeys(event_ids)]
        if not ids:
            return
        with self._tx() as conn:
            # 只有 pending → delivered 一种迁移；已 delivered 或不存在的 id 不受影响
            require_transition("delivery", DeliveryState.PENDING, DeliveryState.DELIVERED)
            conn.executemany(
                "UPDATE event_outbox SET delivery = 'delivered' WHERE event_id = ? AND delivery = 'pending'",
                ids,
            )

    def outbox_cursor(self) -> int:
        with self._tx(write=False) as conn:
            row = conn.execute(
                "SELECT COALESCE(MAX(seq), 0) FROM event_outbox WHERE seq < "
                "COALESCE((SELECT MIN(seq) FROM event_outbox WHERE delivery = 'pending'), 9223372036854775807)"
            ).fetchone()
            return int(row[0])

    # 本机状态 -----------------------------------------------------------

    def load_state(self) -> MonitorState:
        with self._tx(write=False) as conn:
            row = conn.execute(
                "SELECT mode, account_binding_json, paused, pause_reason, needs_baseline, baseline_json, "
                "last_online_at FROM monitor_state WHERE id = 1"
            ).fetchone()
        if row is None:
            return MonitorState()
        mode, binding, paused, pause_reason, needs_baseline, baseline, last_online_at = row
        return MonitorState(
            mode=mode,
            account_binding=None if binding is None else AccountBinding.model_validate(json.loads(binding)),
            paused=bool(paused),
            pause_reason=pause_reason,
            needs_baseline=bool(needs_baseline),
            baseline=Baseline.model_validate(json.loads(baseline)),
            last_online_at=None if last_online_at is None else datetime.fromisoformat(last_online_at),
        )

    def save_state(self, state: MonitorState) -> None:
        # 重新校验：调用方可能在 load_state 之后就地改坏了字段（pydantic 默认不校验赋值）
        state = MonitorState.model_validate(state.model_dump())
        wire = state.model_dump(mode="json")
        with self._tx() as conn:
            conn.execute(
                "INSERT INTO monitor_state (id, mode, account_binding_json, paused, pause_reason, "
                "needs_baseline, baseline_json, last_online_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT (id) DO UPDATE SET mode = excluded.mode, "
                "account_binding_json = excluded.account_binding_json, paused = excluded.paused, "
                "pause_reason = excluded.pause_reason, needs_baseline = excluded.needs_baseline, "
                "baseline_json = excluded.baseline_json, last_online_at = excluded.last_online_at",
                (
                    wire["mode"],
                    None if wire["account_binding"] is None else _dumps(wire["account_binding"]),
                    int(state.paused),
                    wire["pause_reason"],
                    int(state.needs_baseline),
                    _dumps(wire["baseline"]),
                    None if state.last_online_at is None else state.last_online_at.isoformat(),
                ),
            )

    # 内部 ---------------------------------------------------------------

    _COLUMNS = "command_json, state, result_json, delivery, received_at, updated_at"

    def _select_command(self, conn: sqlite3.Connection, command_id: UUID) -> tuple[Any, ...] | None:
        return conn.execute(
            f"SELECT {self._COLUMNS} FROM command_ledger WHERE command_id = ?", (str(command_id),)
        ).fetchone()

    @staticmethod
    def _to_ledger_command(row: tuple[Any, ...]) -> LedgerCommand:
        command_json, state, result_json, delivery, received_at, updated_at = row
        return LedgerCommand(
            command=_COMMAND.validate_python(json.loads(command_json)),
            state=CommandState(state),
            result=None if result_json is None else CommandResult.model_validate(json.loads(result_json)),
            delivery=None if delivery is None else DeliveryState(delivery),
            received_at=datetime.fromisoformat(received_at),
            updated_at=datetime.fromisoformat(updated_at),
        )


def open_ledger(path: Path) -> SqliteLedger:
    """D2 的 __main__ 默认装配入口：打开（必要时创建并迁移）path 处的账本。"""
    return SqliteLedger(path)
