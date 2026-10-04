"""Monitor 核心：指令客户端、执行管线、GUI 执行权、暂停、崩溃恢复、离线检测、本地限额。

Ledger、Driver、ActionHandler、Observer 一律通过 monitor_contracts 的 Protocol 注入。
"""

from __future__ import annotations

from .client import (
    Backoff,
    ClaimResponse,
    CommandClient,
    EventReport,
    HeartbeatAck,
    RequestRejected,
    ResultReport,
    ServerError,
    ServerUnavailable,
    Unauthorized,
)
from .clock import Clock, ManualClock, SystemClock
from .events import make_event
from .gui_lock import ACTION, OBSERVE, GuiLock
from .guard import CommandCancelled, ExecContext, GuardedDriver, ReadOnlyViolation
from .limits import HARD_DAILY_CAPS, MIN_INTERVAL_FLOORS, ActionLimit, RateDecision, check_rate, effective_limit
from .pipeline import ANOMALY_REASONS, ExecOutcome, Gate, Pipeline
from .runtime import MonitorRuntime, RuntimeConfig

__all__ = [
    "ACTION",
    "ANOMALY_REASONS",
    "ActionLimit",
    "Backoff",
    "ClaimResponse",
    "Clock",
    "CommandCancelled",
    "CommandClient",
    "EventReport",
    "ExecContext",
    "ExecOutcome",
    "Gate",
    "GuardedDriver",
    "GuiLock",
    "HARD_DAILY_CAPS",
    "HeartbeatAck",
    "MIN_INTERVAL_FLOORS",
    "ManualClock",
    "MonitorRuntime",
    "OBSERVE",
    "Pipeline",
    "RateDecision",
    "ReadOnlyViolation",
    "RequestRejected",
    "ResultReport",
    "RuntimeConfig",
    "ServerError",
    "ServerUnavailable",
    "SystemClock",
    "Unauthorized",
    "check_rate",
    "effective_limit",
    "make_event",
]
