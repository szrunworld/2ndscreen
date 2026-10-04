"""观察模块（任务 E）：只读识别新投递，实现契约 Observer Protocol。

- create_observer()：D2 的 __main__ 按 ``monitor.observe:create_observer`` 装配
- NewApplicationObserver：观察器本体（observer.py）
- classify_page / PageKind：页面分类（page.py）
- parse_rows / ListRow：会话列表可见行（rows.py）
- parse_list_time / ListTime：列表时间文案（timetext.py）
"""

from .observer import (
    BASELINE_PENDING,
    NAVIGATION_BLOCKED,
    NOT_READY,
    UNSUPPORTED,
    Issue,
    NewApplicationObserver,
    classify_against_baseline,
    conversation_fingerprint,
    create_observer,
)
from .page import Layout, PageKind, classify_page, new_greeting_tab
from .rows import ListRow, RowIssue, parse_rows
from .timetext import ListTime, parse_list_time, time_shape

__all__ = [
    "BASELINE_PENDING",
    "NAVIGATION_BLOCKED",
    "NOT_READY",
    "UNSUPPORTED",
    "Issue",
    "Layout",
    "ListRow",
    "ListTime",
    "NewApplicationObserver",
    "PageKind",
    "RowIssue",
    "classify_against_baseline",
    "classify_page",
    "conversation_fingerprint",
    "create_observer",
    "new_greeting_tab",
    "parse_list_time",
    "parse_rows",
    "time_shape",
]
