"""方案第七节"关键异常"表：每行至少一个测试（fake server + fake handler + 可控时钟）。

另含任务验收的几条硬性要求：kill -9 后写方法只调用一次、回传 500 后补传不重做、
上限触发 failed(rate_limited) 不调用 driver、verify_only 不受上限与白名单约束且不写。
"""

from __future__ import annotations

from datetime import timedelta
from uuid import UUID

import pytest
from monitor_contracts import ActionResult, CommandState, Locator

from monitor.core.testing import (
    ACCOUNT,
    ScriptedHandler,
    ScriptedObserver,
    make_env,
    make_policy,
)


class SimulatedKill(BaseException):
    """模拟 kill -9：不是 Exception，管线不会捕获，账本停在当时的状态。"""


def _rec(env, cid):
    return env.ledger.get_command(UUID(cid))


# ---------------------------------------------------------------------------
# 行 1：动作成功，回传失败 → 保存结果，稍后补传，不重做 GUI 动作
# ---------------------------------------------------------------------------


def test_result_500_then_redelivered_without_redo():
    env = make_env()
    cmd = env.cmd()
    env.server.enqueue(cmd)
    env.server.fail("result", 500, times=3)

    env.run_until(lambda: _rec(env, cmd["command_id"]) is not None and _rec(env, cmd["command_id"]).result is not None)
    # 回传失败三次，结果仍保存在账本，delivery=pending
    for _ in range(3):
        env.run()
        env.clock.advance(env.runtime.backoff.delay() + 0.001)
    env.run_until(lambda: cmd["command_id"] in env.server.results, advance=1)

    rec = _rec(env, cmd["command_id"])
    assert rec.state == CommandState.SUCCEEDED
    assert rec.delivery == "delivered"
    assert len(env.driver.writes) == 1
    assert env.handlers["send_greeting"].run_calls == [UUID(cmd["command_id"])]
    # 失败 3 次 + 成功 1 次，且每次都用同一个 Idempotency-Key
    posts = [r for r in env.server.requests if r.route == "result"]
    assert len(posts) == 4
    assert {r.headers["idempotency-key"] for r in posts} == {f"result:{cmd['command_id']}"}


def test_result_network_error_backs_off_exponentially():
    env = make_env()
    cmd = env.cmd()
    env.server.enqueue(cmd)
    env.server.fail("result", 0, times=4)  # 0 = 网络错误
    env.run_until(lambda: _rec(env, cmd["command_id"]) is not None and _rec(env, cmd["command_id"]).result is not None)

    delays = []
    for _ in range(4):
        env.run()
        delays.append(env.runtime.backoff.delay())
        # 退避期内不再发起任何服务端请求
        before = len(env.server.requests)
        env.run()
        assert len(env.server.requests) == before
        env.clock.advance(env.runtime.backoff.delay() + 0.001)
    assert delays == [1.0, 2.0, 4.0, 8.0]
    assert env.runtime.online is False
    env.run_until(lambda: cmd["command_id"] in env.server.results, advance=1)
    assert env.runtime.online is True
    assert len(env.driver.writes) == 1


# ---------------------------------------------------------------------------
# 行 2：点击后进程崩溃，结果未知 → 重启后重新观察；仍无法确认则 unknown，
#       停止自动重试，依赖该指令的后续指令不执行
# ---------------------------------------------------------------------------


def _crashing_run(command, driver, ctx):
    driver.click(Locator(text="发送"))
    raise SimulatedKill()


def test_kill9_after_click_writes_once_and_ends_unknown():
    greet = ScriptedHandler("send_greeting", run=_crashing_run)  # verify 默认返回"无法判断"
    resume = ScriptedHandler("request_resume")
    env = make_env(handlers=[greet, resume])
    c1 = env.cmd("send_greeting")
    c2 = env.cmd("request_resume", depends_on=c1["command_id"])
    env.server.enqueue(c1)

    with pytest.raises(SimulatedKill):
        env.run_until(lambda: False)
    assert _rec(env, c1["command_id"]).state == CommandState.RUNNING
    assert len(env.driver.writes) == 1

    # 重启：同一账本、同一 Driver。服务端此时又把依赖它的 c2 交下来（模拟服务端误判）
    env.new_runtime()
    env.server.enqueue(c2)
    env.run_until(lambda: _rec(env, c2["command_id"]) is not None and _rec(env, c2["command_id"]).result is not None)
    env.run_until(lambda: c2["command_id"] in env.server.results)

    r1 = _rec(env, c1["command_id"])
    assert r1.state == CommandState.UNKNOWN
    assert r1.result.reason == "crash_recovery"
    assert r1.result.gui_write_performed is True
    assert greet.verify_calls == [UUID(c1["command_id"])]
    # 同一 command_id 的写方法总共只调用一次（崩溃前那一次）
    assert len(env.driver.writes) == 1
    r2 = _rec(env, c2["command_id"])
    assert r2.state == CommandState.FAILED and r2.result.reason == "dependency_not_satisfied"
    assert resume.run_calls == []
    assert env.server.results[c1["command_id"]]["status"] == "unknown"


def test_kill9_recovery_confirms_success_without_redo():
    def verify_done(command, driver, ctx):
        driver.state()
        return ActionResult(status="succeeded", executed_at=ctx.clock())

    greet = ScriptedHandler("send_greeting", run=_crashing_run, verify=verify_done)
    env = make_env(handlers=[greet])
    c1 = env.cmd()
    env.server.enqueue(c1)
    with pytest.raises(SimulatedKill):
        env.run_until(lambda: False)

    env.new_runtime()
    env.run_until(lambda: c1["command_id"] in env.server.results)
    r1 = _rec(env, c1["command_id"])
    assert r1.state == CommandState.SUCCEEDED
    assert any(f.code == "crash_recovery" for f in r1.result.observed.after)
    assert len(env.driver.writes) == 1
    assert len(greet.run_calls) == 1


def test_kill9_recovery_confirms_not_happened_does_not_retry():
    def verify_not_done(command, driver, ctx):
        return ActionResult(status="failed", reason="verification_failed")

    greet = ScriptedHandler("send_greeting", run=_crashing_run, verify=verify_not_done)
    env = make_env(handlers=[greet])
    c1 = env.cmd()
    env.server.enqueue(c1)
    with pytest.raises(SimulatedKill):
        env.run_until(lambda: False)
    env.new_runtime()
    env.run_until(lambda: c1["command_id"] in env.server.results)
    r1 = _rec(env, c1["command_id"])
    assert r1.state == CommandState.FAILED and r1.result.reason == "verification_failed"
    assert len(greet.run_calls) == 1 and len(env.driver.writes) == 1


def test_kill9_after_result_persisted_only_redelivers():
    """结果已落账但还没回传时被杀：重启后只补传，不复核、不重做。"""
    env = make_env()
    c1 = env.cmd()
    env.server.enqueue(c1)
    env.server.fail("result", 0, times=1)
    env.run_until(lambda: _rec(env, c1["command_id"]) is not None and _rec(env, c1["command_id"]).result is not None)
    assert c1["command_id"] not in env.server.results

    env.new_runtime()
    env.run_until(lambda: c1["command_id"] in env.server.results, advance=1)
    assert env.handlers["send_greeting"].verify_calls == []
    assert len(env.driver.writes) == 1


def test_handler_driver_error_after_write_is_unknown():
    from monitor_contracts import WindowLostError

    def click_then_lose(command, driver, ctx):
        driver.click(Locator(text="发送"))
        raise WindowLostError("窗口没了")

    env = make_env(handlers=[ScriptedHandler("send_greeting", run=click_then_lose)])
    c1 = env.cmd()
    env.server.enqueue(c1)
    env.run_until(lambda: c1["command_id"] in env.server.results)
    res = env.server.results[c1["command_id"]]
    assert res["status"] == "unknown" and res["reason"] == "driver_error" and res["gui_write_performed"] is True


def test_handler_driver_error_before_write_is_failed():
    from monitor_contracts import DriverTimeoutError

    def timeout(command, driver, ctx):
        driver.state()
        raise DriverTimeoutError("读取超时")

    env = make_env(handlers=[ScriptedHandler("send_greeting", run=timeout)])
    c1 = env.cmd()
    env.server.enqueue(c1)
    env.run_until(lambda: c1["command_id"] in env.server.results)
    res = env.server.results[c1["command_id"]]
    assert res["status"] == "failed" and res["reason"] == "driver_error" and res["gui_write_performed"] is False


# ---------------------------------------------------------------------------
# 行 3：指令重复送达 → 返回已有结果
# ---------------------------------------------------------------------------


def test_duplicate_delivery_returns_existing_result():
    env = make_env()
    c1 = env.cmd()
    env.server.enqueue(c1)
    env.run_until(lambda: c1["command_id"] in env.server.results)
    first = env.server.results[c1["command_id"]]

    env.server.enqueue(c1)  # 租约过期后服务端重新交付同一条
    env.run_until(lambda: env.server.result_posts.count(c1["command_id"]) == 2)
    assert env.server.results[c1["command_id"]] == first
    assert len(env.handlers["send_greeting"].run_calls) == 1
    assert len(env.driver.writes) == 1
    acks = [a for a in env.server.acks if a["command_id"] == c1["command_id"]]
    assert [a["ledger_state"] for a in acks] == ["queued", "succeeded"]


# ---------------------------------------------------------------------------
# 行 4：登录失效、验证码、未知弹窗、目标歧义 → 暂停相应执行，上报原因；不点任何未知控件
# ---------------------------------------------------------------------------


def _blocked(reason):
    def run(command, driver, ctx):
        driver.state()  # 只读界面，发现阻断后不点击
        return ActionResult(status="failed", reason=reason, reason_detail="界面出现阻断")

    return run


@pytest.mark.parametrize(
    "reason,pause_reason,event_kind",
    [
        ("login_required", "login_required", "login_required"),
        ("captcha", "anomaly", "blocked_by_dialog"),
        ("unknown_dialog", "anomaly", "blocked_by_dialog"),
    ],
)
def test_blocking_anomaly_pauses_and_reports(reason, pause_reason, event_kind):
    env = make_env(handlers=[ScriptedHandler("send_greeting", run=_blocked(reason))])
    c1, c2 = env.cmd(), env.cmd()
    env.server.enqueue(c1)
    env.server.enqueue(c2)
    env.run_until(lambda: c1["command_id"] in env.server.results)
    env.run_until(lambda: len(env.server.events) >= 2, advance=1)

    assert env.server.results[c1["command_id"]]["reason"] == reason
    assert env.runtime.state.paused and env.runtime.state.pause_reason == pause_reason
    kinds = {e["kind"] for e in env.server.events.values()}
    assert {event_kind, "device_paused"} <= kinds
    assert env.driver.writes == []
    # 暂停后不再领取 c2
    for _ in range(5):
        env.run()
        env.clock.advance(31)
    assert env.server.queue and env.server.queue[0]["command_id"] == c2["command_id"]
    assert env.server.heartbeats[-1]["paused"] is True


def test_ambiguous_target_fails_command_without_pausing():
    env = make_env(handlers=[ScriptedHandler("send_greeting", run=_blocked("target_ambiguous"))])
    c1, c2 = env.cmd(), env.cmd()
    env.server.enqueue(c1)
    env.server.enqueue(c2)
    env.run_until(lambda: c2["command_id"] in env.server.results)
    assert env.server.results[c1["command_id"]]["reason"] == "target_ambiguous"
    assert env.runtime.state.paused is False
    assert env.driver.writes == []


# ---------------------------------------------------------------------------
# 行 5：排队时被取消 → 不执行，返回 cancelled
# ---------------------------------------------------------------------------


def test_cancel_while_queued():
    env = make_env()
    env.runtime.pause("user_request", by="user")  # 先让指令停在队列里
    c1 = env.cmd()
    rt = env.runtime
    from monitor.core.client import ClaimResponse
    from monitor_contracts import validate_command

    rt.handle_claim(
        ClaimResponse(commands=(validate_command(c1),), cancellations=(), lease_seconds=60, server_time=env.clock.now())
    )
    env.server.cancellations.add(c1["command_id"])
    env.clock.advance(31)
    env.run_until(lambda: c1["command_id"] in env.server.results)
    res = env.server.results[c1["command_id"]]
    assert res["status"] == "cancelled" and res["executed_at"] is None and res["gui_write_performed"] is False
    assert env.handlers["send_greeting"].run_calls == []


# ---------------------------------------------------------------------------
# 行 6：取消到达时动作已发生 → 回报实际结果
# ---------------------------------------------------------------------------


def test_cancel_after_action_reports_actual_result():
    env = make_env()
    c1 = env.cmd()
    env.server.enqueue(c1)
    env.server.fail("result", 500, times=1)
    env.run_until(lambda: _rec(env, c1["command_id"]) is not None and _rec(env, c1["command_id"]).result is not None)
    env.server.cancellations.add(c1["command_id"])  # 取消晚到
    env.clock.advance(31)
    env.run_until(lambda: c1["command_id"] in env.server.results, advance=1)
    assert env.server.results[c1["command_id"]]["status"] == "succeeded"
    assert _rec(env, c1["command_id"]).state == CommandState.SUCCEEDED


# ---------------------------------------------------------------------------
# 行 7：指令过期 → 不执行，返回 expired
# ---------------------------------------------------------------------------


def test_expired_command_not_executed():
    env = make_env()
    c1 = env.cmd(ttl_seconds=5)
    env.runtime.pause("user_request", by="user")
    from monitor.core.client import ClaimResponse
    from monitor_contracts import validate_command

    env.runtime.handle_claim(
        ClaimResponse(commands=(validate_command(c1),), cancellations=(), lease_seconds=60, server_time=env.clock.now())
    )
    env.clock.advance(10)
    env.runtime.resume()
    env.run_until(lambda: c1["command_id"] in env.server.results)
    res = env.server.results[c1["command_id"]]
    assert res["status"] == "expired" and res["executed_at"] is None
    assert env.handlers["send_greeting"].run_calls == [] and env.driver.calls == []


# ---------------------------------------------------------------------------
# 行 8：用户切换账户 → 停止执行，等待重新绑定
# ---------------------------------------------------------------------------


def test_account_switch_stops_until_rebind():
    env = make_env(handlers=[ScriptedHandler("send_greeting", run=_blocked("account_mismatch"))], observer=ScriptedObserver())
    c1, c2 = env.cmd(), env.cmd()
    env.server.enqueue(c1)
    env.server.enqueue(c2)
    env.run_until(lambda: c1["command_id"] in env.server.results)
    assert env.runtime.state.paused and env.runtime.state.pause_reason == "account_switched"
    observes = len(env.observer.calls)
    for _ in range(4):
        env.run()
        env.clock.advance(50)
    assert env.server.queue[0]["command_id"] == c2["command_id"]  # 没有继续领取
    assert len(env.observer.calls) == observes  # 换账户期间也不观察

    env.handlers["send_greeting"]._run = lambda c, d, x: ActionResult(status="succeeded", executed_at=x.clock())
    env.runtime.bind_account(ACCOUNT, confirmed_by="user")
    assert env.runtime.state.paused is False and env.runtime.state.needs_baseline is True
    env.run_until(lambda: c2["command_id"] in env.server.results, advance=1)
    # 重新绑定后先重建基线（observer 收到未建立的基线）再领取
    assert env.observer.calls[observes].established is False


def test_command_for_other_account_fails_without_driver():
    env = make_env()
    env.runtime.pause("user_request", by="user")
    from monitor.core.client import ClaimResponse
    from monitor_contracts import validate_command

    c1 = env.cmd(account_id="acct_other")
    env.runtime.handle_claim(
        ClaimResponse(commands=(validate_command(c1),), cancellations=(), lease_seconds=60, server_time=env.clock.now())
    )
    env.runtime.resume()
    env.run_until(lambda: c1["command_id"] in env.server.results)
    assert env.server.results[c1["command_id"]]["reason"] == "account_mismatch"
    assert env.driver.calls == []


# ---------------------------------------------------------------------------
# 行 9：离线超过 24 小时 → 上线后先重建观察基线，再领取指令
# ---------------------------------------------------------------------------


def test_offline_over_24h_rebaselines_before_claiming():
    obs = ScriptedObserver()
    env = make_env(observer=obs)
    env.run(2)  # 正常在线一会儿
    assert env.runtime.state.needs_baseline is False
    claims_before = env.server.count("claim")

    for route in ("heartbeat", "claim", "result", "events", "policy", "ack"):
        env.server.fail(route, 0, times=10_000)
    # 25 小时完全连不上（每轮把时钟推过退避期）
    end = env.clock.now() + timedelta(hours=25)
    while env.clock.now() < end:
        env.run()
        env.clock.advance(max(env.runtime.backoff.delay(), 1) + 1)
    assert env.runtime.online is False
    env.server._failures.clear()

    env.server.enqueue(env.cmd())
    n_obs = len(obs.calls)
    claims_at_reconnect = env.server.count("claim")
    env.run()  # 第一次连上：心跳成功 → 离线检测置 needs_baseline → 同一轮里先重建基线，不领取
    assert [b.established for b in obs.calls[n_obs:]] == [False]
    assert env.server.count("claim") == claims_at_reconnect
    assert env.runtime.state.needs_baseline is False
    assert env.runtime.state.baseline.generation == 2
    env.run_until(lambda: len(env.server.results) == 1, advance=1)
    assert env.server.count("claim") > claims_at_reconnect > claims_before - 1


def test_restart_after_25h_down_requires_baseline():
    obs = ScriptedObserver()
    env = make_env(observer=obs)
    env.run(3)
    claims = env.server.count("claim")
    assert claims >= 1
    env.clock.advance(25 * 3600)
    env.new_runtime()
    env.runtime.start()
    assert env.runtime.state.needs_baseline is True
    env.run()  # 心跳 + 重建基线，不领取
    assert env.server.count("claim") == claims
    assert obs.calls[-1].established is False
    assert env.server.heartbeats[-1]["needs_baseline"] is True
    env.run_until(lambda: not env.runtime.state.needs_baseline)
    env.run()
    assert env.server.count("claim") == claims + 1


# ---------------------------------------------------------------------------
# 验收：上限触发 failed(rate_limited) 且不调用 driver
# ---------------------------------------------------------------------------


def test_daily_cap_returns_rate_limited_without_driver():
    limits = make_policy()["daily_limits"] | {"send_greeting": 1}
    env = make_env(policy=make_policy(daily_limits=limits))
    c1, c2 = env.cmd(), env.cmd()
    env.server.enqueue(c1)
    env.server.enqueue(c2)
    env.run_until(lambda: c2["command_id"] in env.server.results)
    assert env.server.results[c1["command_id"]]["status"] == "succeeded"
    res2 = env.server.results[c2["command_id"]]
    assert res2["status"] == "failed" and res2["reason"] == "rate_limited" and res2["gui_write_performed"] is False
    assert len(env.driver.writes) == 1
    assert len(env.handlers["send_greeting"].run_calls) == 1  # 第二条根本没进处理器


def test_policy_cannot_loosen_hard_cap():
    from monitor.core.limits import HARD_DAILY_CAPS

    limits = make_policy()["daily_limits"] | {"send_greeting": 86400}
    env = make_env(policy=make_policy(daily_limits=limits))
    cap = HARD_DAILY_CAPS["send_greeting"]
    cmds = [env.cmd(ttl_seconds=86000) for _ in range(cap + 1)]
    for c in cmds:
        env.server.enqueue(c)
    env.run_until(lambda: cmds[-1]["command_id"] in env.server.results, max_rounds=20 * len(cmds), advance=40)
    statuses = [env.server.results[c["command_id"]]["status"] for c in cmds]
    assert statuses.count("succeeded") == cap
    assert env.server.results[cmds[-1]["command_id"]]["reason"] == "rate_limited"
    assert len(env.driver.writes) == cap


def test_min_interval_defers_then_runs():
    from monitor.core.limits import MIN_INTERVAL_FLOORS

    env = make_env()
    c1, c2 = env.cmd(), env.cmd()
    env.server.enqueue(c1)
    env.server.enqueue(c2)
    env.run_until(lambda: c1["command_id"] in env.server.results)
    t1 = env.clock.now()
    env.run_until(lambda: c2["command_id"] in env.server.results, max_rounds=200, advance=1)
    floor = MIN_INTERVAL_FLOORS["send_greeting"]
    assert env.server.results[c2["command_id"]]["status"] == "succeeded"
    assert (env.clock.now() - t1).total_seconds() >= floor


def test_min_interval_past_expiry_is_rate_limited():
    env = make_env()
    c1 = env.cmd()
    c2 = env.cmd(ttl_seconds=5)
    env.server.enqueue(c1)
    env.server.enqueue(c2)
    env.run_until(lambda: c2["command_id"] in env.server.results)
    assert env.server.results[c2["command_id"]]["reason"] == "rate_limited"
    assert len(env.driver.writes) == 1


def test_whitelist_off_fails_without_calling_handler():
    env = make_env(policy=make_policy(allowed_actions=[]))
    c1 = env.cmd()
    env.server.enqueue(c1)
    env.run_until(lambda: c1["command_id"] in env.server.results)
    assert env.server.results[c1["command_id"]]["reason"] == "action_not_allowed"
    assert env.handlers["send_greeting"].run_calls == [] and env.driver.calls == []


# ---------------------------------------------------------------------------
# 验收：verify_only 不受上限与白名单约束，且不调用写方法
# ---------------------------------------------------------------------------


def test_verify_only_ignores_limits_and_whitelist_and_never_writes():
    def sneaky_verify(command, driver, ctx):
        driver.state()
        try:
            driver.click(Locator(text="发送"))  # 守卫必须拦下
        except Exception:
            pass
        return ActionResult(status="succeeded", executed_at=ctx.clock())

    limits = make_policy()["daily_limits"] | {"send_greeting": 0}
    env = make_env(
        policy=make_policy(allowed_actions=[], daily_limits=limits),
        handlers=[ScriptedHandler("send_greeting", verify=sneaky_verify)],
    )
    cmds = [env.cmd(execution_mode="verify_only") for _ in range(3)]
    for c in cmds:
        env.server.enqueue(c)
    env.run_until(lambda: all(c["command_id"] in env.server.results for c in cmds))
    for c in cmds:
        res = env.server.results[c["command_id"]]
        assert res["status"] == "succeeded" and res["execution_mode"] == "verify_only"
        assert res["gui_write_performed"] is False
    assert env.driver.writes == []
    assert env.handlers["send_greeting"].run_calls == []
    assert len(env.handlers["send_greeting"].verify_calls) == 3


def test_kill9_with_fixture_fake_driver_clicks_once():
    """同一验收用 C 的 FakeDriver 回放真实夹具：求简历按钮的 click 总共只发生一次。"""
    from pathlib import Path

    from monitor.driver import FakeDriver

    fixture = Path(__file__).resolve().parents[2] / "fixtures/ax/conversation_detail/fixture.json"
    button = Locator(text="求简历", role="AXStaticText")

    def click_then_die(command, driver, ctx):
        driver.state()
        driver.click(button)
        raise SimulatedKill()

    def verify_reads_only(command, driver, ctx):
        driver.state()
        return ActionResult(status="unknown", reason="timeout", reason_detail="夹具里看不出请求是否发出")

    handler = ScriptedHandler("request_resume", run=click_then_die, verify=verify_reads_only)
    env = make_env(handlers=[handler], driver=None)
    fake = FakeDriver(fixture, clock=env.clock.now)
    fake.goto(1)
    env.driver = fake
    env.new_runtime()
    c1 = env.cmd("request_resume")
    env.server.enqueue(c1)
    with pytest.raises(SimulatedKill):
        env.run_until(lambda: False)
    assert fake.count("click") == 1

    env.new_runtime()  # 重启
    env.run_until(lambda: c1["command_id"] in env.server.results)
    assert fake.count("click") == 1
    assert len(fake.writes) == 1
    assert env.server.results[c1["command_id"]]["status"] == "unknown"
    assert env.server.results[c1["command_id"]]["reason"] == "crash_recovery"
