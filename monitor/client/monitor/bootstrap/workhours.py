"""策略工作时段判断（local 模式决定何时接管 BOSS 窗口）。

work_hours.windows 为空表示任何时段都不生成对外指令，local 模式下也就不接管窗口。
end 不晚于 start 的窗口视为跨午夜：例如 days=[5]、22:00–02:00 覆盖周五 22:00 到周六 02:00。
"""

from __future__ import annotations

from datetime import datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def _hhmm(text: str) -> time:
    h, m = text.split(":")
    return time(int(h), int(m))


def in_work_hours(work_hours: Any, now: datetime) -> bool:
    """work_hours 是 Policy.work_hours（契约包未单独导出该类型，按字段读取）。now 必须带时区。work_hours 为 None 或时区无效时返回 False（不接管）。"""
    if now.tzinfo is None:
        raise ValueError("now 必须带时区")
    if work_hours is None or not work_hours.windows:
        return False
    try:
        tz = ZoneInfo(work_hours.timezone)
    except (ZoneInfoNotFoundError, ValueError):
        return False
    local = now.astimezone(tz)
    t = local.time().replace(second=0, microsecond=0)
    today = local.isoweekday()
    yesterday = (local - timedelta(days=1)).isoweekday()
    for w in work_hours.windows:
        start, end = _hhmm(w.start), _hhmm(w.end)
        if start < end:
            if today in w.days and start <= t < end:
                return True
        else:  # 跨午夜（含 start == end 表示全天 24 小时）
            if today in w.days and t >= start:
                return True
            if yesterday in w.days and t < end:
                return True
    return False
