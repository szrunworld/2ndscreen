"""本地账本（任务 D1）：Ledger Protocol 的 SQLite 实现。

入口 open_ledger(path) 供 monitor.__main__ 按 "monitor.ledger:open_ledger" 装配。
"""

from __future__ import annotations

from .schema import MIGRATIONS, SCHEMA_VERSION, LedgerSchemaError, Migration, migrate, schema_version
from .sqlite import SqliteLedger, open_ledger

__all__ = [
    "MIGRATIONS",
    "SCHEMA_VERSION",
    "LedgerSchemaError",
    "Migration",
    "SqliteLedger",
    "migrate",
    "open_ledger",
    "schema_version",
]
