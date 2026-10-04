"""FakeDriver 测试：回放录制的 TextEdit 示例夹具、手写夹具，以及 B 的全部夹具（若已存在）。"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from monitor_contracts import (
    ContractValidationError,
    Driver,
    Frame,
    Locator,
    StaleSnapshotError,
    TargetAmbiguousError,
    TargetNotFoundError,
    WindowLostError,
    WindowSelector,
)

from monitor.driver import Advance, FakeDriver, load_fixture

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"
EXAMPLE = FIXTURES / "cli-samples" / "recorded" / "textedit_fixture.json"
B_FIXTURES = sorted((FIXTURES / "ax").glob("**/fixture.json"))


def chat_fixture() -> dict:
    """手写的两行会话列表 → 点"求简历"后出现确认 → 确认后显示已请求。姓名均为占位。"""

    def element(index, role, label="", value="", frame=(0, 0, 10, 10)):
        x, y, w, h = frame
        return {"index": index, "role": role, "label": label, "value": value,
                "frame": {"x": x, "y": y, "w": w, "h": h}, "enabled": True}

    window = {"window_id": 1, "title": "示例", "frame": {"x": 0, "y": 0, "w": 800, "h": 600}, "pid": 42, "app_name": "Demo"}
    rows = [
        element(0, "AXStaticText", value="候选人A", frame=(10, 10, 60, 20)),
        element(1, "AXButton", "求简历", frame=(300, 8, 60, 24)),
        element(2, "AXStaticText", value="候选人B", frame=(10, 50, 60, 20)),
        element(3, "AXButton", "求简历", frame=(300, 48, 60, 24)),
    ]
    confirm = rows + [element(4, "AXButton", "确定", frame=(400, 300, 60, 24))]
    done = rows[:3] + [element(3, "AXStaticText", value="已请求", frame=(300, 48, 60, 24))]
    return {
        "fixture_version": 1,
        "scene": "chat_demo",
        "description": "测试用手写夹具",
        "recorded_at": "2026-10-04T00:00:00+00:00",
        "source": {"app": "Demo", "driver": "hand-written"},
        "redaction": {"names_replaced": True, "phones_removed": True, "wechat_removed": True},
        "steps": [
            {"label": "列表", "window": window, "elements": rows, "annotations": {"page": "conversation_list"}},
            {"label": "确认弹窗", "window": window, "elements": confirm, "annotations": {"page": "unknown_dialog"}},
            {"label": "已请求", "window": window, "elements": done, "annotations": {"page": "conversation_list"}},
        ],
    }


def test_conforms_to_protocol():
    assert isinstance(FakeDriver(EXAMPLE), Driver)


def test_example_fixture_replay_and_write_count():
    fixture = load_fixture(EXAMPLE)
    fake = FakeDriver(EXAMPLE, advances=[Advance(method="click", target=Locator(text="italic"))])
    first = fake.state()
    assert [e.label for e in first.elements] == [e.label for e in fixture.steps[0].elements]
    assert all(e.snapshot_id == first.snapshot_id for e in first.elements)
    fake.click(Locator(text="bold"))  # 不满足规则，不前进
    assert fake.step.label == "初始"
    fake.click(Locator(text="italic"))
    assert fake.step.label == "点了斜体之后"
    fake.type_text(None, "x")
    fake.key("cmd+a")
    assert fake.count("click") == 2 and fake.count("type_text") == 1 and fake.count("key") == 1
    assert fake.count() == 4
    assert [c.step for c in fake.writes] == ["初始", "初始", "点了斜体之后", "点了斜体之后"]
    assert fake.writes[1].element.label == "italic"
    second = fake.state(include_tree=True)
    assert second.elements[14].parent_index == 12


def test_state_ids_change_and_tree_fields_hidden_by_default():
    fake = FakeDriver(EXAMPLE)
    a, b = fake.state(), fake.state()
    assert a.snapshot_id != b.snapshot_id
    fake.goto(1)
    assert all(e.parent_index is None for e in fake.state().elements)


def test_scripted_flow_with_on_step_and_goto():
    fake = FakeDriver(
        chat_fixture(),
        advances=[
            Advance(method="click", on_step="列表", target=Locator(text="求简历", right_of=Locator(text="候选人B"))),
            Advance(method="click", on_step="确认弹窗", target=Locator(text="确定"), goto="已请求"),
        ],
    )
    snap = fake.state()
    target = next(e for e in snap.elements if e.index == 3)
    receipt = fake.click(target)
    assert receipt.op == "click" and receipt.method == "fake" and receipt.snapshot_id == snap.snapshot_id
    assert fake.step.label == "确认弹窗"
    fake.click(Locator(text="确定"))
    assert fake.step.label == "已请求"
    assert [(c.method, c.element.index) for c in fake.writes] == [("click", 3), ("click", 4)]


def test_click_on_other_row_does_not_advance():
    fake = FakeDriver(
        chat_fixture(),
        advances=[Advance(method="click", target=Locator(text="求简历", right_of=Locator(text="候选人B")))],
    )
    fake.click(fake.state().elements[1])
    assert fake.step.label == "列表" and fake.count("click") == 1


def test_auto_advance_and_once():
    fake = FakeDriver(chat_fixture(), auto_advance=True)
    fake.key("return")
    assert fake.step_index == 1
    fake.key("return")
    fake.key("return")  # 停在最后一步
    assert fake.step_index == 2
    fake = FakeDriver(chat_fixture(), advances=[Advance(method="key", once=True)])
    fake.key("return")
    fake.key("return")
    assert fake.step_index == 1


def test_when_predicate():
    fake = FakeDriver(chat_fixture(), advances=[Advance(method="type_text", when=lambda c: c.args["text"] == "go")])
    fake.type_text(None, "stay")
    assert fake.step_index == 0
    fake.type_text(None, "go")
    assert fake.step_index == 1


def test_stale_after_step_change_and_after_new_state():
    fake = FakeDriver(chat_fixture(), auto_advance=True)
    old = fake.state().elements[1]
    fake.key("return")
    with pytest.raises(StaleSnapshotError):
        fake.click(old)
    fresh = fake.state().elements[1]
    fake.state()
    with pytest.raises(StaleSnapshotError):
        fake.click(fresh)
    assert fake.count("click") == 0 and len(fake.rejected) == 2


def test_element_without_snapshot_id_is_stale():
    fake = FakeDriver(chat_fixture())
    fake.state()
    with pytest.raises(StaleSnapshotError):
        fake.click(load_fixture(chat_fixture()).steps[0].elements[1].to_element())


def test_locator_errors_are_rejected_not_counted():
    fake = FakeDriver(chat_fixture())
    with pytest.raises(TargetAmbiguousError):
        fake.click(Locator(text="求简历"))
    with pytest.raises(TargetNotFoundError):
        fake.click(Locator(text="发送"))
    assert fake.count() == 0 and [type(e) for _, e in fake.rejected] == [TargetAmbiguousError, TargetNotFoundError]


def test_fail_next_injects_errors_once():
    fake = FakeDriver(chat_fixture())
    fake.fail_next("state", WindowLostError("gone"))
    fake.fail_next("click", StaleSnapshotError("x"))
    with pytest.raises(WindowLostError):
        fake.state()
    snap = fake.state()
    with pytest.raises(StaleSnapshotError):
        fake.click(snap.elements[1])
    fake.click(snap.elements[1])
    assert fake.count("click") == 1


def test_bind_window_and_screen_ok():
    fake = FakeDriver(chat_fixture(), screen_ok=False)
    assert fake.bind_window(WindowSelector(pid=42)).app_name == "Demo"
    with pytest.raises(WindowLostError):
        fake.bind_window(WindowSelector(pid=7))
    with pytest.raises(WindowLostError):
        fake.bind_window(WindowSelector(title_contains="BOSS"))
    assert fake.screen_ok() is False
    fake.healthy = True
    assert fake.screen_ok() is True
    assert fake.count() == 0  # bind_window 不是写方法
    assert fake.count("bind_window") == 1


def test_screenshot_region_writes_png_and_is_recorded(tmp_path):
    fake = FakeDriver(chat_fixture())
    path = fake.screenshot_region(Frame(x=0, y=0, w=10, h=10), tmp_path / "sub" / "qr.png")
    assert path.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
    assert fake.count("screenshot_region") == 1 and fake.count() == 0


def test_goto_unknown_step():
    fake = FakeDriver(chat_fixture())
    with pytest.raises(KeyError):
        fake.goto("不存在")
    with pytest.raises(IndexError):
        fake.goto(9)


def test_invalid_fixture_rejected():
    bad = copy.deepcopy(chat_fixture())
    bad["steps"][0]["elements"][0]["value"] = "13812345678"
    with pytest.raises(ContractValidationError):
        FakeDriver(bad)


def test_load_from_path_str(tmp_path):
    path = tmp_path / "f.json"
    path.write_text(json.dumps(chat_fixture(), ensure_ascii=False))
    assert FakeDriver(str(path)).fixture.scene == "chat_demo"


@pytest.mark.skipif(not B_FIXTURES, reason="任务 B 的夹具尚未合入本分支")
@pytest.mark.parametrize("path", B_FIXTURES, ids=lambda p: p.parent.name)
def test_replays_every_b_fixture(path):
    fixture = load_fixture(path)
    fake = FakeDriver(fixture, auto_advance=True)
    for pos, step in enumerate(fixture.steps):
        assert fake.step_index == pos
        snap = fake.state(include_tree=True)
        assert [(e.role, e.label, e.value) for e in snap.elements] == [(e.role, e.label, e.value) for e in step.elements]
        fake.key("noop")
    assert fake.count("key") == len(fixture.steps)
