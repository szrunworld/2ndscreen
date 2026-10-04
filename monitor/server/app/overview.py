"""控制台总览 GET /overview：各项分别计数，不合并成"成功数"（方案第十节第 1 条）。

口径（统计日按账户策略时区；不指定账户时按默认时区 Asia/Shanghai）：
- new_applications：当天建立、且有新投递事件（application_observed）的流程数；重复观察合并到同一流程，
  不重复计；只因会话歧义（conversation_ambiguous）建立的流程不计入，只计入待人工处理；
- resume_requested：当天进入 resume_requested 的流程数（指令成功或人工确认）；
- resume_received：当天有简历关联到的流程数（邮件到达并关联，任务 G 调用 link_resume）；
- resume_parsed：当天解析完成的流程数；
- needs_human：当前处于待人工处理的流程数（积压，不按天）；
- unknown_results：当天回报为 unknown 的指令数（含 verify_only）。
"""

from __future__ import annotations

from datetime import date, datetime
from typing import TYPE_CHECKING, Annotated, Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from pydantic.json_schema import SkipJsonSchema

from .db import to_db_time
from .devices import Device
from .main import ConsoleActor, Ctx, ok, problem_responses
from .policy import DEFAULT_TIMEZONE, local_day_bounds, local_today

if TYPE_CHECKING:
    from .db import SqliteStore
    from .main import AppContext

_DEFAULT_TZ_POLICY = {"work_hours": {"timezone": DEFAULT_TIMEZONE}}


class Overview(BaseModel):
    date: Annotated[str, Field(json_schema_extra={"format": "date"})]
    new_applications: Annotated[int, Field(ge=0)]
    resume_requested: Annotated[int, Field(ge=0)]
    resume_received: Annotated[int, Field(ge=0)]
    resume_parsed: Annotated[int, Field(ge=0)]
    needs_human: Annotated[int, Field(ge=0)]
    unknown_results: Annotated[int, Field(ge=0)] | SkipJsonSchema[None] = None
    devices: list[Device]


class OverviewService:
    def __init__(self, ctx: AppContext):
        self.ctx = ctx
        self._s: SqliteStore = ctx.store  # type: ignore[assignment]

    def _count(self, sql: str, args: tuple[Any, ...]) -> int:
        r = self._s._one(sql, args)
        return int(r[0]) if r is not None else 0

    def build(self, account_id: str | None, day: date | None) -> dict[str, Any]:
        policy: Any = _DEFAULT_TZ_POLICY
        if account_id is not None:
            policy = self.ctx.policies.get(account_id) or _DEFAULT_TZ_POLICY
        now: datetime = self.ctx.clock.now()
        day = day or local_today(policy, now)
        start_dt, end_dt = local_day_bounds(policy, day)
        start, end = to_db_time(start_dt), to_db_time(end_dt)
        acct_sql = "" if account_id is None else " AND c.account_id = ?"
        acct: tuple[Any, ...] = () if account_id is None else (account_id,)

        new_applications = self._count(
            f"""SELECT COUNT(*) FROM recruitment_cases c WHERE c.created_at >= ? AND c.created_at < ?{acct_sql}
                  AND EXISTS (SELECT 1 FROM events e
                              WHERE e.case_id = c.case_id AND e.kind = 'application_observed')""",
            (start, end, *acct),
        )
        resume_requested = self._count(
            f"""SELECT COUNT(DISTINCT t.case_id) FROM case_timeline t JOIN recruitment_cases c ON c.case_id = t.case_id
                WHERE t.type = 'stage_change' AND t.stage_to = 'resume_requested'
                  AND t.at >= ? AND t.at < ?{acct_sql}""",
            (start, end, *acct),
        )
        resume_received = self._count(
            f"""SELECT COUNT(DISTINCT l.case_id) FROM case_resume_links l
                JOIN recruitment_cases c ON c.case_id = l.case_id
                WHERE l.linked_at >= ? AND l.linked_at < ?{acct_sql}""",
            (start, end, *acct),
        )
        resume_parsed = self._count(
            f"""SELECT COUNT(DISTINCT l.case_id) FROM case_resume_links l
                JOIN recruitment_cases c ON c.case_id = l.case_id
                WHERE l.parsed_at IS NOT NULL AND l.parsed_at >= ? AND l.parsed_at < ?{acct_sql}""",
            (start, end, *acct),
        )
        needs_human = self._count(
            f"SELECT COUNT(*) FROM recruitment_cases c WHERE c.stage = 'needs_human'{acct_sql}", acct
        )
        unknown_results = self._count(
            f"""SELECT COUNT(*) FROM commands c WHERE c.server_status = 'unknown'
                  AND c.result_recorded_at >= ? AND c.result_recorded_at < ?{acct_sql}""",
            (start, end, *acct),
        )
        devices = []
        for device in self.ctx.store.list_devices():
            binding = self.ctx.store.get_binding(device.device_id)
            if account_id is None or (binding is not None and binding.account_id == account_id):
                devices.append(self.ctx.devices.record(device))
        return {
            "date": day.isoformat(),
            "new_applications": new_applications,
            "resume_requested": resume_requested,
            "resume_received": resume_received,
            "resume_parsed": resume_parsed,
            "needs_human": needs_human,
            "unknown_results": unknown_results,
            "devices": devices,
        }


router = APIRouter(tags=["overview"])


@router.get(
    "/overview",
    operation_id="getOverview",
    summary='控制台总览（分别计数，不合并成"成功数"）',
    response_model=Overview,
    responses=problem_responses(401, 422),
)
def get_overview(
    ctx: Ctx,
    _actor: ConsoleActor,
    account_id: str | None = None,
    date: Annotated[date | None, Query(description="统计日期（账户所在时区），默认今天")] = None,  # noqa: A002
):
    return ok(ctx.overview.build(account_id, date))


__all__ = ["Overview", "OverviewService", "router"]
