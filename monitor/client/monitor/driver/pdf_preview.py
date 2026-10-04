"""在 Driver 层剔除附件 PDF 预览的子树。

依据（docs/monitor/capabilities.md 1.4、B 的 attachment_entry 夹具第 4 步）：附件预览是
窗口内的 AXWebArea『PDF预览』，其下有『切图』按钮和 PDF 文字层；文字层逐行可读，含电话、
邮箱。Monitor 不读这一层，所以 ``state()`` 返回的 Snapshot 里只保留预览容器本身（便于识别
"预览开着"），容器下的子元素一律丢掉。预览工具栏的 3 个图标与右上关闭按钮在容器框外，保留。

判定只看容器的角色与 label，不读子元素的任何文字：

1. 预览容器：基础角色是 AXWebArea，且 label 含 "PDF"（不区分大小写）。
2. 子树成员：排在容器之后（辅助功能树按深度优先展开，后代总在祖先之后），并且
   - 有树信息（parent_index）时：沿 parent_index 向上能到达容器；
   - 没有树信息时（例如不带树的夹具）：元素框完整落在容器框内（容差 1 点）。
     不用"中心点落在框内"，否则容器之后那个铺满窗口的 AXGroup 也会被误删。

剔除后元素重新从 0 连续编号（契约要求 index 等于位置），parent_index 同步换算。
"""

from __future__ import annotations

import unicodedata
from collections.abc import Iterable, Mapping, Sequence
from typing import TypeVar

from monitor_contracts import Element, FixtureElement, Frame

# 容器框的容差（点）。夹具里文字层的框比容器窄 1 点。
_TOLERANCE = 1.0

E = TypeVar("E", Element, FixtureElement)


def is_pdf_preview(role: str, label: str) -> bool:
    """是否是附件 PDF 预览的容器 AXWebArea。"""
    base = role.split("/", 1)[0]
    return base == "AXWebArea" and "PDF" in unicodedata.normalize("NFKC", label or "").upper()


def _inside(inner: Frame, outer: Frame) -> bool:
    return (
        inner.x >= outer.x - _TOLERANCE
        and inner.y >= outer.y - _TOLERANCE
        and inner.x + inner.w <= outer.x + outer.w + _TOLERANCE
        and inner.y + inner.h <= outer.y + outer.h + _TOLERANCE
    )


def hidden_positions(
    elements: Sequence[Element | FixtureElement], parents: Mapping[int, int | None] | None = None
) -> set[int]:
    """要剔除的元素位置（不含容器本身）。

    parents：位置 → 父元素位置。缺省时用元素自带的 parent_index；某个元素在其中查不到
    父信息（键不存在，或值为 None 且元素也没有 parent_index）时按几何规则判定。
    """
    previews = [pos for pos, e in enumerate(elements) if is_pdf_preview(e.role, e.label)]
    if not previews:
        return set()

    def parent_of(pos: int) -> tuple[bool, int | None]:
        """(是否有树信息, 父位置)。"""
        if parents is not None and pos in parents:
            return True, parents[pos]
        own = elements[pos].parent_index
        return (own is not None), own

    hidden: set[int] = set()
    for pos in range(previews[0] + 1, len(elements)):
        element = elements[pos]
        if is_pdf_preview(element.role, element.label):
            continue
        known, parent = parent_of(pos)
        if known:
            seen: set[int] = set()
            while parent is not None and parent not in seen:
                if parent in previews and parent < pos:
                    hidden.add(pos)
                    break
                seen.add(parent)
                parent = parent_of(parent)[1]
        elif any(p < pos and _inside(element.frame, elements[p].frame) for p in previews):
            hidden.add(pos)
    return hidden


def renumber(elements: Iterable[E], hidden: set[int]) -> tuple[list[E], dict[int, int]]:
    """丢掉 hidden 中的位置，其余从 0 连续编号。返回 (新元素, 旧位置 → 新位置)。

    parent_index 指向被剔除的元素时置为 None（规则保证子树整体剔除，正常不会出现）。
    """
    kept = [(pos, e) for pos, e in enumerate(elements) if pos not in hidden]
    mapping = {old: new for new, (old, _) in enumerate(kept)}
    out = []
    for new, (_, e) in enumerate(kept):
        parent = e.parent_index
        out.append(
            e.model_copy(update={"index": new, "parent_index": mapping.get(parent) if parent is not None else None})
        )
    return out, mapping


def strip_pdf_preview(
    elements: Sequence[E], parents: Mapping[int, int | None] | None = None
) -> tuple[list[E], dict[int, int]]:
    """剔除 PDF 预览子树并重新编号。没有预览时原样返回（映射为恒等）。"""
    hidden = hidden_positions(elements, parents)
    if not hidden:
        return list(elements), {pos: pos for pos in range(len(elements))}
    return renumber(elements, hidden)
