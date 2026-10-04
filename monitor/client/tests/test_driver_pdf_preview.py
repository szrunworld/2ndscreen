"""Driver 层剔除附件 PDF 预览子树的测试：规则本身、FakeDriver 回放 B 的 attachment_entry、
CliDriver（index 换算）与录制。"""

from __future__ import annotations

import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path

import pytest
from monitor.driver import Advance, FakeDriver, FixtureRecorder, _cli, load_fixture
from monitor.driver.cli_driver import CliDriver
from monitor.driver.pdf_preview import hidden_positions, is_pdf_preview, strip_pdf_preview
from monitor_contracts import Element, Frame, Locator, Snapshot, TargetNotFoundError, WindowSelector

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"
ATTACHMENT = FIXTURES / "ax" / "attachment_entry" / "fixture.json"
PREVIEW_STEP = 4  # attachment_entry#4：PDF 预览打开
NOW = datetime(2026, 10, 4, 12, 0, tzinfo=UTC)

needs_b = pytest.mark.skipif(not ATTACHMENT.exists(), reason="任务 B 的 attachment_entry 夹具不在本分支")


def el(index, role, label="", value="", frame=(0, 0, 10, 10), parent=None) -> Element:
    x, y, w, h = frame
    return Element(
        index=index, role=role, label=label, value=value, frame=Frame(x=x, y=y, w=w, h=h), parent_index=parent
    )


# ---- 规则 ----


@pytest.mark.parametrize(
    "role,label,expected",
    [
        ("AXWebArea", "PDF预览", True),
        ("AXWebArea", "pdf 预览", True),
        ("AXWebArea", "ＰＤＦ预览", True),  # 全角经 NFKC 归一
        ("AXWebArea", "BOSS直聘", False),
        ("AXGroup", "PDF预览", False),
        ("AXHeading", "简历.pdf | 3", False),
    ],
)
def test_is_pdf_preview(role, label, expected):
    assert is_pdf_preview(role, label) is expected


def test_no_preview_is_identity():
    elements = [el(0, "AXWindow"), el(1, "AXButton", "发送")]
    kept, mapping = strip_pdf_preview(elements)
    assert kept == elements and mapping == {0: 0, 1: 1}


def test_tree_rule_follows_ancestry_not_geometry():
    elements = [
        el(0, "AXWindow", frame=(0, 0, 1000, 800)),
        el(1, "AXWebArea", "PDF预览", frame=(300, 50, 500, 700), parent=0),
        el(2, "AXGroup", frame=(300, 50, 500, 700), parent=1),
        el(3, "AXStaticText", value="文字层", frame=(320, 900, 200, 20), parent=2),  # 滚出可见区，框在容器外
        el(4, "AXGroup", frame=(400, 100, 30, 30), parent=0),  # 浮在预览上但不是它的后代
    ]
    assert hidden_positions(elements) == {2, 3}
    kept, mapping = strip_pdf_preview(elements)
    assert [e.index for e in kept] == [0, 1, 2]
    assert kept[2].frame.x == 400 and kept[2].parent_index == 0
    assert mapping == {0: 0, 1: 1, 4: 2}


def test_geometry_rule_without_tree():
    elements = [
        el(0, "AXWindow", frame=(0, 0, 1000, 800)),
        el(1, "AXGroup", frame=(400, 100, 30, 30)),  # 在容器之前：不是后代
        el(2, "AXWebArea", "PDF预览", frame=(300, 50, 500, 700)),
        el(3, "AXButton", "切图", frame=(760, 60, 28, 42)),
        el(4, "AXGroup", "文字层", frame=(300, 50, 501, 700)),  # 容差 1 点内
        el(5, "AXGroup", frame=(820, 20, 30, 30)),  # 关闭按钮在框外
        el(6, "AXGroup", frame=(0, 0, 1000, 800)),  # 铺满窗口，中心在框内但框不在框内
    ]
    assert hidden_positions(elements) == {3, 4}


def test_explicit_parents_override_and_fill_gaps():
    elements = [
        el(0, "AXWindow", frame=(0, 0, 1000, 800)),
        el(1, "AXWebArea", "PDF预览", frame=(300, 50, 500, 700)),
        el(2, "AXStaticText", value="a", frame=(320, 900, 10, 10)),
        el(3, "AXStaticText", value="b", frame=(320, 60, 10, 10)),
    ]
    # 2 有树信息（父是 1），3 不在映射里 → 几何规则。
    assert hidden_positions(elements, {0: None, 1: 0, 2: 1}) == {2, 3}
    # 3 有树信息、父是窗口 → 保留，即使在框内。
    assert hidden_positions(elements, {0: None, 1: 0, 2: 1, 3: 0}) == {2}


# ---- FakeDriver 回放 B 的 attachment_entry ----


@needs_b
def test_attachment_preview_step_has_no_text_layer():
    fixture = load_fixture(ATTACHMENT)
    raw = fixture.steps[PREVIEW_STEP].elements
    fake = FakeDriver(fixture)
    fake.goto(PREVIEW_STEP)
    snap = fake.state()
    labels = [(e.role, e.label) for e in snap.elements]
    # 容器本身保留，便于识别"预览开着"。
    assert labels.count(("AXWebArea", "PDF预览")) == 1
    # 容器下的『切图』与文字层占位都不在。
    assert ("AXButton", "切图") not in labels
    assert not any("PDF文字层" in e.label or "PDF文字层" in e.value for e in snap.elements)
    assert len(snap.elements) == len(raw) - 2
    # 编号连续；容器框外的元素（工具栏图标、关闭按钮、窗口按钮）都还在。
    assert [e.index for e in snap.elements] == list(range(len(snap.elements)))
    assert sum(1 for e in snap.elements if e.role.startswith("AXButton/")) == 3
    preview = next(e for e in snap.elements if is_pdf_preview(e.role, e.label))
    for e in snap.elements[preview.index + 1 :]:
        assert not (
            preview.frame.x <= e.frame.x
            and e.frame.x + e.frame.w <= preview.frame.x + preview.frame.w + 1
            and preview.frame.y <= e.frame.y
            and e.frame.y + e.frame.h <= preview.frame.y + preview.frame.h + 1
        ), e


@needs_b
def test_attachment_other_steps_unchanged():
    fixture = load_fixture(ATTACHMENT)
    fake = FakeDriver(fixture)
    for pos, step in enumerate(fixture.steps):
        if pos == PREVIEW_STEP:
            continue
        fake.goto(pos)
        assert [(e.role, e.label, e.value) for e in fake.state().elements] == [
            (e.role, e.label, e.value) for e in step.elements
        ]


@needs_b
def test_attachment_preview_kept_when_disabled():
    fake = FakeDriver(ATTACHMENT, hide_pdf_preview=False)
    fake.goto(PREVIEW_STEP)
    labels = [(e.role, e.label) for e in fake.state().elements]
    assert ("AXButton", "切图") in labels
    assert len(labels) == len(load_fixture(ATTACHMENT).steps[PREVIEW_STEP].elements)


@needs_b
def test_attachment_writes_use_filtered_indexes():
    # 预览子树里的控件无法定位；容器之后的元素按剔除后的编号作用，Advance 规则也用同一套编号。
    close = Locator(role="AXGroup", region=Frame(x=4470, y=30, w=40, h=40))
    fake = FakeDriver(ATTACHMENT, advances=[Advance("click", target=close)])
    fake.goto(PREVIEW_STEP)
    with pytest.raises(TargetNotFoundError):
        fake.click(Locator(text="切图"))
    snap = fake.state()
    target = next(e for e in snap.elements if e.frame.x == 4475 and e.frame.y == 37)
    assert target.index == 170  # 原夹具里是 172，前面剔掉了 2 个
    receipt = fake.click(target)
    assert receipt.element == target
    assert fake.step_index == PREVIEW_STEP + 1


# ---- CliDriver ----

CLI_ELEMENTS = [
    {
        "index": 0,
        "role": "AXWindow/AXStandardWindow",
        "label": "BOSS直聘",
        "frame": {"x": 0, "y": 0, "width": 1000, "height": 800},
    },
    {"index": 1, "role": "AXWebArea", "label": "BOSS直聘", "frame": {"x": 0, "y": 0, "width": 1000, "height": 800}},
    {
        "index": 2,
        "role": "AXButton",
        "label": "发送",
        "frame": {"x": 900, "y": 750, "width": 60, "height": 30},
        "actions": ["AXPress"],
    },
    {"index": 3, "role": "AXWebArea", "label": "PDF预览", "frame": {"x": 300, "y": 50, "width": 500, "height": 700}},
    {
        "index": 4,
        "role": "AXButton",
        "label": "切图",
        "frame": {"x": 760, "y": 60, "width": 28, "height": 42},
        "actions": ["AXPress"],
    },
    {
        "index": 5,
        "role": "AXStaticText",
        "value": "电话 13800000000",
        "frame": {"x": 320, "y": 100, "width": 200, "height": 20},
    },
    {
        "index": 6,
        "role": "AXStaticText",
        "value": "邮箱 someone@example.com",
        "frame": {"x": 320, "y": 900, "width": 200, "height": 20},
    },
    {"index": 7, "role": "AXGroup", "frame": {"x": 820, "y": 20, "width": 30, "height": 30}, "actions": ["AXPress"]},
    {"index": 8, "role": "AXGroup", "frame": {"x": 0, "y": 0, "width": 1000, "height": 800}},
]
CLI_TREE = "\n".join(
    [
        '- [0] AXWindow/AXStandardWindow "BOSS直聘"',
        '  - [1] AXWebArea "BOSS直聘"',
        '    - [2] AXButton "发送"',
        '  - [3] AXWebArea "PDF预览"',
        '    - [4] AXButton "切图"',
        "    - AXGroup",
        '      - [5] AXStaticText = "电话 13800000000"',
        '      - [6] AXStaticText = "邮箱 someone@example.com"',
        "  - [7] AXGroup",
        "  - [8] AXGroup",
    ]
)
STATE = {
    "ok": True,
    "app": "BOSS直聘",
    "pid": 4242,
    "screen": "monitor-c",
    "windowID": 77,
    "windowFrame": {"x": 0, "y": 0, "width": 1000, "height": 800},
    "elements": CLI_ELEMENTS,
    "tree": CLI_TREE,
}


class Runner:
    """subprocess.run 替身：state 回放 STATE，click 回报作用的元素。"""

    def __init__(self, state=STATE):
        self.state = state
        self.argv: list[list[str]] = []

    def __call__(self, argv, **kwargs):
        self.argv.append(argv)
        if argv[1] == "state":
            out = self.state
        elif argv[1] == "click":
            index = int(argv[argv.index("--index") + 1])
            out = {"ok": True, "route": "ax.press", "element": CLI_ELEMENTS[index]}
        else:
            raise AssertionError(argv)
        return subprocess.CompletedProcess(argv, 0, json.dumps(out, ensure_ascii=False), "")


def cli_driver(**kwargs) -> tuple[CliDriver, Runner]:
    runner = Runner(kwargs.pop("state", STATE))
    driver = CliDriver("monitor-c", runner=_cli.CliRunner("2ndscreen", runner=runner), **kwargs)
    driver.bind_window(WindowSelector(pid=4242))
    return driver, runner


def test_cli_state_drops_preview_subtree_by_tree():
    driver, _ = cli_driver()
    snap = driver.state()
    texts = " ".join(e.label + e.value for e in snap.elements)
    assert "13800000000" not in texts and "example.com" not in texts and "切图" not in texts
    assert [(e.index, e.role) for e in snap.elements] == [
        (0, "AXWindow/AXStandardWindow"),
        (1, "AXWebArea"),
        (2, "AXButton"),
        (3, "AXWebArea"),
        (4, "AXGroup"),
        (5, "AXGroup"),
    ]
    # 不带树时 parent_index / depth 仍为空；带树时按新编号换算。
    assert all(e.parent_index is None and e.depth is None for e in snap.elements)
    tree = driver.state(include_tree=True)
    assert [e.parent_index for e in tree.elements] == [None, 0, 1, 0, 0, 0]


def test_cli_click_after_preview_uses_cli_index():
    driver, runner = cli_driver()
    close = driver.state().elements[4]
    receipt = driver.click(close)
    click = runner.argv[-1]
    assert click[1] == "click" and click[click.index("--index") + 1] == "7"
    assert receipt.element == close and receipt.method == "ax_press"
    # 定位器同样经过换算。
    driver.click(Locator(text="发送"))
    assert runner.argv[-1][runner.argv[-1].index("--index") + 1] == "2"


def test_cli_ax_press_check_uses_filtered_actions():
    driver, runner = cli_driver()
    whole = driver.state().elements[5]  # CLI index 8，没有 AXPress
    from monitor_contracts import CliFailedError

    with pytest.raises(CliFailedError):
        driver.click(whole, mode="ax_press")
    assert runner.argv[-1][1] == "state"  # 没有发出 click


def test_cli_hide_disabled_keeps_everything():
    driver, _ = cli_driver(hide_pdf_preview=False)
    snap = driver.state()
    assert len(snap.elements) == len(CLI_ELEMENTS)
    assert any("13800000000" in e.value for e in snap.elements)


def test_cli_record_step_hides_even_when_disabled():
    driver, _ = cli_driver(hide_pdf_preview=False)
    rec = FixtureRecorder("pdf_demo", "示例", app="BOSS直聘", clock=lambda: NOW)
    snap = driver.record_step(rec, "预览", {"page": "other"})
    assert len(snap.elements) == 6
    assert len(rec.steps[0]["elements"]) == 6
    assert "13800000000" not in json.dumps(rec.to_dict(), ensure_ascii=False)


def test_cli_without_tree_falls_back_to_geometry():
    driver, _ = cli_driver(state={**STATE, "tree": ""})
    roles = [(e.role, e.label) for e in driver.state().elements]
    # 框内的『切图』和第一行文字被剔除；全窗口 AXGroup 与关闭按钮保留。
    assert ("AXButton", "切图") not in roles
    assert not any("13800000000" in e.value for e in driver.state().elements)
    assert roles[-2:] == [("AXGroup", ""), ("AXGroup", "")]


# ---- 录制 ----


def raw_snapshot() -> Snapshot:
    elements = (
        el(0, "AXWindow", frame=(0, 0, 1000, 800)),
        el(1, "AXWebArea", "PDF预览", frame=(300, 50, 500, 700)),
        el(2, "AXStaticText", value="电话 13800000000", frame=(320, 60, 100, 20)),
        el(3, "AXStaticText", value="候选人A", frame=(10, 10, 60, 20)),
        el(4, "AXStaticText", value="候选人B", frame=(10, 40, 60, 20)),
    )
    return Snapshot(snapshot_id="s", taken_at=NOW, window=None, elements=elements)


def conversation(index: int, name: str) -> dict:
    return {
        "element_index": index,
        "conversation": {"candidate_name": name, "job_title": "岗位"},
        "is_new_application": False,
    }


def test_recorder_strips_preview_and_remaps_annotations():
    rec = FixtureRecorder("pdf_demo", "示例", app="BOSS直聘", clock=lambda: NOW)
    step = rec.add_step(
        raw_snapshot(),
        "预览",
        {"page": "conversation_list", "conversations": [conversation(3, "候选人A")], "is_new_application": [4]},
    )
    assert [e["index"] for e in step["elements"]] == [0, 1, 2, 3]
    assert "13800000000" not in json.dumps(step, ensure_ascii=False)
    assert step["annotations"]["conversations"][0]["element_index"] == 2
    assert step["annotations"]["is_new_application"] == [3]
    rec.fixture()  # 契约校验通过


def test_recorder_rejects_annotation_on_hidden_element():
    rec = FixtureRecorder("pdf_demo", "示例", app="BOSS直聘", clock=lambda: NOW)
    with pytest.raises(ValueError, match="PDF 预览"):
        rec.add_step(raw_snapshot(), "预览", {"page": "other", "is_new_application": [2]})
    assert rec.steps == []
