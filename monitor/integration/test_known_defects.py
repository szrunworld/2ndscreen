"""集成中发现的缺陷与等待中的任务：全部写成 xfail(strict=True)，修好后会变成 XPASS 并让测试失败，
届时删掉标记即可。编号与 docs/monitor/agent-reports/M.md 第五节一致（M-1 在 test_e2e_device.py，
登录页识别在 test_e2e_manual_search_login.py）。"""

from __future__ import annotations

import pytest

from integration_kit import Screen, World, boss_new_greeting


def _online(w: World):
    m = w.bound_monitor(Screen(boss_new_greeting(w.clock)))
    m.run_until(lambda: m.runtime.policy is not None and m.runtime.state.baseline.established, what="上线")
    return m


@pytest.mark.xfail(
    strict=True,
    reason="缺陷 M-2：连接失败进入退避后，心跳到期时间停在过去，MonitorRuntime._idle_seconds 取到负数→0，"
    "run_forever 在退避期内空转（CPU 满载）直到退避结束；应把退避结束时间作为下一次心跳的下限",
)
def test_runtime_does_not_busy_spin_while_backing_off(w: World):
    m = _online(w)
    w.cluster.down = True
    w.clock.advance(31)  # 心跳到期，请求失败，进入退避
    m.runtime.run_once()
    assert m.runtime.backoff.next_at is not None and m.runtime.backoff.next_at > w.clock.now()
    idle = m.runtime.run_once()
    assert idle > 0, "退避期内建议等待 0 秒：真实进程会空转"


@pytest.mark.xfail(
    strict=True,
    raises=Exception,
    reason="缺陷 M-3：心跳收到 4xx（非 401，例如 422 契约不一致、403 device_mismatch）时 RequestRejected 没有被"
    "_server_round 捕获，异常穿出 run_once，run_forever 退出、进程崩溃（launchd 会反复拉起）；应记 last_error 并退避",
)
def test_heartbeat_4xx_does_not_crash_runtime(w: World):
    m = _online(w)
    w.cluster.fail("/heartbeat", status=422, times=1)
    w.clock.advance(31)
    m.runtime.run_once()  # 不应抛异常
    assert m.runtime.last_error is not None


def test_monitor_main_dispatches_install_subcommand(monkeypatch):
    import monitor.install.cli as install_cli
    from monitor.__main__ import main

    seen: list[list[str]] = []
    monkeypatch.setattr(install_cli, "main", lambda argv=None, env=None: seen.append(list(argv or [])) or 0)
    assert main(["install", "--mode", "local"]) == 0  # D2c 起转给 monitor.install.cli
    assert seen and seen[0][-2:] == ["--mode", "local"]
