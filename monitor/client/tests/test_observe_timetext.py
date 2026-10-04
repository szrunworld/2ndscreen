"""列表时间文案解析与基线比较（monitor.observe.timetext / classify_against_baseline）。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from monitor.observe import ListTime, classify_against_baseline, parse_list_time, time_shape

SH = ZoneInfo("Asia/Shanghai")
# 夹具录制时刻附近：2026-10-04 19:20（+08:00）
NOW = datetime(2026, 10, 4, 19, 20, tzinfo=SH)


def local(*args: int) -> datetime:
    return datetime(*args, tzinfo=SH)


@pytest.mark.parametrize(
    ("text", "start", "precision"),
    [
        ("10:32", local(2026, 10, 4, 10, 32), "minute"),
        ("19:03", local(2026, 10, 4, 19, 3), "minute"),
        ("9:05", local(2026, 10, 4, 9, 5), "minute"),
        (" 19：03 ", local(2026, 10, 4, 19, 3), "minute"),  # 全角冒号、首尾空白
        ("昨天", local(2026, 10, 3), "day"),
        ("昨天 16:25", local(2026, 10, 3, 16, 25), "minute"),
        ("前天", local(2026, 10, 2), "day"),
        ("10月3日", local(2026, 10, 3), "day"),
        ("9月14日 08:10", local(2026, 9, 14, 8, 10), "minute"),
        ("09-14 10:55", local(2026, 9, 14, 10, 55), "minute"),
        ("09-14", local(2026, 9, 14), "day"),
        ("2025/10/03", local(2025, 10, 3), "day"),
        ("2025-10-03 07:00", local(2025, 10, 3, 7, 0), "minute"),
        ("2025年10月3日", local(2025, 10, 3), "day"),
        ("10月4日", local(2026, 10, 4), "day"),  # 当天的日期写法
    ],
)
def test_parse_supported_shapes(text: str, start: datetime, precision: str) -> None:
    parsed = parse_list_time(text, NOW, SH)
    assert parsed is not None
    assert parsed.start == start
    assert parsed.precision == precision


@pytest.mark.parametrize(
    "text",
    ["", "   ", "周三", "星期一", "刚刚", "3分钟前", "25:00", "10:60", "2月30日", "13月1日", "abc", "2025/02/30"],
)
def test_unparseable_returns_none(text: str) -> None:
    assert parse_list_time(text, NOW, SH) is None


def test_today_time_in_future_is_uncertain() -> None:
    # 19:20 观察到『23:50』：只能是客户端未刷新的昨天，不猜
    assert parse_list_time("23:50", NOW, SH) is None
    # 时钟误差容许 5 分钟
    assert parse_list_time("19:24", NOW, SH) is not None


def test_future_full_date_is_uncertain() -> None:
    assert parse_list_time("2026/10/05", NOW, SH) is None
    assert parse_list_time("2026-10-05 08:00", NOW, SH) is None


def test_month_day_crossing_year_uses_previous_year() -> None:
    jan2 = datetime(2027, 1, 2, 9, 0, tzinfo=SH)
    parsed = parse_list_time("12月30日", jan2, SH)
    assert parsed is not None and parsed.start == local(2026, 12, 30)


def test_now_is_converted_to_client_timezone() -> None:
    # UTC 2026-10-04 17:00 = 上海 10-05 01:00：『昨天』指 10-04
    now_utc = datetime(2026, 10, 4, 17, 0, tzinfo=UTC)
    parsed = parse_list_time("昨天", now_utc, SH)
    assert parsed is not None and parsed.local_date.isoformat() == "2026-10-04"


def test_naive_now_rejected() -> None:
    with pytest.raises(ValueError):
        parse_list_time("10:32", datetime(2026, 10, 4, 19, 20), SH)


def test_bucket_minute_is_utc_and_day_is_local_date() -> None:
    minute = parse_list_time("19:03", NOW, SH)
    day = parse_list_time("昨天", NOW, SH)
    assert minute is not None and minute.bucket() == "2026-10-04T11:03Z"
    assert day is not None and day.bucket() == "2026-10-03/day"
    # 同一文案多次解析得到同一 bucket（与观察时刻的秒数无关）
    later = parse_list_time("19:03", NOW + timedelta(seconds=37), SH)
    assert later is not None and later.bucket() == minute.bucket()


def test_fixed_offset_timezone_supported() -> None:
    tz = timezone(timedelta(hours=8))
    parsed = parse_list_time("10:32", NOW, tz)
    assert parsed is not None and parsed.bucket() == "2026-10-04T02:32Z"


def test_time_shape_masks_digits() -> None:
    assert time_shape("2025年10月3日 周五") == "9999年99月9日 周五"
    assert time_shape(" 周三 ") == "周三"


BASE = local(2026, 10, 4, 19, 10, 30)


def lt(start: datetime, precision: str) -> ListTime:
    return ListTime(text="x", start=start, precision=precision)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("start", "precision", "expected"),
    [
        (local(2026, 10, 4, 19, 11), "minute", "new"),
        (local(2026, 10, 4, 19, 10), "minute", "backlog"),  # 与基线同一分钟：不猜，按积压
        (local(2026, 10, 4, 19, 9), "minute", "backlog"),
        (local(2026, 10, 3, 23, 59), "minute", "backlog"),
        (local(2026, 10, 5), "day", "new"),
        (local(2026, 10, 3), "day", "backlog"),
        (local(2026, 10, 4), "day", "uncertain"),  # 同一天无法判断先后
    ],
)
def test_classify_against_baseline(start: datetime, precision: str, expected: str) -> None:
    assert classify_against_baseline(lt(start, precision), BASE) == expected


def test_classify_against_baseline_given_in_utc() -> None:
    base_utc = BASE.astimezone(UTC)
    assert classify_against_baseline(lt(local(2026, 10, 4, 19, 11), "minute"), base_utc) == "new"
    assert classify_against_baseline(lt(local(2026, 10, 4), "day"), base_utc) == "uncertain"
