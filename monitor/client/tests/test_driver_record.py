"""录制模式测试：脱敏、校验、写文件；以及 CliDriver.record_step 串起来。号码均为虚构。"""

from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest
from monitor_contracts import ContractValidationError, Element, Frame, Snapshot, StepAnnotations, WindowInfo, validate_ax_fixture

from monitor.driver import FakeDriver, FixtureRecorder
from monitor.driver.redact import EMAIL_MARK, PHONE_MARK, WECHAT_MARK

NOW = datetime(2026, 10, 4, tzinfo=UTC)


def snapshot() -> Snapshot:
    def el(i, role, label="", value=""):
        return Element(index=i, role=role, label=label, value=value, frame=Frame(x=i, y=0, w=5, h=5), snapshot_id="s1")

    return Snapshot(
        snapshot_id="s1",
        taken_at=NOW,
        window=WindowInfo(pid=1, window_id=2, frame=Frame(x=0, y=0, w=100, h=100), title="与张三的聊天", app_name="Demo"),
        elements=(
            el(0, "AXWindow", "与张三的聊天"),
            el(1, "AXStaticText", value="张三 · 后端工程师"),
            el(2, "AXStaticText", value="我的电话 138 1234 5678，微信号：zs_dev2026"),
            el(3, "AXStaticText", value="邮箱 zs@example.com"),
            el(4, "AXButton", "求简历"),
        ),
    )


def test_redacts_elements_and_window_title():
    rec = FixtureRecorder("demo_scene", "示例", app="Demo", replacements={"张三": "候选人A"}, clock=lambda: NOW)
    step = rec.add_step(snapshot(), "第一步", {"page": "conversation_detail"})
    texts = [e["label"] + "|" + e["value"] for e in step["elements"]]
    assert texts[1] == "|候选人A · 后端工程师"
    assert texts[2] == f"|我的电话 {PHONE_MARK}，微信号：{WECHAT_MARK}"
    assert texts[3] == f"|邮箱 {EMAIL_MARK}"
    assert step["window"]["title"] == "与候选人A的聊天"
    assert "snapshot_id" not in step["elements"][0]
    assert "张三" not in json.dumps(rec.to_dict(), ensure_ascii=False)


def test_fixture_validates_and_writes(tmp_path):
    rec = FixtureRecorder("demo_scene", "示例", app="Demo", replacements={"张三": "候选人A"}, clock=lambda: NOW)
    rec.add_step(snapshot(), "第一步", StepAnnotations(page="conversation_detail", notes="x"))
    rec.add_step(snapshot(), "第二步")
    model = rec.fixture()
    assert model.steps[1].annotations.page == "other"
    path = rec.write(tmp_path / "demo_scene" / "fixture.json")
    data = json.loads(path.read_text())
    validate_ax_fixture(data)
    assert data["recorded_at"] == NOW.isoformat()
    # 录出来的夹具可直接被 FakeDriver 回放。
    assert FakeDriver(path).state().elements[4].label == "求简历"


def test_unredacted_phone_without_recorder_fails_validation():
    # 没经过脱敏的数据过不了契约校验（schema 禁止 11 位手机号样式）。
    rec = FixtureRecorder("demo_scene", "示例", app="Demo", clock=lambda: NOW)
    rec.add_step(snapshot(), "第一步")
    data = rec.to_dict()
    data["steps"][0]["elements"][2]["value"] = "13812345678"
    with pytest.raises(ContractValidationError):
        validate_ax_fixture(data)


def test_invalid_scene_name_rejected(tmp_path):
    rec = FixtureRecorder("Bad Scene", "示例", app="Demo", clock=lambda: NOW)
    rec.add_step(snapshot(), "第一步")
    with pytest.raises(ContractValidationError):
        rec.write(tmp_path / "x.json")
    assert not (tmp_path / "x.json").exists()


def test_cli_driver_record_step_uses_state():
    class StubDriver:
        def _state(self, include_tree=False, hide_pdf_preview=None):
            self.include_tree = include_tree
            self.hide_pdf_preview = hide_pdf_preview
            return snapshot()

    from monitor.driver.cli_driver import CliDriver

    stub = StubDriver()
    rec = FixtureRecorder("demo_scene", "示例", app="Demo", replacements={"张三": "候选人A"}, clock=lambda: NOW)
    CliDriver.record_step(stub, rec, "第一步", {"page": "other"}, include_tree=True)  # type: ignore[arg-type]
    assert stub.include_tree is True and len(rec.steps) == 1
    # 录制总是剔除 PDF 预览子树，与构造参数无关。
    assert stub.hide_pdf_preview is True
