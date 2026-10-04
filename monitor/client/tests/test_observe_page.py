"""页面分类、页签定位与会话行解析：对任务 B 的全部夹具逐步核对标注。"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from monitor.driver import FakeDriver
from monitor.observe import Layout, PageKind, classify_page, new_greeting_tab, parse_rows
from monitor.observe.page import has_popup, is_new_greeting_tab, more_menu_open
from monitor.observe.rows import list_empty

AX = Path(__file__).resolve().parents[2] / "fixtures" / "ax"
# 夹具标注里的 page 与分类结果的对应（附件预览在标注里记为 other）
ANNOTATED_PAGE = {
    "conversation_list": PageKind.CONVERSATION_LIST,
    "conversation_detail": PageKind.CONVERSATION_DETAIL,
    "search": PageKind.SEARCH,
    "resume_overlay": PageKind.RESUME_OVERLAY,
    "other": PageKind.ATTACHMENT_PREVIEW,
}


def raw(scene: str) -> dict[str, Any]:
    return json.loads((AX / scene / "fixture.json").read_text())


def all_steps() -> list[tuple[str, int]]:
    out = []
    for path in sorted(AX.glob("*/fixture.json")):
        data = json.loads(path.read_text())
        out.extend((data["scene"], i) for i in range(len(data["steps"])))
    return out


def snapshot_of(scene: str, step: int, mutate=None):  # noqa: ANN001, ANN201
    data = raw(scene)
    if mutate is not None:
        data = copy.deepcopy(data)
        mutate(data["steps"][step])
    driver = FakeDriver(data)
    driver.goto(step)
    return driver.state()


ALL_STEPS = all_steps()


def test_fixture_inventory_is_complete() -> None:
    # B 交付 7 个场景、42 步；全部纳入下面的参数化核对
    assert len({s for s, _ in ALL_STEPS}) == 7
    assert len(ALL_STEPS) == 42


@pytest.mark.parametrize(("scene", "step"), ALL_STEPS)
def test_classification_matches_annotation(scene: str, step: int) -> None:
    snap = snapshot_of(scene, step)
    annotated = raw(scene)["steps"][step]["annotations"]["page"]
    assert classify_page(snap) is ANNOTATED_PAGE[annotated]


@pytest.mark.parametrize(("scene", "step"), ALL_STEPS)
def test_rows_match_annotation(scene: str, step: int) -> None:
    """标注里列出的会话（含 x_conversations_unclassified）与解析出的可见行逐一一致。"""
    ann = raw(scene)["steps"][step]["annotations"]
    snap = snapshot_of(scene, step)
    layout = Layout.of(snap)
    assert layout is not None
    rows, issues = parse_rows(snap, layout)
    assert issues == []
    if "conversations" in ann:
        expected = [
            (c["element_index"], c["conversation"]["candidate_name"], c["conversation"]["job_title"],
             c["conversation"]["hints"][0], bool(c.get("unread")))
            for c in ann["conversations"]
        ]
    elif "x_conversations_unclassified" in ann:
        expected = [
            (c["element_index"], c["candidate_name"], c["job_title"], c["time"], c["unread"])
            for c in ann["x_conversations_unclassified"]
        ]
    else:
        return
    got = [(r.element_index, r.candidate_name, r.job_title, r.time_text, r.unread is not None) for r in rows]
    assert got == expected
    assert [r.position for r in rows] == list(range(len(rows)))


def test_own_status_prefix_and_badge() -> None:
    rows, _ = parse_rows(snap := snapshot_of("conversation_list", 3), Layout.of(snap))  # type: ignore[arg-type]
    assert {r.candidate_name: r.own_status for r in rows} == {
        "候选人M": None, "候选人N": None, "候选人O": "[已读]", "候选人P": "[送达]",
    }
    rows, _ = parse_rows(snap := snapshot_of("new_application_marker", 0), Layout.of(snap))  # type: ignore[arg-type]
    assert [r.unread for r in rows][:2] == [2, 1]


def test_preview_text_is_not_part_of_row() -> None:
    # 候选人N 的预览是 PDF 文件名（含姓名），不应出现在行的任何字段里
    rows, _ = parse_rows(snap := snapshot_of("conversation_list", 3), Layout.of(snap))  # type: ignore[arg-type]
    for row in rows:
        assert ".pdf" not in row.summary()


def test_row_missing_job_is_reported_and_clipped_row_is_skipped() -> None:
    def drop_job(step: dict[str, Any]) -> None:
        step["elements"][64]["label"] = ""  # 候选人C 的岗位 AXGroup（第 2 行，未裁剪）
        step["elements"][128]["label"] = ""  # 候选人K 的岗位 AXGroup（末行，被裁成高 28）

    snap = snapshot_of("new_application_marker", 0, drop_job)
    rows, issues = parse_rows(snap, Layout.of(snap))  # type: ignore[arg-type]
    names = [r.candidate_name for r in rows]
    assert "候选人C" not in names and "候选人K" not in names and len(rows) == 8
    assert [(i.element_index, i.missing) for i in issues] == [(59, ("job",))]


def test_list_empty_marker() -> None:
    assert list_empty(snapshot_of("conversation_list", 4))
    assert not list_empty(snapshot_of("conversation_list", 1))


def test_new_greeting_tab_found_on_list_and_detail() -> None:
    for scene, step in [("conversation_list", 0), ("conversation_detail", 0), ("new_application_marker", 1)]:
        snap = snapshot_of(scene, step)
        layout = Layout.of(snap)
        tab = new_greeting_tab(snap, layout)  # type: ignore[arg-type]
        assert tab is not None and tab.label.startswith("新招呼(")
        assert is_new_greeting_tab(tab, snap, layout)  # type: ignore[arg-type]


def test_new_greeting_tab_rejects_lookalikes() -> None:
    snap = snapshot_of("conversation_list", 0)
    layout = Layout.of(snap)
    assert layout is not None
    # 行容器、『全部』页签都不是『新招呼』页签
    assert not is_new_greeting_tab(snap.elements[51], snap, layout)
    assert not is_new_greeting_tab(snap.elements[34], snap, layout)

    def duplicate_tab(step: dict[str, Any]) -> None:
        step["elements"][39]["label"] = "新招呼(1)"  # 『沟通中』也写成新招呼：不唯一

    snap2 = snapshot_of("conversation_list", 0, duplicate_tab)
    assert new_greeting_tab(snap2, Layout.of(snap2)) is None  # type: ignore[arg-type]

    def drop_all_tab(step: dict[str, Any]) -> None:
        step["elements"][34]["label"] = ""

    snap3 = snapshot_of("conversation_list", 0, drop_all_tab)
    assert new_greeting_tab(snap3, Layout.of(snap3)) is None  # type: ignore[arg-type]
    assert classify_page(snap3) is PageKind.UNKNOWN

    def move_tab_down(step: dict[str, Any]) -> None:
        step["elements"][36]["frame"]["y"] += 300  # 同名控件不在页签栏里

    snap4 = snapshot_of("conversation_list", 0, move_tab_down)
    assert new_greeting_tab(snap4, Layout.of(snap4)) is None  # type: ignore[arg-type]


def test_layout_falls_back_to_window_element() -> None:
    snap = snapshot_of("conversation_list", 0)
    no_window = snap.model_copy(update={"window": None})
    layout = Layout.of(no_window)
    assert layout is not None and (layout.ox, layout.oy) == (3360, 25)
    bare = snap.model_copy(update={"window": None, "elements": ()})
    assert Layout.of(bare) is None
    assert classify_page(bare) is PageKind.UNKNOWN


def test_popup_and_menu_detection() -> None:
    assert has_popup(snapshot_of("attachment_entry", 1))
    assert not has_popup(snapshot_of("attachment_entry", 2))
    menu = snapshot_of("conversation_list", 5)
    assert more_menu_open(menu, Layout.of(menu))  # type: ignore[arg-type]
    plain = snapshot_of("conversation_list", 6)
    assert not more_menu_open(plain, Layout.of(plain))  # type: ignore[arg-type]


def test_attachment_preview_wins_over_other_features() -> None:
    # 预览页里同时有页签组与『在线简历』，仍必须先判为附件预览
    snap = snapshot_of("attachment_entry", 4)
    assert any(el.label == "在线简历" for el in snap.elements)
    assert classify_page(snap) is PageKind.ATTACHMENT_PREVIEW
