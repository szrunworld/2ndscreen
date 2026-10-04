"""账本测试用的构造函数：合法的指令、结果、事件。只在内存里构造对象，不碰磁盘。

供 tests/test_ledger*.py 共用，也可供集成任务（M）复用。
"""

from __future__ import annotations

import itertools
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from monitor_contracts import CommandModel, CommandResult, EventModel, validate_command

from monitor.core.events import make_event

T0 = datetime(2026, 10, 4, 1, 0, tzinfo=UTC)
ACCOUNT = "acct_test"
DEVICE = "dev_test"

_ids = itertools.count(1)
_buckets = itertools.count(1)


def make_command(
    action: str = "request_resume",
    *,
    command_id: UUID | str | None = None,
    issued_at: datetime = T0,
    execution_mode: str = "execute",
) -> CommandModel:
    """合法的会话类指令。"""
    payload: dict[str, Any] = {
        "send_greeting": {"text": "你好"},
        "request_resume": {},
        "request_contact_exchange": {"exchange_type": "wechat"},
    }[action]
    return validate_command(
        {
            "command_id": str(command_id or f"00000000-0000-4000-8000-{next(_ids):012d}"),
            "workflow_id": "case_001",
            "account_id": ACCOUNT,
            "action": action,
            "execution_mode": execution_mode,
            "target": {"conversation": {"candidate_name": "候选人A", "job_title": "后端工程师", "hints": ["北京"]}},
            "payload": payload,
            "issued_at": issued_at.isoformat(),
            "expires_at": (issued_at + timedelta(minutes=10)).isoformat(),
            "depends_on": None,
        }
    )


def make_result(command: CommandModel, status: str = "succeeded", *, at: datetime = T0) -> CommandResult:
    """与 status 相符的最小合法结果（只支持无 output 要求的动作，如 request_resume / send_greeting）。"""
    reason = {
        "succeeded": None,
        "failed": "verification_failed",
        "unknown": "crash_recovery",
        "skipped_precondition": "precondition_already_done",
        "cancelled": None,
        "expired": None,
    }[status]
    executed = status in ("succeeded", "failed", "unknown", "skipped_precondition")
    return CommandResult(
        command_id=command.command_id,
        action=command.action,
        execution_mode=command.execution_mode,
        status=status,
        reason=reason,
        observed={},
        evidence=[],
        # 0.2.0 三个标志：成功/不明视为已发生对外动作；失败与跳过只导航过；未执行的什么都没做
        navigation_performed=executed,
        outbound_action_performed=status in ("succeeded", "unknown"),
        externally_visible_side_effect=status in ("succeeded", "unknown"),
        executed_at=at if executed else None,
        reported_at=at,
    )


def make_event_model(*, observed_at: datetime = T0, bucket: str | None = None) -> EventModel:
    """合法的 device_paused 事件；默认每次调用 bucket 不同，所以 event_id 不同。"""
    return make_event(
        "device_paused",
        device_id=DEVICE,
        account_id=ACCOUNT,
        payload={"reason": "user_request", "by": "user"},
        observed_at=observed_at,
        bucket=bucket or f"b{next(_buckets)}",
    )
