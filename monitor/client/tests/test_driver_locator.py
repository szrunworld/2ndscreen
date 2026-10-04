"""定位器测试：用 Calculator 的真实 state 样例（4x5 按钮网格）与手写元素。"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import pytest

from monitor.driver import _cli
from monitor.driver.errors import TargetAmbiguousError as TargetAmbiguous, TargetNotFoundError as TargetNotFound
from monitor.driver.locator import Query, Region, find_all, find_one, normalize

SAMPLES = Path(__file__).resolve().parents[2] / "fixtures" / "cli-samples"


def elements(name: str):
    sample = json.loads((SAMPLES / f"{name}.json").read_text())
    return _cli.parse_state(sample["stdout"]).elements


CALC = elements("state_calc")
TEXTEDIT = elements("state_textedit")


@dataclass(frozen=True)
class F:
    x: float
    y: float
    width: float
    height: float


@dataclass(frozen=True)
class E:
    index: int
    role: str
    text: str | None
    frame: F | None


def test_exact_text_unique():
    assert find_one(CALC, Query(text="7")).index == 7


def test_exact_text_case_insensitive_by_default():
    assert find_one(CALC, Query(text="all clear")).index == 3
    with pytest.raises(TargetNotFound):
        find_one(CALC, Query(text="all clear", case_sensitive=True))


def test_contains_ambiguous():
    # "Change Sign" 与 "Change Mode" 都包含 "change"。
    with pytest.raises(TargetAmbiguous) as info:
        find_one(CALC, Query(text="change", match="contains"))
    assert "[4, 22]" in str(info.value)


def test_contains_narrowed_by_role():
    assert find_one(CALC, Query(text="change", match="contains", role="AXButton")).index == 4


def test_role_prefix_and_full_subrole():
    assert find_one(TEXTEDIT, Query(text="bold", role="AXCheckBox")).index == 13
    assert find_one(TEXTEDIT, Query(text="bold", role="AXCheckBox/AXSegment")).index == 13
    with pytest.raises(TargetNotFound):
        find_one(TEXTEDIT, Query(text="bold", role="AXCheckBox/AXSwitch"))


def test_value_text_is_matched_and_bidi_mark_ignored():
    after = elements("state_calc_after")
    assert find_one(after, Query(text="7", role="AXStaticText")).value == "‎7"


def test_region_filter():
    # 第一列（x 5493..5533）里的 AXButton 有多个；加文本后唯一。
    column = Region(5490, 300, 45, 200)
    hits = find_all(CALC, Query(role="AXButton", region=column))
    assert [e.index for e in hits] == [7, 11, 15]
    assert find_one(CALC, Query(text="4", region=column)).index == 11


def test_region_excludes_elements_without_frame():
    items = [E(0, "AXButton", "OK", None)]
    with pytest.raises(TargetNotFound):
        find_one(items, Query(text="OK", region=Region(0, 0, 10, 10)))


def test_right_of_same_row_ambiguous_without_nearest():
    # "4" 同行右侧有 5、6、Subtract。
    with pytest.raises(TargetAmbiguous):
        find_one(CALC, Query(role="AXButton", right_of=Query(text="4")))


def test_right_of_nearest():
    assert find_one(CALC, Query(role="AXButton", right_of=Query(text="4"), nearest=True)).index == 12


def test_right_of_with_text():
    assert find_one(CALC, Query(text="Subtract", right_of=Query(text="4"))).index == 14
    # Multiply 在上一行，不算同一行。
    with pytest.raises(TargetNotFound):
        find_one(CALC, Query(text="Multiply", right_of=Query(text="4")))


def test_right_of_excludes_left_side():
    with pytest.raises(TargetNotFound):
        find_one(CALC, Query(text="4", right_of=Query(text="6")))


def test_right_of_anchor_errors_propagate():
    with pytest.raises(TargetNotFound):
        find_one(CALC, Query(text="5", right_of=Query(text="nope")))
    with pytest.raises(TargetAmbiguous):
        find_one(CALC, Query(text="5", right_of=Query(text="change", match="contains")))


def test_right_of_chat_row_like_layout():
    # 会话列表形状：一行里姓名在左、按钮在右；另一行同名按钮不应命中。
    rows = [
        E(1, "AXStaticText", "候选人A", F(100, 100, 60, 20)),
        E(2, "AXButton", "求简历", F(400, 98, 60, 24)),
        E(3, "AXStaticText", "候选人B", F(100, 140, 60, 20)),
        E(4, "AXButton", "求简历", F(400, 138, 60, 24)),
    ]
    assert find_one(rows, Query(text="求简历", right_of=Query(text="候选人B"))).index == 4
    with pytest.raises(TargetAmbiguous):
        find_one(rows, Query(text="求简历"))


def test_nearest_tie_is_still_ambiguous():
    rows = [
        E(1, "AXStaticText", "A", F(0, 0, 10, 10)),
        E(2, "AXButton", "x", F(20, 0, 10, 10)),
        E(3, "AXButton", "y", F(20, 0, 10, 10)),
    ]
    with pytest.raises(TargetAmbiguous):
        find_one(rows, Query(role="AXButton", right_of=Query(text="A"), nearest=True))


def test_empty_list_not_found():
    with pytest.raises(TargetNotFound):
        find_one([], Query(text="x"))


def test_normalize():
    assert normalize("‎  Hello　 World ") == "hello world"
    assert normalize("ＡＢＣ") == "abc"
    assert normalize("Ab", case_sensitive=True) == "Ab"
