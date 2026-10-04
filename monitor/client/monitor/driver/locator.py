"""定位器：在一次快照的元素列表里按契约 ``Locator`` 找唯一目标。纯函数，不调用 CLI。

条件取交集（契约 Locator 的语义），以下是本实现的具体约定：

- ``text``：规范化后与元素的 ``text``、``label``、``value`` 任一相等即命中。比只比
  ``Element.text`` 宽一点：弹出菜单 label="typeface"、value="Helvetica" 时两个词都能定位。
- ``text_contains``：规范化后是上述任一文本的子串。
- ``role``：相等即命中；``role`` 不含 "/" 时也命中带子角色的元素（``AXButton`` 命中
  ``AXButton/AXCloseButton``）。写全 ``AXCheckBox/AXSegment`` 则只命中该子角色。
- ``region``：元素中心点落在矩形内（全局坐标，左上为原点）。
- ``index``：快照内位置。
- ``right_of``：先在同一元素列表里唯一定位锚点（锚点歧义或未找到照常抛错）；候选元素的
  垂直中心落在锚点上下边之间（容差 ``ROW_SLACK``），且左边缘不在锚点右边缘左侧。

结果：恰好一个命中返回它；零个抛 TargetNotFoundError；多个抛 TargetAmbiguousError，
不替调用方挑选。``nearest=True``（不在契约 Locator 里，是本模块的附加参数）只作用于
最外层的 ``right_of``：取离锚点最近的一个，最近距离并列时仍是歧义。

规范化：去掉方向控制符（Calculator 的值带 U+200E）、NFKC、合并空白、去首尾空白；
区分大小写。
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Sequence

from monitor_contracts import Element, Frame, Locator, TargetAmbiguousError, TargetNotFoundError

ROW_SLACK = 2.0

_BIDI = re.compile("[‎‏‪-‮⁦-⁩﻿]")
_SPACE = re.compile(r"\s+")


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", _BIDI.sub("", text))
    return _SPACE.sub(" ", text).strip()


def element_texts(element: Element) -> list[str]:
    """元素可用于文本匹配的候选：text、label、value 中非空且不重复的。"""
    out: list[str] = []
    for value in (element.text, element.label, element.value):
        if value and value not in out:
            out.append(value)
    return out


def _role_matches(want: str, role: str) -> bool:
    return role == want or ("/" not in want and role.split("/", 1)[0] == want)


def _center(frame: Frame) -> tuple[float, float]:
    return (frame.x + frame.w / 2, frame.y + frame.h / 2)


def _basic_matches(locator: Locator, element: Element) -> bool:
    if locator.index is not None and element.index != locator.index:
        return False
    if locator.role is not None and not _role_matches(locator.role, element.role):
        return False
    texts = None
    if locator.text is not None:
        texts = [normalize(t) for t in element_texts(element)]
        if normalize(locator.text) not in texts:
            return False
    if locator.text_contains is not None:
        texts = texts if texts is not None else [normalize(t) for t in element_texts(element)]
        needle = normalize(locator.text_contains)
        if not any(needle in t for t in texts):
            return False
    if locator.region is not None and not locator.region.contains(*_center(element.frame)):
        return False
    return True


def _same_row_right(anchor: Element, element: Element) -> float | None:
    """元素在锚点同一行右侧时返回水平间距，否则 None。"""
    if element.index == anchor.index:
        return None
    a, e = anchor.frame, element.frame
    center_y = e.y + e.h / 2
    if not (a.y - ROW_SLACK <= center_y <= a.y + a.h + ROW_SLACK):
        return None
    gap = e.x - (a.x + a.w)
    if gap < -ROW_SLACK:
        return None
    return max(gap, 0.0)


def find_all(elements: Iterable[Element], locator: Locator, *, nearest: bool = False) -> list[Element]:
    """所有满足条件的元素，保持原顺序。``right_of`` 的锚点必须唯一。"""
    elements = list(elements)
    matches = [e for e in elements if _basic_matches(locator, e)]
    if locator.right_of is None:
        return matches
    anchor = find_one(elements, locator.right_of)
    scored = [(d, e) for e in matches if (d := _same_row_right(anchor, e)) is not None]
    if nearest and scored:
        best = min(d for d, _ in scored)
        return [e for d, e in scored if d == best]
    return [e for _, e in scored]


def find_one(
    elements: Sequence[Element] | Iterable[Element], locator: Locator, *, nearest: bool = False
) -> Element:
    """唯一命中返回元素；否则抛 TargetNotFoundError 或 TargetAmbiguousError。"""
    hits = find_all(elements, locator, nearest=nearest)
    if not hits:
        raise TargetNotFoundError(locator)
    if len(hits) > 1:
        raise TargetAmbiguousError(locator, len(hits))
    return hits[0]
