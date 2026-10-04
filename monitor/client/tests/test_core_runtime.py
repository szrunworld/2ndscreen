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
