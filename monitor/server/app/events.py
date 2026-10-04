"""事件接收：POST /events 批量按 event_id 去重落库，GET /events 列表；进程内事件订阅接口。

F2 通过 ``EventBus.subscribe`` 消费两类内部消息：
- ``EventReceived``：一条新事件（event_id 首次出现）已落库；
- ``CommandResultRecorded``：一条指令结果首次被记录（commands.py 发出）。

消息在数据库提交之后同步投递；订阅者抛出的异常只记日志，不影响 HTTP 响应和其他订阅者。
订阅者需要关联 case 时调用 ``EventService.link_case``。
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Annotated, Any, Literal, Protocol

from fastapi import APIRouter, Body, Query, Request
from pydantic import BaseModel, Field
from pydantic.json_schema import SkipJsonSchema

from monitor_contracts import check

from .db import EventFilter, EventRow, parse_time, to_db_time, wire_time
from .main import (
    ApiModel,
    Ctx,
    ConsoleActor,
    DeviceAuth,
    EventJson,
    IdempotencyKeyHeader,
    ProblemFieldError,
    check_cursor,
    ok,
    problem_responses,
    run_idempotent,
    validation_failed,
)

if TYPE_CHECKING:
    from .main import AppContext

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 进程内事件订阅
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EventReceived:
    """新事件已落库。record 形状同 openapi EventRecord：{event, received_at, case_id}。"""

    event_id: str
    kind: str
    account_id: str | None
    device_id: str
    record: dict[str, Any]


@dataclass(frozen=True)
class CommandResultRecorded:
    """指令结果首次记录。record 形状同 openapi CommandRecord。"""

    command_id: str
    case_id: str | None
    status: str
    record: dict[str, Any]


BusMessage = EventReceived | CommandResultRecorded
Handler = Callable[[BusMessage], None]


class EventBus(Protocol):
    def subscribe(self, handler: Handler) -> Callable[[], None]:
        """注册订阅者，返回取消订阅函数。"""
        ...

    def publish(self, message: BusMessage) -> None: ...


class InProcessEventBus:
    """最简实现：同步、按订阅顺序投递；单个订阅者异常不影响其他订阅者。"""

    def __init__(self) -> None:
        self._handlers: list[Handler] = []
        self._lock = threading.Lock()
        self.failures = 0  # 订阅者抛异常的次数（便于测试与监控）

    def subscribe(self, handler: Handler) -> Callable[[], None]:
        with self._lock:
            self._handlers.append(handler)

        def unsubscribe() -> None:
            with self._lock:
                if handler in self._handlers:
                    self._handlers.remove(handler)

        return unsubscribe

    def publish(self, message: BusMessage) -> None:
        with self._lock:
            handlers = list(self._handlers)
        for handler in handlers:
            try:
                handler(message)
            except Exception:
                self.failures += 1
                log.exception("事件订阅者处理 %s 失败", type(message).__name__)


# ---------------------------------------------------------------------------
# HTTP 形状
# ---------------------------------------------------------------------------


class EventBatch(ApiModel):
    device_id: str
    events: Annotated[list[dict[str, Any]], Field(min_length=1, max_length=100)]


class EventItemResult(BaseModel):
    index: Annotated[int, Field(ge=0)]
    event_id: str | None = None
    status: Literal["accepted", "duplicate", "rejected"]
    errors: list[ProblemFieldError] | SkipJsonSchema[None] = None


class EventBatchResult(BaseModel):
    results: list[EventItemResult]


class EventRecord(BaseModel):
    event: EventJson
    received_at: str = Field(json_schema_extra={"format": "date-time"})
    case_id: str | None


class EventList(BaseModel):
    items: list[EventRecord]
    next_cursor: str | None


# ---------------------------------------------------------------------------
# 业务
# ---------------------------------------------------------------------------


def event_record(row: EventRow) -> dict[str, Any]:
    return {"event": row.event, "received_at": wire_time(row.received_at), "case_id": row.case_id}


class EventService:
    def __init__(self, ctx: AppContext):
        self.ctx = ctx

    def ingest(self, device_id: str, events: list[Any]) -> list[dict[str, Any]]:
        """逐条校验并按 event_id 去重落库，返回逐条结果。单条失败不影响整批。"""
        store, now = self.ctx.store, to_db_time(self.ctx.clock.now())
        results: list[dict[str, Any]] = []
        accepted: list[EventRow] = []
        for index, data in enumerate(events):
            event_id = data.get("event_id") if isinstance(data, dict) else None
            item: dict[str, Any] = {"index": index, "event_id": event_id if isinstance(event_id, str) else None}
            errors = [_err(e.path, e.message, e.code) for e in check("event", data)]
            if not errors and data["device_id"] != device_id:
                errors = [_err("device_id", "事件的 device_id 与批次 device_id 不一致", "device_mismatch")]
            if errors:
                item.update(status="rejected", errors=errors)
                results.append(item)
                continue
            row = EventRow(
                event_id=data["event_id"],
                device_id=device_id,
                account_id=data.get("account_id"),
                kind=data["kind"],
                event=data,
                observed_at=to_db_time(parse_time(data["observed_at"])),
                received_at=now,
            )
            if store.insert_event(row):
                item["status"] = "accepted"
                accepted.append(row)
            else:
                item["status"] = "duplicate"
            results.append(item)
        for row in accepted:
            stored = store.get_event(row.event_id) or row
            self.ctx.bus.publish(
                EventReceived(row.event_id, row.kind, row.account_id, row.device_id, event_record(stored))
            )
        return results

    def link_case(self, event_id: str, case_id: str) -> bool:
        """F2 把事件关联到 recruitment_case；事件不存在返回 False。"""
        return self.ctx.store.set_event_case(event_id, case_id)

    def get(self, event_id: str) -> dict[str, Any] | None:
        row = self.ctx.store.get_event(event_id)
        return None if row is None else event_record(row)


def _err(path: str, message: str, code: str) -> dict[str, str]:
    return {"path": path, "message": message, "code": code}


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------

router = APIRouter(tags=["events"])


@router.post(
    "/events",
    operation_id="postEvents",
    summary="批量上报事件（按 event_id 幂等）",
    response_model=EventBatchResult,
    responses=problem_responses(401, 422),
)
def post_events(
    request: Request,
    ctx: Ctx,
    device: DeviceAuth,
    idempotency_key: IdempotencyKeyHeader,
    body: Annotated[EventBatch, Body()],
):
    if body.device_id != device.device_id:
        raise validation_failed([_err("device_id", "device_id 与设备令牌不符", "device_mismatch")])
    payload = body.model_dump(mode="json")
    return run_idempotent(
        ctx,
        request,
        f"device:{device.device_id}",
        idempotency_key,
        payload,
        lambda: (200, {"results": ctx.events.ingest(device.device_id, payload["events"])}),
    )


@router.get(
    "/events",
    operation_id="listEvents",
    summary="事件列表（控制台最近活动）",
    response_model=EventList,
    # 运行时未认证仍返回 401；yaml 未列出，已在交付报告提接口请求，这里与 yaml 保持一致
)
def list_events(
    ctx: Ctx,
    _actor: ConsoleActor,
    account_id: str | None = None,
    case_id: str | None = None,
    kind: str | None = None,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
):
    page = ctx.store.list_events(EventFilter(account_id, case_id, kind), check_cursor(cursor), limit)
    return ok({"items": [event_record(r) for r in page.items], "next_cursor": page.next_cursor})


__all__ = [
    "BusMessage",
    "CommandResultRecorded",
    "EventBus",
    "EventReceived",
    "EventService",
    "InProcessEventBus",
    "event_record",
    "router",
]
