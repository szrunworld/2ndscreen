"""SQLite 账本特有的行为：版本化迁移、WAL、重启持久化、事务中途异常后的一致性，
以及接到 D2 运行时上的崩溃恢复。共用的 Protocol 行为见 test_ledger_contract.py。
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import textwrap
from datetime import datetime, timedelta
from uuid import UUID

import pytest
from monitor_contracts import (
    AccountBinding,
    Baseline,
    CommandState,
    DeliveryState,
    Locator,
    MonitorState,
)

from monitor.__main__ import DEFAULT_LEDGER, load_factory
from monitor.core.testing import ACCOUNT, ScriptedHandler, make_env
from monitor.ledger import (
    MIGRATIONS,
    SCHEMA_VERSION,
    LedgerSchemaError,
    Migration,
    SqliteLedger,
    migrate,
    open_ledger,
    schema_version,
)
from monitor.ledger.testing import T0, make_command, make_event_model, make_result

S = CommandState


@pytest.fixture
def db(tmp_path):
    return tmp_path / "ledger.db"


@pytest.fixture
def ledger(db):
    led = open_ledger(db)
    yield led
    led.close()


def _raw(path) -> sqlite3.Connection:
    return sqlite3.connect(path, isolation_level=None)


def _objects(conn, kind: str) -> set[str]:
    return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = ?", (kind,))}


# ---------------------------------------------------------------------------
# 入口与基本设置
# ---------------------------------------------------------------------------


def test_default_factory_in_main_resolves_to_open_ledger(db):
    factory = load_factory(DEFAULT_LEDGER)
    assert factory is open_ledger
    led = factory(db)
    assert isinstance(led, SqliteLedger) and led.path == db
    led.close()


def test_open_creates_parent_dirs_and_uses_wal(tmp_path):
    path = tmp_path / "a" / "b" / "ledger.db"
    with open_ledger(path) as led:
        assert path.exists()
        assert led._conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert led._conn.execute("PRAGMA synchronous").fetchone()[0] == 2  # FULL


def test_open_rejects_non_database_file(tmp_path):
    path = tmp_path / "not-a-db"
    path.write_bytes(b"this is not sqlite" * 100)
    with pytest.raises(sqlite3.DatabaseError):
        open_ledger(path)


def test_result_stored_as_whole_json_without_field_columns(ledger, db):
    """契约 0.2.0 将拆分 gui_write_performed：账本不为结果字段单独建列。"""
    cols = {r[1] for r in _raw(db).execute("PRAGMA table_info(command_ledger)")}
    assert not cols & {"gui_write_performed", "status", "reason", "executed_at"}
    cmd = make_command()
    ledger.put_command(cmd, received_at=T0)
    ledger.transition_command(cmd.command_id, S.RUNNING, at=T0)
    res = make_result(cmd, "succeeded")
    ledger.transition_command(cmd.command_id, S.SUCCEEDED, at=T0, result=res)
    stored = _raw(db).execute("SELECT result_json FROM command_ledger").fetchone()[0]
    assert json.loads(stored) == res.to_wire()


# ---------------------------------------------------------------------------
# 迁移
# ---------------------------------------------------------------------------


def test_migrate_empty_database_to_latest(db):
    conn = _raw(db)
    assert schema_version(conn) == 0
    assert migrate(conn) == SCHEMA_VERSION == len(MIGRATIONS)
    assert {"command_ledger", "event_outbox", "monitor_state", "schema_version"} <= _objects(conn, "table")
    assert {"command_ledger_by_state", "command_ledger_pending", "event_outbox_pending"} <= _objects(conn, "index")
    # 再次迁移是空操作
    assert migrate(conn) == SCHEMA_VERSION
    assert conn.execute("SELECT COUNT(*) FROM schema_version").fetchone()[0] == 1


def test_upgrade_from_previous_version_keeps_data(db):
    """先只建 v1 并写入数据（模拟旧版程序留下的库），再用当前程序打开。"""
    conn = _raw(db)
    assert migrate(conn, MIGRATIONS[:1]) == 1
    assert "command_ledger_pending" not in _objects(conn, "index")
    conn.close()

    # 按 v1 的表结构直接写 SQL（模拟旧版程序留下的数据）
    cmd = make_command()
    ev = make_event_model()
    conn = _raw(db)
    conn.execute(
        "INSERT INTO command_ledger (command_id, action, command_json, state, received_at, received_at_us, "
        "updated_at) VALUES (?, ?, ?, 'running', ?, 0, ?)",
        (str(cmd.command_id), cmd.action, cmd.model_dump_json(), T0.isoformat(), T0.isoformat()),
    )
    conn.execute(
        "INSERT INTO event_outbox (event_id, kind, event_json, delivery, enqueued_at) VALUES (?, ?, ?, 'pending', ?)",
        (ev.event_id, ev.kind, ev.model_dump_json(), T0.isoformat()),
    )
    conn.close()

    with open_ledger(db) as led:
        assert schema_version(led._conn) == SCHEMA_VERSION
        assert "command_ledger_pending" in _objects(led._conn, "index")
        running = led.list_commands(states=[S.RUNNING])
        assert [r.command for r in running] == [cmd]
        assert [e.event for e in led.pending_events()] == [ev]
        # 升级后的库可以正常继续写
        led.transition_command(cmd.command_id, S.UNKNOWN, at=T0, result=make_result(cmd, "unknown"))
        assert [r.command_id for r in led.pending_results()] == [cmd.command_id]


def test_newer_schema_version_is_refused(db):
    conn = _raw(db)
    migrate(conn)
    conn.execute("UPDATE schema_version SET version = ?", (SCHEMA_VERSION + 1,))
    conn.close()
    with pytest.raises(LedgerSchemaError, match="高于"):
        open_ledger(db)
    # 拒绝打开不改动库
    assert schema_version(_raw(db)) == SCHEMA_VERSION + 1


def test_failed_migration_rolls_back_to_previous_version(db):
    broken = (
        *MIGRATIONS,
        Migration(
            version=SCHEMA_VERSION + 1,
            description="故意失败",
            statements=("CREATE TABLE extra_table (x INTEGER)", "THIS IS NOT SQL"),
        ),
    )
    conn = _raw(db)
    with pytest.raises(LedgerSchemaError, match=f"版本 {SCHEMA_VERSION + 1}"):
        migrate(conn, broken)
    # 前面的版本已完整提交，失败那一步的半截 DDL 全部回滚
    assert schema_version(conn) == SCHEMA_VERSION
    assert "extra_table" not in _objects(conn, "table")
    assert not conn.in_transaction


def test_migrate_rejects_bad_inputs(db):
    conn = _raw(db)
    with pytest.raises(ValueError, match="连续"):
        migrate(conn, (MIGRATIONS[1],))
    implicit = sqlite3.connect(db)  # 默认 isolation_level=""，会隐式开事务
    with pytest.raises(ValueError, match="isolation_level"):
        migrate(implicit)
    assert schema_version(conn) == 0


# ---------------------------------------------------------------------------
# 重启持久化
# ---------------------------------------------------------------------------


def test_reopen_keeps_everything_and_finds_running(db):
    queued, running, done = make_command(), make_command(), make_command()
    ev1, ev2 = make_event_model(), make_event_model()
    state = MonitorState(
        mode="local",
        account_binding=AccountBinding(account_id=ACCOUNT, bound_at=T0, confirmed_by="tester"),
        needs_baseline=False,
        baseline=Baseline(account_id=ACCOUNT, established=True, generation=2, data={"k": "值"}),
        last_online_at=T0,
    )
    with open_ledger(db) as led:
        for i, c in enumerate((queued, running, done)):
            led.put_command(c, received_at=T0 + timedelta(seconds=i))
        led.transition_command(running.command_id, S.RUNNING, at=T0)
        led.transition_command(done.command_id, S.RUNNING, at=T0)
        led.transition_command(done.command_id, S.SUCCEEDED, at=T0, result=make_result(done))
        led.append_event(ev1, at=T0)
        led.append_event(ev2, at=T0)
        led.mark_events_delivered([ev1.event_id])
        led.save_state(state)
        seq2 = led.pending_events()[0].seq

    with open_ledger(db) as led:
        assert [r.command.command_id for r in led.list_commands(states=[S.RUNNING])] == [running.command_id]
        assert [r.command_id for r in led.pending_results()] == [done.command_id]
        assert [e.event.event_id for e in led.pending_events()] == [ev2.event_id]
        assert led.outbox_cursor() == seq2 - 1
        assert led.load_state() == state
        # seq 跨重启继续递增
        ev3 = make_event_model()
        led.append_event(ev3, at=T0)
        assert led.pending_events()[-1].seq > seq2


# ---------------------------------------------------------------------------
# 参数校验（SQLite 版比内存替身更严的部分）
# ---------------------------------------------------------------------------


def test_naive_datetimes_rejected(ledger):
    cmd = make_command()
    naive = datetime(2026, 10, 4, 1, 0)
    with pytest.raises(ValueError):
        ledger.put_command(cmd, received_at=naive)
    ledger.put_command(cmd, received_at=T0)
    with pytest.raises(ValueError):
        ledger.transition_command(cmd.command_id, S.RUNNING, at=naive)
    with pytest.raises(ValueError):
        ledger.append_event(make_event_model(), at=naive)
    assert ledger.get_command(cmd.command_id).state == S.QUEUED
    assert ledger.pending_events() == []


@pytest.mark.parametrize("limit", [0, -1, True, 1.5])
def test_bad_limit_rejected(ledger, limit):
    with pytest.raises(ValueError):
        ledger.pending_results(limit=limit)
    with pytest.raises(ValueError):
        ledger.pending_events(limit=limit)


def test_result_for_other_command_rejected(ledger):
    a, b = make_command(), make_command()
    ledger.put_command(a, received_at=T0)
    ledger.transition_command(a.command_id, S.RUNNING, at=T0)
    with pytest.raises(ValueError, match="不一致"):
        ledger.transition_command(a.command_id, S.SUCCEEDED, at=T0, result=make_result(b))
    assert ledger.get_command(a.command_id).state == S.RUNNING


def test_closed_ledger_raises(db):
    led = open_ledger(db)
    led.close()
    with pytest.raises(sqlite3.ProgrammingError):
        led.load_state()


# ---------------------------------------------------------------------------
# 崩溃一致性：事务中途抛异常
# ---------------------------------------------------------------------------


class Boom(Exception):
    pass


class FaultyConn:
    """包住真实连接，在匹配的语句上抛异常（语句本身不执行），用来模拟事务中途失败。"""

    def __init__(self, conn: sqlite3.Connection, fail_on, exc: BaseException | None = None, after: int = 0):
        self._conn = conn
        self._fail_on = fail_on
        self._exc = exc or Boom("注入的故障")
        self._after = after  # 前 after 次匹配放行
        self.hits = 0

    def execute(self, sql, *args):
        if self._fail_on(sql):
            self.hits += 1
            if self.hits > self._after:
                raise self._exc
        return self._conn.execute(sql, *args)

    def executemany(self, sql, rows):
        # 逐行执行，便于在第 n 行注入故障
        for row in rows:
            self.execute(sql, row)

    def __getattr__(self, name):
        return getattr(self._conn, name)


def _inject(led: SqliteLedger, fail_on, **kw) -> FaultyConn:
    faulty = FaultyConn(led._conn, fail_on, **kw)
    led._conn = faulty  # type: ignore[assignment]
    return faulty


def _restore(led: SqliteLedger, faulty: FaultyConn) -> None:
    led._conn = faulty._conn


def _running(led):
    cmd = make_command()
    led.put_command(cmd, received_at=T0)
    led.transition_command(cmd.command_id, S.RUNNING, at=T0)
    return cmd


def test_commit_failure_on_terminal_transition_rolls_back(ledger, db):
    cmd = _running(ledger)
    faulty = _inject(ledger, lambda sql: sql == "COMMIT")
    with pytest.raises(Boom):
        ledger.transition_command(cmd.command_id, S.SUCCEEDED, at=T0, result=make_result(cmd))
    _restore(ledger, faulty)
    assert not ledger._conn.in_transaction
    rec = ledger.get_command(cmd.command_id)
    assert rec.state == S.RUNNING and rec.result is None and rec.delivery is None
    assert ledger.pending_results() == []
    # 另一个连接（模拟重启后的进程）看到的也是一致的旧状态
    assert _raw(db).execute("SELECT state FROM command_ledger").fetchone()[0] == "running"
    # 账本仍可用，重试可以成功
    ledger.transition_command(cmd.command_id, S.SUCCEEDED, at=T0, result=make_result(cmd))
    assert [r.command_id for r in ledger.pending_results()] == [cmd.command_id]


def test_keyboard_interrupt_mid_transaction_rolls_back(ledger):
    cmd = make_command()
    ledger.put_command(cmd, received_at=T0)
    faulty = _inject(ledger, lambda sql: sql.startswith("UPDATE command_ledger"), exc=KeyboardInterrupt())
    with pytest.raises(KeyboardInterrupt):
        ledger.transition_command(cmd.command_id, S.RUNNING, at=T0)
    _restore(ledger, faulty)
    assert ledger.get_command(cmd.command_id).state == S.QUEUED


def test_append_event_commit_failure_leaves_no_row_and_no_seq_gap(ledger):
    e1, e2 = make_event_model(), make_event_model()
    faulty = _inject(ledger, lambda sql: sql == "COMMIT")
    with pytest.raises(Boom):
        ledger.append_event(e1, at=T0)
    _restore(ledger, faulty)
    assert ledger.pending_events() == []
    assert ledger.outbox_cursor() == 0
    assert ledger.append_event(e1, at=T0) is True  # 未落库，所以不算重复
    ledger.append_event(e2, at=T0)
    assert [e.seq for e in ledger.pending_events()] == [1, 2]


def test_mark_events_delivered_is_all_or_nothing(ledger):
    events = [make_event_model() for _ in range(3)]
    for ev in events:
        ledger.append_event(ev, at=T0)
    # 第 2 行更新时失败：第 1 行的更新也必须回滚
    faulty = _inject(ledger, lambda sql: sql.startswith("UPDATE event_outbox"), after=1)
    with pytest.raises(Boom):
        ledger.mark_events_delivered([e.event_id for e in events])
    assert faulty.hits == 2
    _restore(ledger, faulty)
    assert len(ledger.pending_events()) == 3
    assert ledger.outbox_cursor() == 0


def test_save_state_failure_keeps_previous_state(ledger):
    old = MonitorState(mode="local", needs_baseline=False)
    ledger.save_state(old)
    faulty = _inject(ledger, lambda sql: sql == "COMMIT")
    with pytest.raises(Boom):
        ledger.save_state(MonitorState(mode="remote", paused=True, pause_reason="anomaly"))
    _restore(ledger, faulty)
    assert ledger.load_state() == old


def test_mark_result_delivered_failure_keeps_pending(ledger):
    cmd = _running(ledger)
    ledger.transition_command(cmd.command_id, S.SUCCEEDED, at=T0, result=make_result(cmd))
    faulty = _inject(ledger, lambda sql: sql == "COMMIT")
    with pytest.raises(Boom):
        ledger.mark_result_delivered(cmd.command_id)
    _restore(ledger, faulty)
    assert ledger.get_command(cmd.command_id).delivery == DeliveryState.PENDING
    assert [r.command_id for r in ledger.pending_results()] == [cmd.command_id]


_KILL_CHILD = textwrap.dedent(
    """
    import os, sys
    from pathlib import Path
    from monitor_contracts import CommandState as S
    from monitor.ledger import open_ledger
    from monitor.ledger.testing import T0, make_command, make_event_model, make_result

    led = open_ledger(Path(sys.argv[1]))
    cmd = make_command(command_id=sys.argv[2])
    led.put_command(cmd, received_at=T0)
    led.transition_command(cmd.command_id, S.RUNNING, at=T0)   # 已提交：处理器调用前落 running
    led.append_event(make_event_model(bucket="committed"), at=T0)

    real = led._conn

    class KillAtCommit:
        def __getattr__(self, name):
            return getattr(real, name)

        def execute(self, sql, *args):
            if sql == "COMMIT":
                os._exit(9)   # 进程在提交前被杀：不回滚、不关闭连接
            return real.execute(sql, *args)

    led._conn = KillAtCommit()
    led.transition_command(cmd.command_id, S.SUCCEEDED, at=T0, result=make_result(cmd))
    """
)


def test_process_killed_before_commit_recovers_running(db):
    """真实子进程在事务提交前退出（os._exit，不走任何清理）；重开账本后数据一致。"""
    cid = "00000000-0000-4000-8000-00000000abcd"
    proc = subprocess.run(
        [sys.executable, "-c", _KILL_CHILD, str(db), cid],
        capture_output=True,
        text=True,
        timeout=60,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    assert proc.returncode == 9, proc.stderr

    with open_ledger(db) as led:
        rec = led.get_command(UUID(cid))
        assert rec.state == S.RUNNING and rec.result is None and rec.delivery is None
        assert [r.command.command_id for r in led.list_commands(states=[S.RUNNING])] == [UUID(cid)]
        assert led.pending_results() == []
        assert len(led.pending_events()) == 1
        assert led._conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


# ---------------------------------------------------------------------------
# 接到 D2 运行时：kill -9 后用真正重开的 SQLite 账本做崩溃恢复
# ---------------------------------------------------------------------------


class SimulatedKill(BaseException):
    """模拟进程被杀：管线只捕获 Exception，账本停在当时的状态。"""


def _crashing_run(command, driver, ctx):
    driver.click(Locator(text="发送"))
    raise SimulatedKill()


def test_d2_crash_recovery_with_reopened_sqlite_ledger(db):
    greet = ScriptedHandler("send_greeting", run=_crashing_run)  # verify 默认"无法判断"
    env = make_env(handlers=[greet])
    led = open_ledger(db)
    led.save_state(env.ledger.load_state())  # 继承 make_env 准备好的绑定与基线
    env.ledger = led
    env.new_runtime()

    c1 = env.cmd("send_greeting")
    env.server.enqueue(c1)
    with pytest.raises(SimulatedKill):
        env.run_until(lambda: False)
    assert len(env.driver.writes) == 1
    led.close()

    # 重启：新进程重新打开同一个文件
    env.ledger = open_ledger(db)
    assert [r.command.command_id for r in env.ledger.list_commands(states=[S.RUNNING])] == [UUID(c1["command_id"])]
    env.new_runtime()
    env.run_until(lambda: c1["command_id"] in env.server.results)

    rec = env.ledger.get_command(UUID(c1["command_id"]))
    assert rec.state == S.UNKNOWN and rec.result.reason == "crash_recovery"
    assert rec.delivery == DeliveryState.DELIVERED
    assert greet.verify_calls == [UUID(c1["command_id"])]
    assert len(env.driver.writes) == 1  # 没有重做
    env.ledger.close()
