"""Ledger Protocol 的共用契约测试：同一组用例同时跑 D2 的 InMemoryLedger 与 D1 的 SqliteLedger。

两者在这些用例上的可观察行为必须一致；SQLite 特有的行为（迁移、持久化、崩溃一致性）
见 test_ledger_sqlite.py。
"""

from __future__ import annotations

from datetime import timedelta
from uuid import UUID

import pytest
from monitor_contracts import (
    COMMAND_TRANSITIONS,
    AccountBinding,
    Baseline,
    CommandState,
    DeliveryState,
    IllegalTransition,
    Ledger,
    MonitorState,
)
from monitor_contracts.states import TERMINAL_COMMAND_STATES

from monitor.core.testing import InMemoryLedger
from monitor.ledger import open_ledger
from monitor.ledger.testing import T0, make_command, make_event_model, make_result

S = CommandState


@pytest.fixture(params=["memory", "sqlite"])
def ledger(request, tmp_path):
    if request.param == "memory":
        yield InMemoryLedger()
    else:
        led = open_ledger(tmp_path / "ledger.db")
        yield led
        led.close()


def _at(seconds: float):
    return T0 + timedelta(seconds=seconds)


def _to_terminal(ledger, cmd, status: str, *, at=T0):
    """把 queued 指令推进到给定终态（经由合法路径）。"""
    if S(status) not in COMMAND_TRANSITIONS[S.QUEUED]:
        ledger.transition_command(cmd.command_id, S.RUNNING, at=at)
    return ledger.transition_command(cmd.command_id, S(status), at=at, result=make_result(cmd, status, at=at))


# ---------------------------------------------------------------------------
# 指令
# ---------------------------------------------------------------------------


def test_satisfies_protocol(ledger):
    assert isinstance(ledger, Ledger)


def test_put_command_new_then_idempotent(ledger):
    cmd = make_command()
    rec, created = ledger.put_command(cmd, received_at=T0)
    assert created is True
    assert rec.state == S.QUEUED and rec.result is None and rec.delivery is None
    assert rec.command == cmd and rec.received_at == T0 and rec.updated_at == T0

    ledger.transition_command(cmd.command_id, S.RUNNING, at=_at(1))
    again, created2 = ledger.put_command(cmd, received_at=_at(5))
    assert created2 is False
    # 已存在时原样返回已有记录，不重置状态、不改接收时间
    assert again.state == S.RUNNING and again.received_at == T0
    assert len(ledger.list_commands()) == 1


def test_get_command_missing_returns_none(ledger):
    assert ledger.get_command(UUID("00000000-0000-4000-8000-ffffffffffff")) is None


def test_returned_records_are_copies(ledger):
    cmd = make_command()
    rec, _ = ledger.put_command(cmd, received_at=T0)
    rec.state = S.SUCCEEDED  # 修改返回对象不影响账本
    assert ledger.get_command(cmd.command_id).state == S.QUEUED


def test_list_commands_order_and_filter(ledger):
    a, b, c = make_command(), make_command(), make_command()
    # 接收时间乱序写入；带不同时区的时间也按真实时刻排序
    from datetime import timezone

    east8 = timezone(timedelta(hours=8))
    ledger.put_command(b, received_at=_at(20).astimezone(east8))
    ledger.put_command(a, received_at=_at(10))
    ledger.put_command(c, received_at=_at(30))
    assert [r.command.command_id for r in ledger.list_commands()] == [a.command_id, b.command_id, c.command_id]

    ledger.transition_command(b.command_id, S.RUNNING, at=_at(40))
    running = ledger.list_commands(states=[S.RUNNING])
    assert [r.command.command_id for r in running] == [b.command_id]
    queued = ledger.list_commands(states=iter([S.QUEUED]))  # 一次性迭代器也可以
    assert [r.command.command_id for r in queued] == [a.command_id, c.command_id]
    assert ledger.list_commands(states=[]) == []
    assert ledger.list_commands(states=[S.UNKNOWN]) == []


@pytest.mark.parametrize("status", sorted(s.value for s in TERMINAL_COMMAND_STATES))
def test_transition_to_terminal_sets_result_and_pending(ledger, status):
    cmd = make_command()
    ledger.put_command(cmd, received_at=T0)
    rec = _to_terminal(ledger, cmd, status, at=_at(3))
    assert rec.state == S(status)
    assert rec.result == make_result(cmd, status, at=_at(3))
    assert rec.delivery == DeliveryState.PENDING
    assert rec.updated_at == _at(3)
    assert ledger.get_command(cmd.command_id) == rec


def test_transition_queued_to_running_has_no_result(ledger):
    cmd = make_command()
    ledger.put_command(cmd, received_at=T0)
    rec = ledger.transition_command(cmd.command_id, S.RUNNING, at=_at(1))
    assert rec.state == S.RUNNING and rec.result is None and rec.delivery is None
    assert ledger.pending_results() == []


ILLEGAL = [
    (S.QUEUED, S.SUCCEEDED),
    (S.QUEUED, S.UNKNOWN),
    (S.QUEUED, S.SKIPPED_PRECONDITION),
    (S.QUEUED, S.QUEUED),
    (S.RUNNING, S.QUEUED),  # 防止重做
    (S.RUNNING, S.RUNNING),
    (S.RUNNING, S.EXPIRED),
    (S.SUCCEEDED, S.FAILED),
    (S.UNKNOWN, S.SUCCEEDED),
    (S.FAILED, S.RUNNING),
]


@pytest.mark.parametrize(("src", "dst"), ILLEGAL)
def test_illegal_transition_raises_and_keeps_record(ledger, src, dst):
    cmd = make_command()
    ledger.put_command(cmd, received_at=T0)
    if src == S.RUNNING:
        ledger.transition_command(cmd.command_id, S.RUNNING, at=_at(1))
    elif src != S.QUEUED:
        _to_terminal(ledger, cmd, src.value, at=_at(1))
    before = ledger.get_command(cmd.command_id)

    result = make_result(cmd, dst.value) if dst in TERMINAL_COMMAND_STATES else None
    with pytest.raises(IllegalTransition):
        ledger.transition_command(cmd.command_id, dst, at=_at(9), result=result)
    assert ledger.get_command(cmd.command_id) == before


def test_transition_unknown_command_raises_keyerror(ledger):
    with pytest.raises(KeyError):
        ledger.transition_command(UUID("00000000-0000-4000-8000-ffffffffffff"), S.RUNNING, at=T0)


def test_transition_unknown_state_name_raises_valueerror(ledger):
    cmd = make_command()
    ledger.put_command(cmd, received_at=T0)
    with pytest.raises(ValueError):
        ledger.transition_command(cmd.command_id, "paused", at=T0)  # type: ignore[arg-type]


def test_terminal_without_result_rejected(ledger):
    cmd = make_command()
    ledger.put_command(cmd, received_at=T0)
    ledger.transition_command(cmd.command_id, S.RUNNING, at=_at(1))
    with pytest.raises(ValueError):
        ledger.transition_command(cmd.command_id, S.SUCCEEDED, at=_at(2))
    assert ledger.get_command(cmd.command_id).state == S.RUNNING


def test_non_terminal_with_result_rejected(ledger):
    cmd = make_command()
    ledger.put_command(cmd, received_at=T0)
    with pytest.raises(ValueError):
        ledger.transition_command(cmd.command_id, S.RUNNING, at=_at(1), result=make_result(cmd, "succeeded"))
    assert ledger.get_command(cmd.command_id).state == S.QUEUED


def test_result_status_must_match_target(ledger):
    cmd = make_command()
    ledger.put_command(cmd, received_at=T0)
    ledger.transition_command(cmd.command_id, S.RUNNING, at=_at(1))
    with pytest.raises(ValueError):
        ledger.transition_command(cmd.command_id, S.SUCCEEDED, at=_at(2), result=make_result(cmd, "failed"))
    rec = ledger.get_command(cmd.command_id)
    assert rec.state == S.RUNNING and rec.result is None
    assert ledger.pending_results() == []


# ---------------------------------------------------------------------------
# 结果回传
# ---------------------------------------------------------------------------


def test_pending_results_in_completion_order_and_limit(ledger):
    a, b, c = make_command(), make_command(), make_command()
    for i, cmd in enumerate((a, b, c)):
        ledger.put_command(cmd, received_at=_at(i))
    # 完成顺序与接收顺序不同：c、a、b
    _to_terminal(ledger, c, "succeeded", at=_at(10))
    _to_terminal(ledger, a, "cancelled", at=_at(11))
    _to_terminal(ledger, b, "unknown", at=_at(12))
    assert [r.command_id for r in ledger.pending_results()] == [c.command_id, a.command_id, b.command_id]
    assert [r.command_id for r in ledger.pending_results(limit=2)] == [c.command_id, a.command_id]


def test_mark_result_delivered_idempotent(ledger):
    a, b = make_command(), make_command()
    ledger.put_command(a, received_at=T0)
    ledger.put_command(b, received_at=T0)
    _to_terminal(ledger, a, "succeeded")
    _to_terminal(ledger, b, "failed")

    ledger.mark_result_delivered(a.command_id)
    assert ledger.get_command(a.command_id).delivery == DeliveryState.DELIVERED
    assert [r.command_id for r in ledger.pending_results()] == [b.command_id]

    snapshot = ledger.get_command(a.command_id)
    ledger.mark_result_delivered(a.command_id)  # 重复调用无副作用
    assert ledger.get_command(a.command_id) == snapshot
    assert [r.command_id for r in ledger.pending_results()] == [b.command_id]


def test_mark_result_delivered_without_result_raises(ledger):
    cmd = make_command()
    ledger.put_command(cmd, received_at=T0)
    with pytest.raises(KeyError):
        ledger.mark_result_delivered(cmd.command_id)  # 还在 queued，没有结果
    with pytest.raises(KeyError):
        ledger.mark_result_delivered(UUID("00000000-0000-4000-8000-ffffffffffff"))
    assert ledger.get_command(cmd.command_id).delivery is None


# ---------------------------------------------------------------------------
# 事件 outbox
# ---------------------------------------------------------------------------


def test_append_event_idempotent_and_seq_monotonic(ledger):
    e1, e2, e3 = make_event_model(), make_event_model(), make_event_model()
    assert ledger.append_event(e1, at=_at(1)) is True
    assert ledger.append_event(e2, at=_at(2)) is True
    assert ledger.append_event(e1, at=_at(3)) is False  # 同 event_id 不再写入
    assert ledger.append_event(e3, at=_at(4)) is True

    entries = ledger.pending_events()
    assert [e.event.event_id for e in entries] == [e1.event_id, e2.event_id, e3.event_id]
    seqs = [e.seq for e in entries]
    assert seqs == sorted(seqs) and len(set(seqs)) == 3 and seqs[0] >= 1
    assert entries[0].event == e1 and entries[0].enqueued_at == _at(1)
    assert all(e.delivery == DeliveryState.PENDING for e in entries)


def test_pending_events_after_seq_and_limit(ledger):
    events = [make_event_model() for _ in range(5)]
    for i, ev in enumerate(events):
        ledger.append_event(ev, at=_at(i))
    seqs = [e.seq for e in ledger.pending_events()]
    assert [e.seq for e in ledger.pending_events(after_seq=seqs[1])] == seqs[2:]
    assert [e.seq for e in ledger.pending_events(after_seq=seqs[0], limit=2)] == seqs[1:3]
    assert ledger.pending_events(after_seq=seqs[-1]) == []


def test_mark_events_delivered_and_cursor(ledger):
    assert ledger.outbox_cursor() == 0
    events = [make_event_model() for _ in range(4)]
    for ev in events:
        ledger.append_event(ev, at=T0)
    seqs = [e.seq for e in ledger.pending_events()]
    assert ledger.outbox_cursor() == 0

    # 先确认第 2、3 个：游标不能越过未确认的第 1 个
    ledger.mark_events_delivered([events[1].event_id, events[2].event_id])
    assert ledger.outbox_cursor() == 0
    assert [e.event.event_id for e in ledger.pending_events()] == [events[0].event_id, events[3].event_id]

    ledger.mark_events_delivered(iter([events[0].event_id]))
    assert ledger.outbox_cursor() == seqs[2]

    # 重复确认、未知 id、空列表都无副作用
    ledger.mark_events_delivered([events[0].event_id, "f" * 64])
    ledger.mark_events_delivered([])
    assert ledger.outbox_cursor() == seqs[2]
    assert [e.event.event_id for e in ledger.pending_events()] == [events[3].event_id]

    ledger.mark_events_delivered([events[3].event_id])
    assert ledger.outbox_cursor() == seqs[3]
    assert ledger.pending_events() == []


def test_seq_keeps_increasing_after_delivery(ledger):
    e1, e2 = make_event_model(), make_event_model()
    ledger.append_event(e1, at=T0)
    first = ledger.pending_events()[0].seq
    ledger.mark_events_delivered([e1.event_id])
    ledger.append_event(e2, at=T0)
    assert ledger.pending_events()[0].seq > first
    # 已确认的事件再次 append 仍按 event_id 去重
    assert ledger.append_event(e1, at=T0) is False


# ---------------------------------------------------------------------------
# 本机状态
# ---------------------------------------------------------------------------


def test_load_state_default(ledger):
    assert ledger.load_state() == MonitorState()


def test_save_and_load_state_roundtrip(ledger):
    state = MonitorState(
        mode="remote",
        account_binding=AccountBinding(account_id="acct_1", bound_at=T0, confirmed_by="用户"),
        paused=True,
        pause_reason="login_required",
        needs_baseline=False,
        baseline=Baseline(
            account_id="acct_1", established=True, generation=3, updated_at=_at(5), data={"会话": ["甲", 1, None]}
        ),
        last_online_at=_at(7),
    )
    ledger.save_state(state)
    assert ledger.load_state() == state

    # 覆盖保存：解除暂停、清空绑定
    state2 = state.model_copy(update={"paused": False, "pause_reason": None, "account_binding": None})
    ledger.save_state(state2)
    assert ledger.load_state() == state2


def test_save_state_rejects_invalid_and_keeps_old(ledger):
    good = MonitorState(mode="local", needs_baseline=False)
    ledger.save_state(good)
    bad = ledger.load_state()
    bad.paused = True  # 就地改坏：paused 但没有 pause_reason（赋值不触发校验）
    with pytest.raises(ValueError):
        ledger.save_state(bad)
    assert ledger.load_state() == good


def test_loaded_state_is_copy(ledger):
    ledger.save_state(MonitorState(mode="local"))
    s = ledger.load_state()
    s.baseline.data["x"] = 1
    assert ledger.load_state().baseline.data == {}
