"""任务 J：bootstrap（重试、时段、防休眠、屏幕操作、remote / local Session）。

fake 2ndscreen CLI、fake caffeinate、ManualClock；不调用真实 2ndscreen，不动用户的 BOSS 窗口。
"""

from __future__ import annotations

import threading
from datetime import UTC, datetime

import pytest
from monitor_contracts import WindowLostError, validate_policy

from monitor.bootstrap import (
    AppAlreadyRunning,
    BootstrapFailed,
    Caffeinate,
    GateDriver,
    LocalSession,
    RemoteSession,
    RetryPolicy,
    RuntimeView,
    ScreenOps,
    StepFailed,
    in_work_hours,
    run_with_retry,
)
from monitor.bootstrap.testing import FakeCli, FakePopen, fail, ok, window_info
from monitor.core import GuiLock, ManualClock
from monitor.core.testing import RecordingDriver, make_policy
from monitor.driver import _cli

NOT_RUNNING = (1, None, "error: 2ndscreen is not running")


# ---------------------------------------------------------------------------
# 重试
# ---------------------------------------------------------------------------


def test_retry_succeeds_after_failures_with_backoff():
    sleeps, reports = [], []
    attempts = iter([StepFailed("a"), StepFailed("b"), "done"])

    def fn():
        x = next(attempts)
        if isinstance(x, Exception):
            raise x
        return x

    out = run_with_retry("remote", fn, policy=RetryPolicy(attempts=5), sleep=sleeps.append,
                         report=lambda c, m: reports.append((c, m)))
    assert out == "done"
    assert sleeps == [2.0, 4.0]
    assert [c for c, _ in reports] == ["bootstrap_remote"] * 2
    assert "第 1/5 次失败" in reports[0][1]


def test_retry_is_bounded_and_reports_every_failure():
    sleeps, reports, calls = [], [], []

    def fn():
        calls.append(1)
        raise _cli.CliFailure(kind="cli_failed", message="2ndscreen is not running")

    with pytest.raises(BootstrapFailed) as info:
        run_with_retry("remote", fn, policy=RetryPolicy(attempts=4, base_seconds=1, max_seconds=3),
                       sleep=sleeps.append, report=lambda c, m: reports.append(m))
    assert len(calls) == 4 and len(reports) == 4
    assert sleeps == [1, 2, 3]  # 封顶 max_seconds
    assert info.value.attempts == 4 and "已停止重试" in str(info.value)


def test_retry_stops_early_when_asked_and_does_not_swallow_bugs():
    with pytest.raises(BootstrapFailed):
        run_with_retry("x", lambda: (_ for _ in ()).throw(StepFailed("s")), policy=RetryPolicy(),
                       sleep=lambda s: None, report=lambda c, m: None, should_stop=lambda: True)
    with pytest.raises(KeyError):  # 程序缺陷不重试
        run_with_retry("x", lambda: {}["k"], policy=RetryPolicy(), sleep=lambda s: None, report=lambda c, m: None)
    with pytest.raises(ValueError):
        RetryPolicy(attempts=0)


# ---------------------------------------------------------------------------
# 工作时段
# ---------------------------------------------------------------------------


def wh(windows, tz="Asia/Shanghai"):
    return validate_policy(make_policy(work_hours={"timezone": tz, "windows": windows})).work_hours


def at(y, mo, d, h, mi):  # 北京时间
    return datetime(y, mo, d, h - 8, mi, tzinfo=UTC) if h >= 8 else datetime(y, mo, d - 1, h + 16, mi, tzinfo=UTC)


def test_work_hours_inside_and_outside():
    hours = wh([{"days": [1, 2, 3, 4, 5], "start": "09:00", "end": "18:00"}])
    # 2026-10-05 是周一
    assert in_work_hours(hours, at(2026, 10, 5, 9, 0))
    assert in_work_hours(hours, at(2026, 10, 5, 17, 59))
    assert not in_work_hours(hours, at(2026, 10, 5, 18, 0))
    assert not in_work_hours(hours, at(2026, 10, 4, 10, 0))  # 周日


def test_work_hours_overnight_and_edge_cases():
    hours = wh([{"days": [5], "start": "22:00", "end": "02:00"}])
    assert in_work_hours(hours, at(2026, 10, 9, 23, 0))  # 周五 23:00
    assert in_work_hours(hours, at(2026, 10, 10, 1, 30))  # 周六 01:30
    assert not in_work_hours(hours, at(2026, 10, 10, 2, 0))
    assert not in_work_hours(wh([]), at(2026, 10, 5, 10, 0))  # 空窗口 = 不接管
    assert not in_work_hours(None, at(2026, 10, 5, 10, 0))
    assert not in_work_hours(wh([{"days": [1], "start": "09:00", "end": "18:00"}], tz="Mars/Base"), at(2026, 10, 5, 10, 0))
    with pytest.raises(ValueError):
        in_work_hours(hours, datetime(2026, 10, 5, 10, 0))


# ---------------------------------------------------------------------------
# caffeinate
# ---------------------------------------------------------------------------


def test_caffeinate_holds_child_tied_to_monitor_pid():
    popen = FakePopen()
    c = Caffeinate(popen=popen, watch_pid=1234)
    assert c.ensure()
    assert popen.procs[0].argv == ["/usr/bin/caffeinate", "-d", "-i", "-s", "-w", "1234"]
    c.start()  # 已在运行：不再起第二个
    assert len(popen.procs) == 1
    c.stop()
    assert popen.procs[0].terminated and not c.alive()


def test_caffeinate_restart_is_bounded():
    popen = FakePopen()
    c = Caffeinate(popen=popen, max_restarts=2)
    c.ensure()
    for _ in range(5):
        popen.procs[-1].returncode = 1  # 意外退出
        c.ensure()
    assert len(popen.procs) == 3  # 首次 + 2 次重启
    assert not c.ensure()
    assert not Caffeinate(popen=FakePopen(fail_with=OSError("no caffeinate"))).ensure()


# ---------------------------------------------------------------------------
# 屏幕操作
# ---------------------------------------------------------------------------


def ops_for(cli: FakeCli, pids=(4242,)) -> ScreenOps:
    return ScreenOps(cli=cli.runner(), screen="monitor", owner_pid=999, pid_resolver=lambda sel: list(pids))


def test_ensure_screen_creates_once_with_owner_and_no_idle_timeout():
    cli = FakeCli()
    ops = ops_for(cli)
    assert ops.ensure_screen() is True
    assert ops.ensure_screen() is False
    [create] = [c for c in cli.calls if c[:2] == ("screen", "create")]
    assert create[create.index("--idle-timeout") + 1] == "0"
    assert create[create.index("--owner-pid") + 1] == "999"


def test_launch_variants():
    cli = FakeCli(responses={"app launch": [
        fail("the app refused to move its window", pid=55, windows=[window_info(55)]),
        fail("com.zhipin.www is already running; pass --new-instance, or use window move"),
        fail("give a bundle ID of an installed app or a path to an .app"),
    ]})
    ops = ops_for(cli)
    assert ops.launch("com.zhipin.www") == 55  # 拒绝改尺寸但窗口已在屏上
    with pytest.raises(AppAlreadyRunning):
        ops.launch("com.zhipin.www")
    with pytest.raises(_cli.CliFailure):
        ops.launch("com.zhipin.www")
    launch = cli.calls[0]
    assert launch[launch.index("--bundle") + 1] == "com.zhipin.www" and "--new-instance" not in launch


def test_move_release_destroy_tolerate_expected_failures():
    cli = FakeCli(responses={
        "window release": [fail('pid 4242 has no matching window on screen "monitor"'), fail("1 window(s) refused to move")],
        "screen destroy": fail('no agent screen named "monitor"'),
        "window move": [fail("1 window(s) refused to move", windows=[window_info(4242)]), fail("pid 1 has no matching on-screen window")],
    })
    ops = ops_for(cli)
    ops.release(4242)  # 已不在本屏：视为成功
    with pytest.raises(_cli.CliFailure):
        ops.release(4242)
    ops.destroy_screen()
    assert ops.move(4242, fit=True)[0].pid == 4242
    assert "--fit-screen" in cli.calls[-1]
    with pytest.raises(_cli.CliFailure):
        ops.move(1)


# ---------------------------------------------------------------------------
# GateDriver
# ---------------------------------------------------------------------------


def test_gate_driver_blocks_when_closed():
    clock = ManualClock()
    inner = RecordingDriver(clock)
    gate = GateDriver(inner)
    with pytest.raises(WindowLostError):
        gate.state()
    with pytest.raises(WindowLostError):
        gate.click(None)
    assert gate.screen_ok() is False
    assert inner.calls == []
    gate.open()
    gate.state()
    assert gate.screen_ok() is True and [c.method for c in inner.calls] == ["state"]
    assert gate.WRITE_METHODS == RecordingDriver.WRITE_METHODS  # 其他属性透传


# ---------------------------------------------------------------------------
# Session 公共夹具
# ---------------------------------------------------------------------------


class SpyLock(GuiLock):
    """记录"有线程开始申请 ACTION"，用于不靠固定等待地断言"正在等锁"。"""

    def __init__(self) -> None:
        super().__init__()
        self.action_requested = threading.Event()

    def acquire(self, use, timeout=None):
        if use == "action" and self.holder is not None:
            self.action_requested.set()
        return super().acquire(use, timeout)


class View:
    def __init__(self, policy=None, paused=(False, None)):
        self.clock = ManualClock(datetime(2026, 10, 5, 2, 0, tzinfo=UTC))  # 北京时间周一 10:00
        self.reports: list[tuple[str, str]] = []
        self.policy = policy
        self.paused = paused
        self.lock = SpyLock()

    def view(self) -> RuntimeView:
        return RuntimeView(report=lambda c, m: self.reports.append((c, m)), policy=lambda: self.policy,
                           pause_state=lambda: self.paused, gui_lock=self.lock, now=self.clock.now,
                           sleep=self.clock.sleep)


def office_policy():
    return validate_policy(make_policy(work_hours={"timezone": "Asia/Shanghai",
                                                   "windows": [{"days": [1, 2, 3, 4, 5], "start": "09:00", "end": "18:00"}]}))


def remote(cli: FakeCli, v: View, *, pids=(4242,), attempts=3, rounds=2):
    driver = RecordingDriver(v.clock)
    popen = FakePopen()
    s = RemoteSession(caffeinate=Caffeinate(popen=popen), ops=ops_for(cli, pids), driver=driver,
                      gate=GateDriver(driver), view=v.view(), bundle_id="com.zhipin.www",
                      retry=RetryPolicy(attempts=attempts), max_rounds=rounds)
    return s, driver, popen


def local(cli: FakeCli, v: View, *, pids=(4242,), attempts=3, rounds=2):
    driver = RecordingDriver(v.clock)
    s = LocalSession(ops=ops_for(cli, pids), driver=driver, gate=GateDriver(driver), view=v.view(),
                     bundle_id="com.zhipin.www", retry=RetryPolicy(attempts=attempts), max_rounds=rounds)
    return s, driver


# ---------------------------------------------------------------------------
# RemoteSession
# ---------------------------------------------------------------------------


def test_remote_start_creates_screen_launches_binds_and_caffeinates():
    cli, v = FakeCli(), View()
    s, driver, popen = remote(cli, v)
    assert s.start() is True
    assert cli.verbs()[:3] == ["screen list", "screen create", "app launch"]
    assert [c.method for c in driver.calls] == ["bind_window"]
    assert driver.calls[0].args["selector"].pid == 4242
    assert s.gate.is_open and s.pid == 4242 and s.state == "ok"
    assert len(popen.procs) == 1 and popen.procs[0].poll() is None
    assert v.reports == []
    s.shutdown()
    assert popen.procs[0].terminated


def test_remote_start_reuses_running_boss_with_window_move():
    cli = FakeCli(responses={"app launch": fail("com.zhipin.www is already running; pass --new-instance, or use window move")})
    v = View()
    s, driver, _ = remote(cli, v, pids=(777,))
    assert s.start()
    move = next(c for c in cli.calls if c[:2] == ("window", "move"))
    assert move[move.index("--pid") + 1] == "777" and "--fill" in move
    assert driver.calls[0].args["selector"].pid == 777


def test_remote_bootstrap_failure_is_bounded_and_reported():
    cli = FakeCli(responses={"screen list": NOT_RUNNING})
    v = View()
    s, driver, _ = remote(cli, v, attempts=3, rounds=2)
    assert s.start() is False
    assert s.state == "failed" and s.rounds_failed == 1 and not s.gate.is_open
    assert [c for c, _ in v.reports] == ["bootstrap_remote"] * 3
    assert v.clock.sleeps == [2.0, 4.0]  # 退避经可控时钟，没有真实 sleep
    # 下一轮由 tick 触发；用尽 max_rounds 后不再尝试
    for _ in range(5):
        v.clock.advance(60)
        s.tick(v.clock.now())
    assert s.rounds_failed == 2 and s.gave_up
    assert cli.count("screen list") == 6  # 2 轮 × 3 次，没有无限循环
    assert "等待人工点『重试』" in v.reports[-1][1]
    assert driver.calls == []
    s.reset_budget()
    assert not s.gave_up and s.state == "starting"


def test_remote_tick_rebootstraps_when_window_lost():
    cli, v = FakeCli(), View()
    s, driver, _ = remote(cli, v)
    assert s.start()
    driver.screen_ok = lambda: False  # 窗口丢了
    v.clock.advance(31)
    s.tick(v.clock.now())
    assert cli.count("app launch") == 2
    # 健康时只检查不重启
    driver.screen_ok = lambda: True
    v.clock.advance(31)
    s.tick(v.clock.now())
    assert cli.count("app launch") == 2


def test_remote_bind_failure_retried():
    cli, v = FakeCli(), View()
    s, driver, _ = remote(cli, v)
    calls = []

    def flaky_bind(selector=None):
        calls.append(selector)
        if len(calls) < 2:
            raise WindowLostError("窗口还没出现")
        return None

    driver.bind_window = flaky_bind
    assert s.start()
    assert len(calls) == 2
    assert "绑定窗口" in v.reports[0][1]


# ---------------------------------------------------------------------------
# LocalSession
# ---------------------------------------------------------------------------


def test_local_takes_over_in_work_hours_and_releases_after():
    cli, v = FakeCli(), View(policy=office_policy())
    s, driver = local(cli, v)
    s.start()
    assert cli.calls == []  # 启动时不碰窗口
    s.tick(v.clock.now())
    assert s.held and s.state == "held"
    move = next(c for c in cli.calls if c[:2] == ("window", "move"))
    assert "--fit-screen" in move and move[move.index("--pid") + 1] == "4242"
    assert driver.calls[0].method == "bind_window"
    assert cli.count("app launch") == 0  # local 从不启动用户的 BOSS
    # 北京时间 18:00 之后归还
    v.clock.advance(8 * 3600 + 60)
    s.tick(v.clock.now())
    assert not s.held and s.state == "released"
    rel = next(c for c in cli.calls if c[:2] == ("window", "release"))
    assert rel[rel.index("--pid") + 1] == "4242"


@pytest.mark.parametrize("reason", ["user_request", "login_required", "account_switched"])
def test_local_releases_when_paused(reason):
    cli, v = FakeCli(), View(policy=office_policy())
    s, _ = local(cli, v)
    s.tick(v.clock.now())
    assert s.held
    v.paused = (True, reason)
    v.clock.advance(31)
    s.tick(v.clock.now())
    assert not s.held and cli.count("window release") == 1


def test_local_keeps_window_during_anomaly_pause_and_without_policy_never_takes():
    cli, v = FakeCli(), View(policy=office_policy(), paused=(True, "anomaly"))
    s, _ = local(cli, v)
    s.tick(v.clock.now())
    assert s.held  # 异常暂停仍允许只读观察
    cli2, v2 = FakeCli(), View(policy=None)
    s2, _ = local(cli2, v2)
    s2.tick(v2.clock.now())
    assert not s2.held and cli2.calls == []


def test_local_boss_not_running_is_reported_not_launched():
    cli, v = FakeCli(), View(policy=office_policy())
    s, driver = local(cli, v, pids=(), attempts=2, rounds=1)
    s.tick(v.clock.now())
    assert not s.held and s.state == "failed" and s.gave_up
    assert all(c == "bootstrap_takeover" for c, _ in v.reports)
    assert "BOSS 未运行" in v.reports[0][1]
    assert cli.count("app launch") == 0 and cli.count("window move") == 0
    v.clock.advance(60)
    s.tick(v.clock.now())  # 预算用尽：不再尝试
    assert len([r for r in v.reports if "第" in r[1]]) == 2


def test_local_bind_failure_after_move_gives_window_back():
    cli, v = FakeCli(), View(policy=office_policy())
    s, driver = local(cli, v, attempts=1, rounds=1)

    def bad_bind(selector=None):
        raise WindowLostError("绑定失败")

    driver.bind_window = bad_bind
    s.tick(v.clock.now())
    assert not s.held and cli.count("window release") == 1


def test_local_release_failure_is_bounded_and_explained():
    cli = FakeCli(responses={"window release": fail("1 window(s) refused to move")})
    v = View(policy=office_policy())
    s, _ = local(cli, v, attempts=2, rounds=5)
    s.tick(v.clock.now())
    v.paused = (True, "user_request")
    v.clock.advance(31)
    s.tick(v.clock.now())
    assert s.state == "release_failed" and not s.gate.is_open  # 闸门先关，运行时碰不到窗口
    assert "退出 Monitor" in s.detail
    assert cli.count("window release") == 2


def test_local_release_now_from_another_thread_waits_for_gui_lock():
    cli, v = FakeCli(), View(policy=office_policy())
    s, _ = local(cli, v)
    s.tick(v.clock.now())
    assert s.held
    holding = threading.Event()
    release = threading.Event()

    def action():  # 模拟正在执行的动作持有 GUI 锁
        with v.lock.hold("action"):
            holding.set()
            release.wait(5)

    t_action = threading.Thread(target=action)
    t_action.start()
    holding.wait(5)
    t_release = threading.Thread(target=s.release_now)
    t_release.start()
    assert v.lock.action_requested.wait(5)  # 归还线程已在等 GUI 锁
    assert not s.gate.is_open or cli.count("window release") == 0
    assert cli.count("window release") == 0  # 动作结束前不动窗口
    release.set()
    t_action.join(5)
    t_release.join(5)
    assert cli.count("window release") == 1 and not s.held
    # 用户暂停期间即使在时段内也不重新接管；恢复后重新接管
    s.tick(v.clock.now())
    assert not s.held
    s.resume_hold()
    s.tick(v.clock.now())
    assert s.held


def test_local_shutdown_releases_and_destroys_screen():
    cli, v = FakeCli(), View(policy=office_policy())
    s, _ = local(cli, v)
    s.tick(v.clock.now())
    s.shutdown()
    assert cli.count("window release") == 1 and cli.count("screen destroy") == 1
    assert cli.screens == set()


def test_session_snapshot_shape():
    cli, v = FakeCli(), View()
    s, _, _ = remote(cli, v)
    s.start()
    assert s.snapshot() == {"window_held": True, "boss_pid": 4242, "session_state": "ok", "session_detail": "BOSS pid 4242"}
    assert ok()[0] == 0
