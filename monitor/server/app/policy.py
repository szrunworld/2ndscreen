"""策略：账户级策略的存储、校验、读写接口（If-Match 乐观锁），以及业务层用的策略判定。

判定规则（方案第三节、api.md 第四节）：
- 对外动作（问候、求简历、换微信、搜索）只在白名单 allowed_actions 开启、策略未暂停、
  账户下至少有一台未暂停的设备、处于工作时段内、未超过每日上限时生成；
- 每日上限取 min(策略值, Monitor 本地硬上限)。策略校验直接拒绝高于硬上限的 daily_limits
  和低于本地最小间隔的 min_interval_seconds（策略只能收紧，不能放宽）；
- verify_only（重新检查）与 provide_input 不受白名单和限额约束，由调用方跳过判定。

本地硬上限与最小间隔与 Monitor 客户端 ``monitor.core.limits`` 保持一致（测试会核对）；
服务端不依赖客户端包，所以在这里另写一份。
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import TYPE_CHECKING, Annotated, Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import monitor_contracts as mc
from fastapi import APIRouter, Body, Depends, Header, Request, Security
from fastapi.security import HTTPAuthorizationCredentials
from monitor_contracts import check

from .db import canonical_json, to_db_time, wire_time
from .main import (
    AccountIdStr,
    ApiError,
    ConsoleActor,
    Ctx,
    IdempotencyKeyHeader,
    console_bearer,
    contract_ref,
    device_bearer,
    get_ctx,
    hash_token,
    not_found,
    ok,
    problem_responses,
    run_idempotent,
    validation_failed,
)

if TYPE_CHECKING:
    from .db import SqliteStore
    from .main import AppContext

# Monitor 本地硬上限（用户 2026-10-04 确认；与 client/monitor/core/limits.py 一致）
HARD_DAILY_CAPS: Mapping[str, int] = {
    "send_greeting": 40,
    "request_resume": 40,
    "request_contact_exchange": 40,
    "search_candidates": 40,
}
MIN_INTERVAL_FLOORS: Mapping[str, int] = {
    "send_greeting": 45,
    "request_resume": 45,
    "request_contact_exchange": 60,
    "search_candidates": 30,
}
assert set(HARD_DAILY_CAPS) == set(mc.OUTWARD_ACTIONS) == set(MIN_INTERVAL_FLOORS)

DEFAULT_COMPANY_MAILBOX = "zhaopin@remotedesk.io"
DEFAULT_TIMEZONE = "Asia/Shanghai"
SERVER_FIELDS = ("policy_version", "updated_at", "updated_by", "company_mailbox")

PolicyJson = Annotated[dict[str, Any], contract_ref("./schemas/policy.json")]


def default_policy(account_id: str, now: datetime, company_mailbox: str | None) -> dict[str, Any]:
    """新账户的默认策略：对外动作全部关闭（白名单为空），其余取契约默认值与本地硬上限。"""
    return {
        "account_id": account_id,
        "policy_version": 1,
        "allowed_actions": [],
        "job_scope": {"mode": "all", "job_titles": []},
        "greeting": {"enabled": False, "template": ""},
        "auto_request_resume": False,
        "after_resume_received": {"action": "none", "wait_for_parse": True},
        "resume_mail_timeout_days": 3,
        "company_mailbox": company_mailbox,
        "mail_retention_days": 30,
        "work_hours": {
            "timezone": DEFAULT_TIMEZONE,
            "windows": [{"days": [1, 2, 3, 4, 5], "start": "09:00", "end": "18:00"}],
        },
        "daily_limits": dict(HARD_DAILY_CAPS),
        "min_interval_seconds": dict(MIN_INTERVAL_FLOORS),
        "pause_on_anomaly": True,
        "paused": False,
        "updated_at": wire_time(to_db_time(now)),
        "updated_by": "system",
    }


# ---------------------------------------------------------------------------
# 纯函数：校验与判定
# ---------------------------------------------------------------------------


def _err(path: str, message: str, code: str) -> dict[str, str]:
    return {"path": path, "message": message, "code": code}


def policy_errors(body: Any) -> list[dict[str, str]]:
    """契约校验 + 服务端附加规则。返回字段级错误（空列表表示合法）。

    附加规则：daily_limits 不得高于本地硬上限；min_interval_seconds 不得低于本地最小间隔；
    work_hours.timezone 必须是可识别的 IANA 时区；工作时段窗口 start 必须早于 end。
    """
    errors = [_err(e.path, e.message, e.code) for e in check("policy", body)]
    if errors:
        return errors
    for action, cap in HARD_DAILY_CAPS.items():
        if body["daily_limits"][action] > cap:
            errors.append(_err(f"daily_limits.{action}", f"不得高于 Monitor 本地硬上限 {cap}", "exceeds_hard_limit"))
    for action, floor in MIN_INTERVAL_FLOORS.items():
        if body["min_interval_seconds"][action] < floor:
            errors.append(
                _err(f"min_interval_seconds.{action}", f"不得低于 Monitor 本地最小间隔 {floor} 秒", "below_floor")
            )
    try:
        ZoneInfo(body["work_hours"]["timezone"])
    except (ZoneInfoNotFoundError, ValueError):
        errors.append(_err("work_hours.timezone", "不是可识别的 IANA 时区", "invalid_timezone"))
    for i, window in enumerate(body["work_hours"]["windows"]):
        if window["start"] >= window["end"]:
            errors.append(_err(f"work_hours.windows[{i}]", "start 必须早于 end（不支持跨午夜）", "invalid_window"))
    return errors


def policy_zone(policy: Mapping[str, Any]) -> ZoneInfo:
    try:
        return ZoneInfo(policy["work_hours"]["timezone"])
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        return ZoneInfo(DEFAULT_TIMEZONE)


def in_work_hours(policy: Mapping[str, Any], at: datetime) -> bool:
    """at 是否落在策略工作时段内（按策略时区；窗口为 [start, end)）。空窗口表示任何时段都不在内。"""
    local = at.astimezone(policy_zone(policy))
    hhmm = local.strftime("%H:%M")
    weekday = local.isoweekday()
    return any(weekday in w["days"] and w["start"] <= hhmm < w["end"] for w in policy["work_hours"]["windows"])


def job_in_scope(policy: Mapping[str, Any], job_title: str) -> bool:
    scope = policy["job_scope"]
    if scope["mode"] == "all":
        return True
    wanted = job_title.strip()
    return any(t.strip() == wanted for t in scope["job_titles"])


def effective_daily_limit(policy: Mapping[str, Any], action: str) -> int:
    return min(policy["daily_limits"][action], HARD_DAILY_CAPS[action])


def local_day_bounds(policy: Mapping[str, Any], day: date) -> tuple[datetime, datetime]:
    """策略时区下某一天的 [开始, 结束)，返回 UTC 时间。"""
    tz = policy_zone(policy)
    start = datetime.combine(day, time(0, 0), tzinfo=tz)
    return start.astimezone(UTC), (start + timedelta(days=1)).astimezone(UTC)


def local_today(policy: Mapping[str, Any], now: datetime) -> date:
    return now.astimezone(policy_zone(policy)).date()


def render_greeting(template: str, candidate_name: str, job_title: str) -> str:
    """渲染问候模板。只替换 {candidate_name}、{job_title} 两个占位符，其他花括号原样保留。"""
    return template.replace("{candidate_name}", candidate_name).replace("{job_title}", job_title)


def normalize_if_match(value: str) -> str:
    v = value.strip()
    if v.startswith("W/"):
        v = v[2:]
    return v.strip('"')


# ---------------------------------------------------------------------------
# 存储（与 F1 共用同一个 SQLite 连接；表在 db.MIGRATIONS v2）
# ---------------------------------------------------------------------------


class PolicyStore:
    def __init__(self, store: SqliteStore):
        self._s = store

    def get(self, account_id: str) -> dict[str, Any] | None:
        r = self._s._one("SELECT policy_json FROM policies WHERE account_id = ?", (account_id,))
        return None if r is None else _loads(r["policy_json"])

    def insert_if_absent(self, policy: dict[str, Any]) -> bool:
        with self._s._tx() as c:
            cur = c.execute(
                "INSERT OR IGNORE INTO policies (account_id, policy_version, policy_json, updated_at) VALUES (?,?,?,?)",
                (policy["account_id"], policy["policy_version"], canonical_json(policy), policy["updated_at"]),
            )
            return cur.rowcount == 1

    def compare_and_set(self, policy: dict[str, Any], expected_version: int) -> bool:
        """仅当当前版本等于 expected_version 时写入（原子）。"""
        with self._s._tx() as c:
            cur = c.execute(
                """UPDATE policies SET policy_version = ?, policy_json = ?, updated_at = ?
                   WHERE account_id = ? AND policy_version = ?""",
                (
                    policy["policy_version"],
                    canonical_json(policy),
                    policy["updated_at"],
                    policy["account_id"],
                    expected_version,
                ),
            )
            return cur.rowcount == 1

    def account_known(self, account_id: str) -> bool:
        """账户是否存在：已有策略、有设备绑定或已有流程。"""
        for sql in (
            "SELECT 1 FROM policies WHERE account_id = ?",
            "SELECT 1 FROM account_bindings WHERE account_id = ?",
            "SELECT 1 FROM recruitment_cases WHERE account_id = ?",
        ):
            if self._s._one(sql + " LIMIT 1", (account_id,)) is not None:
                return True
        return False

    def count_outbound(self, account_id: str, action: str, start: str, end: str) -> int:
        """[start, end) 内为该账户生成的对外指令数（execute 模式；已取消或过期且没有结果的不算）。"""
        r = self._s._one(
            """SELECT COUNT(*) AS n FROM commands
               WHERE account_id = ? AND action = ? AND created_at >= ? AND created_at < ?
                 AND COALESCE(json_extract(command_json, '$.execution_mode'), 'execute') = 'execute'
                 AND NOT (server_status IN ('cancelled', 'expired') AND result_json IS NULL)""",
            (account_id, action, start, end),
        )
        return int(r["n"]) if r is not None else 0


def _loads(text: str) -> dict[str, Any]:
    return json.loads(text)


# ---------------------------------------------------------------------------
# 业务
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Gate:
    """对外动作判定结果：allowed=False 时 reason 为 not_allowed / paused / devices_paused /
    outside_work_hours / daily_limit_reached。"""

    allowed: bool
    reason: str | None = None


class PolicyService:
    def __init__(self, ctx: AppContext, company_mailbox: str | None = DEFAULT_COMPANY_MAILBOX):
        self.ctx = ctx
        self.company_mailbox = company_mailbox
        self.repo = PolicyStore(ctx.store)  # type: ignore[arg-type]

    def _now(self) -> datetime:
        return self.ctx.clock.now()

    def get(self, account_id: str) -> dict[str, Any] | None:
        """读取策略；账户已知但还没有策略时写入默认策略（版本 1）。未知账户返回 None。"""
        policy = self.repo.get(account_id)
        if policy is None:
            if not self.repo.account_known(account_id):
                return None
            self.repo.insert_if_absent(default_policy(account_id, self._now(), self.company_mailbox))
            policy = self.repo.get(account_id)
        assert policy is not None
        policy["company_mailbox"] = self.company_mailbox  # 只读，以服务端配置为准
        return policy

    def require(self, account_id: str) -> dict[str, Any]:
        policy = self.get(account_id)
        if policy is None:
            raise not_found("账户策略")
        return policy

    def version(self, account_id: str) -> int | None:
        """心跳响应里的 policy_version。"""
        policy = self.get(account_id)
        return None if policy is None else int(policy["policy_version"])

    def put(self, account_id: str, body: Any, if_match: str, actor: str) -> dict[str, Any]:
        """保存策略：If-Match 必须等于当前版本（412），服务端字段覆盖，版本 +1。"""
        current = self.require(account_id)
        if not isinstance(body, dict):
            raise validation_failed([_err("", "请求体必须是对象", "type")])
        merged = dict(body)
        # 服务端字段以服务端为准：先用当前值填上，便于校验；保存时再覆盖
        for name in SERVER_FIELDS:
            merged[name] = current[name]
        if merged.get("account_id") != account_id:
            raise validation_failed([_err("account_id", "与路径中的 account_id 不一致", "path_mismatch")])
        errors = policy_errors(merged)
        if errors:
            raise validation_failed(errors, "策略不合法")
        expected = normalize_if_match(if_match)
        if expected != str(current["policy_version"]):
            raise ApiError(412, "policy_version_mismatch", "策略已被修改，请刷新后重试", existing=current)
        merged.update(
            policy_version=current["policy_version"] + 1,
            updated_at=wire_time(to_db_time(self._now())),
            updated_by=actor,
            company_mailbox=self.company_mailbox,
        )
        if not self.repo.compare_and_set(merged, current["policy_version"]):
            raise ApiError(412, "policy_version_mismatch", "策略已被修改，请刷新后重试", existing=self.get(account_id))
        on_change = getattr(self.ctx, "orchestrator", None)
        if on_change is not None:
            on_change.tick()  # 策略放宽（例如开启白名单）后推进被挂起的自动步骤
        return merged

    # -- 判定 -----------------------------------------------------------------

    def devices_all_paused(self, account_id: str) -> bool:
        """账户下所有已绑定、未吊销的设备都处于暂停（没有绑定设备时不算暂停）。"""
        bound = []
        for device in self.ctx.store.list_devices():
            binding = self.ctx.store.get_binding(device.device_id)
            if binding is not None and binding.account_id == account_id and not device.revoked:
                bound.append(device)
        return bool(bound) and all(d.paused or (d.last_heartbeat or {}).get("paused") for d in bound)

    def sent_today(self, policy: Mapping[str, Any], action: str, now: datetime) -> int:
        start, end = local_day_bounds(policy, local_today(policy, now))
        return self.repo.count_outbound(policy["account_id"], action, to_db_time(start), to_db_time(end))

    def gate(self, policy: Mapping[str, Any], action: str, now: datetime | None = None) -> Gate:
        """能否现在为该账户生成一条 execute 模式的对外指令。"""
        now = now or self._now()
        if action not in HARD_DAILY_CAPS:
            raise ValueError(f"{action} 不是对外动作")
        if action not in policy["allowed_actions"]:
            return Gate(False, "not_allowed")
        if policy["paused"]:
            return Gate(False, "paused")
        if self.devices_all_paused(policy["account_id"]):
            return Gate(False, "devices_paused")
        if not in_work_hours(policy, now):
            return Gate(False, "outside_work_hours")
        if self.sent_today(policy, action, now) >= effective_daily_limit(policy, action):
            return Gate(False, "daily_limit_reached")
        return Gate(True)


GATE_REASON_TEXT = {
    "not_allowed": "策略白名单未开启该动作",
    "paused": "账户策略已暂停",
    "devices_paused": "账户下的设备都已暂停",
    "outside_work_hours": "不在工作时段内",
    "daily_limit_reached": "已达每日上限",
}


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------

BearerCred = HTTPAuthorizationCredentials | None


def require_console_or_device(
    request: Request,
    console: Annotated[BearerCred, Security(console_bearer)],
    device: Annotated[BearerCred, Security(device_bearer)],
) -> str:
    """控制台会话或设备令牌任一有效即可（GET 策略：控制台读写、Monitor 读）。"""
    ctx = get_ctx(request)
    cred = console or device
    if cred is None:
        raise ApiError(401, "unauthorized", "未认证或令牌已吊销")
    actor = ctx.console_auth.authenticate(cred.credentials)
    if actor is not None:
        return f"console:{actor}"
    row = ctx.store.get_device_by_token_hash(hash_token(cred.credentials))
    if row is not None and not row.revoked:
        return f"device:{row.device_id}"
    raise ApiError(401, "unauthorized", "未认证或令牌已吊销")


router = APIRouter(tags=["policy"])


@router.get(
    "/accounts/{account_id}/policy",
    operation_id="getPolicy",
    summary="读取策略（控制台与设备均可）",
    response_model=PolicyJson,
    responses={
        200: {"headers": {"ETag": {"description": "等于 policy_version", "schema": {"type": "string"}}}},
        **problem_responses(401, 404),
    },
)
def get_policy(
    ctx: Ctx,
    principal: Annotated[str, Depends(require_console_or_device)],
    account_id: Annotated[str, AccountIdStr],
):
    if principal.startswith("device:"):
        binding = ctx.store.get_binding(principal.removeprefix("device:"))
        if binding is None or binding.account_id != account_id:
            raise not_found("账户策略")  # 设备只能读自己绑定账户的策略；不暴露其他账户是否存在
    policy = ctx.policies.require(account_id)
    resp = ok(policy)
    resp.headers["ETag"] = str(policy["policy_version"])
    return resp


@router.put(
    "/accounts/{account_id}/policy",
    operation_id="putPolicy",
    summary="保存策略（乐观锁）",
    response_model=PolicyJson,
    responses=problem_responses(401, 404, 412, 422),
)
def put_policy(
    request: Request,
    ctx: Ctx,
    actor: ConsoleActor,
    account_id: Annotated[str, AccountIdStr],
    idempotency_key: IdempotencyKeyHeader,
    if_match: Annotated[str, Header(alias="If-Match")],
    body: Annotated[PolicyJson, Body()],
):
    def handle() -> tuple[int, Any]:
        return 200, ctx.policies.put(account_id, body, if_match, actor)

    resp = run_idempotent(
        ctx, request, f"console:{actor}", idempotency_key, {"if_match": if_match, "body": body}, handle
    )
    if 200 <= resp.status_code < 300:
        resp.headers["ETag"] = str(json.loads(resp.body)["policy_version"])
    return resp


__all__ = [
    "DEFAULT_COMPANY_MAILBOX",
    "GATE_REASON_TEXT",
    "Gate",
    "HARD_DAILY_CAPS",
    "MIN_INTERVAL_FLOORS",
    "PolicyService",
    "PolicyStore",
    "default_policy",
    "effective_daily_limit",
    "in_work_hours",
    "job_in_scope",
    "local_day_bounds",
    "local_today",
    "policy_errors",
    "render_greeting",
    "router",
]
