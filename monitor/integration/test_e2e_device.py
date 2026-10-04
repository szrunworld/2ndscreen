"""设备注册与绑定（api.md 3.1）、控制台暂停与恢复、吊销令牌。

注册走 J 的 register_device（真实请求体、Idempotency-Key 规则），之后的往来走真实运行时。
"""

from __future__ import annotations

import pytest

from integration_kit import (
    ACCOUNT,
    Screen,
    World,
    at_local,
    bind_locally,
    boss_new_greeting,
    build_registration,
    register_device,
    BASE_URL,
)
from monitor.install.register import RegistrationError


def _screen(w: World) -> Screen:
    return Screen(boss_new_greeting(w.clock))


def test_register_with_enrollment_code_then_console_binding(w: World):
    ident = w.register("local")
    dev = w.server.device(ident.device_id)
    assert dev["mode"] == "local" and dev["revoked"] is False and dev["account_binding"] is None
    assert "send_greeting" in dev["capabilities"]

    m = w.monitor(ident, _screen(w))
    m.run(3)
    # 未绑定：心跳 account_id=null，服务端 account_confirmed=false，不领取
    assert m.runtime.account_id is None
    assert w.cluster.count(":claim") == 0
    assert w.server.device(ident.device_id)["last_heartbeat"]["account_id"] is None

    w.server.bind(ident.device_id)
    w.enable_automation()
    bind_locally(m)  # 见 integration_kit.bind_locally：缺陷 M-1 的替代步骤
    m.run_until(lambda: m.runtime.account_confirmed is True and m.runtime.policy is not None, what="绑定确认、取到策略")
    assert m.runtime.policy.account_id == ACCOUNT
    hb = w.server.device(ident.device_id)["last_heartbeat"]
    assert hb["account_id"] == ACCOUNT and hb["mode"] == "local"
    assert w.server.device(ident.device_id)["account_binding"]["account_id"] == ACCOUNT


@pytest.mark.xfail(
    strict=True,
    reason="缺陷 M-1：Monitor 得不到控制台确认的绑定账户（HeartbeatAck 只有 account_confirmed，"
    "install/bootstrap 也不询问或拉取 account_id），没有代码调用 runtime.bind_account；等待契约 + core 补上",
)
def test_monitor_learns_binding_from_server_without_manual_step(w: World):
    ident = w.register("local")
    m = w.monitor(ident, _screen(w))
    m.run(2)
    w.server.bind(ident.device_id)
    w.enable_automation()
    w.clock.advance(31)  # 下一次心跳
    m.run(5)
    assert m.runtime.account_id == ACCOUNT


def test_enrollment_code_is_single_use(w: World):
    code = w.server.enroll("remote")
    body = build_registration(
        enrollment_code=code, device_name="d1", mode="remote", capabilities=["observe"], os_version="15", arch="arm64"
    )
    first = register_device(BASE_URL, body, transport=w.cluster, allow_insecure_http=True)
    # 同一次安装的重试（同一个 Idempotency-Key）原样返回同一台设备
    again = register_device(BASE_URL, body, transport=w.cluster, allow_insecure_http=True)
    assert again.device_id == first.device_id
    # 另一台机器拿同一个注册码（不同请求体）被拒绝
    other = dict(body, device_name="d2")
    with pytest.raises(RegistrationError) as exc:
        register_device(BASE_URL, other, transport=w.cluster, allow_insecure_http=True)
    assert exc.value.status in (403, 422)


def test_console_pause_stops_claims_and_resume_continues(w: World):
    fake = boss_new_greeting(w.clock)
    screen = Screen(fake)
    m = w.bound_monitor(screen)
    m.run_until(lambda: m.runtime.state.baseline.established, what="建基线")
    w.server.ok("POST", f"/devices/{m.identity.device_id}:pause", {"note": "午休"})
    w.clock.advance(31)
    m.run_until(lambda: m.runtime.state.paused, what="心跳收到暂停")
    assert m.runtime.state.pause_reason == "server_request"

    # 暂停期间候选人L 到达：观察照常（server_request 暂停不停观察），事件上报，但不领取、不执行
    w.clock.advance((at_local(19, 12) - w.clock.now()).total_seconds())
    fake.goto("list_new")
    claims_before = w.cluster.count(":claim")
    for _ in range(10):
        w.clock.advance(30)
        m.run(2)
    assert len(w.server.events(kind="application_observed")) == 1
    assert w.cluster.count(":claim") == claims_before
    assert screen.outbound() == []
    # 设备暂停时服务端不生成对外指令，流程挂起（blocked_reason）
    assert w.server.commands() == []
    assert w.server.cases()[0]["stage"] == "new_application"
    assert w.server.device(m.identity.device_id)["paused"] is True

    w.server.ok("POST", f"/devices/{m.identity.device_id}:resume", {"note": "继续"})
    w.clock.advance(31)
    m.run_until(lambda: w.server.cases()[0]["stage"] == "resume_requested", what="恢复后执行")
    assert not m.runtime.state.paused
    assert screen.outbound() == ["greeting_type", "greeting_send", "resume_request"]


def test_revoked_token_stops_all_server_traffic(w: World):
    m = w.bound_monitor(_screen(w))
    m.run_until(lambda: m.runtime.policy is not None, what="上线")
    w.server.ok("POST", f"/devices/{m.identity.device_id}:revoke", {"note": "设备丢失"})
    w.clock.advance(31)
    m.run(3)
    assert m.runtime.revoked is True
    assert m.runtime.status()["revoked"] is True
    sent = len(w.cluster.requests)
    for _ in range(5):
        w.clock.advance(60)
        m.run(2)
    assert len(w.cluster.requests) == sent  # 吊销后不再发任何请求
    assert w.server.device(m.identity.device_id)["revoked"] is True
    # 重启进程也一样：第一次请求 401 后停止
    m.restart()
    m.run(3)
    assert m.runtime.revoked is True
    assert len(w.cluster.requests) == sent + 1


def test_bind_script_workaround_then_monitor_claims(w: World):
    """运维替代步骤（scripts/bind_account.py）：Monitor 停止 → 写入绑定 → 再启动即确认绑定、建基线、领取。"""
    import importlib.util

    from integration_kit import MONITOR_DIR

    spec = importlib.util.spec_from_file_location("bind_account_script", MONITOR_DIR / "scripts" / "bind_account.py")
    script = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(script)

    fake = boss_new_greeting(w.clock)
    screen = Screen(fake)
    ident = w.register("local")
    m = w.monitor(ident, screen)
    m.run(3)
    assert m.runtime.account_id is None
    w.server.bind(ident.device_id)
    w.enable_automation()
    m.close()  # 停止 Monitor

    ledger = w.workdir / "monitor.db"
    assert script.main(["--ledger", str(ledger), "--account", ACCOUNT, "--confirmed-by", "ops@example.com"]) == 0
    assert script.main(["--ledger", str(w.workdir / "missing.db"), "--account", ACCOUNT, "--confirmed-by", "x"]) == 2

    m.restart()
    assert m.runtime.account_id == ACCOUNT and m.runtime.state.needs_baseline
    m.run_until(lambda: m.runtime.account_confirmed is True and not m.runtime.state.needs_baseline, what="确认并建基线")
    w.clock.advance((at_local(19, 12) - w.clock.now()).total_seconds())
    fake.goto("list_new")
    m.run_until(lambda: w.server.cases() and w.server.cases()[0]["stage"] == "resume_requested", what="主线")
    assert screen.outbound() == ["greeting_type", "greeting_send", "resume_request"]
