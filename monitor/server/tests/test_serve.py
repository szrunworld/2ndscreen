"""服务端正式入口的配置（缺陷 M-4）：控制台 / 服务令牌来自环境变量、令牌文件、命令行，令牌不进日志。"""

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
from fastapi.testclient import TestClient

from app import main as app_main
from app import serve
from app.db import FakeClock
from app.main import hash_token
from app.notify import WebhookNotifier

SERVER_DIR = Path(__file__).resolve().parents[1]
CONSOLE = "console-token-0123456789"
CONSOLE_2 = "console-token-abcdefghij"
SERVICE = "service-token-0123456789"


def load(argv: list[str] | None = None, **env: str) -> serve.ServeConfig:
    return serve.load_config(argv or [], env)


# ---------------------------------------------------------------------------
# 配置解析
# ---------------------------------------------------------------------------


def test_tokens_from_environment():
    cfg = load(
        MONITOR_CONSOLE_TOKENS=f"{CONSOLE}=alice@example.com, {CONSOLE_2}=bob",
        MONITOR_SERVICE_TOKENS=f"{SERVICE}=mail-ingest",
    )
    assert cfg.console_tokens == {CONSOLE: "alice@example.com", CONSOLE_2: "bob"}
    assert cfg.service_tokens == {SERVICE: "mail-ingest"}
    assert (cfg.db, cfg.host, cfg.port) == ("monitor_server.db", "127.0.0.1", 8000)
    assert cfg.webhook_url is None


def test_tokens_from_command_line_and_files(tmp_path: Path):
    console_file = tmp_path / "console.tokens"
    console_file.write_text(f"# 控制台令牌\n{CONSOLE}=alice\n\n{CONSOLE_2}=bob\n", encoding="utf-8")
    service_file = tmp_path / "service.tokens"
    service_file.write_text(f"{SERVICE}=mail-ingest\n", encoding="utf-8")
    cfg = load(
        [
            "--db", "x.db", "--host", "0.0.0.0", "--port", "0",
            "--console-tokens-file", str(console_file),
            "--service-tokens-file", str(service_file),
            "--console-token", "cli-console-token-000=carol",
            "--service-token", "cli-service-token-000=search",
        ]
    )  # fmt: skip
    assert (cfg.db, cfg.host, cfg.port) == ("x.db", "0.0.0.0", 0)
    assert cfg.console_tokens == {CONSOLE: "alice", CONSOLE_2: "bob", "cli-console-token-000": "carol"}
    assert cfg.service_tokens == {SERVICE: "mail-ingest", "cli-service-token-000": "search"}


def test_sources_are_merged_and_same_mapping_is_allowed():
    cfg = load(
        ["--console-token", f"{CONSOLE}=alice", "--console-token", f"{CONSOLE_2}=bob"],
        MONITOR_CONSOLE_TOKENS=f"{CONSOLE}=alice",
    )
    assert cfg.console_tokens == {CONSOLE: "alice", CONSOLE_2: "bob"}


@pytest.mark.parametrize(
    ("argv", "env", "needle"),
    [
        ([], {}, "MONITOR_CONSOLE_TOKENS"),
        ([], {"MONITOR_CONSOLE_TOKENS": " , "}, "MONITOR_CONSOLE_TOKENS"),
        ([], {"MONITOR_CONSOLE_TOKENS": CONSOLE}, "令牌=操作者"),
        ([], {"MONITOR_CONSOLE_TOKENS": f"{CONSOLE}="}, "令牌=操作者"),
        ([], {"MONITOR_CONSOLE_TOKENS": "short=alice"}, "太短"),
        ([], {"MONITOR_CONSOLE_TOKENS": f"{CONSOLE}={'a' * 129}"}, "128"),
        (["--console-token", f"{CONSOLE}=bob"], {"MONITOR_CONSOLE_TOKENS": f"{CONSOLE}=alice"}, "不同操作者"),
        ([], {"MONITOR_CONSOLE_TOKENS": f"{CONSOLE}=alice", "MONITOR_SERVICE_TOKENS": f"{CONSOLE}=mail"}, "同时"),
        ([], {"MONITOR_CONSOLE_TOKENS": f"{CONSOLE}=alice", "MONITOR_WEBHOOK_SECRET": "s3cret"}, "MONITOR_WEBHOOK_URL"),
        (["--console-tokens-file", "/nonexistent/console.tokens"], {}, "读不到令牌文件"),
    ],
)
def test_config_errors_never_echo_tokens(argv, env, needle):
    with pytest.raises(serve.ConfigError) as info:
        serve.load_config(argv, env)
    message = str(info.value)
    assert needle in message
    for secret in (CONSOLE, "short", "s3cret"):
        assert secret not in message


def test_repr_and_summary_hide_secrets():
    cfg = load(
        MONITOR_CONSOLE_TOKENS=f"{CONSOLE}=alice",
        MONITOR_SERVICE_TOKENS=f"{SERVICE}=mail-ingest",
        MONITOR_WEBHOOK_URL="https://hooks.example.com/monitor",
        MONITOR_WEBHOOK_SECRET="webhook-secret-xyz",
    )
    for text in (repr(cfg), cfg.summary()):
        assert CONSOLE not in text and SERVICE not in text and "webhook-secret-xyz" not in text
    assert "alice" in cfg.summary() and "控制台令牌 1 个" in cfg.summary()


# ---------------------------------------------------------------------------
# 装配
# ---------------------------------------------------------------------------


def test_build_app_authenticates_configured_tokens(tmp_path: Path):
    cfg = load(
        ["--db", str(tmp_path / "s.db")],
        MONITOR_CONSOLE_TOKENS=f"{CONSOLE}=alice",
        MONITOR_SERVICE_TOKENS=f"{SERVICE}=mail-ingest",
    )
    app = serve.build_app(cfg, clock=FakeClock())
    client = TestClient(app)
    key = {"Idempotency-Key": "test-serve-0001"}
    resp = client.post(
        "/api/v1/device-enrollments", json={"mode": "local"}, headers={"Authorization": f"Bearer {CONSOLE}", **key}
    )
    assert resp.status_code == 201, resp.text
    enrollment = app.state.ctx.store.get_enrollment(hash_token(resp.json()["enrollment_code"]))
    assert enrollment is not None and enrollment.created_by == "alice"
    # 服务令牌只能调用允许 serviceToken 的接口，不能当控制台会话
    assert client.get("/api/v1/mail-messages", headers={"Authorization": f"Bearer {SERVICE}"}).status_code == 200
    denied = client.post(
        "/api/v1/device-enrollments", json={"mode": "local"}, headers={"Authorization": f"Bearer {SERVICE}", **key}
    )
    assert denied.status_code == 401
    assert client.get("/api/v1/devices", headers={"Authorization": "Bearer wrong-token-000000000"}).status_code == 401


def test_build_app_installs_webhook_notifier(tmp_path: Path):
    cfg = load(
        ["--db", str(tmp_path / "s.db")],
        MONITOR_CONSOLE_TOKENS=f"{CONSOLE}=alice",
        MONITOR_WEBHOOK_URL="https://hooks.example.com/monitor",
        MONITOR_WEBHOOK_SECRET="webhook-secret-xyz",
    )
    ctx = serve.build_app(cfg, clock=FakeClock()).state.ctx
    webhooks = [n for n in ctx.notifications.notifiers if isinstance(n, WebhookNotifier)]
    assert [w.url for w in webhooks] == ["https://hooks.example.com/monitor"]


def test_main_serve_dispatches_to_entry(monkeypatch, capsys):
    seen = []
    monkeypatch.setenv("MONITOR_CONSOLE_TOKENS", f"{CONSOLE}=alice")
    monkeypatch.setattr(serve, "run", seen.append)
    assert app_main.main(["serve", "--db", "x.db", "--port", "0"]) == 0
    assert len(seen) == 1 and seen[0].console_tokens == {CONSOLE: "alice"} and seen[0].port == 0


def test_main_serve_without_console_tokens_exits_2(monkeypatch, capsys):
    monkeypatch.delenv("MONITOR_CONSOLE_TOKENS", raising=False)
    monkeypatch.setenv("MONITOR_SERVICE_TOKENS", f"{SERVICE}=mail-ingest")
    assert app_main.main(["serve", "--db", "x.db"]) == 2
    err = capsys.readouterr().err
    assert "MONITOR_CONSOLE_TOKENS" in err and SERVICE not in err


# ---------------------------------------------------------------------------
# 真实进程：python -m app.main serve
# ---------------------------------------------------------------------------


def _read_until_ready(proc: subprocess.Popen, timeout: float = 30.0) -> tuple[str, list[str]]:
    """读 stderr 直到就绪行（按事件等待，不是固定 sleep）。"""
    sel = selectors.DefaultSelector()
    sel.register(proc.stderr, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout
    seen: list[str] = []
    while time.monotonic() < deadline:
        if not sel.select(timeout=deadline - time.monotonic()):
            break
        line = proc.stderr.readline()
        if not line:
            break
        seen.append(line)
        if line.startswith("monitor-server ready "):
            return line.split()[-1], seen
    proc.kill()
    raise AssertionError("服务端没有就绪：" + "".join(seen)[-2000:])


def test_real_process_uses_env_tokens_and_keeps_them_out_of_logs(tmp_path: Path):
    env = dict(os.environ, MONITOR_CONSOLE_TOKENS=f"{CONSOLE}=alice", MONITOR_SERVICE_TOKENS=f"{SERVICE}=mail-ingest")
    proc = subprocess.Popen(
        [sys.executable, "-m", "app.main", "serve", "--db", str(tmp_path / "s.db"), "--port", "0"],
        cwd=SERVER_DIR, env=env, stderr=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
    )  # fmt: skip
    try:
        url, logs = _read_until_ready(proc)
        with httpx.Client(base_url=url, timeout=10) as http:
            ok = http.post(
                "/device-enrollments",
                json={"mode": "remote"},
                headers={"Authorization": f"Bearer {CONSOLE}", "Idempotency-Key": "test-serve-real-0001"},
            )
            assert ok.status_code == 201, ok.text
            assert http.get("/devices", headers={"Authorization": "Bearer nope-nope-nope-nope"}).status_code == 401
    finally:
        proc.send_signal(signal.SIGTERM)
        try:
            out, err = proc.communicate(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()
            raise
    text = "".join(logs) + err + out
    assert "控制台令牌 1 个（alice）" in text
    assert CONSOLE not in text and SERVICE not in text
