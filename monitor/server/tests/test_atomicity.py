"""F2b：指令创建与流程更新的原子性，以及崩溃后重启的恢复。

不重复发送是底线：无论在"创建指令"和"更新 case"之间抛异常，还是进程在 F1 落库之后、F2 处理之前崩溃，
重做之后每一步都只有一条指令，case 状态与指令一致。
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

import pytest
from server_testkit import (
    CONSOLE_TOKEN,
    SERVICE_TOKEN,
    T0,
    Harness,
    auto_policy,
    case_commands,
    claim_all,
    observe,
    only_case,
    run_command,
)

from app.db import CommandRow, FakeClock, ManualActionRow, SqliteStore
from app.events import InProcessEventBus
from app.main import StaticTokenAuthenticator, create_app


class FileHarness(Harness):
    """用文件数据库的 Harness，可以"重启"：关掉应用、在同一个库上重新创建。"""

    def __init__(self, path: Path, clock: FakeClock | None = None):  # noqa: D107 - 覆盖父类以换存储
        from fastapi.testclient import TestClient

        self.path = path
        self.clock = clock or FakeClock(T0)
        self.store = SqliteStore(path)
        self.bus = InProcessEventBus()
        self.messages: list[Any] = []
        self.bus.subscribe(self.messages.append)
        self.app = create_app(
            store=self.store,
            clock=self.clock,
            console_auth=StaticTokenAuthenticator({CONSOLE_TOKEN: "alice"}),
            service_auth=StaticTokenAuthenticator({SERVICE_TOKEN: "mail-ingest"}),
            bus=self.bus,
        )
        self.ctx = self.app.state.ctx
        self.client = TestClient(self.app)

    def crash_before_f2(self) -> None:
        """模拟"F1 已提交、F2 还没处理"时进程崩溃：断开编排对总线的订阅。"""
        self.ctx.orchestrator.close()

    def restart(self) -> FileHarness:
        self.client.close()
        self.store.close()
        return FileHarness(self.path, self.clock)


@pytest.fixture
def fh(tmp_path: Path):
    harness = FileHarness(tmp_path / "server.db")
    holder = {"h": harness}
    yield holder
    holder["h"].client.close()
    holder["h"].store.close()


def commands_in_db(h: Harness, action: str | None = None) -> list[CommandRow]:
    rows = h.ctx.store._all("SELECT command_id FROM commands ORDER BY seq")
    out = [h.ctx.store.get_command(r["command_id"]) for r in rows]
    return [c for c in out if c is not None and (action is None or c.action == action)]


class Boom(RuntimeError):
    pass


def boom(*_: Any, **__: Any) -> None:
    raise Boom("模拟在创建指令与更新流程之间失败")


# ---------------------------------------------------------------------------
# 存储层：调用方事务与嵌套
# ---------------------------------------------------------------------------


def _row(account: str = "acct_demo") -> CommandRow:
    command_id = str(uuid.uuid4())
    return CommandRow(
        command_id=command_id,
        account_id=account,
        action="send_greeting",
        command={"command_id": command_id, "issued_at": "2026-10-04T01:30:00Z"},
        expires_at="2026-10-04T02:30:00.000000+00:00",
        created_at="2026-10-04T01:30:00.000000+00:00",
    )


def _manual(target: str) -> ManualActionRow:
    return ManualActionRow(
        f"ma_{uuid.uuid4().hex}", "recheck", "alice", "2026-10-04T01:30:00.000000+00:00", "", "command", target
    )


def test_transaction_commits_together_and_rolls_back_together():
    store = SqliteStore()
    ok_row, bad_row = _row(), _row()
    with store.transaction():
        assert store.insert_command(ok_row)
        store.insert_manual_action(_manual(ok_row.command_id))
    assert store.get_command(ok_row.command_id) is not None
    with pytest.raises(Boom), store.transaction():
        store.insert_command(bad_row)
        store.insert_manual_action(_manual(bad_row.command_id))
        raise Boom()
    assert store.get_command(bad_row.command_id) is None
    assert store.list_manual_actions("command", bad_row.command_id) == []
    store.close()


def test_nested_failure_rolls_back_only_inner_block():
    store = SqliteStore()
    outer, inner = _row(), _row()
    with store.transaction():
        store.insert_command(outer)
        with pytest.raises(Boom), store.transaction():
            store.insert_command(inner)
            raise Boom()
        assert store.get_command(inner.command_id) is None
    assert store.get_command(outer.command_id) is not None
    # 事务结束后连接回到自动提交状态，后续写入正常
    assert store.insert_command(_row())
    store.close()


# ---------------------------------------------------------------------------
# 两步之间抛异常：整体回滚，重做后只有一条指令
# ---------------------------------------------------------------------------


def test_failure_after_auto_command_insert_rolls_back_and_recovers_once(h: Harness, monkeypatch):
    device_id, token = h.ready_device()
    auto_policy(h)
    monkeypatch.setattr(h.ctx.cases.repo, "register_command", boom)
    event = observe(h, device_id, token)  # 事件已由 F1 提交；F2 处理中途失败（总线吞掉异常）
    assert h.bus.failures == 1
    assert commands_in_db(h) == []  # 已插入的问候指令随事务回滚
    assert h.get("/cases").json()["items"] == []
    assert h.store.get_event(event["event_id"]).case_id is None

    monkeypatch.undo()
    h.ctx.orchestrator.tick()  # 恢复步骤重做这条事件
    h.ctx.orchestrator.tick()  # 再做一次也不会重复
    case = only_case(h)
    assert [c.action for c in commands_in_db(h)] == ["send_greeting"]
    assert h.ctx.cases.get(case["case_id"]).next_action is None
    assert h.store.get_event(event["event_id"]).case_id == case["case_id"]
    assert [c["action"] for c in claim_all(h, device_id, token)] == ["send_greeting"]


def test_failure_after_resume_request_insert_keeps_case_consistent(h: Harness, monkeypatch):
    device_id, token = h.ready_device()
    auto_policy(h)
    observe(h, device_id, token)
    [greeting] = claim_all(h, device_id, token)
    monkeypatch.setattr(h.ctx.cases.repo, "register_command", boom)
    run_command(h, device_id, token, greeting)  # 结果已记录；F2 生成求简历时失败
    assert commands_in_db(h, "request_resume") == []
    assert only_case(h)["stage"] == "new_application"  # 阶段与指令一致：没有半截状态

    monkeypatch.undo()
    h.ctx.orchestrator.tick()
    h.ctx.orchestrator.tick()
    assert [c.action for c in commands_in_db(h)] == ["send_greeting", "request_resume"]
    assert commands_in_db(h, "request_resume")[0].depends_on == greeting["command_id"]
    assert only_case(h)["stage"] == "greeted"


def test_failure_inside_manual_wechat_leaves_nothing(h: Harness, monkeypatch):
    device_id, token = h.ready_device()
    auto_policy(h, greeting=False, auto_request_resume=False)
    observe(h, device_id, token)
    case_id = only_case(h)["case_id"]
    monkeypatch.setattr(h.ctx.cases.repo, "register_command", boom)
    with pytest.raises(Boom):
        h.post(f"/cases/{case_id}:request-wechat", {"note": "约面试"}, key="click-wechat-1")
    assert commands_in_db(h) == []
    assert h.store.list_manual_actions("case", case_id) == []
    assert only_case(h)["stage"] == "new_application"

    monkeypatch.undo()
    resp = h.post(f"/cases/{case_id}:request-wechat", {"note": "约面试"}, key="click-wechat-1")  # 控制台重试
    assert resp.status_code == 201
    assert [c.action for c in commands_in_db(h)] == ["request_contact_exchange"]
    assert len(h.store.list_manual_actions("case", case_id)) == 1
    assert only_case(h)["stage"] == "contact_requested"


def test_failure_inside_recheck_and_stop_leaves_nothing(h: Harness, monkeypatch):
    device_id, token = h.ready_device()
    auto_policy(h)
    observe(h, device_id, token)
    [greeting] = claim_all(h, device_id, token)
    run_command(h, device_id, token, greeting, "unknown")
    case_id = only_case(h)["case_id"]

    monkeypatch.setattr(h.ctx.cases.repo, "register_command", boom)
    with pytest.raises(Boom):
        h.post(f"/commands/{greeting['command_id']}:recheck")
    assert len(commands_in_db(h)) == 1
    assert h.store.list_manual_actions("command", greeting["command_id"]) == []
    monkeypatch.undo()

    monkeypatch.setattr(h.ctx.cases, "transition", boom)
    with pytest.raises(Boom):
        h.post(f"/cases/{case_id}:stop", {"note": "停止"})
    assert h.store.list_manual_actions("case", case_id) == []
    assert only_case(h)["stage"] == "needs_human"


def test_failure_inside_confirm_sent_rolls_back_manual_record(h: Harness, monkeypatch):
    device_id, token = h.ready_device()
    auto_policy(h)
    observe(h, device_id, token)
    [greeting] = claim_all(h, device_id, token)
    run_command(h, device_id, token, greeting, "unknown")
    monkeypatch.setattr(h.ctx.cases.repo, "register_command", boom)  # 确认后生成求简历时失败
    path = f"/commands/{greeting['command_id']}:confirm-sent"
    with pytest.raises(Boom):
        h.post(path, {"note": "手机上看到已发"})
    assert h.store.list_manual_actions("command", greeting["command_id"]) == []
    assert only_case(h)["stage"] == "needs_human"
    monkeypatch.undo()
    assert h.post(path, {"note": "手机上看到已发"}).status_code == 200
    assert [c.action for c in commands_in_db(h)] == ["send_greeting", "request_resume"]
    assert only_case(h)["stage"] == "greeted"


def test_tick_continues_after_one_case_fails(h: Harness, monkeypatch):
    device_id, token = h.ready_device()
    window = {"timezone": "Asia/Shanghai", "windows": [{"days": [7], "start": "10:00", "end": "12:00"}]}
    auto_policy(h, work_hours=window)
    from server_testkit import conversation

    observe(h, device_id, token, conversation("甲"))
    observe(h, device_id, token, conversation("乙"))
    h.clock.advance(31 * 60)
    orch = h.ctx.orchestrator
    real = orch.advance
    first = {"done": False}

    def flaky(case_id: str):
        if not first["done"]:
            first["done"] = True
            raise Boom()
        return real(case_id)

    monkeypatch.setattr(orch, "advance", flaky)
    orch.tick()
    assert len(commands_in_db(h)) == 1  # 一个失败、另一个照常
    monkeypatch.undo()
    orch.tick()
    assert len(commands_in_db(h)) == 2


# ---------------------------------------------------------------------------
# 进程崩溃后重启
# ---------------------------------------------------------------------------


def test_crash_after_event_commit_recovers_on_restart(fh):
    h: FileHarness = fh["h"]
    device_id, token = h.ready_device()
    auto_policy(h)
    h.crash_before_f2()
    observe(h, device_id, token)
    assert h.get("/cases").json()["items"] == []

    h = fh["h"] = h.restart()
    h.ctx.orchestrator.tick()  # 部署时由启动时的后台定时器执行
    h.ctx.orchestrator.tick()
    case = only_case(h)
    assert case["stage"] == "new_application"
    assert [c.action for c in commands_in_db(h)] == ["send_greeting"]
    assert [c["action"] for c in claim_all(h, device_id, token)] == ["send_greeting"]


def test_crash_after_result_commit_recovers_on_restart(fh):
    h: FileHarness = fh["h"]
    device_id, token = h.ready_device()
    auto_policy(h)
    observe(h, device_id, token)
    [greeting] = claim_all(h, device_id, token)
    h.crash_before_f2()
    run_command(h, device_id, token, greeting)
    assert only_case(h)["stage"] == "new_application" and len(commands_in_db(h)) == 1

    h = fh["h"] = h.restart()
    h.ctx.orchestrator.tick()
    h.ctx.orchestrator.tick()
    assert only_case(h)["stage"] == "greeted"
    assert [c.action for c in commands_in_db(h)] == ["send_greeting", "request_resume"]
    # 恢复后的流程继续正常推进
    [resume] = claim_all(h, device_id, token)
    run_command(h, device_id, token, resume)
    assert only_case(h)["stage"] == "resume_requested"
    assert case_commands(h, only_case(h)["case_id"])[-1]["action"] == "request_resume"


def test_live_delivery_after_recovery_is_skipped(h: Harness):
    """恢复步骤先处理了，总线消息稍后到达时不再处理一遍（反之亦然）。"""
    device_id, token = h.ready_device()
    auto_policy(h)
    observe(h, device_id, token)
    [greeting] = claim_all(h, device_id, token)
    run_command(h, device_id, token, greeting)
    msg = next(m for m in h.messages if type(m).__name__ == "CommandResultRecorded")
    h.ctx.orchestrator.handle(msg)  # 重复投递
    event_msg = next(m for m in h.messages if type(m).__name__ == "EventReceived")
    h.ctx.orchestrator.handle(event_msg)
    assert [c.action for c in commands_in_db(h)] == ["send_greeting", "request_resume"]
    assert len(h.get("/cases").json()["items"]) == 1
    assert h.ctx.orchestrator.recover() == 0
