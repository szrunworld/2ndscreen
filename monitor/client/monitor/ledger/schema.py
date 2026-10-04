"""本地账本的表结构与版本化迁移。

规则：
- 已发布的迁移永不修改，只能追加新版本；每一步在自己的事务里执行，并在同一事务里
  更新 schema_version，所以任何一步失败后库都停在上一个完整版本。
- 库的版本高于本程序认识的最高版本时拒绝打开（不降级），避免旧程序写坏新结构。
- 结果、指令、事件都按契约 to_wire() 整体存 JSON，不为单个字段建列，契约增删字段
  （例如 0.2.0 把 gui_write_performed 拆成三个标志）不需要改表。
"""

from __future__ import annotations

import sqlite3
from collections.abc import Sequence
from dataclasses import dataclass


class LedgerSchemaError(RuntimeError):
    """库结构无法使用：版本比程序新，或迁移失败。"""


@dataclass(frozen=True)
class Migration:
    version: int
    description: str
    statements: tuple[str, ...]


# v1：三张表。状态只在 queued / running 两个非终态上加约束（这两个值不会变），
# 终态枚举不写进 CHECK，契约新增终态时不需要重建表。
_V1 = Migration(
    version=1,
    description="三张表：command_ledger、event_outbox、monitor_state",
    statements=(
        """
        CREATE TABLE command_ledger (
            command_id     TEXT PRIMARY KEY,
            action         TEXT NOT NULL,
            command_json   TEXT NOT NULL,
            state          TEXT NOT NULL,
            result_json    TEXT,
            delivery       TEXT CHECK (delivery IN ('pending', 'delivered')),
            received_at    TEXT NOT NULL,
            received_at_us INTEGER NOT NULL,
            updated_at     TEXT NOT NULL,
            finished_seq   INTEGER UNIQUE,
            CHECK ((state IN ('queued', 'running'))
                   = (result_json IS NULL AND delivery IS NULL AND finished_seq IS NULL))
        )
        """,
        """
        CREATE TABLE event_outbox (
            seq         INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id    TEXT NOT NULL UNIQUE,
            kind        TEXT NOT NULL,
            event_json  TEXT NOT NULL,
            delivery    TEXT NOT NULL CHECK (delivery IN ('pending', 'delivered')),
            enqueued_at TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE monitor_state (
            id                   INTEGER PRIMARY KEY CHECK (id = 1),
            mode                 TEXT,
            account_binding_json TEXT,
            paused               INTEGER NOT NULL CHECK (paused IN (0, 1)),
            pause_reason         TEXT,
            needs_baseline       INTEGER NOT NULL CHECK (needs_baseline IN (0, 1)),
            baseline_json        TEXT NOT NULL,
            last_online_at       TEXT,
            CHECK (paused = 0 OR pause_reason IS NOT NULL)
        )
        """,
    ),
)

# v2：回传与恢复查询用的索引（pending_results / pending_events / list_commands(states=...)）。
_V2 = Migration(
    version=2,
    description="回传与崩溃恢复查询的索引",
    statements=(
        "CREATE INDEX command_ledger_by_state ON command_ledger (state, received_at_us)",
        "CREATE INDEX command_ledger_pending ON command_ledger (finished_seq) WHERE delivery = 'pending'",
        "CREATE INDEX event_outbox_pending ON event_outbox (seq) WHERE delivery = 'pending'",
    ),
)

MIGRATIONS: tuple[Migration, ...] = (_V1, _V2)
SCHEMA_VERSION = MIGRATIONS[-1].version

_VERSION_TABLE = """
CREATE TABLE IF NOT EXISTS schema_version (
    id      INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL
)
"""


def schema_version(conn: sqlite3.Connection) -> int:
    """当前库的结构版本；空库（没有 schema_version 表或没有行）为 0。"""
    exists = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'"
    ).fetchone()
    if exists is None:
        return 0
    row = conn.execute("SELECT version FROM schema_version WHERE id = 1").fetchone()
    return 0 if row is None else int(row[0])


def migrate(conn: sqlite3.Connection, migrations: Sequence[Migration] = MIGRATIONS) -> int:
    """把库升级到 migrations 的最高版本，返回升级后的版本。

    conn 必须处于自动提交模式（isolation_level=None），由本函数显式管理事务。
    """
    if conn.isolation_level is not None:
        raise ValueError("migrate 需要 isolation_level=None 的连接")
    versions = [m.version for m in migrations]
    if versions != list(range(1, len(migrations) + 1)):
        raise ValueError(f"迁移版本必须从 1 连续递增，实际为 {versions}")
    target = len(migrations)

    for m in migrations:
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute(_VERSION_TABLE)
            current = schema_version(conn)
            if current > target:
                raise LedgerSchemaError(f"账本结构版本 {current} 高于本程序支持的 {target}，拒绝打开")
            if current >= m.version:
                conn.execute("ROLLBACK")
                continue
            for sql in m.statements:
                conn.execute(sql)
            conn.execute(
                "INSERT INTO schema_version (id, version) VALUES (1, ?) "
                "ON CONFLICT (id) DO UPDATE SET version = excluded.version",
                (m.version,),
            )
            conn.execute("COMMIT")
        except LedgerSchemaError:
            conn.rollback()
            raise
        except sqlite3.Error as exc:
            conn.rollback()
            raise LedgerSchemaError(f"迁移到版本 {m.version}（{m.description}）失败：{exc}") from exc
        except BaseException:
            conn.rollback()
            raise

    # 空迁移列表或库已是最新：也要拒绝比程序新的库
    current = schema_version(conn)
    if current > target:
        raise LedgerSchemaError(f"账本结构版本 {current} 高于本程序支持的 {target}，拒绝打开")
    return current
