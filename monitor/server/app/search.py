"""搜索任务：控制台提交关键词 → 生成 search_candidates 指令 → Monitor 回报快照 → 控制台查看。

- ``POST /search-runs``：检查策略白名单（allowed_actions 含 search_candidates）、暂停（策略 paused、
  账户下设备全部暂停）、每日上限与最小间隔，然后创建 search_candidates 指令（有效期默认 600 秒）。
  不满足时 409 ``policy_blocked``，errors[].code 给出具体原因。
- ``GET /search-runs``、``GET /search-runs/{search_id}``：搜索任务与快照。

快照随指令结果到达（``CommandResultRecorded``），按契约 0.3.1 卡片形状（fields、masked_name、
prop_card_texts）原样保存。``SearchRun.outcome`` 只由 coverage 得出：
partial / complete → results；empty_confirmed → no_results；unreadable → unreadable。
unreadable 的 items 也是空的，但 outcome 不同，控制台不得把它显示成"没有结果"；指令失败且没有快照时
outcome 为 null。

搜索结果不需要身份：result_ref 只是本次快照里的位置，不能作为任何指令的目标（契约 0.3.0 已从会话目标
删除 result_ref，校验器拒绝）。本模块不提供从搜索结果发起动作的入口。
"""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Callable, Mapping
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Annotated, Any, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Body, Path, Query, Request
from pydantic import BaseModel, Field

from .commands import CommandCreateError
from .db import SqliteStore, from_db_time, to_db_time, wire_time
from .events import CommandResultRecorded
from .main import (
    AccountIdStr,
    ApiError,
    ApiModel,
    ConsoleActor,
    Ctx,
    IdempotencyKeyHeader,
    check_cursor,
    contract_ref,
    not_found,
    ok,
    problem_responses,
    run_idempotent,
    validation_failed,
)

if TYPE_CHECKING:
    from .main import AppContext

log = logging.getLogger(__name__)

ACTION = "search_candidates"
DEFAULT_TTL_SECONDS = 600
# Monitor 本地的硬上限与最小间隔下限（用户 2026-10-04 确认；client 的 core/limits.py 是权威），
# 服务端只能更严：有效上限 = min(策略, 硬上限)，有效间隔 = max(策略, 下限)。
HARD_DAILY_CAP = 40
MIN_INTERVAL_FLOOR_SECONDS = 30

OUTCOME_BY_COVERAGE = {
    "complete": "results",
    "partial": "results",
    "empty_confirmed": "no_results",
    "unreadable": "unreadable",
}
SEARCH_STATUS_BY_SERVER_STATUS = {
    "pending": "pending",
    "claimed": "running",
    "acked": "running",
    "succeeded": "completed",
    "failed": "failed",
    "unknown": "failed",
    "skipped_precondition": "failed",
    "expired": "expired",
    "cancelled": "cancelled",
}

SnapshotJson = Annotated[dict[str, Any], contract_ref("./schemas/search_snapshot.json")]
DateTimeStr = Annotated[str, Field(json_schema_extra={"format": "date-time"})]
SearchIdStr = Annotated[str, Path(pattern=r"^[A-Za-z0-9_-]{1,64}$")]


# ---------------------------------------------------------------------------
# HTTP 形状
# ---------------------------------------------------------------------------


class SearchRunCreate(ApiModel):
    account_id: AccountIdStr
    query: Annotated[str, Field(min_length=1, max_length=100)]
    max_results: Annotated[int, Field(ge=1, le=100)]
    ttl_seconds: Annotated[int, Field(ge=60, le=3600)] = DEFAULT_TTL_SECONDS


class SearchRun(BaseModel):
    search_id: str
    account_id: str
    query: str
    max_results: int
    command_id: Annotated[str, Field(json_schema_extra={"format": "uuid"})]
    status: Literal["pending", "running", "completed", "failed", "expired", "cancelled"]
    outcome: Literal["results", "no_results", "unreadable"] | None
    created_at: DateTimeStr
    expires_at: DateTimeStr
    snapshot: SnapshotJson | None


class SearchRunList(BaseModel):
    items: list[SearchRun]
    next_cursor: str | None


# ---------------------------------------------------------------------------
# 存储
# ---------------------------------------------------------------------------


class SearchStore:
    def __init__(self, store: SqliteStore):
        self._s = store

    def insert(self, run: dict[str, Any]) -> None:
        with self._s._tx() as c:
            c.execute(
                """INSERT INTO search_runs (search_id, account_id, query, max_results, command_id, created_by,
                       created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)""",
                (
                    run["search_id"],
                    run["account_id"],
                    run["query"],
                    run["max_results"],
                    run["command_id"],
                    run["created_by"],
                    run["created_at"],
                    run["expires_at"],
                ),
            )

    def get(self, search_id: str) -> Any:
        return self._s._one("SELECT * FROM search_runs WHERE search_id = ?", (search_id,))

    def by_command(self, command_id: str) -> Any:
        return self._s._one("SELECT * FROM search_runs WHERE command_id = ?", (command_id,))

    def set_snapshot(self, search_id: str, snapshot: dict[str, Any], outcome: str, now: str) -> bool:
        with self._s._tx() as c:
            cur = c.execute(
                """UPDATE search_runs SET snapshot_json = ?, outcome = ?, snapshot_at = ?
                   WHERE search_id = ? AND snapshot_json IS NULL""",
                (json.dumps(snapshot, ensure_ascii=False), outcome, now, search_id),
            )
            return cur.rowcount == 1

    def count_between(self, account_id: str, start: str, end: str) -> int:
        r = self._s._one(
            "SELECT count(*) AS n FROM search_runs WHERE account_id = ? AND created_at >= ? AND created_at < ?",
            (account_id, start, end),
        )
        return int(r["n"]) if r else 0

    def last_created_at(self, account_id: str) -> str | None:
        r = self._s._one("SELECT max(created_at) AS t FROM search_runs WHERE account_id = ?", (account_id,))
        return None if r is None else r["t"]

    def list(self, account_id: str | None, cursor: str | None, limit: int) -> Any:
        where, args = [], []
        if account_id is not None:
            where.append("account_id = ?")
            args.append(account_id)
        return self._s._page("search_runs", where, args, cursor, limit, lambda r: r)


# ---------------------------------------------------------------------------
# 业务
# ---------------------------------------------------------------------------

PolicyLookup = Callable[[str], Mapping[str, Any] | None]


class SearchService:
    """policy_lookup(account_id) 返回账户策略（线上 policy 形状）或 None。

    F2 合并前默认 None：没有策略即白名单为空，搜索一律 409（契约：allowed_actions 默认全部关闭）。
    F2 合并后装配为 ``ctx.policies.get``。
    """

    def __init__(self, ctx: AppContext, policy_lookup: PolicyLookup | None = None):
        self.ctx = ctx
        self.store = SearchStore(ctx.store)  # type: ignore[arg-type]
        self.policy_lookup: PolicyLookup = policy_lookup or (lambda account_id: None)
        self._unsubscribe = ctx.bus.subscribe(self._on_message)  # type: ignore[arg-type]

    # -- 门槛 -----------------------------------------------------------------

    def blocked_reasons(self, account_id: str, now: datetime) -> list[dict[str, str]]:
        """返回不能创建搜索的原因（空列表表示可以）。"""
        policy = self.policy_lookup(account_id)
        if policy is None:
            return [_err("policy", "账户没有策略，对外动作默认全部关闭", "action_not_allowed")]
        if ACTION not in policy.get("allowed_actions", []):
            return [_err("policy.allowed_actions", "策略白名单未开启搜索", "action_not_allowed")]
        reasons: list[dict[str, str]] = []
        if policy.get("paused"):
            reasons.append(_err("policy.paused", "账户策略已暂停", "paused"))
        if self._devices_all_paused(account_id):
            reasons.append(_err("devices", "账户下的设备都已暂停", "device_paused"))
        limit = min(int(policy.get("daily_limits", {}).get(ACTION, 0)), HARD_DAILY_CAP)
        start, end = _local_day(policy, now)
        if self.store.count_between(account_id, to_db_time(start), to_db_time(end)) >= limit:
            reasons.append(_err("policy.daily_limits.search_candidates", f"已达每日上限 {limit}", "daily_limit_reached"))
        interval = max(int(policy.get("min_interval_seconds", {}).get(ACTION, 0)), MIN_INTERVAL_FLOOR_SECONDS)
        last = self.store.last_created_at(account_id)
        if last is not None and from_db_time(last) + timedelta(seconds=interval) > now:  # type: ignore[operator]
            reasons.append(
                _err("policy.min_interval_seconds.search_candidates", f"距上次搜索不足 {interval} 秒", "rate_limited")
            )
        return reasons

    def _devices_all_paused(self, account_id: str) -> bool:
        """账户下所有已绑定、未吊销的设备都暂停（没有绑定设备时不算暂停，指令等设备上线后领取）。"""
        bound = []
        for device in self.ctx.store.list_devices():
            binding = self.ctx.store.get_binding(device.device_id)
            if binding is not None and binding.account_id == account_id and not device.revoked:
                bound.append(device)
        return bool(bound) and all(d.paused or (d.last_heartbeat or {}).get("paused") for d in bound)

    # -- 创建与查询 -------------------------------------------------------------

    def create(self, body: SearchRunCreate, actor: str) -> dict[str, Any]:
        now = self.ctx.clock.now()
        reasons = self.blocked_reasons(body.account_id, now)
        if reasons:
            raise ApiError(409, "policy_blocked", "策略未开启搜索、设备暂停或超出上限", errors=reasons)
        search_id = f"s_{uuid.uuid4().hex[:16]}"
        command_id = str(uuid.uuid4())
        expires = now + timedelta(seconds=body.ttl_seconds)
        command = {
            "command_id": command_id,
            "workflow_id": None,
            "account_id": body.account_id,
            "action": ACTION,
            "execution_mode": "execute",
            "target": {"scope": "current_page"},
            "payload": {"search_id": search_id, "query": body.query, "max_results": body.max_results},
            "issued_at": wire_time(to_db_time(now)),
            "expires_at": wire_time(to_db_time(expires)),
            "depends_on": None,
        }
        try:
            self.ctx.commands.create_command(command)
        except CommandCreateError as exc:
            raise validation_failed(exc.errors or [_err("query", str(exc), exc.code)], "搜索指令不符合契约") from exc
        self.store.insert(
            {
                "search_id": search_id,
                "account_id": body.account_id,
                "query": body.query,
                "max_results": body.max_results,
                "command_id": command_id,
                "created_by": actor,
                "created_at": to_db_time(now),
                "expires_at": to_db_time(expires),
            }
        )
        return self.record(self.store.get(search_id))

    def get(self, search_id: str) -> dict[str, Any] | None:
        row = self.store.get(search_id)
        return None if row is None else self.record(row)

    def record(self, row: Any) -> dict[str, Any]:
        """组装 openapi SearchRun。status 跟随指令；pending 且已过期显示 expired。"""
        cmd = self.ctx.store.get_command(row["command_id"])
        server_status = cmd.server_status if cmd is not None else "pending"
        status = SEARCH_STATUS_BY_SERVER_STATUS.get(server_status, "pending")
        if status == "pending" and row["expires_at"] <= to_db_time(self.ctx.clock.now()):
            status = "expired"
        return {
            "search_id": row["search_id"],
            "account_id": row["account_id"],
            "query": row["query"],
            "max_results": row["max_results"],
            "command_id": row["command_id"],
            "status": status,
            "outcome": row["outcome"],
            "created_at": wire_time(row["created_at"]),
            "expires_at": wire_time(row["expires_at"]),
            "snapshot": None if row["snapshot_json"] is None else json.loads(row["snapshot_json"]),
        }

    # -- 快照落库 -------------------------------------------------------------

    def _on_message(self, message: Any) -> None:
        if isinstance(message, CommandResultRecorded) and message.record["command"]["action"] == ACTION:
            self.store_snapshot(message.command_id, message.record["result"])

    def store_snapshot(self, command_id: str, result: Mapping[str, Any] | None) -> str | None:
        """从指令结果中取快照落库，返回 outcome；没有快照或对不上搜索任务时返回 None。

        结果已由 F1 按契约校验（unreadable 不能配 succeeded、items 与 coverage 一致等），这里只做归属检查。
        """
        row = self.store.by_command(command_id)
        if row is None or result is None:
            return None
        snapshot = (result.get("output") or {}).get("snapshot")
        if snapshot is None:
            return None
        if snapshot.get("search_id") != row["search_id"]:
            log.warning("搜索指令 %s 的快照 search_id 与任务 %s 不一致，未保存", command_id, row["search_id"])
            return None
        outcome = OUTCOME_BY_COVERAGE[snapshot["coverage"]]
        self.store.set_snapshot(row["search_id"], dict(snapshot), outcome, to_db_time(self.ctx.clock.now()))
        return outcome


def _local_day(policy: Mapping[str, Any], now: datetime) -> tuple[datetime, datetime]:
    """策略时区里的"今天"（每日上限按此计数）；时区无效时按 UTC。"""
    try:
        zone = ZoneInfo(policy.get("work_hours", {}).get("timezone") or "UTC")
    except Exception:
        zone = ZoneInfo("UTC")
    local = now.astimezone(zone)
    start = local.replace(hour=0, minute=0, second=0, microsecond=0)
    return start, start + timedelta(days=1)


def _err(path: str, message: str, code: str) -> dict[str, str]:
    return {"path": path, "message": message, "code": code}


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------

router = APIRouter(tags=["search"])


@router.post(
    "/search-runs",
    operation_id="createSearchRun",
    summary="控制台提交搜索（创建 search_candidates 指令）",
    status_code=201,
    response_model=SearchRun,
    responses=problem_responses(401, 409, 422),
)
def create_search_run(
    request: Request,
    ctx: Ctx,
    actor: ConsoleActor,
    idempotency_key: IdempotencyKeyHeader,
    body: Annotated[SearchRunCreate, Body()],
):
    return run_idempotent(
        ctx,
        request,
        f"console:{actor}",
        idempotency_key,
        body.model_dump(mode="json"),
        lambda: (201, ctx.search.create(body, actor)),
    )


@router.get(
    "/search-runs",
    operation_id="listSearchRuns",
    summary="搜索任务列表",
    response_model=SearchRunList,
    responses=problem_responses(401, 422),
)
def list_search_runs(
    ctx: Ctx,
    _actor: ConsoleActor,
    account_id: str | None = None,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
):
    page = ctx.search.store.list(account_id, check_cursor(cursor), limit)
    return ok({"items": [ctx.search.record(r) for r in page.items], "next_cursor": page.next_cursor})


@router.get(
    "/search-runs/{search_id}",
    operation_id="getSearchRun",
    summary="搜索任务与快照",
    response_model=SearchRun,
    responses=problem_responses(401, 404),
)
def get_search_run(ctx: Ctx, _actor: ConsoleActor, search_id: SearchIdStr):
    record = ctx.search.get(search_id)
    if record is None:
        raise not_found("搜索任务")
    return ok(record)


__all__ = [
    "HARD_DAILY_CAP",
    "MIN_INTERVAL_FLOOR_SECONDS",
    "OUTCOME_BY_COVERAGE",
    "SearchRunCreate",
    "SearchService",
    "SearchStore",
    "router",
]
