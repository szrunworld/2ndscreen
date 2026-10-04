"""core 小部件：限额、GUI 锁、只读守卫、时钟、事件构造、写操作标记、内存账本。"""

from __future__ import annotations

import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

import pytest
from monitor_contracts import (
    ActionResult,
    CommandState,
    Frame,
    IllegalTransition,
    LedgerCommand,
    Locator,
    validate_command,
    validate_command_result,
    validate_policy,
)

from monitor.core import write_flags
from monitor.core.clock import ManualClock, SystemClock
from monitor.core.events import make_event
from monitor.core.guard import CommandCancelled, ExecContext, GuardedDriver, ReadOnlyViolation
from monitor.core.gui_lock import ACTION, OBSERVE, GuiLock
from monitor.core.limits import HARD_DAILY_CAPS, MIN_INTERVAL_FLOORS, check_rate, effective_limit, policy_timezone
from monitor.core.testing import ACCOUNT, DEVICE, InMemoryLedger, RecordingDriver, make_command, make_policy


def wait_until(pred, timeout=2.0):
    """等待状态成立（不是固定 sleep：条件一成立立即返回，超时则失败）。"""
    deadline = time.monotonic() + timeout
    ev = threading.Event()
    while not pred():
        if time.monotonic() > deadline:
            raise AssertionError("等待超时")
        ev.wait(0.001)


# ---------------------------------------------------------------------------
# 限额
# ---------------------------------------------------------------------------


def test_effective_limit_only_tightens():
    loose = validate_policy(make_policy(daily_limits={k: 86400 for k in HARD_DAILY_CAPS}))
    lim = effective_limit("send_greeting", loose)
    assert lim.daily_cap == HARD_DAILY_CAPS["send_greeting"]
    assert lim.min_interval_seconds == MIN_INTERVAL_FLOORS["send_greeting"]
    tight = validate_policy(
        make_policy(
            daily_limits={k: 3 for k in HARD_DAILY_CAPS},
            min_interval_seconds={k: 600 for k in HARD_DAILY_CAPS},
        )
    )
    lim = effective_limit("send_greeting", tight)
    assert (lim.daily_cap, lim.min_interval_seconds) == (3, 600)
    assert effective_limit("request_resume", None).daily_cap == HARD_DAILY_CAPS["request_resume"]


def test_effective_limit_rejects_non_outward_action():
    with pytest.raises(ValueError):
        effective_limit("provide_input", None)


def test_hard_tables_are_immutable():
    with pytest.raises(TypeError):
        HARD_DAILY_CAPS["send_greeting"] = 10**6  # type: ignore[index]


def _executed(clock, at, *, action="send_greeting", wrote=True, mode="execute"):
    cmd = validate_command(make_command(action, clock=clock, execution_mode=mode))
    res = validate_command_result(
        {
            "command_id": str(cmd.command_id),
            "action": action,
            "execution_mode": mode,
            "status": "succeeded",
            "reason": None,
            "observed": {"before": [], "after": []},
            "evidence": [],
            "navigation_performed": wrote,
            "outbound_action_performed": wrote and action != "search_candidates",
            "externally_visible_side_effect": wrote and action != "search_candidates",
            "executed_at": at.isoformat(),
            "reported_at": at.isoformat(),
        }
    )
    return LedgerCommand(command=cmd, state="succeeded", result=res, delivery="pending", received_at=at, updated_at=at)


def test_hard_limits_values_confirmed_by_user():
    # 用户 2026-10-04 确认的数值；改动需要用户同意（0.3.0 移除 forward_resume，剩 4 种对外动作）
    assert dict(HARD_DAILY_CAPS) == {
        "send_greeting": 40,
        "request_resume": 40,
        "request_contact_exchange": 40,
        "search_candidates": 40,
    }
    assert dict(MIN_INTERVAL_FLOORS) == {
        "send_greeting": 45,
        "request_resume": 45,
        "request_contact_exchange": 60,
        "search_candidates": 30,
    }


def test_check_rate_daily_cap_and_interval():
    clock = ManualClock(datetime(2026, 10, 4, 10, 0, tzinfo=UTC))
    policy = validate_policy(make_policy(daily_limits={k: 2 for k in HARD_DAILY_CAPS}))
    now = clock.now()
    hist = [_executed(clock, now - timedelta(hours=2))]
    assert check_rate("send_greeting", now=now, history=hist, policy=policy).allowed
    hist.append(_executed(clock, now - timedelta(seconds=10)))
    d = check_rate("send_greeting", now=now, history=hist, policy=policy)
    assert not d.allowed and d.kind == "daily_cap" and d.used_today == 2 and "上限" in d.detail()
    # 其他动作、没写界面的、verify_only 的都不计入
    hist2 = [
        _executed(clock, now - timedelta(seconds=5), action="request_resume"),
        _executed(clock, now - timedelta(seconds=5), wrote=False),
        _executed(clock, now - timedelta(seconds=5), mode="verify_only", wrote=False),
    ]
    assert check_rate("send_greeting", now=now, history=hist2, policy=policy).allowed
    d = check_rate("send_greeting", now=now, history=[_executed(clock, now - timedelta(seconds=5))], policy=policy)
    floor = MIN_INTERVAL_FLOORS["send_greeting"]
    assert d.kind == "min_interval" and d.retry_at == now + timedelta(seconds=floor - 5)


def _failed_result(cid, at, *, action, navigation, outbound):
    return validate_command_result(
        {
            "command_id": cid,
            "action": action,
            "execution_mode": "execute",
            "status": "failed",
            "reason": "timeout",
            "observed": {"before": [], "after": []},
            "evidence": [],
            "navigation_performed": navigation,
            "outbound_action_performed": outbound,
            "externally_visible_side_effect": outbound,
            "executed_at": None,
            "reported_at": at.isoformat(),
        }
    )


def _failed(clock, at, *, action, navigation, outbound):
    cmd = validate_command(make_command(action, clock=clock))
    res = _failed_result(str(cmd.command_id), at, action=action, navigation=navigation, outbound=outbound)
    return LedgerCommand(command=cmd, state="failed", result=res, delivery="pending", received_at=at, updated_at=at)


def test_check_rate_counts_outbound_only_except_search():
    clock = ManualClock(datetime(2026, 10, 4, 10, 0, tzinfo=UTC))
    policy = validate_policy(make_policy(daily_limits={k: 1 for k in HARD_DAILY_CAPS}))
    now = clock.now()
    earlier = now - timedelta(hours=1)
    # 只导航过的失败不计入对外动作的上限
    nav_only = [_failed(clock, earlier, action="send_greeting", navigation=True, outbound=False)]
    assert check_rate("send_greeting", now=now, history=nav_only, policy=policy).allowed
    sent = [_failed(clock, earlier, action="send_greeting", navigation=True, outbound=True)]
    assert check_rate("send_greeting", now=now, history=sent, policy=policy).kind == "daily_cap"
    # 搜索没有对外动作，动过界面就计入
    cid = "00000000-0000-4000-8000-00000000abcd"
    searched = _failed_result(cid, earlier, action="search_candidates", navigation=True, outbound=False)
    assert write_flags.counts_toward_limit(searched)
    untouched = _failed_result(cid, earlier, action="search_candidates", navigation=False, outbound=False)
    assert not write_flags.counts_toward_limit(untouched)


def test_check_rate_day_boundary_uses_policy_timezone():
    # 上海时间 2026-10-04 23:30 执行；上海次日 00:10 时计数归零
    sh = make_policy(daily_limits={k: 1 for k in HARD_DAILY_CAPS}, work_hours={"timezone": "Asia/Shanghai", "windows": []})
    policy = validate_policy(sh)
    clock = ManualClock(datetime(2026, 10, 4, 15, 30, tzinfo=UTC))
    hist = [_executed(clock, clock.now())]
    later = clock.now() + timedelta(minutes=40)
    assert check_rate("send_greeting", now=later, history=hist, policy=policy).allowed
    # 用 UTC 划分则仍是同一天 → 达到上限
    utc_policy = validate_policy(make_policy(daily_limits={k: 1 for k in HARD_DAILY_CAPS}))
    assert check_rate("send_greeting", now=later, history=hist, policy=utc_policy).kind == "daily_cap"


def test_policy_timezone_fallback():
    assert policy_timezone(None) is UTC
    bad = validate_policy(make_policy(work_hours={"timezone": "Not/AZone", "windows": []}))
    assert policy_timezone(bad) is UTC


# ---------------------------------------------------------------------------
# GUI 锁
# ---------------------------------------------------------------------------


def test_gui_lock_basic_and_non_reentrant():
    lock = GuiLock()
    with lock.hold(ACTION) as ok:
        assert ok and lock.holder == ACTION
        with pytest.raises(RuntimeError):
            lock.acquire(OBSERVE, timeout=0)
    assert lock.holder is None
    with pytest.raises(RuntimeError):
        lock.release()
    with pytest.raises(ValueError):
        lock.acquire("other", timeout=0)  # type: ignore[arg-type]


def test_gui_lock_action_has_priority_over_observe():
    lock = GuiLock()
    holder_release = threading.Event()
    holder_has = threading.Event()
    order: list[str] = []

    def hold_observe():
        with lock.hold(OBSERVE) as ok:
            assert ok
            holder_has.set()
            holder_release.wait(2)

    def want_action():
        with lock.hold(ACTION) as ok:
            order.append("action" if ok else "action-failed")

    t1 = threading.Thread(target=hold_observe)
    t1.start()
    assert holder_has.wait(2)
    t2 = threading.Thread(target=want_action)
    t2.start()
    wait_until(lambda: lock.actions_waiting == 1)
    # 有动作在排队时，观察拿不到执行权（即使稍后锁空出来，也轮不到它）
    got = []
    t3 = threading.Thread(target=lambda: got.append(lock.acquire(OBSERVE, timeout=0)))
    t3.start()
    t3.join(2)
    assert got == [False]
    holder_release.set()
    t1.join(2)
    t2.join(2)
    assert order == ["action"]
    assert lock.holder is None and lock.actions_waiting == 0


def test_gui_lock_release_by_other_thread_refused():
    lock = GuiLock()
    assert lock.acquire(ACTION)
    err = []

    def other():
        try:
            lock.release()
        except RuntimeError as e:
            err.append(e)

    t = threading.Thread(target=other)
    t.start()
    t.join(2)
    assert err and lock.holder == ACTION
    lock.release()


# ---------------------------------------------------------------------------
# 只读守卫
# ---------------------------------------------------------------------------


def test_guard_execute_splits_navigation_and_outbound():
    clock = ManualClock()
    inner = RecordingDriver(clock)
    g = GuardedDriver(inner, mode="execute")
    g.state()
    g.bind_window()
    assert g.screen_ok() and not g.navigated and not g.outbound_performed
    g.click(Locator(text="会话"))
    g.scroll(None, "down", 1)
    g.type_text(None, "搜索词")  # 块外输入（如搜索框）记为导航
    assert g.navigation_calls == 3 and not g.outbound_performed
    with g.outbound():
        g.type_text(None, "你好")
        g.key("return")
    assert g.outbound_calls == 2 and g.navigation_calls == 3 and len(inner.writes) == 5


def test_guard_verify_allows_navigation_blocks_input_and_outbound():
    inner = RecordingDriver(ManualClock())
    g = GuardedDriver(inner, mode="verify")
    g.click(Locator(text="会话"))
    g.scroll(None, "down", 1)
    for call in (lambda: g.type_text(None, "x"), lambda: g.key("return")):
        with pytest.raises(ReadOnlyViolation):
            call()
    with pytest.raises(ReadOnlyViolation):
        with g.outbound():
            g.click(Locator(text="发送"))
    assert [c.method for c in inner.writes] == ["click", "scroll"]
    assert g.navigation_calls == 2 and g.outbound_calls == 0


def test_guard_read_only_blocks_all_writes_and_screenshot(tmp_path: Path):
    inner = RecordingDriver(ManualClock())
    g = GuardedDriver(inner, mode="read_only")
    for call in (
        lambda: g.click(Locator(text="发送")),
        lambda: g.type_text(None, "x"),
        lambda: g.key("return"),
        lambda: g.scroll(None, "down", 1),
    ):
        with pytest.raises(ReadOnlyViolation):
            call()
    with pytest.raises(ReadOnlyViolation):
        GuardedDriver(inner, mode="execute").screenshot_region(Frame(x=0, y=0, w=1, h=1), tmp_path / "a.png")
    assert inner.writes == [] and g.navigation_calls == 0 and g.outbound_calls == 0


def test_guard_cancel_interrupts_until_first_outbound():
    inner = RecordingDriver(ManualClock())
    cancelled = False
    g = GuardedDriver(inner, mode="execute", cancelled=lambda: cancelled)
    g.click(Locator(text="会话"))
    cancelled = True
    with pytest.raises(CommandCancelled):
        g.click(Locator(text="另一个会话"))
    with pytest.raises(CommandCancelled):
        with g.outbound():
            pass
    assert len(inner.writes) == 1
    # 对外动作已经发生后不再打断（回报实际结果）
    g2 = GuardedDriver(inner, mode="execute", cancelled=lambda: cancelled)
    cancelled = False
    with g2.outbound():
        g2.click(Locator(text="发送"))
        cancelled = True
        g2.key("return")
    g2.scroll(None, "down", 1)
    assert g2.outbound_calls == 2 and g2.navigation_calls == 1


def test_exec_context_outbound_and_cancel_flag():
    clock = ManualClock()
    g = GuardedDriver(RecordingDriver(clock), mode="execute", cancelled=lambda: True)
    ctx = ExecContext(
        account_id=ACCOUNT, device_id=DEVICE, mode="local", allowed_actions=frozenset(), deadline=clock.now(), guard=g
    )
    assert ctx.cancel_requested()
    with pytest.raises(CommandCancelled):
        with ctx.outbound():
            pass
    bare = ExecContext(account_id=ACCOUNT, device_id=DEVICE, mode="local", allowed_actions=frozenset(), deadline=clock.now())
    assert not bare.cancel_requested()
    with pytest.raises(RuntimeError):
        bare.outbound()


# ---------------------------------------------------------------------------
# 时钟、事件、写标记
# ---------------------------------------------------------------------------


def test_manual_clock():
    c = ManualClock(datetime(2026, 1, 1, tzinfo=UTC))
    c.sleep(5)
    c.sleep(0)
    assert c.now() == datetime(2026, 1, 1, 0, 0, 5, tzinfo=UTC) and c.sleeps == [5, 0]
    with pytest.raises(ValueError):
        c.advance(-1)
    with pytest.raises(ValueError):
        ManualClock(datetime(2026, 1, 1))


def test_system_clock_wake_interrupts_sleep():
    c = SystemClock()
    assert c.now().tzinfo is not None
    c.sleep(0)
    t = threading.Timer(0.01, c.wake)
    t.start()
    t0 = time.monotonic()
    c.sleep(5)  # 被 wake 提前唤醒
    assert time.monotonic() - t0 < 4


def test_make_event_valid_and_deduplicates_by_bucket():
    now = datetime(2026, 10, 4, 1, 0, 10, tzinfo=UTC)
    payload = {"reason": "user_request", "by": "user"}
    e1 = make_event("device_paused", device_id=DEVICE, account_id=ACCOUNT, payload=payload, observed_at=now)
    e2 = make_event("device_paused", device_id=DEVICE, account_id=ACCOUNT, payload=payload, observed_at=now + timedelta(seconds=20))
    e3 = make_event("device_paused", device_id=DEVICE, account_id=ACCOUNT, payload=payload, observed_at=now + timedelta(minutes=2))
    assert e1.event_id == e2.event_id != e3.event_id
    with pytest.raises(ValueError):
        make_event("device_paused", device_id=DEVICE, account_id=ACCOUNT, payload={"reason": "nope", "by": "user"}, observed_at=now)


def test_write_flags():
    ar = ActionResult(status="failed", reason="timeout")
    nav_only = {"navigation_performed": True, "outbound_action_performed": False, "externally_visible_side_effect": False}
    assert write_flags.merged(ar, navigated=True, outbound_done=False, verify_only=False) == nav_only
    assert write_flags.merged(ar, navigated=False, outbound_done=True, verify_only=False) == {
        "navigation_performed": False,
        "outbound_action_performed": True,
        "externally_visible_side_effect": True,
    }
    # verify_only：处理器错报对外动作也被清掉；导航与对方可见如实保留
    declared = ar.model_copy(update=write_flags.flags(navigation=True, outbound=True))
    assert write_flags.merged(declared, navigated=False, outbound_done=False, verify_only=True) == {
        "navigation_performed": True,
        "outbound_action_performed": False,
        "externally_visible_side_effect": True,
    }
    assert write_flags.outbound(ar) is False and write_flags.outbound(declared) is True
    assert write_flags.none() == write_flags.flags() == {
        "navigation_performed": False,
        "outbound_action_performed": False,
        "externally_visible_side_effect": False,
    }


def test_write_flags_outbound_implies_visible():
    for nav in (False, True):
        for out in (False, True):
            for vis in (False, True):
                f = write_flags.flags(navigation=nav, outbound=out, visible=vis)
                assert not f["outbound_action_performed"] or f["externally_visible_side_effect"]
                ar = ActionResult(status="failed", reason="timeout", **f)
                m = write_flags.merged(ar, navigated=nav, outbound_done=out, verify_only=False)
                assert not m["outbound_action_performed"] or m["externally_visible_side_effect"]


# ---------------------------------------------------------------------------
# 内存账本（Ledger 替身本身也要可信）
# ---------------------------------------------------------------------------


def test_in_memory_ledger_idempotent_put_and_transitions():
    clock = ManualClock()
    led = InMemoryLedger()
    cmd = validate_command(make_command(clock=clock))
    rec, created = led.put_command(cmd, received_at=clock.now())
    assert created and rec.state == CommandState.QUEUED
    rec2, created2 = led.put_command(cmd, received_at=clock.now() + timedelta(seconds=1))
    assert not created2 and rec2.received_at == rec.received_at
    led.transition_command(cmd.command_id, CommandState.RUNNING, at=clock.now())
    with pytest.raises(IllegalTransition):
        led.transition_command(cmd.command_id, CommandState.QUEUED, at=clock.now())
    with pytest.raises(ValueError):
        led.transition_command(cmd.command_id, CommandState.SUCCEEDED, at=clock.now())  # 缺 result
    with pytest.raises(KeyError):
        led.get_command(UUID(int=9)) or led.transition_command(UUID(int=9), CommandState.RUNNING, at=clock.now())
    res = ActionResult(status="succeeded", executed_at=clock.now()).to_command_result(cmd, reported_at=clock.now())
    led.transition_command(cmd.command_id, CommandState.SUCCEEDED, at=clock.now(), result=res)
    assert led.pending_results() == [res]
    led.mark_result_delivered(cmd.command_id)
    led.mark_result_delivered(cmd.command_id)  # 重复无副作用
    assert led.pending_results() == []


def test_in_memory_ledger_outbox_cursor():
    clock = ManualClock()
    led = InMemoryLedger()
    evs = [
        make_event("device_paused", device_id=DEVICE, account_id=ACCOUNT, payload={"reason": "user_request", "by": "user"}, observed_at=clock.now() + timedelta(minutes=i))
        for i in range(3)
    ]
    assert [led.append_event(e, at=clock.now()) for e in evs] == [True, True, True]
    assert led.append_event(evs[0], at=clock.now()) is False
    assert led.outbox_cursor() == 0
    led.mark_events_delivered([evs[0].event_id, evs[2].event_id])
    assert led.outbox_cursor() == 1
    assert [e.event.event_id for e in led.pending_events()] == [evs[1].event_id]
    st = led.load_state()
    st.paused = True
    st.pause_reason = "user_request"
    assert led.load_state().paused is False  # 返回的是副本
    led.save_state(st)
    assert led.load_state().paused is True
