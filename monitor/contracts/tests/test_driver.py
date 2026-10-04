"""Driver 协议的数据模型与错误分类。"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest
from pydantic import ValidationError

from monitor_contracts import (
    DRIVER_ERROR_CODES,
    ActionReceipt,
    CliFailedError,
    Driver,
    DriverError,
    Element,
    Frame,
    Locator,
    Snapshot,
    StaleSnapshotError,
    TargetAmbiguousError,
    TargetNotFoundError,
    WindowInfo,
    WindowSelector,
)

NOW = datetime(2026, 10, 4, tzinfo=UTC)
F = Frame(x=10, y=20, w=100, h=40)


def el(i, label="", value="", **kw):
    return Element(index=i, role="AXStaticText", label=label, value=value, frame=F, **kw)


def test_element_text():
    assert el(0, "发送").text == "发送"
    assert el(0, "", "你好").text == "你好"
    assert el(0, "备注", "你好").text == "备注 你好"
    assert el(0, "发送", "发送").text == "发送"
    assert el(0).text == ""


def test_frame_helpers():
    assert F.center() == (60, 40)
    assert F.contains(10, 20) and not F.contains(9, 20)


def test_snapshot_index_and_id_checks():
    Snapshot(snapshot_id="s1", taken_at=NOW, window=None, elements=(el(0), el(1, snapshot_id="s1")))
    with pytest.raises(ValidationError):
        Snapshot(snapshot_id="s1", taken_at=NOW, window=None, elements=(el(1),))
    with pytest.raises(ValidationError):
        Snapshot(snapshot_id="s1", taken_at=NOW, window=None, elements=(el(0, snapshot_id="s0"),))
    with pytest.raises(ValidationError):
        Snapshot(snapshot_id="s1", taken_at=datetime(2026, 10, 4), window=None)  # 必须带时区


def test_models_are_frozen():
    e = el(0, "x")
    with pytest.raises(ValidationError):
        e.label = "y"


def test_locator_requires_a_condition():
    Locator(text_contains="求简历", right_of=Locator(text="候选人A"))
    with pytest.raises(ValidationError):
        Locator()


def test_window_selector_requires_a_condition():
    WindowSelector(app_name="BOSS直聘")
    with pytest.raises(ValidationError):
        WindowSelector()


def test_window_info_shape():
    w = WindowInfo(pid=1, window_id=7, frame=F)
    assert w.title == "" and w.app_name is None


def test_receipt():
    r = ActionReceipt(op="click", method="ax_press", element=el(0), snapshot_id="s1", performed_at=NOW)
    assert r.op == "click"
    with pytest.raises(ValidationError):
        ActionReceipt(op="drag", method="event", performed_at=NOW)


def test_error_taxonomy():
    assert set(DRIVER_ERROR_CODES) == {
        "driver_error",
        "window_lost",
        "screen_lost",
        "timeout",
        "snapshot_stale",
        "cli_failed",
        "target_ambiguous",
        "target_not_found",
    }
    assert len(DRIVER_ERROR_CODES) == len(set(DRIVER_ERROR_CODES))
    err = CliFailedError(2, "boom")
    assert isinstance(err, DriverError) and err.returncode == 2 and "boom" in str(err)
    amb = TargetAmbiguousError(Locator(text="发送"), 3)
    assert amb.count == 3 and amb.code == "target_ambiguous"
    assert TargetNotFoundError(Locator(role="AXButton")).code == "target_not_found"
    assert issubclass(StaleSnapshotError, DriverError)


class _MiniDriver:
    """最小的结构化实现，用来确认 Protocol 形状可被满足。"""

    def state(self, include_tree=False):
        return Snapshot(snapshot_id="s", taken_at=NOW, window=None)

    def click(self, target, mode="auto"):
        return ActionReceipt(op="click", method="event", performed_at=NOW)

    def type_text(self, target, text):
        return ActionReceipt(op="type_text", method="paste", performed_at=NOW)

    def key(self, keys):
        return ActionReceipt(op="key", method="event", performed_at=NOW)

    def scroll(self, target, direction, amount):
        return ActionReceipt(op="scroll", method="event", performed_at=NOW)

    def bind_window(self, selector=None):
        return WindowInfo(window_id=1, frame=F)

    def screen_ok(self):
        return True

    def screenshot_region(self, rect, out_path):
        return Path(out_path)


def test_protocol_is_satisfiable():
    assert isinstance(_MiniDriver(), Driver)
    assert not isinstance(object(), Driver)
