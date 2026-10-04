"""定位器：在一次快照的元素列表里找唯一目标。纯函数，不调用 CLI。

条件全部满足才算命中（与）：

- 文本：``exact``（规范化后相等）或 ``contains``（规范化后包含）。元素的候选文本是
  ``text``、``label``、``value`` 中非空的那些，任一满足即可。
- 角色：``AXButton`` 同时命中 ``AXButton`` 与 ``AXButton/AXSomeSubrole``；写全
  ``AXCheckBox/AXSegment`` 则只命中这一子角色。
- 几何区域：元素中心点落在区域内（全局坐标，左上为原点）。
- 同一行右侧：先按 ``right_of`` 唯一定位锚点（锚点歧义或未找到照常报错），候选元素
  的垂直中心落在锚点的上下边之间，且左边缘不在锚点右边缘的左侧（容差 ``row_slack``）。

结果：恰好一个命中返回它；零个抛"目标未找到"；多个抛"目标歧义"，不替调用方挑选。
``nearest=True`` 只用于"同一行右侧"：取离锚点最近的一个，最近距离并列时仍是歧义。

规范化：去掉方向控制符（Calculator 的值带 U+200E）、NFKC、合并空白、去首尾空白；
``case_sensitive=False`` 时再转小写。
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from .errors import TargetAmbiguousError, TargetNotFoundError

_BIDI = re.compile("[‎‏‪-‮⁦-⁩﻿]")
_SPACE = re.compile(r"\s+")


@dataclass(frozen=True)
class Region:
    """全局坐标的矩形区域（点）。"""

    x: float
    y: float
    width: float
    height: float

    def contains(self, px: float, py: float) -> bool:
        return self.x <= px <= self.x + self.width and self.y <= py <= self.y + self.height


@dataclass(frozen=True)
class Query:
    """一次定位条件。所有字段都可空；全空的查询会命中所有带框的元素（通常导致歧义）。"""

    text: str | None = None
    match: Literal["exact", "contains"] = "exact"
    role: str | None = None
    # Region 或契约 Frame：任何带 contains(x, y) 的矩形。
    region: Any = None
    right_of: Query | None = None
    nearest: bool = False
    case_sensitive: bool = False
    row_slack: float = 2.0

    def describe(self) -> str:
        parts = []
        if self.text is not None:
            parts.append(f"text {self.match} {self.text!r}")
        if self.role:
            parts.append(f"role={self.role}")
        if self.region:
            parts.append(f"region={self.region!r}")
        if self.right_of:
            parts.append(f"right_of[{self.right_of.describe()}]")
        return ", ".join(parts) or "<any>"


def normalize(text: str, case_sensitive: bool = False) -> str:
    text = unicodedata.normalize("NFKC", _BIDI.sub("", text))
    text = _SPACE.sub(" ", text).strip()
    return text if case_sensitive else text.casefold()


def element_texts(element: Any) -> list[str]:
    """元素的候选文本：契约 Element 的 ``text``，以及 CLI 原始元素的 ``label``/``value``。"""
    out = []
    for name in ("text", "label", "value"):
        value = getattr(element, name, None)
        if isinstance(value, str) and value and value not in out:
            out.append(value)
    return out


def _frame(element: Any) -> tuple[float, float, float, float] | None:
    frame = getattr(element, "frame", None)
    if frame is None:
        return None
    # 契约 Frame 用 w/h，CLI 原始框用 width/height。
    w = getattr(frame, "w", None)
    h = getattr(frame, "h", None)
    if w is None or h is None:
        w, h = frame.width, frame.height
    return (float(frame.x), float(frame.y), float(w), float(h))


def _role_matches(want: str, role: str) -> bool:
    return role == want or ("/" not in want and role.split("/", 1)[0] == want)


def _text_matches(query: Query, element: Any) -> bool:
    assert query.text is not None
    needle = normalize(query.text, query.case_sensitive)
    for candidate in element_texts(element):
        hay = normalize(candidate, query.case_sensitive)
        if hay == needle if query.match == "exact" else needle in hay:
            return True
    return False


def _basic_matches(query: Query, element: Any) -> bool:
    if query.role is not None and not _role_matches(query.role, str(getattr(element, "role", ""))):
        return False
    if query.text is not None and not _text_matches(query, element):
        return False
    if query.region is not None:
        frame = _frame(element)
        if frame is None:
            return False
        x, y, w, h = frame
        if not query.region.contains(x + w / 2, y + h / 2):
            return False
    return True


def _same_row_right(anchor: Any, element: Any, slack: float) -> float | None:
    """元素在锚点同一行右侧时返回水平距离，否则 None。"""
    a, e = _frame(anchor), _frame(element)
    if a is None or e is None or element is anchor:
        return None
    ax, ay, aw, ah = a
    ex, ey, ew, eh = e
    center_y = ey + eh / 2
    if not (ay - slack <= center_y <= ay + ah + slack):
        return None
    gap = ex - (ax + aw)
    if gap < -slack:
        return None
    return max(gap, 0.0)


def find_all(elements: Iterable[Any], query: Query) -> list[Any]:
    """返回所有满足条件的元素，保持原顺序；``right_of`` 的锚点必须唯一。"""
    elements = list(elements)
    matches = [e for e in elements if _basic_matches(query, e)]
    if query.right_of is None:
        return matches
    anchor = find_one(elements, query.right_of)
    scored = []
    for e in matches:
        distance = _same_row_right(anchor, e, query.row_slack)
        if distance is not None:
            scored.append((distance, e))
    if query.nearest and scored:
        best = min(d for d, _ in scored)
        return [e for d, e in scored if d == best]
    return [e for _, e in scored]


def find_one(elements: Sequence[Any] | Iterable[Any], query: Query) -> Any:
    """唯一命中返回元素；否则抛 TargetNotFound 或 TargetAmbiguous。"""
    hits = find_all(elements, query)
    if not hits:
        raise TargetNotFoundError(f"没有元素满足 {query.describe()}")
    if len(hits) > 1:
        indexes = [getattr(h, "index", None) for h in hits]
        raise TargetAmbiguousError(f"{len(hits)} 个元素满足 {query.describe()}：index {indexes}")
    return hits[0]
