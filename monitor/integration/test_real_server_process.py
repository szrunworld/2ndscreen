"""冒烟：真实服务端进程（uvicorn，经 scripts/serve.py 启动，含 lifespan 后台推进）+ 真实 HTTP。

其余集成测试用进程内 ASGI 以便控制时钟；这里只验证同一套装配在真实进程、真实套接字上也能完成
注册 → 绑定 → 心跳 → 取策略 → 领取（空），以及进程正常退出。
"""

from __future__ import annotations

import os
import selectors
import signal
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

from integration_kit import ACCOUNT, MONITOR_DIR, WORK_HOURS_ALL_DAY, new_key
from monitor.core import CommandClient, MonitorRuntime, RuntimeConfig, SystemClock
from monitor.install.register import build_registration, register_device
from monitor.ledger import open_ledger

SERVE = MONITOR_DIR / "scripts" / "serve.py"
TOKEN = "smoke-console-token"


def _wait_ready(proc: subprocess.Popen, timeout: float = 30.0) -> str:
    """读 stderr 直到出现就绪行（按事件等待，不是固定 sleep）。"""
    sel = selectors.DefaultSelector()
    sel.register(proc.stderr, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout
    seen = []
    while time.monotonic() < deadline:
        if not sel.select(timeout=deadline - time.monotonic()):
            break
        line = proc.stderr.readline()
        if not line:
            break
        seen.append(line)
        if line.startswith("monitor-server ready "):
            return line.split()[-1]
    proc.kill()
    raise AssertionError("服务端没有就绪：" + "".join(seen)[-2000:])


@pytest.fixture
def server_url(tmp_path: Path):
    env = dict(os.environ, MONITOR_CONSOLE_TOKENS=f"{TOKEN}=smoke@example.com")
    proc = subprocess.Popen(
        [sys.executable, str(SERVE), "--db", str(tmp_path / "server.db"), "--port", "0"],
        cwd=MONITOR_DIR, env=env, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, text=True,
    )
    try:
        yield _wait_ready(proc)
    finally:
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()
            raise


def test_register_bind_heartbeat_against_real_process(server_url: str, tmp_path: Path):
    console = httpx.Client(base_url=server_url, headers={"Authorization": f"Bearer {TOKEN}"}, timeout=10)
    code = console.post("/device-enrollments", json={"mode": "remote"}, headers={"Idempotency-Key": new_key()}).json()[
        "enrollment_code"
    ]
    body = build_registration(
        enrollment_code=code, device_name="smoke", mode="remote", capabilities=["observe"], os_version="15", arch="arm64"
    )
    reg = register_device(server_url, body, allow_insecure_http=True)
    r = console.put(f"/devices/{reg.device_id}/account-binding", json={"account_id": ACCOUNT}, headers={"Idempotency-Key": new_key()})
    assert r.status_code == 200, r.text
    policy = console.get(f"/accounts/{ACCOUNT}/policy").json()
    policy["work_hours"] = WORK_HOURS_ALL_DAY
    r = console.put(
        f"/accounts/{ACCOUNT}/policy", json=policy,
        headers={"Idempotency-Key": new_key(), "If-Match": str(policy["policy_version"])},
    )
    assert r.status_code == 200, r.text

    clock = SystemClock()
    ledger = open_ledger(tmp_path / "monitor.db")
    client = CommandClient(base_url=server_url, device_id=reg.device_id, token=reg.device_token, now=clock.now)
    rt = MonitorRuntime(
        config=RuntimeConfig(device_id=reg.device_id, mode="remote", claim_wait_seconds=0),
        ledger=ledger, driver=None, client=client, handlers={}, clock=clock, observer=None,  # type: ignore[arg-type]
    )
    rt.bind_account(ACCOUNT, confirmed_by="smoke@example.com")  # 缺陷 M-1 的替代步骤
    for _ in range(10):
        rt.run_once()
        if rt.account_confirmed and rt.policy is not None and not rt.state.needs_baseline:
            break
    rt.run_once()  # 领取一次（空）
    assert rt.account_confirmed is True and rt.policy is not None and rt.revoked is False
    dev = console.get(f"/devices/{reg.device_id}").json()
    assert dev["status"] == "online" and dev["last_heartbeat"]["account_id"] == ACCOUNT
    client.close()
    ledger.close()
    console.close()


def test_serve_script_refuses_to_start_without_console_tokens(tmp_path: Path):
    env = {k: v for k, v in os.environ.items() if k != "MONITOR_CONSOLE_TOKENS"}
    proc = subprocess.run(
        [sys.executable, str(SERVE), "--db", str(tmp_path / "s.db"), "--port", "0"],
        cwd=MONITOR_DIR, env=env, capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 2 and "MONITOR_CONSOLE_TOKENS" in proc.stderr
