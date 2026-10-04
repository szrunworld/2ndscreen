"""定位器测试：用 Calculator / TextEdit 的真实 state 样例与手写元素。"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from monitor_contracts import Element, Frame, Locator, TargetAmbiguousError, TargetNotFoundError

from monitor.driver import _cli
from monitor.driver.cli_driver import snapshot_from_state
from monitor.driver.locator import find_all, find_one, normalize

SAMPLES = Path(__file__).resolve().parents[2] / "fixtures" / "cli-samples"


def elements(name: str):
    raw = _cli.parse_state(json.loads((SAMPLES / f"{name}.json").read_text())["stdout"])
    return snapshot_from_state(raw, snapshot_id="s", taken_at=datetime.now(UTC)).elements


CALC = elements("state_calc")
TEXTEDIT = elements("state_textedit")


def el(index, role, label="", value="", frame=(0, 0, 10, 10)):
    x, y, w, h = frame
    return Element(index=index, role=role, label=label, value=value, frame=Frame(x=x, y=y, w=w, h=h))


def test_exact_text_unique():
    assert find_one(CALC, Locator(text="7")).index == 7


def test_exact_text_is_case_sensitive():
    assert find_one(CALC, Locator(text="All Clear")).index == 3
    with pytest.raises(TargetNotFoundError):
        find_one(CALC, Locator(text="all clear"))


def test_text_matches_label_or_value():
    assert find_one(TEXTEDIT, Locator(text="typeface")).index == 4
    assert find_one(TEXTEDIT, Locator(text="Helvetica")).index == 4


def test_contains_ambiguous():
    # "Change Sign" 与 "Change Mode" 都包含 "Change"。
    with pytest.raises(TargetAmbiguousError) as info:
        find_one(CALC, Locator(text_contains="Change"))
    assert info.value.count == 2 and info.value.code == "target_ambiguous"


def test_contains_narrowed_by_role():
    assert find_one(CALC, Locator(text_contains="Change", role="AXButton")).index == 4


def test_role_base_and_full_subrole():
    assert find_one(TEXTEDIT, Locator(text="bold", role="AXCheckBox")).index == 13
    assert find_one(TEXTEDIT, Locator(text="bold", role="AXCheckBox/AXSegment")).index == 13
    with pytest.raises(TargetNotFoundError):
        find_one(TEXTEDIT, Locator(text="bold", role="AXCheckBox/AXSwitch"))


def test_bidi_mark_ignored():
    # 值取自 state_calc_after 样例（Calculator 显示区带 U+200E）。
    after = [el(0, "AXStaticText", value="‎7"), el(1, "AXButton", "7")]
    assert find_one(after, Locator(text="7", role="AXStaticText")).value == "‎7"


def test_region_filter():
    column = Frame(x=5490, y=300, w=45, h=200)
    assert [e.index for e in find_all(CALC, Locator(role="AXButton", region=column))] == [7, 11, 15]
    assert find_one(CALC, Locator(text="4", region=column)).index == 11


def test_index_condition():
    assert find_one(CALC, Locator(index=12)).label == "5"
    with pytest.raises(TargetNotFoundError):
        find_one(CALC, Locator(index=12, text="6"))


def test_right_of_ambiguous_without_nearest():
    with pytest.raises(TargetAmbiguousError):
        find_one(CALC, Locator(role="AXButton", right_of=Locator(text="4")))


def test_right_of_nearest():
    assert find_one(CALC, Locator(role="AXButton", right_of=Locator(text="4")), nearest=True).index == 12


def test_right_of_with_text_and_other_row():
    assert find_one(CALC, Locator(text="Subtract", right_of=Locator(text="4"))).index == 14
    with pytest.raises(TargetNotFoundError):
        find_one(CALC, Locator(text="Multiply", right_of=Locator(text="4")))


def test_right_of_excludes_left_side():
    with pytest.raises(TargetNotFoundError):
        find_one(CALC, Locator(text="4", right_of=Locator(text="6")))


def test_right_of_anchor_errors_propagate():
    with pytest.raises(TargetNotFoundError):
        find_one(CALC, Locator(text="5", right_of=Locator(text="nope")))
    with pytest.raises(TargetAmbiguousError):
        find_one(CALC, Locator(text="5", right_of=Locator(text_contains="Change")))


def test_right_of_chat_row_like_layout():
    # 会话列表形状：姓名在左、按钮在右；只认同一行。
    rows = [
        el(0, "AXStaticText", value="候选人A", frame=(100, 100, 60, 20)),
        el(1, "AXButton", "求简历", frame=(400, 98, 60, 24)),
        el(2, "AXStaticText", value="候选人B", frame=(100, 140, 60, 20)),
        el(3, "AXButton", "求简历", frame=(400, 138, 60, 24)),
    ]
    assert find_one(rows, Locator(text="求简历", right_of=Locator(text="候选人B"))).index == 3
    with pytest.raises(TargetAmbiguousError):
        find_one(rows, Locator(text="求简历"))


def test_nearest_tie_is_still_ambiguous():
    rows = [el(0, "AXStaticText", "A"), el(1, "AXButton", "x", frame=(20, 0, 10, 10)), el(2, "AXButton", "y", frame=(20, 0, 10, 10))]
    with pytest.raises(TargetAmbiguousError):
        find_one(rows, Locator(role="AXButton", right_of=Locator(text="A")), nearest=True)


def test_empty_list_not_found():
    with pytest.raises(TargetNotFoundError) as info:
        find_one([], Locator(text="x"))
    assert info.value.locator == Locator(text="x")


def test_normalize():
    assert normalize("‎  Hello　 World ") == "Hello World"
    assert normalize("ＡＢＣ") == "ABC"
