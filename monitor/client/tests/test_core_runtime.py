"""运行时：暂停语义、心跳、观察调度、策略刷新、令牌吊销、补发 ack、事件补传。"""

from __future__ import annotations

from datetime import timedelta
from itertools import pairwise

import pytest
from monitor_contracts import ActionResult, DriverTimeoutError, WindowLostError

from monitor.core.client import ClaimResponse
from monitor.core.events import make_event
from monitor.core.gui_lock import ACTION
from monitor.core.runtime import RuntimeConfig
from monitor.core.testing import ACCOUNT, DEVICE, ScriptedHandler, ScriptedObserver, make_env, make_policy


def _ev(env, kind, payload, minutes=0):
    return make_event(
        kind, device_id=DEVICE, account_id=ACCOUNT, payload=payload, observed_at=env.clock.now() + timedelta(minutes=minutes)
    )


# ---------------------------------------------------------------------------
# 暂停：停止领取与启动新动作，不中断回传
# ---------------------------------------------------------------------------


def test_user_pause_stops_claiming_but_keeps_reporting():
    env = make_env()
    c1, c2 = env.cmd(), env.cmd()
    env.server.enqueue(c1)
    env.server.fail("result", 500, times=1)
    env.run_until(lambda: env.ledger.list_commands() and env.ledger.list_commands()[0].result is not None)
    env.runtime.pause("user_request", by="user")
    env.server.enqueue(c2)
    for _ in range(5):
        env.run()
        env.clock.advance(31)
    # 暂停期间：c1 的结果仍补传成功、心跳照发并带 paused；c2 没被领取
    assert c1["command_id"] in env.server.results
    assert env.server.queue[0]["command_id"] == c2["command_id"]
    assert env.server.heartbeats[-1]["paused"] is True
    assert env.server.heartbeats[-1]["pause_reason"] == "user_request"
    assert any(e["kind"] == "device_paused" for e in env.server.events.values())

    env.runtime.resume()
    env.run_until(lambda: c2["command_id"] in env.server.results)


def test_queued_command_not_started_while_paused():
    env = make_env()
    env.runtime.pause("user_request", by="user")
    c1 = env.cmd()
    from monitor_contracts import validate_command

    env.runtime.handle_claim(
        ClaimResponse(commands=(validate_command(c1),), cancellations=(), lease_seconds=60, server_time=env.clock.now())
    )
    for _ in range(3):
        env.run()
    assert env.handlers["send_greeting"].run_calls == []
    assert env.server.acks[-1]["ledger_state"] == "queued"  # 入账后照常 ack
    env.runtime.resume()
    env.run_until(lambda: c1["command_id"] in env.server.results)


def test_server_pause_and_resume_via_heartbeat():
    env = make_env()
    env.server.paused = True
    env.run()
    assert env.runtime.state.paused and env.runtime.state.pause_reason == "server_request"
    env.server.paused = False
    env.clock.advance(31)
    env.run()
    assert not env.runtime.state.paused


def test_server_unpause_does_not_clear_local_pause():
    env = make_env()
    env.runtime.pause("user_request", by="user")
    env.server.paused = False
    env.run()
    env.clock.advance(31)
    env.run()
    assert env.runtime.state.paused and env.runtime.state.pause_reason == "user_request"


def test_pause_twice_keeps_first_reason_and_resume_noop():
    env = make_env()
    env.runtime.resume()  # 未暂停时无副作用
    env.runtime.pause("login_required", by="monitor")
    env.runtime.pause("user_request", by="user")
    assert env.runtime.state.pause_reason == "login_required"
    assert env.ledger.load_state().paused is True


# ---------------------------------------------------------------------------
# 观察调度：动作优先，默认 45 秒，可配
# ---------------------------------------------------------------------------


def _observe_times(env, obs, seconds, step=1.0):
    times = []
    end = env.clock.now() + timedelta(seconds=seconds)
    while env.clock.now() < end:
        n = len(obs.calls)
        env.run()
        if len(obs.calls) > n:
            times.append(env.clock.now())
        env.clock.advance(step)
    return times


def test_observe_default_period_45s():
    obs = ScriptedObserver()
    env = make_env(observer=obs)
    times = _observe_times(env, obs, 200)
    gaps = {round((b - a).total_seconds()) for a, b in pairwise(times)}
    assert gaps == {45}


def test_observe_period_configurable():
    obs = ScriptedObserver()
    env = make_env(observer=obs, observe_interval=10)
    times = _observe_times(env, obs, 60)
    gaps = {round((b - a).total_seconds()) for a, b in pairwise(times)}
    assert gaps == {10}


def test_actions_take_priority_over_observation():
    obs = ScriptedObserver()
    env = make_env(observer=obs)
    env.run()  # 首轮观察
    n = len(obs.calls)
    env.clock.advance(60)  # 观察已到期
    c1 = env.cmd()
    from monitor_contracts import validate_command

    env.runtime.handle_claim(
        ClaimResponse(commands=(validate_command(c1),), cancellations=(), lease_seconds=60, server_time=env.clock.now())
    )
    env.run()  # 这一轮执行指令，不观察
    assert len(env.handlers["send_greeting"].run_calls) == 1 and len(obs.calls) == n
    env.run()
    assert len(obs.calls) == n + 1


def test_observe_skipped_when_gui_lock_busy():
    obs = ScriptedObserver()
    env = make_env(observer=obs)
    import threading

    hold = threading.Event()
    got = threading.Event()

    def holder():
        with env.runtime.gui_lock.hold(ACTION):
            got.set()
            hold.wait(2)

    t = threading.Thread(target=holder)
    t.start()
    assert got.wait(2)
    env.run()
    assert obs.calls == []
    hold.set()
    t.join(2)
    env.clock.advance(46)
    env.run()
    assert len(obs.calls) == 1


def test_observer_events_go_to_outbox_and_server():
    obs = ScriptedObserver()
    env = make_env(observer=obs)
    ev = _ev(env, "device_paused", {"reason": "anomaly", "by": "monitor"}, minutes=7)
    obs._scripts = [[ev]]
    env.run_until(lambda: ev.event_id in env.server.events, advance=46)


def test_observer_login_events_pause_and_resume():
    obs = ScriptedObserver()
    env = make_env(observer=obs)
    lr = make_event("login_required", device_id=DEVICE, account_id=ACCOUNT, payload={"reason": "logged_out", "mode": "local"}, observed_at=env.clock.now())
    ok = make_event("login_ok", device_id=DEVICE, account_id=ACCOUNT, payload={"mode": "local"}, observed_at=env.clock.now() + timedelta(minutes=5))
    obs._scripts = [[lr], [ok]]
    env.run_until(lambda: env.runtime.state.paused, advance=46)
    assert env.runtime.state.pause_reason == "login_required" and env.runtime.client_state == "login_required"
    # 登录失效时仍继续只读观察，看到 login_ok 后恢复
    env.run_until(lambda: not env.runtime.state.paused, advance=46)
    assert env.runtime.client_state == "running"


def test_observer_blocked_dialog_pauses_anomaly():
    obs = ScriptedObserver()
    env = make_env(observer=obs)
    ev = make_event(
        "blocked_by_dialog",
        device_id=DEVICE,
        account_id=ACCOUNT,
        payload={"dialog_kind": "risk_warning", "dialog_text": "操作频繁", "buttons": ["知道了"]},
        observed_at=env.clock.now(),
    )
    obs._scripts = [[ev]]
    env.run_until(lambda: env.runtime.state.paused, advance=46)
    assert env.runtime.state.pause_reason == "anomaly"


@pytest.mark.parametrize("exc,code,state", [(WindowLostError("x"), "window_lost", "not_running"), (DriverTimeoutError("x"), "timeout", "unknown"), (RuntimeError("x"), "observe_failed", "unknown")])
def test_observer_errors_recorded_not_fatal(exc, code, state):
    class Boom(ScriptedObserver):
        def observe(self, driver, baseline):
            raise exc

    env = make_env(observer=Boom())
    env.run()
    assert env.runtime.last_error.code == code and env.runtime.client_state == state
    env.clock.advance(31)
    env.run()
    assert env.server.heartbeats[-1]["last_error"]["code"] == code


def test_observer_may_navigate_but_not_type():
    """观察用 verify 守卫：允许点击切页签（导航），禁止输入与按键。"""
    from monitor_contracts import Locator

    class Navigator(ScriptedObserver):
        def observe(self, driver, baseline):
            driver.click(Locator(text="新招呼"))
            return super().observe(driver, baseline)

    env = make_env(observer=Navigator())
    env.run()
    assert [w.method for w in env.driver.writes] == ["click"]
    assert env.runtime.state.baseline.established

    class Typer(ScriptedObserver):
        def observe(self, driver, baseline):
            driver.type_text(Locator(text="搜索"), "x")
            return []

    env = make_env(observer=Typer())
    env.run()
    assert env.driver.writes == [] and env.runtime.last_error.code == "driver_error"


def test_observer_attach_receives_device_id_and_reporter():
    class Attachable(ScriptedObserver):
        def attach(self, *, device_id=None, report=None):
            self.device_id, self.report = device_id, report

    obs = Attachable()
    env = make_env(observer=obs)
    assert obs.device_id == env.runtime.config.device_id
    obs.report("unsupported_presentation", "测试", "conversation_list")
    assert env.runtime.last_error.code == "unsupported_presentation"


def test_first_baseline_carries_bound_account():
    obs = ScriptedObserver()
    env = make_env(observer=obs)
    env.run()
    assert obs.calls[0].account_id == env.runtime.account_id is not None


def test_observer_that_cannot_establish_keeps_needs_baseline():
    class Unsure(ScriptedObserver):
        def observe(self, driver, baseline):
            self.calls.append(baseline)
            return []  # 读不出，不置 established

    obs = Unsure()
    env = make_env(observer=obs, baseline_ready=False)
    env.server.enqueue(env.cmd())
    for _ in range(4):
        env.run()
        env.clock.advance(1)
    assert env.runtime.state.needs_baseline is True
    assert env.server.count("claim") == 0


def test_without_observer_baseline_cleared_and_claims():
    env = make_env(baseline_ready=False)
    c1 = env.cmd()
    env.server.enqueue(c1)
    env.run_until(lambda: c1["command_id"] in env.server.results)
    assert env.runtime.state.needs_baseline is False


# ---------------------------------------------------------------------------
# 领取前提：绑定、策略、账户确认、令牌
# ---------------------------------------------------------------------------


def test_no_claim_without_binding():
    env = make_env(bind=False)
    for _ in range(3):
        env.run()
    assert env.server.count("claim") == 0 and env.server.count("policy") == 0
    assert env.server.heartbeats[-1]["account_id"] is None


def test_no_claim_when_account_not_confirmed():
    env = make_env()
    env.server.account_confirmed = False
    for _ in range(3):
        env.run()
    assert env.server.count("claim") == 0


def test_no_claim_without_policy_and_error_recorded():
    env = make_env(policy=None)
    env.server.policy = None
    for _ in range(3):
        env.run()
    assert env.server.count("claim") == 0
    assert env.runtime.last_error.code == "policy_unavailable"


def test_policy_refreshed_when_version_changes():
    env = make_env()
    env.run()
    assert env.runtime.policy.policy_version == 1
    env.server.policy = make_policy(policy_version=2, allowed_actions=[])
    env.clock.advance(31)
    env.run()
    assert env.runtime.policy.policy_version == 2 and env.runtime.policy.allowed_actions == []
    assert env.server.count("policy") == 2


def test_revoked_token_stops_all_server_traffic():
    env = make_env()
    env.server.token = "rotated_token"
    env.run()
    n = len(env.server.requests)
    for _ in range(3):
        env.clock.advance(31)
        env.run()
    assert env.runtime.revoked and len(env.server.requests) == n
    assert env.runtime.status()["revoked"] is True


def test_invalid_command_reported_via_last_error():
    env = make_env()
    from monitor.core.client import InvalidCommand
    from monitor_contracts import FieldError

    env.runtime.handle_claim(
        ClaimResponse(
            commands=(),
            cancellations=(),
            lease_seconds=60,
            server_time=env.clock.now(),
            invalid=(InvalidCommand(0, "abc", (FieldError("payload.text", "太短", "min_length"),)),),
        )
    )
    assert env.runtime.last_error.code == "invalid_command"


def test_ack_retried_after_failure():
    env = make_env()
    c1 = env.cmd()
    env.server.enqueue(c1)
    env.server.fail("ack", 503, times=1)
    env.run_until(lambda: any(a["command_id"] == c1["command_id"] for a in env.server.acks), advance=2)
    assert env.server.count("ack") >= 2


def test_rejected_event_is_parked_not_resent():
    env = make_env()
    ev = _ev(env, "device_paused", {"reason": "anomaly", "by": "monitor"}, minutes=3)
    env.ledger.append_event(ev, at=env.clock.now())
    env.server.reject_event_ids.add(ev.event_id)
    env.run()
    posts = env.server.count("events")
    for _ in range(3):
        env.clock.advance(31)
        env.run()
    assert env.server.count("events") == posts == 1
    assert env.runtime.last_error.code == "event_rejected"
    assert env.ledger.pending_events()[0].event.event_id == ev.event_id


def test_rejected_result_is_parked():
    env = make_env()
    c1 = env.cmd()
    env.server.enqueue(c1)
    env.server.fail("result", 404, times=1)
    env.run_until(lambda: env.server.count("result") == 1)
    for _ in range(3):
        env.clock.advance(31)
        env.run()
    assert env.server.count("result") == 1 and env.runtime.last_error.code == "result_rejected"


def test_heartbeat_reports_queue_and_clears_sent_error():
    env = make_env()
    env.runtime.record_error("demo_error", "演示")
    env.run()
    hb = env.server.heartbeats[-1]
    assert hb["last_error"]["code"] == "demo_error"
    assert set(hb["queue"]) == {"queued_commands", "undelivered_results", "outbox_events"}
    env.clock.advance(31)
    env.run()
    assert env.server.heartbeats[-1]["last_error"] is None
    assert env.runtime.status()["last_error"]["code"] == "demo_error"  # 状态窗口仍显示最近异常


def test_heartbeat_period_and_claim_wait_bounded():
    env = make_env(heartbeat_interval=30)
    env.run()
    first = env.server.count("heartbeat")
    env.clock.advance(10)
    env.run()
    assert env.server.count("heartbeat") == first
    waits = [r.body["wait_seconds"] for r in env.server.requests if r.route == "claim"]
    assert waits[-1] <= 20  # 不会长轮询到错过下一次心跳
    env.clock.advance(21)
    env.run()
    assert env.server.count("heartbeat") == first + 1


def test_unknown_handler_action_is_unsupported():
    env = make_env(handlers=[ScriptedHandler("send_greeting")])
    c1 = env.cmd("request_resume")
    env.server.enqueue(c1)
    env.run_until(lambda: c1["command_id"] in env.server.results)
    assert env.server.results[c1["command_id"]]["reason"] == "unsupported"


def test_handler_bad_result_falls_back_conservatively():
    def wrong(command, driver, ctx):
        from monitor_contracts import Locator

        driver.click(Locator(text="发送"))
        # 违反契约：cancelled 却声明了对外动作
        return ActionResult(status="cancelled", outbound_action_performed=True, externally_visible_side_effect=True)

    env = make_env(handlers=[ScriptedHandler("send_greeting", run=wrong)])
    c1 = env.cmd()
    env.server.enqueue(c1)
    env.run_until(lambda: c1["command_id"] in env.server.results)
    res = env.server.results[c1["command_id"]]
    assert res["status"] == "unknown" and res["reason"] == "driver_error"
    assert env.runtime.last_error.code == "handler_contract"


def test_handler_exception_recorded():
    def boom(command, driver, ctx):
        raise KeyError("bug")

    env = make_env(handlers=[ScriptedHandler("send_greeting", run=boom)])
    c1 = env.cmd()
    env.server.enqueue(c1)
    env.run_until(lambda: c1["command_id"] in env.server.results)
    assert env.server.results[c1["command_id"]]["status"] == "failed"
    assert env.runtime.last_error.code == "handler_error"


def test_dependency_waits_for_local_predecessor():
    env = make_env()
    c1 = env.cmd()
    c2 = env.cmd("request_resume", depends_on=c1["command_id"])
    from monitor_contracts import validate_command

    env.runtime.pause("user_request", by="user")
    # 服务端一般不会同时下发，这里直接入账检验本地顺序：c2 必须等 c1 成功
    env.runtime.handle_claim(
        ClaimResponse(commands=(validate_command(c2), validate_command(c1)), cancellations=(), lease_seconds=60, server_time=env.clock.now())
    )
    env.runtime.resume()
    env.run_until(lambda: c2["command_id"] in env.server.results)
    order = [r for r in env.server.result_posts]
    assert order.index(c1["command_id"]) < order.index(c2["command_id"])
    assert env.server.results[c2["command_id"]]["status"] == "succeeded"


# ---------------------------------------------------------------------------
# 配置、循环、状态
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "kw",
    [{"heartbeat_interval": 0}, {"observe_interval": -1}, {"claim_wait_seconds": 31}, {"local_allowed_actions": frozenset({"provide_input"})}],
)
def test_runtime_config_validation(kw):
    with pytest.raises(ValueError):
        RuntimeConfig(device_id=DEVICE, **kw)


def test_local_allowlist_narrows_policy():
    env = make_env(local_allowed_actions=frozenset({"request_resume"}))
    c1 = env.cmd()
    env.server.enqueue(c1)
    env.run_until(lambda: c1["command_id"] in env.server.results)
    assert env.server.results[c1["command_id"]]["reason"] == "action_not_allowed"


def test_run_forever_sleeps_on_clock_and_stops():
    env = make_env()
    rt = env.runtime
    sleeps = []

    def sleep(s):
        sleeps.append(s)
        env.clock.advance(s)
        if len(sleeps) >= 3:
            rt.stop()

    env.clock.sleep = sleep
    rt.run_forever()
    assert len(sleeps) == 3 and all(s > 0 for s in sleeps)


def test_status_snapshot():
    env = make_env()
    env.run()
    st = env.runtime.status()
    assert st["mode"] == "local" and st["account_id"] == ACCOUNT and st["online"] is True
    assert st["paused"] is False and st["current_action"] is None


def test_status_includes_outbox_last_error_and_current_command():
    seen = {}

    def run(cmd, driver, ctx):
        seen["st"] = env.runtime.status()  # 执行中（运行时线程）读状态
        with ctx.outbound():
            driver.click(None)
        return ActionResult(status="succeeded")

    env = make_env(handlers=[ScriptedHandler("send_greeting", run=run)])
    st = env.runtime.status()
    assert st["device_id"] == DEVICE and st["monitor_version"] == env.runtime.config.monitor_version
    assert st["current_command_id"] is None and st["current_started_at"] is None
    assert st["last_error"] is None and st["outbox_events"] == 0
    env.runtime.record_error("demo_error", "示例错误", scene="greeting")
    env.runtime._emit("device_paused", {"reason": "user_request", "by": "user"}, env.clock.now())
    st = env.runtime.status()
    assert st["last_error"]["code"] == "demo_error" and st["last_error"]["message"] == "示例错误"
    assert st["last_error"]["scene"] == "greeting" and st["last_error"]["at"] == env.clock.now()
    assert st["outbox_events"] == 1
    c = env.cmd()
    env.server.enqueue(c)
    env.run_until(lambda: "st" in seen)
    cur = seen["st"]
    assert cur["current_command_id"] == c["command_id"] and cur["current_action"] == "send_greeting"
    assert cur["current_started_at"] is not None


# ---------------------------------------------------------------------------
# 窗口挂起（suspend_gui / resume_gui）
# ---------------------------------------------------------------------------


class _ClosedWindowObserver(ScriptedObserver):
    """窗口归还后，界面调用会抛 window_lost（GateDriver 的行为）。"""

    def __init__(self) -> None:
        super().__init__()
        self.window_open = True

    def observe(self, driver, baseline):
        if not self.window_open:
            self.calls.append(baseline)
            raise WindowLostError("窗口已归还")
        return super().observe(driver, baseline)


def test_suspend_gui_stops_observe_execute_and_keeps_real_error():
    obs = _ClosedWindowObserver()
    env = make_env(observer=obs)
    rt = env.runtime
    env.run()
    observed = len(obs.calls)
    assert observed == 1 and rt.client_state == "unknown"
    rt.record_error("bootstrap_takeover", "引导失败")  # 尚未随心跳发出的真实错误
    rt.suspend_gui("时段外")
    obs.window_open = False
    c = env.cmd()
    env.server.enqueue(c)
    for _ in range(4):
        env.clock.advance(46)
        env.run()
    st = rt.status()
    assert st["gui_suspended"] is True and st["gui_suspend_reason"] == "时段外"
    assert len(obs.calls) == observed  # 不观察
    assert env.handlers["send_greeting"].run_calls == []  # 不执行
    assert env.server.queue and env.server.queue[0]["command_id"] == c["command_id"]  # 不领取
    assert rt.last_error.code == "bootstrap_takeover"  # 没被 window_lost 覆盖
    sent = [hb["last_error"]["code"] for hb in env.server.heartbeats if hb["last_error"]]
    assert sent == ["bootstrap_takeover"]
    assert env.server.heartbeats[-1]["client_state"] == "unknown"  # 契约没有 suspended，如实报 unknown
    assert env.server.heartbeats[-1]["paused"] is False  # 挂起不是暂停
    # 挂起期间 window_lost 直接上报也不记
    rt.record_error("window_lost", "x")
    assert rt.last_error.code == "bootstrap_takeover"

    obs.window_open = True
    rt.resume_gui()
    env.run()
    assert rt.status()["gui_suspended"] is False
    assert len(obs.calls) == observed + 1  # 恢复后立即观察一次
    env.run_until(lambda: c["command_id"] in env.server.results)
    assert env.handlers["send_greeting"].run_calls
    # 恢复后 window_lost 照常是错误
    rt.record_error("window_lost", "真的丢了")
    assert rt.last_error.code == "window_lost"


def test_suspend_request_is_queued_until_runtime_thread_applies_it():
    env = make_env(observer=ScriptedObserver())
    rt = env.runtime
    rt.suspend_gui("用户暂停")
    # 还没轮到运行时线程：状态未变，但已到的请求足以让 window_lost 不被记为错误
    assert rt.gui_suspended is False
    rt.record_error("window_lost", "窗口已归还")
    assert rt.last_error is None
    rt.resume_gui()
    rt.suspend_gui("时段外")
    env.run()
    assert rt.gui_suspended and rt.gui_suspend_reason == "时段外"  # 按顺序生效，最后一个为准
    assert env.observer.calls == []


def test_suspend_after_command_picked_leaves_it_queued():
    """窗口归属方持有 GUI 锁归还窗口时，管线拿到锁后再确认一次，指令留在队列不执行。"""
    from monitor_contracts import validate_command

    env = make_env()
    rt = env.runtime
    env.run()  # 拿到策略
    c = env.cmd()
    rt.handle_claim(ClaimResponse(commands=(validate_command(c),), cancellations=(), lease_seconds=60, server_time=env.clock.now()))
    rt.suspend_gui("用户暂停")  # 请求已到，尚未生效
    assert rt.pipeline.run_next(rt.gate()) is None
    assert env.handlers["send_greeting"].run_calls == []
    assert env.ledger.list_commands()[0].state == "queued"


def test_suspend_does_not_busy_loop_on_deferred_command():
    env = make_env(observer=ScriptedObserver())
    rt = env.runtime
    env.run()
    rt.suspend_gui("时段外")
    rt.pipeline.wake_at = env.clock.now() - timedelta(seconds=5)  # 有被推迟且已到期的指令
    idle = rt.run_once()
    assert idle > 0


# ---------------------------------------------------------------------------
# 绑定以服务端为准（契约 0.3.3，缺陷 M-1）
# ---------------------------------------------------------------------------


def test_binding_from_heartbeat_ack_is_written_locally_then_claims():
    env = make_env(bind=False, observer=ScriptedObserver())
    rt = env.runtime
    env.run(2)
    assert rt.account_id is None and env.server.count("claim") == 0
    c = env.cmd()
    env.server.enqueue(c)
    env.server.bind(ACCOUNT, confirmed_by="ops_li")
    env.clock.advance(31)
    env.run()  # 心跳回执带绑定：写入本机，要求重建基线
    st = env.ledger.load_state()
    assert st.account_binding is not None and st.account_binding.account_id == ACCOUNT
    assert st.account_binding.confirmed_by == "ops_li"
    assert rt.account_id == ACCOUNT
    assert rt.state.needs_baseline is False  # 同一轮里已用未建立的基线观察（重建）
    assert any(not b.established and b.account_id == ACCOUNT for b in env.observer.calls)
    env.run_until(lambda: c["command_id"] in env.server.results, advance=1)
    env.clock.advance(31)
    env.run()
    assert env.server.heartbeats[-1]["account_id"] == ACCOUNT and rt.account_confirmed is True


def test_same_binding_in_ack_changes_nothing():
    env = make_env(observer=ScriptedObserver())
    rt = env.runtime
    before = env.ledger.load_state().account_binding
    gen = rt.state.baseline.generation
    for _ in range(3):
        env.run()
        env.clock.advance(31)
    assert env.ledger.load_state().account_binding == before
    assert rt.state.baseline.generation == gen and rt.state.needs_baseline is False


def test_account_change_rebaselines_before_any_execution():
    env = make_env(observer=ScriptedObserver())
    rt = env.runtime
    env.run()
    observes = len(env.observer.calls)
    # 本机已入账一条新账户的指令（例如换绑前服务端已下发），换绑后必须先重建基线再执行
    from monitor_contracts import validate_command

    other = env.cmd(account_id="acct_other")
    env.server.bind("acct_other", confirmed_by="ops_li")
    env.server.policy = make_policy(account_id="acct_other")
    env.clock.advance(31)
    rt._next_observe = env.clock.now() + timedelta(hours=1)  # 观察周期还没到：只能因 needs_baseline 而观察
    calls_at_switch: list[int] = []
    orig_run = env.handlers["send_greeting"]._run

    def run(c, d, x):
        calls_at_switch.append(len(env.observer.calls))
        return orig_run(c, d, x)

    env.handlers["send_greeting"]._run = run
    # 换绑前本机已入账一条新账户的指令；本轮心跳换绑后，执行要等基线重建
    rt.handle_claim(
        ClaimResponse(commands=(validate_command(other),), cancellations=(), lease_seconds=60, server_time=env.clock.now())
    )
    env.run()  # 心跳：换账户 → 不执行 → 因 needs_baseline 观察
    assert rt.account_id == "acct_other"
    assert env.handlers["send_greeting"].run_calls == []
    rebuilt = env.observer.calls[observes]
    assert rebuilt.established is False and rebuilt.account_id == "acct_other"
    assert rt.state.baseline.generation == 2 and rt.state.needs_baseline is False
    env.run_until(lambda: other["command_id"] in env.server.results, advance=1)
    assert calls_at_switch and calls_at_switch[0] > observes  # 执行发生在重建基线之后
    assert env.server.results[other["command_id"]]["status"] == "succeeded"


def test_binding_revoked_by_server_stops_claiming():
    env = make_env()
    rt = env.runtime
    env.run()
    assert rt.policy is not None
    env.server.account_binding = None
    c = env.cmd()
    env.server.enqueue(c)
    claims = env.server.count("claim")
    for _ in range(3):
        env.clock.advance(31)
        env.run()
    assert rt.account_id is None and env.ledger.load_state().account_binding is None
    assert rt.policy is None
    assert env.server.count("claim") == claims and env.server.queue[0]["command_id"] == c["command_id"]
    assert env.server.heartbeats[-1]["account_id"] is None
    assert rt.last_error.code == "account_unbound"


def test_ack_without_binding_field_keeps_local_binding():
    """0.3.3 之前的服务端回执没有 account_binding：不能当成"撤销"。"""
    env = make_env()
    env.server.report_binding = False
    env.server.account_binding = None
    for _ in range(3):
        env.run()
        env.clock.advance(31)
    assert env.runtime.account_id == ACCOUNT


def test_console_reconfirm_resumes_account_switched_pause():
    env = make_env(observer=ScriptedObserver())
    rt = env.runtime
    env.run()
    rt.pause("account_switched", by="monitor")
    for _ in range(2):
        env.clock.advance(31)
        env.run()
    assert rt.state.paused  # 绑定没变：继续等
    env.server.bind(ACCOUNT, confirmed_by="ops_li")  # 控制台重新确认（bound_at 变了）
    env.clock.advance(31)
    gen = rt.state.baseline.generation
    env.run()
    assert rt.state.paused is False and rt.state.baseline.generation == gen + 1  # 恢复并重建基线
    assert env.ledger.load_state().account_binding.confirmed_by == "ops_li"


# ---------------------------------------------------------------------------
# 退避期间不空转（缺陷 M-2）
# ---------------------------------------------------------------------------


def test_backoff_idle_waits_until_backoff_ends():
    env = make_env(observer=ScriptedObserver(), max_idle_seconds=600)
    rt = env.runtime
    env.run(2)
    rt._next_observe = env.clock.now() + timedelta(hours=1)
    for _ in range(5):
        env.server.fail("heartbeat", 0, times=1)
    env.clock.advance(31)
    hb_before = env.server.count("heartbeat")
    for expected in (1, 2, 4, 8):
        idle = rt.run_once()  # 心跳失败，进入退避
        assert rt.backoff.next_at is not None
        assert idle == pytest.approx(expected)
        # 退避期内不论跑多少轮都建议等待到退避结束，不再发请求
        assert rt.run_once() == pytest.approx(expected)
        env.clock.advance(idle)
    assert env.server.count("heartbeat") == hb_before + 4
    env.server._failures.clear()
    assert rt.run_once() >= 0 and rt.online is True


def test_revoked_runtime_does_not_spin():
    env = make_env(observer=ScriptedObserver())
    rt = env.runtime
    env.run(2)
    rt._next_observe = env.clock.now() + timedelta(hours=1)
    env.server.token = "rotated_token"
    env.clock.advance(31)
    rt.run_once()
    assert rt.revoked
    assert rt.run_once() > 0


# ---------------------------------------------------------------------------
# 心跳 4xx 不让进程崩溃（缺陷 M-3）
# ---------------------------------------------------------------------------


def test_heartbeat_4xx_records_error_and_retries_with_backoff():
    env = make_env()
    rt = env.runtime
    env.server.fail("heartbeat", 422, times=2)
    rt.run_once()  # 不抛异常
    assert rt.last_error.code == "heartbeat_rejected"
    assert rt.backoff.failures == 1 and rt.backoff.next_at > env.clock.now()
    assert env.server.count("claim") == 0
    env.clock.advance(1)
    rt.run_once()
    assert rt.backoff.failures == 2
    env.clock.advance(2)
    c = env.cmd()
    env.server.enqueue(c)
    env.run_until(lambda: c["command_id"] in env.server.results)
    assert rt.backoff.failures == 0 and rt.revoked is False
    # 被拒的那次错误随下一次成功心跳发出
    assert any((hb["last_error"] or {}).get("code") == "heartbeat_rejected" for hb in env.server.heartbeats)


def test_heartbeat_409_pauses_claims_and_execution_until_accepted():
    env = make_env()
    rt = env.runtime
    env.run()  # 上线、取到策略
    from monitor_contracts import validate_command

    queued = env.cmd()
    rt.handle_claim(ClaimResponse(commands=(validate_command(queued),), cancellations=(), lease_seconds=60, server_time=env.clock.now()))
    env.server.fail("heartbeat", 409, times=3)
    later = env.cmd()
    env.server.enqueue(later)
    env.clock.advance(31)
    rt.run_once()
    assert rt.contract_incompatible and rt.last_error.code == "contract_incompatible"
    assert rt.status()["contract_incompatible"] is True
    claims = env.server.count("claim")
    for step in (1, 2):
        idle = rt.run_once()
        assert idle > 0  # 不空转
        env.clock.advance(idle)
        rt.run_once()
    assert env.handlers["send_greeting"].run_calls == []  # 不执行
    assert env.server.count("claim") == claims  # 不领取
    assert rt.revoked is False
    env.clock.advance(10)
    env.run_until(lambda: later["command_id"] in env.server.results, advance=1)  # 服务端接受心跳后自动恢复
    assert rt.contract_incompatible is False
    assert queued["command_id"] in env.server.results


def test_heartbeat_401_stops_and_records_token_revoked():
    env = make_env()
    rt = env.runtime
    env.server.fail("heartbeat", 401, times=1)
    rt.run_once()
    assert rt.revoked and rt.last_error.code == "token_revoked"
    n = len(env.server.requests)
    for _ in range(3):
        env.clock.advance(31)
        rt.run_once()
    assert len(env.server.requests) == n

