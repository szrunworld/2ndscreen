"""混沌测试（进程内部分）：回报 500 后补传、重复送达、排队中与执行中取消、指令过期、离线超过 24 小时、
服务端重启、租约过期未 ack 重新领取。执行中被杀（真子进程 os._exit）见 test_chaos_kill.py。

每个场景都断言 FakeDriver 收到的对外动作类写调用与预期**完全一致**（Screen.outbound()），
即任何重试、重放、重启都不会让同一个对外动作发生第二次。
"""

from __future__ import annotations

from datetime import timedelta

from integration_kit import (
    CANDIDATE,
    Screen,
    World,
    at_local,
    boss_new_greeting,
    case_stage,
    reach_new_greeting,
    server_cmd,
)
from monitor.bootstrap.app import CancellationWatcher, MonitorApp
from monitor.core import CommandClient
from monitor_contracts import CommandState, DeliveryState

FULL = ["greeting_type", "greeting_send", "resume_request"]


def _flow(w: World, **kw):
    fake = boss_new_greeting(w.clock)
    screen = Screen(fake)
    m = w.bound_monitor(screen, **kw)
    reach_new_greeting(w, fake, m)
    return m, fake, screen


def _finish(w: World, m) -> None:
    m.run_until(lambda: case_stage(w) == "resume_requested", what="流程到 resume_requested")
    m.run_until(lambda: m.results_pending() == 0 and m.events_pending() == 0, what="全部回传")


# ---------------------------------------------------------------------------
# 回报失败后补传
# ---------------------------------------------------------------------------


def test_result_500_then_redelivered_without_redoing_gui(w: World):
    """回报接口连续 3 次 500（请求没到服务端）：结果留在本机账本，退避后补传，不重做界面动作。"""
    m, _, screen = _flow(w)
    w.cluster.fail("/result", times=3)
    _finish(w, m)
    assert w.cluster.count("/result", status=500) == 3
    assert screen.outbound() == FULL
    for action in ("send_greeting", "request_resume"):
        rec = server_cmd(w, action)
        assert rec["server_status"] == "succeeded"
        led = m.ledger_command(rec["command"]["command_id"])
        assert led.state == CommandState.SUCCEEDED and led.delivery == DeliveryState.DELIVERED


def test_result_recorded_but_response_lost_is_redelivered_idempotently(w: World):
    """服务端已落库、响应丢失（500）：补传同一个结果，服务端按幂等返回，不判冲突，不重做。"""
    m, _, screen = _flow(w)
    w.cluster.fail("/result", kind="lose_response", times=2)
    _finish(w, m)
    assert screen.outbound() == FULL
    assert m.runtime.last_error is None or m.runtime.last_error.code != "result_conflict"
    greet = server_cmd(w, "send_greeting")
    assert greet["server_status"] == "succeeded"
    # 同一条指令的结果请求发了不止一次，但服务端只有一个结果
    assert w.cluster.count(f"/commands/{greet['command']['command_id']}/result") >= 2


def test_server_unreachable_for_minutes_then_everything_delivered(w: World):
    """问候点完发送后服务端整个不可达 10 分钟：结果与事件都留在本机，恢复后补传，流程继续。"""
    m, fake, screen = _flow(w)

    def outage(rec, scr):
        if rec.kind == "greeting_send":
            w.cluster.down = True

    screen.hooks.append(outage)
    m.run_until(lambda: w.cluster.down, what="问候发出")
    m.run_until(lambda: m.ledger.pending_results(), what="结果落账")
    end = w.clock.now() + timedelta(minutes=10)
    m.run_until(lambda: w.clock.now() >= end, max_rounds=500, what="断网 10 分钟")
    assert server_cmd(w, "send_greeting")["server_status"] == "acked"  # 服务端还不知道结果
    assert m.results_pending() == 1
    w.cluster.down = False
    _finish(w, m)
    assert screen.outbound() == FULL


# ---------------------------------------------------------------------------
# 重复送达
# ---------------------------------------------------------------------------


def test_duplicate_delivery_returns_existing_result(w: World):
    """网络层把已完成指令的领取响应又送了一次：按 command_id 去重，回报已有结果，不重做。"""
    m, _, screen = _flow(w)
    _finish(w, m)
    resume = server_cmd(w, "request_resume")
    cid = resume["command"]["command_id"]
    before = w.cluster.count(f"/commands/{cid}/result")
    w.cluster.fail("commands:claim", kind="replay", times=1)
    for _ in range(6):
        w.clock.advance(30)
        m.run(2)
    assert w.cluster.count(f"/commands/{cid}/result") == before + 1  # 回报已有结果
    assert server_cmd(w, "request_resume")["result"] == resume["result"]  # 服务端结果不变
    assert screen.outbound() == FULL
    assert m.runtime.last_error is None or m.runtime.last_error.code != "result_conflict"


# ---------------------------------------------------------------------------
# 取消
# ---------------------------------------------------------------------------


def test_cancel_while_queued_on_device(w: World):
    """问候已领取、入账，用户随即在状态窗口点了暂停；控制台取消 → 心跳带回取消 → 本机 cancelled，从未执行。"""
    m, _, screen = _flow(w)
    cancelled: list[str] = []

    def on_claim(request, status, data):
        if data and data.get("commands") and not cancelled:
            cid = data["commands"][0]["command_id"]
            cancelled.append(cid)
            m.runtime.pause("user_request", by="user", detail="状态窗口")

    w.cluster.after_hooks.append(on_claim)
    m.run_until(lambda: cancelled, what="领取问候")
    w.server.ok("POST", f"/commands/{cancelled[0]}:cancel", {"note": "候选人已线下联系"})
    w.clock.advance(31)
    m.run_until(lambda: server_cmd(w, "send_greeting")["server_status"] == "cancelled", what="回报 cancelled")
    result = server_cmd(w, "send_greeting")["result"]
    assert result["status"] == "cancelled" and result["executed_at"] is None
    assert not (result["navigation_performed"] or result["outbound_action_performed"])
    m.runtime.resume(by="user")
    for _ in range(6):
        w.clock.advance(30)
        m.run(2)
    assert screen.outbound() == []
    assert case_stage(w) == "new_application"  # 取消的问候不推进流程


def _watcher(w: World, m) -> CancellationWatcher:
    """J 的取消线程（旁路心跳）。这里在钩子里同步调用 poll_once()，等价于它在动作执行中醒来一次。"""

    class _NoSession:
        def snapshot(self):
            return None

        def stop(self):
            pass

    app = MonitorApp(runtime=m.runtime, session=_NoSession())  # type: ignore[arg-type]
    app.publish()
    side = CommandClient(
        base_url="http://monitor.test/api/v1", device_id=m.identity.device_id, token=m.identity.token,
        transport=w.cluster, now=w.clock.now,
    )
    return CancellationWatcher(app=app, client=side, now=w.clock.now)


def test_cancel_while_running_before_outbound(w: World):
    """会话已打开（导航），还没输入问候时取消到达：守卫打断，回报 cancelled（navigation=true）。"""
    m, _, screen = _flow(w)
    watcher = _watcher(w, m)
    fired: list[bool] = []

    def cancel_after_open(rec, scr):
        if rec.kind == "open_row" and not fired:
            fired.append(True)
            [cmd] = [c for c in w.cluster.claimed if c["action"] == "send_greeting"]
            w.server.ok("POST", f"/commands/{cmd['command_id']}:cancel", {"note": "取消"})
            # 旁路心跳的幂等键按 sent_at 生成；可控时钟不走时会与主循环同一时刻的心跳撞键，先走 1 秒
            w.clock.advance(1)
            watcher.app.publish()
            assert watcher.poll_once() is True

    screen.hooks.append(cancel_after_open)
    m.run_until(lambda: server_cmd(w, "send_greeting")["server_status"] == "cancelled", what="cancelled")
    result = server_cmd(w, "send_greeting")["result"]
    assert result["navigation_performed"] is True and result["outbound_action_performed"] is False
    assert screen.outbound() == []
    watcher.stop()


def test_cancel_arriving_after_outbound_reports_actual_result(w: World):
    """点完『发送』后取消才到：不能回报 cancelled，回报实际结果（succeeded），流程照常推进。"""
    m, _, screen = _flow(w)
    watcher = _watcher(w, m)
    fired: list[bool] = []

    def cancel_after_send(rec, scr):
        if rec.kind == "greeting_send" and not fired:
            fired.append(True)
            [cmd] = [c for c in w.cluster.claimed if c["action"] == "send_greeting"]
            w.server.ok("POST", f"/commands/{cmd['command_id']}:cancel", {"note": "取消"})
            w.clock.advance(1)
            watcher.app.publish()
            assert watcher.poll_once() is True

    screen.hooks.append(cancel_after_send)
    m.run_until(lambda: server_cmd(w, "send_greeting")["server_status"] == "succeeded", what="回报实际结果")
    assert server_cmd(w, "send_greeting")["result"]["outbound_action_performed"] is True
    assert screen.outbound()[:2] == ["greeting_type", "greeting_send"]
    assert screen.count("greeting_send") == 1
    watcher.stop()


# ---------------------------------------------------------------------------
# 过期
# ---------------------------------------------------------------------------


def test_command_expires_in_device_queue(w: World):
    """问候已入账，设备被用户暂停 3 小时（超过 2 小时有效期）：恢复后不执行，回报 expired，流程转人工。"""
    m, _, screen = _flow(w)
    got: list[bool] = []

    def on_claim(request, status, data):
        if data and data.get("commands") and not got:
            got.append(True)
            m.runtime.pause("user_request", by="user")

    w.cluster.after_hooks.append(on_claim)
    m.run_until(lambda: got, what="领取")
    end = w.clock.now() + timedelta(hours=3)
    m.run_until(lambda: w.clock.now() >= end, max_rounds=1000, what="暂停 3 小时")
    m.runtime.resume(by="user")
    m.run_until(lambda: server_cmd(w, "send_greeting")["server_status"] == "expired", what="回报 expired")
    result = server_cmd(w, "send_greeting")["result"]
    assert result["executed_at"] is None
    assert not (result["navigation_performed"] or result["outbound_action_performed"] or result["externally_visible_side_effect"])
    assert screen.outbound() == []
    assert case_stage(w) == "needs_human"


def test_unclaimed_command_expires_on_server_while_device_offline(w: World):
    """设备离线期间指令在服务端过期：上线后领不到，什么都不执行，流程转人工。"""
    m, fake, screen = _flow(w)

    def cut_after_events(request, status, data):
        if request.url.path.endswith("/events") and w.server.cases():
            w.cluster.down = True  # 新投递刚上报、问候刚生成，还没领取就断网

    w.cluster.after_hooks.append(cut_after_events)
    m.run_until(lambda: w.cluster.down, what="新投递上报、生成问候")
    w.cluster.after_hooks.remove(cut_after_events)
    end = w.clock.now() + timedelta(hours=3)
    m.run_until(lambda: w.clock.now() >= end, max_rounds=2000, what="离线 3 小时")
    w.cluster.down = False
    for _ in range(10):
        w.clock.advance(30)
        m.run(2)
    assert server_cmd(w, "send_greeting")["server_status"] == "expired"
    assert screen.outbound() == []
    assert case_stage(w) == "needs_human"


# ---------------------------------------------------------------------------
# 离线超过 24 小时：先重建基线再领取
# ---------------------------------------------------------------------------


def _claims_only_after_baseline(w: World, m) -> list[bool]:
    seen: list[bool] = []

    def check(request, status, data):
        if request.url.path.endswith("commands:claim"):
            seen.append(m.runtime.state.needs_baseline)

    w.cluster.after_hooks.append(check)
    return seen


def test_process_down_over_24h_rebuilds_baseline_before_claiming(w: World):
    fake = boss_new_greeting(w.clock)
    screen = Screen(fake)
    m = w.bound_monitor(screen)
    m.run_until(lambda: m.runtime.state.baseline.established, what="建基线")
    gen = m.runtime.state.baseline.generation
    m.close()
    # 停机 25 小时；期间候选人L 等人进了『新招呼』（对重建后的基线来说都是积压）
    w.clock.advance(25 * 3600)
    fake.goto("list_new")
    seen = _claims_only_after_baseline(w, m)
    m.restart()
    assert m.runtime.state.needs_baseline is True
    m.run_until(lambda: not m.runtime.state.needs_baseline, what="重建基线")
    assert m.runtime.state.baseline.generation == gen + 1
    for _ in range(6):
        w.clock.advance(45)
        m.run(2)
    assert seen and not any(seen)  # 每次领取时 needs_baseline 都已清除
    hb_flags = [hb for hb in [w.server.device(m.identity.device_id)["last_heartbeat"]]]
    assert hb_flags[0]["needs_baseline"] is False
    assert w.server.events(kind="application_observed") == []  # 离线期间的会话不当新投递
    assert screen.outbound() == []


def test_network_down_over_24h_rebuilds_baseline_before_claiming(w: World):
    fake = boss_new_greeting(w.clock)
    screen = Screen(fake)
    m = w.bound_monitor(screen)
    m.run_until(lambda: m.runtime.state.baseline.established, what="建基线")
    gen = m.runtime.state.baseline.generation
    w.cluster.down = True
    end = w.clock.now() + timedelta(hours=25)
    m.run_until(lambda: w.clock.now() >= end, max_rounds=5000, what="断网 25 小时")
    fake.goto("list_new")
    seen = _claims_only_after_baseline(w, m)
    assert m.runtime.state.needs_baseline is False  # 断网期间不判离线（没有服务端响应可比）
    w.cluster.down = False
    m.run_until(
        lambda: m.runtime.state.baseline.generation == gen + 1 and not m.runtime.state.needs_baseline,
        what="恢复连接后重建基线",
    )
    for _ in range(6):
        w.clock.advance(45)
        m.run(2)
    assert seen and not any(seen)
    assert w.server.events(kind="application_observed") == []
    assert screen.outbound() == []


# ---------------------------------------------------------------------------
# 服务端重启
# ---------------------------------------------------------------------------


def test_server_restart_mid_flow(w: World):
    """问候点完发送后服务端重启（同一个库，新进程）：结果补传到新实例，新实例照常生成求简历。"""
    m, _, screen = _flow(w)
    restarted: list[bool] = []

    def restart(rec, scr):
        if rec.kind == "greeting_send" and not restarted:
            restarted.append(True)
            w.cluster.stop_server()

    screen.hooks.append(restart)
    m.run_until(lambda: restarted and m.ledger.pending_results(), what="结果落账，服务端已停")
    w.clock.advance(20)
    m.run(3)
    w.cluster.start_server()
    _finish(w, m)
    assert screen.outbound() == FULL
    assert [c["command"]["action"] for c in w.server.commands()] == ["send_greeting", "request_resume"] or sorted(
        c["command"]["action"] for c in w.server.commands()
    ) == ["request_resume", "send_greeting"]


def test_server_restart_between_claim_and_ack(w: World):
    """领取后、ack 前服务端重启：设备的 ack 补发到新实例，不重复领取、不重复执行。"""
    m, _, screen = _flow(w)
    done: list[bool] = []

    def restart_on_claim(request, status, data):
        if data and data.get("commands") and not done:
            done.append(True)
            w.cluster.stop_server()

    w.cluster.after_hooks.append(restart_on_claim)
    m.run_until(lambda: done, what="领取")
    w.clock.advance(5)
    m.run(2)
    w.cluster.start_server()
    _finish(w, m)
    assert screen.outbound() == FULL
    assert len([c for c in w.cluster.claimed if c["action"] == "send_greeting"]) == 1


# ---------------------------------------------------------------------------
# 租约过期未 ack：重新领取同一条指令
# ---------------------------------------------------------------------------


def test_lost_claim_response_is_reclaimed_after_lease_expires(w: World):
    """领取响应丢失（服务端已发出租约，设备没收到）：租约（60 秒）内领不到，过期后重新领到同一条，只执行一次。"""
    m, _, screen = _flow(w)
    w.cluster.fail("commands:claim", kind="lose_response", only_with_commands=True, times=1)
    _finish(w, m)
    greet_claims = [c for c in w.cluster.claimed if c["action"] == "send_greeting"]
    assert len(greet_claims) == 2 and greet_claims[0]["command_id"] == greet_claims[1]["command_id"]
    assert screen.outbound() == FULL


def test_crash_after_intake_before_ack_executes_once(w: World):
    """入账后 ack 发不出去，进程随即重启（未 ack 列表只在内存里）：重启后照常执行并回报，
    即使服务端在租约过期后再次下发同一条指令，本机也按 command_id 去重，不重做。"""
    m, _, screen = _flow(w)
    ack_fault = w.cluster.fail("/ack", times=10_000)
    m.run_until(lambda: m.ledger.list_commands(), what="入账")
    m.restart()
    w.clock.advance(61)  # 服务端租约过期
    m.run_until(lambda: server_cmd(w, "send_greeting")["server_status"] in ("succeeded", "failed", "unknown"), what="回报")
    ack_fault.times = 0
    _finish(w, m)
    assert screen.outbound() == FULL
    assert server_cmd(w, "send_greeting")["server_status"] == "succeeded"
    assert CANDIDATE  # 保持导入（文档用）
    assert at_local(0) is not None
