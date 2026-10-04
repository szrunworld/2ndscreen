"""会话列表可见行的解析（规则来自 conversation_list、new_application_marker 夹具）。

一行是列表栏里 x≈120、宽 384、高 76 的无标签 AXGroup（最后一行可能被裁成高 28）。行内：
- 姓名：带 label 的 AXGroup，位于第一行文字（x≈192）；
- 岗位：紧随姓名、同一行的下一个带 label 的 AXGroup；
- 时间：行右侧的 StaticText（x≈464）；
- 未读数：头像角的数字 StaticText（x≈167），只有未读时才有；
- 我方消息状态前缀：独立 StaticText『[已读]』『[送达]』。

只读姓名、岗位、时间、未读与前缀；不读消息预览（预览可能含个人信息，也不是识别依据）。
"""

from __future__ import annotations

from dataclasses import dataclass

from monitor_contracts import Element, Frame, Snapshot

from .page import LIST_COLUMN_X, Layout

ROW_X = 120.0
ROW_W = 384.0
ROW_X_TOLERANCE = 6.0
ROW_W_TOLERANCE = 10.0
ROW_MIN_H = 20.0
ROW_MAX_H = 90.0
# 行容器顶端要在子筛选栏（y≈115–132）之下
ROW_MIN_Y = 138.0
# 行内相对位置（相对行左上角）
NAME_LINE_MAX_DY = 32.0
TIME_MIN_DX = 300.0
BADGE_DX = (35.0, 65.0)
# 行高小于此值视为被裁剪的末行：缺字段时直接跳过，不当作不支持的呈现
CLIPPED_ROW_H = 60.0

OWN_STATUS_PREFIXES = frozenset({"[已读]", "[送达]"})


@dataclass(frozen=True)
class ListRow:
    """会话列表中的一行。position 是在可见行中的序号（从 0 开始，自上而下）。"""

    position: int
    element_index: int
    candidate_name: str
    job_title: str
    time_text: str
    unread: int | None
    own_status: str | None

    def summary(self) -> str:
        return f"{self.candidate_name} · {self.job_title} · {self.time_text}"


@dataclass(frozen=True)
class RowIssue:
    """某一行不符合已知结构（缺姓名、岗位或时间）。"""

    element_index: int
    missing: tuple[str, ...]


def _is_row_container(el: Element, rel: Frame) -> bool:
    return (
        el.role == "AXGroup"
        and not el.label.strip()
        and abs(rel.x - ROW_X) <= ROW_X_TOLERANCE
        and abs(rel.w - ROW_W) <= ROW_W_TOLERANCE
        and ROW_MIN_H <= rel.h <= ROW_MAX_H
        and rel.y >= ROW_MIN_Y
    )


def _inside(rel: Frame, row: Frame) -> bool:
    return row.x <= rel.x < row.x + row.w and row.y <= rel.y < row.y + row.h


def parse_rows(snapshot: Snapshot, layout: Layout) -> tuple[list[ListRow], list[RowIssue]]:
    """解析当前快照里会话列表的可见行。只看列表栏区域内的元素。"""
    rels = [(el, layout.rel(el.frame)) for el in snapshot.elements]
    containers = [(el, rel) for el, rel in rels if _is_row_container(el, rel)]
    containers.sort(key=lambda pair: pair[1].y)
    column = [(el, rel) for el, rel in rels if LIST_COLUMN_X[0] <= rel.x <= LIST_COLUMN_X[1]]

    rows: list[ListRow] = []
    issues: list[RowIssue] = []
    for container, box in containers:
        members = [(el, rel) for el, rel in column if el.index != container.index and _inside(rel, box)]
        labeled = sorted(
            (
                (el, rel)
                for el, rel in members
                if el.role == "AXGroup" and el.label.strip() and rel.y - box.y <= NAME_LINE_MAX_DY
            ),
            key=lambda pair: pair[1].x,
        )
        name = labeled[0][0].label.strip() if labeled else ""
        job = labeled[1][0].label.strip() if len(labeled) > 1 else ""
        statics = [(el, rel) for el, rel in members if el.role == "AXStaticText"]
        time_text = ""
        unread: int | None = None
        own_status: str | None = None
        for el, rel in statics:
            text = el.value.strip() or el.label.strip()
            dx = rel.x - box.x
            if dx >= TIME_MIN_DX and rel.y - box.y <= NAME_LINE_MAX_DY and not time_text:
                time_text = text
            elif BADGE_DX[0] <= dx <= BADGE_DX[1] and text.isdigit():
                unread = int(text)
            elif text in OWN_STATUS_PREFIXES:
                own_status = text
        missing = tuple(k for k, v in (("name", name), ("job", job), ("time", time_text)) if not v)
        if missing:
            if box.h >= CLIPPED_ROW_H:
                issues.append(RowIssue(element_index=container.index, missing=missing))
            continue
        rows.append(
            ListRow(
                position=len(rows),
                element_index=container.index,
                candidate_name=name,
                job_title=job,
                time_text=time_text,
                unread=unread,
                own_status=own_status,
            )
        )
    return rows, issues


def list_empty(snapshot: Snapshot) -> bool:
    """列表明确显示为空（『暂无牛人』）。"""
    return any(el.value.strip() == "暂无牛人" or el.label.strip() == "暂无牛人" for el in snapshot.elements)
