"""对外动作的每日上限与最小间隔：本地强制，策略只能收紧。

下面两张表是写死在代码里的硬约束（方案第三、十一节）：
- HARD_DAILY_CAPS：每种对外动作每天最多执行多少次。策略里的 daily_limits 高于它时按它算。
- MIN_INTERVAL_FLOORS：两次同类动作之间至少间隔多少秒。策略里的 min_interval_seconds 低于它时按它算。

改这两张表等于放宽安全边界，需要用户同意；不要做成配置项。
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, tzinfo
from types import MappingProxyType
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from monitor_contracts import OUTWARD_ACTIONS, CommandState, LedgerCommand, Policy

from . import write_flags

# 数值来源：用户 2026-10-04 确认；N 阶段拿到平台实测配额后再调。
HARD_DAILY_CAPS: MappingProxyType[str, int] = MappingProxyType(
    {
        "send_greeting": 40,
        "request_resume": 40,
        "request_contact_exchange": 40,
        "search_candidates": 40,
    }
)

# 数值来源：用户 2026-10-04 确认；N 阶段实测后再调。单位：秒。
MIN_INTERVAL_FLOORS: MappingProxyType[str, int] = MappingProxyType(
    {
        "send_greeting": 45,
        "request_resume": 45,
        "request_contact_exchange": 60,
        "search_candidates": 30,
    }
)

assert set(HARD_DAILY_CAPS) == set(OUTWARD_ACTIONS) == set(MIN_INTERVAL_FLOORS)


@dataclass(frozen=True)
class ActionLimit:
    daily_cap: int
    min_interval_seconds: int


def effective_limit(action: str, policy: Policy | None) -> ActionLimit:
    """取策略与硬约束中更严的一方。没有策略时用硬约束。"""
    if action not in HARD_DAILY_CAPS:
        raise ValueError(f"{action} 不是对外动作，没有上限")
    cap = HARD_DAILY_CAPS[action]
    interval = MIN_INTERVAL_FLOORS[action]
    if policy is not None:
        cap = min(cap, getattr(policy.daily_limits, action))
        interval = max(interval, getattr(policy.min_interval_seconds, action))
    return ActionLimit(daily_cap=cap, min_interval_seconds=interval)


def policy_timezone(policy: Policy | None) -> tzinfo:
    """按策略工作时段的时区划分"每日"；没有策略或时区无效时用 UTC。"""
    if policy is None:
        return UTC
    try:
        return ZoneInfo(policy.work_hours.timezone)
    except (ZoneInfoNotFoundError, ValueError):
        return UTC


@dataclass(frozen=True)
class RateDecision:
    allowed: bool
    kind: Literal["ok", "daily_cap", "min_interval"]
    used_today: int
    limit: ActionLimit
    retry_at: datetime | None = None

    def detail(self) -> str:
        if self.kind == "daily_cap":
            return f"今日已执行 {self.used_today} 次，达到上限 {self.limit.daily_cap}"
        if self.kind == "min_interval":
            return f"距上次同类动作不足 {self.limit.min_interval_seconds} 秒"
        return ""


def _counts_as_execution(rec: LedgerCommand) -> datetime | None:
    """一条账本记录是否计入上限；计入时返回执行时间。

    只统计 execute 模式下真正碰过界面的执行：正在 running 的，或结果按 write_flags.counts_toward_limit 计入的（对外动作；搜索看导航）。
    前置检查失败（白名单、限额、过期等）没有动界面，不计入。
    """
    if rec.command.execution_mode != "execute":
        return None
    if rec.state == CommandState.RUNNING:
        return rec.updated_at
    if rec.result is not None and write_flags.counts_toward_limit(rec.result):
        return rec.result.executed_at or rec.updated_at
    return None


def check_rate(
    action: str,
    *,
    now: datetime,
    history: Iterable[LedgerCommand],
    policy: Policy | None,
) -> RateDecision:
    """检查 action 现在能否执行。history 是账本中的指令记录（含所有动作，函数内部过滤）。"""
    limit = effective_limit(action, policy)
    tz = policy_timezone(policy)
    today = now.astimezone(tz).date()
    used = 0
    last: datetime | None = None
    for rec in history:
        if rec.command.action != action:
            continue
        at = _counts_as_execution(rec)
        if at is None:
            continue
        if at.astimezone(tz).date() == today:
            used += 1
        if last is None or at > last:
            last = at
    if used >= limit.daily_cap:
        return RateDecision(False, "daily_cap", used, limit)
    if last is not None and limit.min_interval_seconds > 0:
        retry_at = last + timedelta(seconds=limit.min_interval_seconds)
        if retry_at > now:
            return RateDecision(False, "min_interval", used, limit, retry_at=retry_at)
    return RateDecision(True, "ok", used, limit)
