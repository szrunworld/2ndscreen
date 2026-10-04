"""混沌：执行中被杀（真实子进程 os._exit(9)）后重启。

父进程跑到问候成功并回传，然后停掉自己的 Monitor 与服务端实例；子进程在同一个服务端库、同一个本机账本上
继续跑，点下『求简历』的瞬间被 os._exit(9) 杀掉（账本里这条指令停在 running，没有结果）。
父进程再起服务端与 Monitor：崩溃恢复只做 verify_only（只读复核），按界面事实落终态并回报。

断言：三段（父进程前半、子进程、父进程重启后）合计的对外写调用与预期完全一致——『求简历』只点了一次。
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import timedelta
from pathlib import Path

import pytest

from integration_kit import (
    Screen,
    World,
    boss_new_greeting,
    case_stage,
    read_journal,
    reach_new_greeting,
    server_cmd,
)
from monitor_contracts import CommandState, DeliveryState

CHILD = Path(__file__).with_name("kill_child.py")


def _run_until_killed(w: World, m, *, start_step: str, kill_on: str) -> list:
    journal = w.workdir / "child_writes.jsonl"
    m.close()
    w.cluster.stop_server()
    args = {
        "workdir": str(w.workdir),
        "device_id": m.identity.device_id,
        "token": m.identity.token,
        "mode": m.identity.mode,
        "now": w.clock.now().isoformat(),
        "start_step": start_step,
        "kill_on": kill_on,
        "journal": str(journal),
    }
    proc = subprocess.run([sys.executable, str(CHILD), json.dumps(args)], capture_output=True, text=True, timeout=180)
    assert proc.returncode == 9, f"子进程没有按计划被杀（{proc.returncode}）：{proc.stderr[-2000:]}"
    # 子进程用的是自己的可控时钟；重启前把父进程的时钟拨过去（进程重启需要时间）
    w.clock.advance(timedelta(minutes=10).total_seconds())
    return read_journal(journal)


def _first_half(w: World):
    fake = boss_new_greeting(w.clock)
    screen = Screen(fake)
    m = w.bound_monitor(screen)
    reach_new_greeting(w, fake, m)
    m.run_until(
        lambda: (rec := server_cmd(w, "send_greeting"))["server_status"] == "succeeded"
        and m.ledger_command(rec["command"]["command_id"]).delivery == DeliveryState.DELIVERED,
        what="问候成功并回传",
    )
    return m, screen


@pytest.mark.parametrize(
    ("after_restart_step", "final_status", "reason", "stage"),
    [
        # 点击生效了：重启后界面上有『简历请求已发送』→ 复核确认 → succeeded
        ("detail_requested", "succeeded", None, "resume_requested"),
        # 点击没生效（或界面看不出来）：复核确认没有发生 → failed/verification_failed，不重点、转人工
        ("detail_greeted", "failed", "verification_failed", "needs_human"),
    ],
)
def test_killed_right_after_resume_click(w: World, after_restart_step, final_status, reason, stage):
    m, screen1 = _first_half(w)
    assert screen1.outbound() == ["greeting_type", "greeting_send"]

    child_writes = _run_until_killed(w, m, start_step="detail_greeted", kill_on="resume_request")
    assert [r.kind for r in child_writes if r.kind in ("resume_request", "greeting_type", "greeting_send")] == [
        "resume_request"
    ]

    # 子进程死后：账本里求简历停在 running、没有结果；服务端只知道它被领取 / ack 了
    w.cluster.start_server()
    resume = server_cmd(w, "request_resume")
    assert resume["server_status"] in ("claimed", "acked") and resume["result"] is None

    fake2 = boss_new_greeting(w.clock)
    fake2.goto(after_restart_step)
    screen2 = Screen(fake2)
    m2 = w.monitor(m.identity, screen2)  # 同一个账本文件 monitor.db
    led = m2.ledger_command(resume["command"]["command_id"])
    assert led.state == CommandState.RUNNING and led.result is None

    m2.run_until(lambda: server_cmd(w, "request_resume")["server_status"] == final_status, what="恢复后回报")
    result = server_cmd(w, "request_resume")["result"]
    assert result["reason"] == reason
    assert result["outbound_action_performed"] is (final_status == "succeeded")
    m2.run_until(lambda: case_stage(w) == stage, what="流程阶段")

    # 合计：输入问候、点发送、点求简历各一次；重启后的复核没有任何对外写调用
    assert screen2.outbound() == []
    total = screen1.outbound() + [r.kind for r in child_writes if r.kind in ("resume_request",)] + screen2.outbound()
    assert total == ["greeting_type", "greeting_send", "resume_request"]
    led = m2.ledger_command(resume["command"]["command_id"])
    assert led.delivery == DeliveryState.DELIVERED


def test_killed_after_greeting_typed_before_send(w: World):
    """输入问候后、点『发送』前被杀：复核看不到消息 → failed/verification_failed，不重新输入、不发送。"""
    fake = boss_new_greeting(w.clock)
    screen = Screen(fake)
    m = w.bound_monitor(screen)
    reach_new_greeting(w, fake, m)
    m.run_until(lambda: m.runtime.state.baseline.established, what="建基线")
    # 新投递已上报、问候已生成；子进程负责领取并执行，输入完问候就被杀
    m.run_until(lambda: server_cmd(w, "send_greeting")["server_status"] is not None, what="问候已生成")
    child_writes = _run_until_killed(w, m, start_step="list_new", kill_on="greeting_type")
    assert [r.kind for r in child_writes if r.kind.startswith("greeting")] == ["greeting_type"]

    w.cluster.start_server()
    fake2 = boss_new_greeting(w.clock)
    fake2.goto("detail")  # 会话已打开，聊天区没有我方消息
    screen2 = Screen(fake2)
    m2 = w.monitor(m.identity, screen2)
    m2.run_until(lambda: server_cmd(w, "send_greeting")["server_status"] in ("failed", "unknown"), what="恢复后回报")
    result = server_cmd(w, "send_greeting")["result"]
    assert (result["status"], result["reason"]) in (("failed", "verification_failed"), ("unknown", "crash_recovery"))
    assert screen2.outbound() == []
    assert case_stage(w) == "needs_human"
    assert server_cmd(w, "request_resume")["server_status"] is None  # 问候不明不推进求简历
