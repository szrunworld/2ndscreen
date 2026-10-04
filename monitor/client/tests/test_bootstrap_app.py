"""任务 J：进程装配（MonitorApp、CancellationWatcher、build_app）。

用 core.testing 的 FakeServer / InMemoryLedger / ManualClock，fake 2ndscreen CLI；不起真实线程循环、不 sleep。
"""

from __future__ import annotations

import argparse
from uuid import UUID

import pytest
from monitor_contracts import CommandState, validate_command

from monitor.bootstrap import Caffeinate, GateDriver, LocalSession, RemoteSession, RetryPolicy, RuntimeView, ScreenOps
from monitor.bootstrap.app import AppSetupError, CancellationWatcher, MonitorApp, build_app, build_parser
from monitor.bootstrap.testing import FakeCli, FakeKeychain, FakePopen
from monitor.core import ClaimResponse, CommandCancelled
from monitor.core.testing import (
    BASE_URL,
    DEVICE,
    TOKEN,
    RecordingDriver,
    ScriptedHandler,
    make_env,
    make_policy,
)
from monitor.install import FileStore, InstallConfig, MonitorPaths, save_config


def office_hours_policy():
    return make_policy(work_hours={"timezone": "UTC", "windows": [{"days": [1, 2, 3, 4, 5, 6, 7], "start": "00:00", "end": "23:59"}]})


def wire(env, cli: FakeCli, *, mode: str = "remote", spawn=None, opener=None):
    """把 make_env 的运行时包上 GateDriver 与 Session，组装成 MonitorApp。"""
    rt = env.runtime
    inner = env.driver
    gate = GateDriver(inner, open=False)
    rt.driver = gate
    rt.pipeline.driver = gate
    view = RuntimeView(report=rt.record_error, policy=lambda: rt.policy,
                       pause_state=lambda: (rt.state.paused, rt.state.pause_reason), gui_lock=rt.gui_lock,
                       now=env.clock.now, sleep=env.clock.sleep)
    ops = ScreenOps(cli=cli.runner(), screen="monitor", owner_pid=1, pid_resolver=lambda sel: [4242])
    common = dict(ops=ops, driver=inner, gate=gate, view=view, bundle_id="com.zhipin.www", retry=RetryPolicy(attempts=2), max_rounds=1)
    session = RemoteSession(caffeinate=Caffeinate(popen=FakePopen()), **common) if mode == "remote" else LocalSession(**common)
    opened = []
    app = MonitorApp(runtime=rt, session=session, console_url="https://console.test/",
                     opener=opener or opened.append, spawn=spawn or (lambda fn: fn()))
    return app, opened


def test_snapshot_reflects_runtime_and_session():
    env = make_env(mode="remote")
    app, _ = wire(env, FakeCli())
    with pytest.raises(RuntimeError):
        app.snapshot()
    app.start()
    snap = app.snapshot()
    assert snap.mode == "remote" and snap.device_id == DEVICE and snap.account_id
    assert snap.session["session_state"] == "ok" and snap.session["window_held"] is True
    assert snap.queued == 0 and snap.outbox == 0 and snap.current_action is None
    assert snap.console_url == "https://console.test/"


def test_remote_bootstrap_failure_reaches_heartbeat_last_error():
    env = make_env(mode="remote")
    app, _ = wire(env, FakeCli(responses={"screen list": (1, None, "error: 2ndscreen is not running")}))
    app.start()
    snap = app.snapshot()
    assert snap.session["session_state"] == "failed"
    assert snap.last_error_code == "bootstrap_remote"
    app.step()  # 心跳把 last_error 带给服务端
    sent = [hb["last_error"] for hb in env.server.heartbeats if hb.get("last_error")]
    assert sent and sent[-1]["code"] == "bootstrap_remote"


def test_remote_pause_and_resume_buttons():
    env = make_env(mode="remote")
    app, _ = wire(env, FakeCli())
    app.start()
    app.on_button("pause")
    app.step()
    assert env.runtime.state.paused and env.runtime.state.pause_reason == "user_request"
    assert app.snapshot().paused
    assert app.session.held  # remote 暂停不归还窗口
    app.on_button("resume")
    app.step()
    assert not env.runtime.state.paused


def test_local_pause_returns_window_immediately_and_resume_takes_over_again():
    env = make_env(mode="local", policy=office_hours_policy())
    cli = FakeCli()
    app, _ = wire(env, cli, mode="local")
    app.start()
    app.step()  # 拿到策略
    app.step()  # 时段内接管
    assert app.session.held
    app.on_button("pause")  # spawn 同步执行：立刻归还
    assert cli.count("window release") == 1 and not app.session.held
    app.step()
    assert env.runtime.state.pause_reason == "user_request"
    assert not app.session.held
    app.on_button("resume")
    app.step()
    assert not env.runtime.state.paused and app.session.held


def test_console_and_unknown_buttons():
    env = make_env()
    app, opened = wire(env, FakeCli())
    app.on_button("console")
    assert opened == ["https://console.test/"]
    with pytest.raises(ValueError):
        app.on_button("format_disk")


def test_retry_button_resets_failed_session():
    env = make_env(mode="remote")
    cli = FakeCli()
    cli.responses["screen list"] = lambda args: (1, None, "error: 2ndscreen is not running") if cli.count("screen list") <= 2 else (0, {"ok": True, "screens": []}, "")
    app, _ = wire(env, cli)
    app.start()
    assert app.session.gave_up
    env.clock.advance(60)
    app.step()
    assert cli.count("app launch") == 0  # 预算用尽，不自动重试
    app.on_button("retry")
    env.clock.advance(60)
    app.step()
    assert app.session.state == "ok" and cli.count("app launch") == 1


def test_run_exits_and_shuts_down_on_stop():
    env = make_env(mode="remote")
    app, _ = wire(env, FakeCli())
    popen = app.session.caffeinate.popen
    original = app.step

    def step_then_stop():
        out = original()
        app.stop()
        return out

    app.step = step_then_stop  # type: ignore[method-assign]
    app.run()
    assert app.stopping and app.snapshot().stopping
    assert popen.procs[0].terminated  # caffeinate 随退出结束


# ---------------------------------------------------------------------------
# 执行中取消（D2b：需要另一线程调用 pipeline.cancel）
# ---------------------------------------------------------------------------


def watcher_for(env, app) -> CancellationWatcher:
    from monitor.core import CommandClient

    side = CommandClient(base_url=BASE_URL, device_id=DEVICE, token=TOKEN, transport=env.server.transport(), now=env.clock.now)
    return CancellationWatcher(app=app, client=side, now=env.clock.now)


def test_cancel_arrives_while_action_running():
    outcome = {}

    def run(cmd, driver, ctx):
        driver.click(None)  # 导航
        env.server.cancellations.add(str(cmd.command_id))  # 控制台此时点了取消
        outcome["sent"] = watcher.poll_once()  # 取消线程在动作执行中发心跳
        try:
            with ctx.outbound():
                driver.click(None)
        except CommandCancelled:
            outcome["interrupted"] = True
            raise
        raise AssertionError("应被取消打断")

    env = make_env(mode="remote", handlers=[ScriptedHandler("send_greeting", run=run)])
    app, _ = wire(env, FakeCli())
    watcher = watcher_for(env, app)
    assert watcher.poll_once() is False  # 没有动作在执行：不发旁路心跳
    app.start()
    cmd = env.cmd()
    env.server.enqueue(cmd)
    for _ in range(6):
        app.step()
        rec = env.ledger.get_command(UUID(cmd["command_id"]))
        if rec is not None and rec.result is not None:
            break
    assert outcome == {"sent": True, "interrupted": True}
    assert rec.result.status == "cancelled"
    assert rec.result.outbound_action_performed is False and rec.result.navigation_performed is True
    side_hb = [hb for hb in env.server.heartbeats if hb["current_action"] is not None]
    assert side_hb and side_hb[0]["current_action"]["command_id"] == cmd["command_id"]


def test_cancel_for_queued_command_is_deferred_to_runtime_thread():
    seen = {}

    def run(cmd, driver, ctx):
        env.server.cancellations.add(other["command_id"])
        seen["sent"] = watcher.poll_once()
        seen["deferred_before_step"] = env.ledger.get_command(UUID(other["command_id"])).state
        with ctx.outbound():
            driver.click(None)
        from monitor_contracts import ActionResult

        return ActionResult(status="succeeded", executed_at=env.clock.now())

    env = make_env(mode="remote", handlers=[ScriptedHandler("send_greeting", run=run), ScriptedHandler("request_resume")])
    app, _ = wire(env, FakeCli())
    watcher = watcher_for(env, app)
    app.start()
    first = env.cmd()
    other = env.cmd("request_resume")
    # 两条都已入账：第二条排队
    env.runtime.handle_claim(ClaimResponse(commands=(validate_command(first), validate_command(other)),
                                           cancellations=(), lease_seconds=60, server_time=env.clock.now()))
    app.step()
    assert seen["sent"] is True
    assert seen["deferred_before_step"] == CommandState.QUEUED  # 取消线程不改账本
    rec = env.ledger.get_command(UUID(other["command_id"]))
    assert rec.state == CommandState.CANCELLED


def test_watcher_stops_on_unauthorized_and_survives_server_errors():
    def run(cmd, driver, ctx):
        env.server.fail("heartbeat", 500)
        results.append(watcher.poll_once())
        env.server.fail("heartbeat", 401)
        results.append(watcher.poll_once())
        from monitor_contracts import ActionResult

        return ActionResult(status="failed", reason="target_not_found")

    results: list[bool] = []
    env = make_env(mode="remote", handlers=[ScriptedHandler("send_greeting", run=run)])
    app, _ = wire(env, FakeCli())
    watcher = watcher_for(env, app)
    app.start()
    env.server.enqueue(env.cmd())
    for _ in range(4):
        app.step()
    assert results == [False, False]
    assert watcher.failures == 2 and watcher._stop.is_set()


# ---------------------------------------------------------------------------
# build_app：按安装配置装配
# ---------------------------------------------------------------------------


def make_install(tmp_path, mode="remote", token_store="file", token=TOKEN) -> MonitorPaths:
    paths = MonitorPaths(tmp_path / "home")
    save_config(paths, InstallConfig(server_url=BASE_URL, device_id=DEVICE, device_name="m", mode=mode,  # type: ignore[arg-type]
                                     token_store=token_store, console_url="https://console.test/"))  # type: ignore[arg-type]
    if token_store == "file" and token:
        FileStore(paths.token_file).save(DEVICE, token)
    return paths


def args(*extra: str) -> argparse.Namespace:
    return build_parser().parse_args(["--observer", "none", "--handlers", "none", *extra])


@pytest.mark.parametrize(("mode", "cls"), [("remote", RemoteSession), ("local", LocalSession)])
def test_build_app_assembles_from_install_config(tmp_path, mode, cls):
    from monitor.core import ManualClock
    from monitor.core.testing import FakeServer

    paths = make_install(tmp_path, mode=mode)
    clock = ManualClock()
    server = FakeServer(device_id=DEVICE, token=TOKEN, clock=clock, policy=make_policy())
    app, watcher = build_app(args(), paths=paths, transport=server.transport(), clock=clock,
                             driver_factory=lambda screen, binary: RecordingDriver(clock),
                             cli_runner=FakeCli().runner(), caffeinate=Caffeinate(popen=FakePopen()),
                             pid_resolver=lambda sel: [4242])
    assert isinstance(app.session, cls)
    assert isinstance(app.runtime.driver, GateDriver)
    assert app.runtime.mode == mode
    app.start()
    app.step()
    assert server.heartbeats and server.heartbeats[0]["mode"] == mode
    assert watcher.client is not app.runtime.client  # 旁路心跳用独立连接
    app.runtime.ledger.close()


def test_build_app_reads_token_from_keychain(tmp_path):
    from monitor.core import ManualClock

    paths = make_install(tmp_path, token_store="keychain")
    kc = FakeKeychain(items={DEVICE: TOKEN})
    app, _ = build_app(args(), paths=paths, keychain=kc, clock=ManualClock(),
                       driver_factory=lambda s, b: RecordingDriver(ManualClock()), cli_runner=FakeCli().runner())
    assert app.runtime.config.device_id == DEVICE
    app.runtime.ledger.close()


def test_build_app_errors(tmp_path):
    with pytest.raises(AppSetupError, match="尚未安装"):
        build_app(args(), paths=MonitorPaths(tmp_path / "empty"))
    paths = make_install(tmp_path, token=None)
    with pytest.raises(AppSetupError, match="令牌"):
        build_app(args(), paths=paths)
    with pytest.raises(AppSetupError, match="keychain"):
        build_app(args(), paths=make_install(tmp_path / "k", token_store="keychain"), keychain=FakeKeychain())
    bad = make_install(tmp_path / "b")
    with pytest.raises(AppSetupError, match="无法导入"):
        build_app(build_parser().parse_args(["--observer", "none", "--handlers", "no.such.module:f"]), paths=bad,
                  driver_factory=lambda s, b: None, cli_runner=FakeCli().runner())
