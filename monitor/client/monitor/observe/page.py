"""页面分类与页签定位（规则来自任务 B 的夹具与 capabilities.md 1.2–1.6）。

分类只看元素树里可读的结构特征，判断不了就返回 unknown，不猜：

| 类别 | 特征 |
| --- | --- |
| attachment_preview | 有 label 为『PDF预览』的 AXWebArea。最先判断，命中后不再看其他元素（不读 PDF 文字层） |
| resume_overlay | 有 AXButton『继续沟通』，且侧栏有『转发』 |
| search | 有『根据热门词为您检索到以下牛人』或排序项『综合排序』 |
| conversation_detail | 有消息页页签组，且有 AXLink『在线简历』 |
| conversation_list | 有消息页页签组 |
| unknown | 其他（登录页、验证码当前没有夹具，也落在这里） |

坐标一律换算成窗口相对坐标（夹具与 CLI 输出都是全局坐标，显示器重排后会平移）。
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum

from monitor_contracts import Element, Frame, Snapshot


class PageKind(StrEnum):
    CONVERSATION_LIST = "conversation_list"
    CONVERSATION_DETAIL = "conversation_detail"
    SEARCH = "search"
    RESUME_OVERLAY = "resume_overlay"
    ATTACHMENT_PREVIEW = "attachment_preview"
    UNKNOWN = "unknown"


# 有消息页页签组、可以读会话列表的页面
LIST_PAGES = frozenset({PageKind.CONVERSATION_LIST, PageKind.CONVERSATION_DETAIL})

# 页签组几何（窗口相对）：页签在会话列表栏（x 120–504）顶部，y 约 56–100
TAB_BAR_Y = (40.0, 110.0)
LIST_COLUMN_X = (115.0, 510.0)
TAB_ROW_TOLERANCE = 6.0

NEW_GREETING_TAB = re.compile(r"^新招呼(?:\(\d+\))?$")
ALL_TAB_LABEL = "全部"
# 『更多』筛选菜单展开时可见的菜单项（菜单盖在列表上，展开时不读行）
MORE_MENU_ITEMS = frozenset({"牛人发起", "我发起", "已获取简历", "道具来源", "新建分组"})
# 气泡、确认框的按钮：出现即视为有弹层，观察器不点任何东西
POPUP_BUTTONS = frozenset({"确认", "确定"})


@dataclass(frozen=True)
class Layout:
    """把全局坐标换算到窗口相对坐标。"""

    ox: float
    oy: float

    def rel(self, frame: Frame) -> Frame:
        return Frame(x=frame.x - self.ox, y=frame.y - self.oy, w=frame.w, h=frame.h)

    @classmethod
    def of(cls, snapshot: Snapshot) -> Layout | None:
        if snapshot.window is not None:
            return cls(snapshot.window.frame.x, snapshot.window.frame.y)
        for el in snapshot.elements:
            if el.role.startswith("AXWindow"):
                return cls(el.frame.x, el.frame.y)
        return None


def _texts(el: Element) -> tuple[str, str]:
    return el.label.strip(), el.value.strip()


def _has_text(elements: Sequence[Element], text: str, *, roles: tuple[str, ...] | None = None) -> bool:
    for el in elements:
        if roles is not None and not el.role.startswith(roles):
            continue
        if text in _texts(el):
            return True
    return False


def find_tabs(snapshot: Snapshot, layout: Layout) -> tuple[list[Element], list[Element]]:
    """返回 (『新招呼』页签候选, 『全部』页签候选)。只认页签栏区域内带 label 的 AXGroup。"""
    new_tabs: list[Element] = []
    all_tabs: list[Element] = []
    for el in snapshot.elements:
        if el.role != "AXGroup":
            continue
        rel = layout.rel(el.frame)
        if not (TAB_BAR_Y[0] <= rel.y <= TAB_BAR_Y[1] and LIST_COLUMN_X[0] <= rel.x <= LIST_COLUMN_X[1]):
            continue
        label = el.label.strip()
        if NEW_GREETING_TAB.match(label):
            new_tabs.append(el)
        elif label == ALL_TAB_LABEL:
            all_tabs.append(el)
    return new_tabs, all_tabs


def new_greeting_tab(snapshot: Snapshot, layout: Layout) -> Element | None:
    """唯一的『新招呼(N)』页签；它必须与『全部』页签在同一行（页签组）。找不到或不唯一时返回 None。

    这是观察器唯一允许点击的控件：调用方只能把这里返回的元素交给 click。
    """
    new_tabs, all_tabs = find_tabs(snapshot, layout)
    if len(new_tabs) != 1 or len(all_tabs) != 1:
        return None
    tab, sibling = new_tabs[0], all_tabs[0]
    if abs(layout.rel(tab.frame).y - layout.rel(sibling.frame).y) > TAB_ROW_TOLERANCE:
        return None
    return tab


def is_new_greeting_tab(el: Element, snapshot: Snapshot, layout: Layout) -> bool:
    """el 是否就是该快照里的『新招呼』页签（点击前的最后一道核对）。"""
    tab = new_greeting_tab(snapshot, layout)
    return tab is not None and tab.index == el.index and tab == el


def has_popup(snapshot: Snapshot) -> bool:
    """有确认气泡或对话框（按钮『确认/确定』）。"""
    return any(el.role.startswith("AXButton") and el.label.strip() in POPUP_BUTTONS for el in snapshot.elements)


def more_menu_open(snapshot: Snapshot, layout: Layout) -> bool:
    """『更多』筛选菜单展开（菜单项出现在列表栏附近）。"""
    hits = 0
    for el in snapshot.elements:
        if el.role != "AXStaticText" or el.value.strip() not in MORE_MENU_ITEMS:
            continue
        rel = layout.rel(el.frame)
        if rel.y < 300 and rel.x >= LIST_COLUMN_X[0]:
            hits += 1
    return hits >= 2


def classify_page(snapshot: Snapshot) -> PageKind:
    els = snapshot.elements
    # 附件预览最先判断：命中后不再看任何其他元素（PDF 文字层含电话、邮箱）
    if any(el.role.startswith("AXWebArea") and el.label.strip() == "PDF预览" for el in els):
        return PageKind.ATTACHMENT_PREVIEW
    if _has_text(els, "继续沟通", roles=("AXButton",)) and _has_text(els, "转发"):
        return PageKind.RESUME_OVERLAY
    if _has_text(els, "根据热门词为您检索到以下牛人") or _has_text(els, "综合排序"):
        return PageKind.SEARCH
    layout = Layout.of(snapshot)
    if layout is None:
        return PageKind.UNKNOWN
    new_tabs, all_tabs = find_tabs(snapshot, layout)
    if not new_tabs or not all_tabs:
        return PageKind.UNKNOWN
    if _has_text(els, "在线简历", roles=("AXLink",)):
        return PageKind.CONVERSATION_DETAIL
    return PageKind.CONVERSATION_LIST
