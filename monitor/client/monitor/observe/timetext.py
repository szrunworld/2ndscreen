"""会话列表时间文案的解析。

列表行右上角显示该会话最近一条消息的时间，形态由客户端决定。B 的夹具里实际见到的只有
『19:03』（当天）与『昨天』；聊天区里还见到『昨天 16:25』『09-14 10:55』。其余形态按常见写法
支持，但只接受能确定换算的写法，其他一律返回 None（调用方按"不确定"处理，不猜）。

精度分两种：
- minute：能确定到分钟（『19:03』『昨天 16:25』『10月3日 08:10』）。
- day：只能确定到日（『昨天』『10月3日』『2025/10/03』）。

时区：客户端显示的是本机本地时间，观察器按配置的时区（默认 Asia/Shanghai）换算。
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta, tzinfo
from typing import Literal

Precision = Literal["minute", "day"]

# 当天时间比观察时刻晚超过这个量，视为不一致（可能是跨午夜后客户端尚未刷新），按不确定处理
FUTURE_TOLERANCE = timedelta(minutes=5)

_HM = r"(?P<h>[01]?\d|2[0-3])[:：](?P<m>[0-5]\d)"
_RE_TODAY = re.compile(rf"^{_HM}$")
_RE_RELATIVE = re.compile(rf"^(?P<rel>昨天|前天)(?:\s*{_HM})?$")
_RE_MONTH_DAY_CN = re.compile(rf"^(?P<mo>1[0-2]|0?[1-9])月(?P<d>3[01]|[12]\d|0?[1-9])日(?:\s*{_HM})?$")
_RE_MONTH_DAY_DASH = re.compile(rf"^(?P<mo>1[0-2]|0?[1-9])[-/](?P<d>3[01]|[12]\d|0?[1-9])(?:\s+{_HM})?$")
_RE_FULL_DATE = re.compile(
    rf"^(?P<y>20\d\d)(?:[-/.]|年)(?P<mo>1[0-2]|0?[1-9])(?:[-/.]|月)(?P<d>3[01]|[12]\d|0?[1-9])日?(?:\s*{_HM})?$"
)

_RELATIVE_DAYS = {"昨天": 1, "前天": 2}


@dataclass(frozen=True)
class ListTime:
    """解析结果。start 是该时间片的起点（本地时区、带时区）。"""

    text: str
    start: datetime
    precision: Precision

    @property
    def local_date(self) -> date:
        return self.start.date()

    def bucket(self) -> str:
        """event_id 用的时间片：分钟精度规范化到 UTC 分钟，日精度用本地日期。"""
        if self.precision == "minute":
            return self.start.astimezone(UTC).strftime("%Y-%m-%dT%H:%MZ")
        return f"{self.local_date.isoformat()}/day"


def normalize_time_text(text: str) -> str:
    """NFKC、去首尾空白、合并内部空白。"""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", text)).strip()


def _at(day: date, hour: int, minute: int, tz: tzinfo) -> datetime:
    return datetime.combine(day, time(hour, minute), tzinfo=tz)


def _safe_date(year: int, month: int, day: int) -> date | None:
    try:
        return date(year, month, day)
    except ValueError:
        return None


def parse_list_time(text: str, now: datetime, tz: tzinfo) -> ListTime | None:
    """把列表上的时间文案换算成带时区时间；无法确定时返回 None。

    now 必须带时区。换算结果不能晚于 now（当天时间允许 FUTURE_TOLERANCE 的时钟误差）。
    『M月D日』不带年份：取今年；若落在未来，则取去年（列表只展示近 30 天，跨年时才会出现）。
    """
    if now.tzinfo is None:
        raise ValueError("now 必须带时区")
    raw = normalize_time_text(text)
    if not raw:
        return None
    local_now = now.astimezone(tz)
    today = local_now.date()

    def finish(day: date | None, m: re.Match[str]) -> ListTime | None:
        if day is None:
            return None
        if m.group("h") is not None:
            start = _at(day, int(m.group("h")), int(m.group("m")), tz)
            precision: Precision = "minute"
        else:
            start = _at(day, 0, 0, tz)
            precision = "day"
        if precision == "minute" and start > local_now + FUTURE_TOLERANCE:
            return None
        if precision == "day" and day > today:
            return None
        return ListTime(text=raw, start=start, precision=precision)

    if m := _RE_TODAY.match(raw):
        start = _at(today, int(m.group("h")), int(m.group("m")), tz)
        if start > local_now + FUTURE_TOLERANCE:
            return None
        return ListTime(text=raw, start=start, precision="minute")
    if m := _RE_RELATIVE.match(raw):
        return finish(today - timedelta(days=_RELATIVE_DAYS[m.group("rel")]), m)
    if m := (_RE_MONTH_DAY_CN.match(raw) or _RE_MONTH_DAY_DASH.match(raw)):
        month, dom = int(m.group("mo")), int(m.group("d"))
        day = _safe_date(today.year, month, dom)
        if day is not None and day > today:
            day = _safe_date(today.year - 1, month, dom)
        return finish(day, m)
    if m := _RE_FULL_DATE.match(raw):
        return finish(_safe_date(int(m.group("y")), int(m.group("mo")), int(m.group("d"))), m)
    return None


def time_shape(text: str) -> str:
    """无法解析的时间文案的"形态"：数字替换成 9，用于"同一呈现只上报一次"的去重键。"""
    return re.sub(r"\d", "9", normalize_time_text(text))[:40]
