"""动作公共层测试，兼作 H1 测试的夹具派生工具（test_actions_greeting / test_actions_request_resume 按路径加载本文件）。

派生规则：从 monitor/fixtures/ax 的真实步骤出发，只追加或删除元素（坐标按窗口相对写，换算成夹具的全局坐标），
重新编号 index；annotations 只保留 page，避免旧的元素引用失效。派生出来的界面变化（发送后出现消息、
确认气泡、系统提示）是 H1 的假设，不是观察结果，真机形态以 N 阶段为准。
"""

from __future__ import annotations

import copy
import json
import sys
import types
import uuid
from collections.abc import Callable, Iterable
from datetime import UTC, datetime, timedelta
from functools import cache
from pathlib import Path
from typing import Any

import pytest
from monitor_contracts import Conversation, Snapshot, validate_command

from monitor.actions import EXTENSION_MODULES, RequestResumeHandler, SendGreetingHandler, create_handlers
from monitor.actions.common import (
    CONVERSATION_TABS,
    EVIDENCE_MAX_CHARS,
    EVIDENCE_MAX_ITEMS,
    NAME_PLACEHOLDER,
    ConversationSession,
    Evidence,
    Stop,
    Waiter,
    chat_area,
    detail_header,
    detect_blockers,
    find_rows,
    find_tab,
    header_matches,
    make_view,
    match_rows,
    norm,
    not_allowed,
    own_messages,
    send_button,
    system_notices,
    toolbar_button,
    unique,
)
from monitor.core import ExecContext, GuardedDriver, ManualClock
from monitor.driver import Advance, FakeDriver

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "ax"
START = datetime(2026, 10, 4, 12, 0, tzinfo=UTC)

CONV_P = {"candidate_name": "候选人P", "job_title": "Vue 前端 研发工程师", "hints": ["昨天"]}
CONV_O = {"candidate_name": "候选人O", "job_title": "Vue 前端 研发工程师", "hints": ["昨天"]}
CONV_A = {"candidate_name": "候选人A", "job_title": "Vue 前端 研发工程师", "hints": []}

# ---------------------------------------------------------------------------
# 夹具派生工具
# ---------------------------------------------------------------------------


@cache
def _raw(scene: str) -> str:
    return (FIXTURES / scene / "fixture.json").read_text()


def load_raw(scene: str) -> dict[str, Any]:
    return json.loads(_raw(scene))


def raw_step(scene: str, index: int) -> dict[str, Any]:
    return copy.deepcopy(load_raw(scene)["steps"][index])


def origin(step: dict[str, Any]) -> tuple[float, float]:
    frame = step["window"]["frame"]
    return frame["x"], frame["y"]


def el(step: dict[str, Any], role: str, rel: tuple[float, float, float, float], *, label: str = "", value: str = "") -> dict:
    """按窗口相对坐标造一个夹具元素（index 由 derive 统一编号）。"""
    ox, oy = origin(step)
    x, y, w, h = rel
    return {"index": 0, "role": role, "label": label, "value": value, "frame": {"x": ox + x, "y": oy + y, "w": w, "h": h}}


def text(step: dict[str, Any], value: str, rel: tuple[float, float, float, float]) -> dict:
    return el(step, "AXStaticText", rel, value=value)


def derive(
    step: dict[str, Any],
    label: str,
    *,
    add: Iterable[dict] = (),
    drop: Callable[[dict], bool] | None = None,
) -> dict[str, Any]:
    new = copy.deepcopy(step)
    elements = [e for e in new["elements"] if not (drop and drop(e))] + [copy.deepcopy(a) for a in add]
    for pos, e in enumerate(elements):
        e["index"] = pos
    new["elements"] = elements
    new["label"] = label
    new["annotations"] = {"page": step["annotations"]["page"]}
    return new


def shifted_copy(step: dict[str, Any], indexes: range, dy: float) -> list[dict]:
    """把一组元素整体下移 dy（造同名同岗位的第二行，用于歧义场景）。"""
    out = []
    for e in step["elements"][indexes.start : indexes.stop]:
        c = copy.deepcopy(e)
        c["frame"]["y"] += dy
        out.append(c)
    return out


# 会话详情里派生元素的位置（窗口相对）。聊天区 = 输入框水平范围（x 511–1389）、表头带以下、输入框（y 788）以上。
def own_message(step: dict[str, Any], body: str, y: float = 700) -> list[dict]:
    """我方消息：右半边的消息文本，左侧同一行有『送达』。"""
    return [text(step, "送达", (1160, y + 11, 24, 13)), text(step, body, (1201, y, 140, 16))]


def notice(step: dict[str, Any], body: str = "简历请求已发送", y: float = 700) -> dict:
    """居中系统提示（与 conversation_detail#0 的『简历请求已发送』同一水平位置）。"""
    return text(step, body, (905, y, 84, 14))


def dialog(step: dict[str, Any], body: str, buttons: Iterable[str], *, x: float = 700, y: float = 690) -> list[dict]:
    """按钮条上方的气泡：一行静态文本 + 下方一排 AXButton（形态同 attachment_entry#1）。"""
    out = [text(step, body, (x, y, 154, 16))]
    for i, b in enumerate(buttons):
        out.append(el(step, "AXButton", (x + 70 + 54 * i, y + 29, 44, 24), label=b))
    return out


def fake(steps: list[dict[str, Any]], *, advances: Iterable[Advance] = (), clock: ManualClock | None = None) -> FakeDriver:
    meta = load_raw("conversation_detail")
    fixture = {k: v for k, v in meta.items() if k != "steps"}
    fixture["scene"] = "h1_derived"
    fixture["steps"] = steps
    return FakeDriver(fixture, advances=advances, clock=(clock or ManualClock(START)).now)


def command(action: str, conversation: dict, payload: dict | None = None, *, mode: str = "execute"):
    return validate_command(
        {
            "command_id": str(uuid.uuid4()),
            "workflow_id": "case-1",
            "account_id": "acct-1",
            "action": action,
            "execution_mode": mode,
            "target": {"conversation": conversation},
            "payload": payload or {},
            "issued_at": (START - timedelta(minutes=1)).isoformat(),
            "expires_at": (START + timedelta(minutes=10)).isoformat(),
            "depends_on": None,
        }
    )


def context(
    driver: FakeDriver, clock: ManualClock, *, allowed: Iterable[str] = (), verify: bool = False
) -> tuple[GuardedDriver, ExecContext]:
    guard = GuardedDriver(driver, mode="verify" if verify else "execute")
    ctx = ExecContext(
        account_id="acct-1",
        device_id="dev-1",
        mode="local",
        allowed_actions=frozenset(allowed),
        deadline=START + timedelta(minutes=10),
        clock=clock.now,
        guard=guard,
    )
    return guard, ctx


def evidence_text(result) -> str:
    return "\n".join(i.text for i in result.evidence) + "\n" + json.dumps(result.observed.model_dump(mode="json"), ensure_ascii=False)


def view_of(step: dict[str, Any]):
    driver = fake([step])
    return make_view(driver.state())


# ---------------------------------------------------------------------------
# 规范化与视图
# ---------------------------------------------------------------------------


def test_norm_collapses_whitespace_bidi_and_fullwidth():
    assert norm("  a‎  b \n") == "a b"
    assert norm("沟通职位：") == norm("沟通职位:")
    assert norm(None) == ""


def test_make_view_drops_pdf_text_layer_but_keeps_preview_container():
    step = raw_step("attachment_entry", 4)
    secret = text(step, "PDF正文 someone@example.com", (400, 300, 300, 16))  # 预览区域内（338,50 765×825）
    view = view_of(derive(step, "pdf", add=[secret]))
    texts = {norm(e.text) for e in view.elements}
    assert "PDF预览" in texts
    assert not any("someone@example.com" in t for t in texts)
    assert "<PDF文字层已脱敏>" not in texts
    assert "切图" not in texts  # 预览工具栏也在区域内
    assert len(view.hidden_regions) == 1
    # 预览区域外的表头仍可读
    assert "候选人N" in texts


def test_make_view_without_preview_is_unchanged():
    step = raw_step("conversation_detail", 0)
    view = view_of(step)
    assert len(view.elements) == len(step["elements"])
    assert view.hidden_regions == ()


# ---------------------------------------------------------------------------
# 弹窗识别：在 B 的全部夹具步骤上与页面标注一致
# ---------------------------------------------------------------------------

# 有弹窗或遮罩的步骤（其余步骤都必须识别为无遮挡）
BLOCKED_STEPS = {
    ("attachment_entry", 1): "dialog",
    ("attachment_entry", 4): "pdf_preview",
    **{("resume_overlay", i): "resume_overlay" for i in range(6)},
    ("new_application_marker", 5): "resume_overlay",
}


@pytest.mark.parametrize("scene", sorted(p.name for p in FIXTURES.iterdir() if (p / "fixture.json").exists()))
def test_detect_blockers_matches_every_fixture_step(scene):
    for i, step in enumerate(load_raw(scene)["steps"]):
        kinds = {b.kind for b in detect_blockers(view_of(step))}
        expected = BLOCKED_STEPS.get((scene, i))
        if expected is None:
            assert kinds == set(), (scene, i, kinds)
        else:
            assert expected in kinds, (scene, i, kinds)


def test_detect_blockers_reads_bubble_text_and_buttons():
    (blocker,) = detect_blockers(view_of(raw_step("attachment_entry", 1)))
    assert blocker.kind == "dialog"
    assert blocker.text == "确定向牛人索取简历吗？"  # 保留界面原文（全角问号）
    assert blocker.button_labels == ("取消", "确认")


def test_detect_blockers_dialog_role_and_window_chrome():
    step = raw_step("conversation_detail", 0)
    sheet = el(step, "AXSheet", (1100, 225, 280, 50))  # 放在聊天区的空白处
    inner = text(step, "登录已失效", (1110, 235, 100, 16))
    blockers = detect_blockers(view_of(derive(step, "sheet", add=[sheet, inner])))
    assert [b.kind for b in blockers] == ["dialog"]
    assert blockers[0].text == "登录已失效"


# ---------------------------------------------------------------------------
# 会话列表与详情
# ---------------------------------------------------------------------------


def test_find_rows_and_match_by_name_job_hints():
    view = view_of(raw_step("conversation_detail", 0))
    assert len(find_rows(view)) == 4
    (row,) = match_rows(view, Conversation(**CONV_P))
    assert "候选人P" in row.texts and not row.unread("候选人P")
    # 任何一项不一致都不命中
    assert match_rows(view, Conversation(**{**CONV_P, "hints": ["16:23"]})) == []
    assert match_rows(view, Conversation(**{**CONV_P, "job_title": "视觉算法工程师"})) == []
    assert match_rows(view, Conversation(**{**CONV_P, "candidate_name": "候选人"})) == []


def test_match_rows_agrees_with_fixture_conversation_annotations():
    """B 标注过的每个会话（姓名 + 岗位 + hints）在该步都恰好命中一行，且就是标注的那一行。"""
    checked = 0
    for p in sorted(FIXTURES.iterdir()):
        if not (p / "fixture.json").exists():
            continue
        for step in load_raw(p.name)["steps"]:
            view = view_of(step)
            for ann in step["annotations"].get("conversations", []):
                rows = match_rows(view, Conversation(**ann["conversation"]))
                assert len(rows) == 1, (p.name, step["label"], ann)
                assert ann["element_index"] == rows[0].container.index
                assert bool(ann.get("unread")) == rows[0].unread(ann["conversation"]["candidate_name"])
                checked += 1
    assert checked >= 20


def test_rows_unread_badge():
    view = view_of(raw_step("conversation_detail", 2))
    conv = Conversation(candidate_name="候选人B", job_title="Vue 前端 研发工程师", hints=["19:03"])
    (row,) = match_rows(view, conv)
    assert row.unread("候选人B")


def test_list_page_rows_without_detail():
    view = view_of(raw_step("conversation_list", 0))
    assert find_rows(view)
    assert detail_header(view) is None
    assert chat_area(view) is None
    assert own_messages(view, "谢谢") == []


def test_detail_header_and_chat_parts():
    view = view_of(raw_step("conversation_detail", 0))
    header = detail_header(view)
    assert header is not None and "候选人P" in header.names and header.job_title == "Vue 前端 研发工程师"
    assert header_matches(view, Conversation(**CONV_P))
    assert not header_matches(view, Conversation(**CONV_O))
    assert len(system_notices(view, "简历请求已发送")) == 1
    # 列表预览里的同一文本（index 80）不算我方消息；聊天区里带『送达』的才算
    (mine,) = own_messages(view, "可以发送一下简历吗？")
    assert mine.index == 125
    # 候选人消息（左侧、无状态）不算
    assert own_messages(view, "我对这个岗位很感兴趣，期待您的回复~") == []
    assert [e.index for e in toolbar_button(view, "求简历")] == [133]
    assert [e.index for e in send_button(view)] == [144]
    assert find_tab(view, "新招呼") is not None and find_tab(view, "全部") is not None


def test_system_notice_must_be_centered_in_chat():
    step = raw_step("conversation_detail", 1)
    off_center = text(step, "简历请求已发送", (1201, 700, 84, 14))  # 右侧：像是一条消息，不是系统提示
    in_list = text(step, "简历请求已发送", (192, 465, 84, 14))  # 列表列里
    view = view_of(derive(step, "x", add=[off_center, in_list]))
    assert system_notices(view, "简历请求已发送") == []


def test_unique_requires_exactly_one():
    view = view_of(raw_step("conversation_detail", 0))
    assert unique(send_button(view), "发送").index == 144
    with pytest.raises(Stop) as e:
        unique([], "发送")
    assert e.value.reason == "target_not_found"
    with pytest.raises(Stop) as e:
        unique(list(view.elements[:2]), "发送")
    assert e.value.reason == "target_ambiguous"


def test_tab_list_includes_new_greetings_first():
    assert CONVERSATION_TABS[0] == "新招呼"


# ---------------------------------------------------------------------------
# 等待
# ---------------------------------------------------------------------------


def test_waiter_times_out_with_injected_clock():
    clock = ManualClock(START)
    driver = fake([raw_step("conversation_detail", 0)], clock=clock)
    found, view = Waiter(clock, timeout=10, interval=0.5).poll(driver, lambda v: None)
    assert found is None and isinstance(view.snapshot, Snapshot)
    assert sum(clock.sleeps) == pytest.approx(10)
    assert clock.now() - START == timedelta(seconds=10)


def test_waiter_returns_as_soon_as_check_passes():
    clock = ManualClock(START)
    driver = fake([raw_step("conversation_detail", 0)], clock=clock)
    reads = []

    def check(v):
        reads.append(v)
        return "ok" if len(reads) == 3 else None

    found, _ = Waiter(clock).poll(driver, check)
    assert found == "ok" and len(reads) == 3 and clock.sleeps == [0.5, 0.5]


def test_waiter_rejects_bad_settings():
    with pytest.raises(ValueError):
        Waiter(ManualClock(START), timeout=0)
    with pytest.raises(ValueError):
        Waiter(ManualClock(START), interval=-1)


# ---------------------------------------------------------------------------
# evidence 与结果
# ---------------------------------------------------------------------------


def test_evidence_redacts_truncates_and_caps():
    ev = Evidence(lambda: START, names=("候选人P",))
    ev.add("候选人P 的邮箱 someone@example.com 电话 13812345678")
    assert ev.items[0].text == f"{NAME_PLACEHOLDER} 的邮箱 [邮箱] 电话 [手机号]"
    ev.add("候选人P 的邮箱 someone@example.com 电话 13812345678")  # 重复不再追加
    assert len(ev.items) == 1
    ev.add("长" * 800)
    assert len(ev.items[1].text) == EVIDENCE_MAX_CHARS
    for i in range(100):
        ev.add(f"条目{i}")
    assert len(ev.items) == EVIDENCE_MAX_ITEMS
    ev.add("   ")
    assert len(ev.items) == EVIDENCE_MAX_ITEMS


def test_not_allowed_result_has_no_flags():
    r = not_allowed("send_greeting")
    assert (r.status, r.reason) == ("failed", "action_not_allowed")
    assert not (r.navigation_performed or r.outbound_action_performed or r.externally_visible_side_effect)
    r.check_for("send_greeting")


def _session(verify=False):
    clock = ManualClock(START)
    driver = fake([raw_step("conversation_detail", 0)], clock=clock)
    guard, ctx = context(driver, clock, allowed={"send_greeting"}, verify=verify)
    cmd = command("send_greeting", CONV_P, {"text": "你好"}, mode="verify_only" if verify else "execute")
    return ConversationSession(cmd, guard, ctx, Waiter(clock), verify=verify), guard


def test_session_result_failed_after_outbound_becomes_unknown():
    s, guard = _session()
    with s.outbound():
        pass
    r = s.result("failed", "timeout", "x")
    assert (r.status, r.reason) == ("unknown", "timeout")
    assert r.outbound_action_performed and r.externally_visible_side_effect and r.executed_at == START


def test_session_result_before_outbound_stays_failed():
    s, _ = _session()
    r = s.result("failed", "target_not_found")
    assert (r.status, r.reason, r.outbound_action_performed) == ("failed", "target_not_found", False)


def test_session_verify_maps_unclear_failures_to_unknown_and_forbids_outbound():
    s, _ = _session(verify=True)
    assert s.result("failed", "target_not_found").status == "unknown"
    assert s.result("failed", "verification_failed").status == "failed"
    with pytest.raises(RuntimeError):
        with s.outbound():
            pass


def test_session_outbound_goes_through_guard():
    s, guard = _session()
    with s.outbound():
        guard.click(send_button(make_view(guard.state()))[0])
    assert guard.outbound_calls == 1 and guard.navigation_calls == 0


# ---------------------------------------------------------------------------
# 注册
# ---------------------------------------------------------------------------


def test_create_handlers_registers_greeting_and_resume_only():
    handlers = create_handlers(clock=ManualClock(START))
    assert [h.action for h in handlers] == ["send_greeting", "request_resume"]
    assert isinstance(handlers[0], SendGreetingHandler) and isinstance(handlers[1], RequestResumeHandler)
    assert EXTENSION_MODULES == ("search", "contact_exchange")


def test_create_handlers_without_clock_uses_system_clock():
    assert len(create_handlers()) == 2


class _Stub:
    def __init__(self, action):
        self.action = action

    def run(self, command, driver, ctx):  # pragma: no cover - 不会被调用
        raise AssertionError

    verify_only = run


def test_create_handlers_picks_up_extension_modules(monkeypatch):
    mod = types.ModuleType("monitor.actions.search")
    seen = {}

    def factory(*, clock):
        seen["clock"] = clock
        return [_Stub("search_candidates")]

    mod.create_handlers = factory
    monkeypatch.setitem(sys.modules, "monitor.actions.search", mod)
    clock = ManualClock(START)
    assert [h.action for h in create_handlers(clock=clock)][-1] == "search_candidates"
    assert seen["clock"] is clock


def test_create_handlers_rejects_duplicate_action(monkeypatch):
    mod = types.ModuleType("monitor.actions.contact_exchange")
    mod.create_handlers = lambda *, clock: [_Stub("send_greeting")]
    monkeypatch.setitem(sys.modules, "monitor.actions.contact_exchange", mod)
    with pytest.raises(ValueError, match="重复注册"):
        create_handlers(clock=ManualClock(START))


def test_create_handlers_does_not_swallow_broken_extension(monkeypatch):
    import importlib

    real = importlib.import_module

    def broken(name, *a, **k):
        if name == "monitor.actions.search":
            raise ModuleNotFoundError("No module named 'nonexistent_dep'", name="nonexistent_dep")
        return real(name, *a, **k)

    monkeypatch.setattr(importlib, "import_module", broken)
    with pytest.raises(ModuleNotFoundError):
        create_handlers(clock=ManualClock(START))


# ---------------------------------------------------------------------------
# 接入 D2：经过真实的 MonitorRuntime / Pipeline / GuardedDriver（core.testing 的内存账本与 fake 服务端）
# ---------------------------------------------------------------------------


def _runtime_env(steps, advances, *, allowed):
    from monitor.core.testing import make_env, make_policy

    driver = fake(steps, advances=advances)
    env = make_env(driver=driver, policy=make_policy(allowed_actions=list(allowed)))
    env.handlers = {hd.action: hd for hd in create_handlers(clock=env.clock)}
    env.new_runtime()
    return env, driver


def _runtime_command(env, action, conversation, payload):
    cmd = env.cmd(action)
    cmd["target"] = {"conversation": conversation}
    cmd["payload"] = payload
    return cmd


def _result_of(env, cmd):
    env.run_until(lambda: cmd["command_id"] in env.server.results, advance=1)
    return env.server.results[cmd["command_id"]]


def test_runtime_request_resume_with_confirmation_end_to_end():
    from monitor_contracts import Locator

    b = raw_step("conversation_detail", 1)
    steps = [b, derive(b, "气泡", add=dialog(b, "确定向牛人索取简历吗？", ["取消", "确认"])), derive(b, "已请求", add=[notice(b)])]
    advances = [
        Advance("click", on_step=0, target=Locator(text="求简历"), goto=1),
        Advance("click", on_step=1, target=Locator(text="确认", role="AXButton"), goto=2),
    ]
    env, driver = _runtime_env(steps, advances, allowed=["request_resume"])
    cmd = _runtime_command(env, "request_resume", CONV_O, {})
    env.server.enqueue(cmd)
    result = _result_of(env, cmd)
    assert result["status"] == "succeeded" and result["reason"] is None
    assert result["navigation_performed"] and result["outbound_action_performed"]
    assert result["externally_visible_side_effect"] and result["executed_at"] is not None
    assert [c.element.text for c in driver.writes if c.element is not None][1:] == ["求简历", "确认"]


def test_runtime_greeting_whitelist_closed_reports_not_allowed_without_driver():
    b = raw_step("conversation_detail", 1)
    env, driver = _runtime_env([b], (), allowed=["request_resume"])
    cmd = _runtime_command(env, "send_greeting", CONV_O, {"text": "你好"})
    env.server.enqueue(cmd)
    result = _result_of(env, cmd)
    assert (result["status"], result["reason"]) == ("failed", "action_not_allowed")
    assert driver.count() == 0
    assert not (result["navigation_performed"] or result["outbound_action_performed"])


def test_runtime_greeting_timeout_is_unknown_and_counts_outbound():
    b = raw_step("conversation_detail", 1)
    env, driver = _runtime_env([b], (), allowed=["send_greeting"])
    cmd = _runtime_command(env, "send_greeting", CONV_O, {"text": "你好，方便聊聊吗？"})
    env.server.enqueue(cmd)
    result = _result_of(env, cmd)
    assert (result["status"], result["reason"]) == ("unknown", "timeout")
    assert result["outbound_action_performed"] and driver.count("type_text") == 1


def test_runtime_verify_only_never_types():
    b = raw_step("conversation_detail", 0)
    env, driver = _runtime_env([b], (), allowed=[])
    cmd = _runtime_command(env, "send_greeting", CONV_P, {"text": "可以发送一下简历吗？"})
    cmd["execution_mode"] = "verify_only"
    env.server.enqueue(cmd)
    result = _result_of(env, cmd)
    assert result["status"] == "succeeded" and not result["outbound_action_performed"]
    assert driver.count("type_text") == 0 and driver.count("click") == 1
