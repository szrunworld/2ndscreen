"""指令客户端：与服务端的全部 HTTP 往来（形状严格按 monitor/contracts/openapi.yaml）。

接口：
- POST /devices/{id}/heartbeat          心跳（device_heartbeat）→ HeartbeatAck
- POST /devices/{id}/commands:claim     长轮询领取 → ClaimResponse
- POST /commands/{id}/ack               确认已写入本地账本
- POST /commands/{id}/result            回报最终结果（command_result）→ ResultAccepted / 409
- POST /events                          批量上报事件 → 逐条 accepted / duplicate / rejected
- GET  /accounts/{account_id}/policy    读取策略

所有请求带 `Authorization: Bearer <设备令牌>`；所有写接口带确定性的 Idempotency-Key
（monitor_contracts.idempotency），断网重试复用同一个键。

错误分三类：ServerUnavailable（网络错误、超时、5xx、429，可重试，由调用方指数退避）、
Unauthorized（401，令牌被吊销）、RequestRejected（其他 4xx，重试无意义）。
"""

from __future__ import annotations

import random
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Literal
from uuid import UUID

import httpx
from monitor_contracts import (
    CommandModel,
    CommandResult,
    ContractValidationError,
    DeviceHeartbeat,
    EventModel,
    FieldError,
    Policy,
    claim_key,
    command_ack_key,
    command_result_key,
    events_batch_key,
    heartbeat_key,
    validate_command,
    validate_command_result,
    validate_policy,
)

LONG_POLL_MAX_SECONDS = 30
# 长轮询的 HTTP 超时要比 wait_seconds 宽裕，避免服务端按时返回却被本地判超时
LONG_POLL_GRACE_SECONDS = 10
DEFAULT_TIMEOUT_SECONDS = 15


class ServerError(Exception):
    def __init__(self, message: str, *, status: int | None = None, problem: dict[str, Any] | None = None):
        super().__init__(message)
        self.status = status
        self.problem = problem or {}

    @property
    def code(self) -> str | None:
        return self.problem.get("code")


class ServerUnavailable(ServerError):
    """网络不通、超时、5xx 或 429：稍后按退避重试。"""


class Unauthorized(ServerError):
    """401：设备令牌无效或已吊销。停止领取，等人工处理。"""


class RequestRejected(ServerError):
    """其他 4xx：请求本身被拒绝，原样重试没有意义。"""


@dataclass(frozen=True)
class HeartbeatAck:
    server_time: datetime
    paused: bool
    policy_version: int | None
    cancellations: tuple[UUID, ...]
    account_confirmed: bool | None = None


@dataclass(frozen=True)
class InvalidCommand:
    """领取到但不符合契约的指令：不入账、不 ack，记入 last_error 供人处理。"""

    index: int
    command_id: str | None
    errors: tuple[FieldError, ...]


@dataclass(frozen=True)
class ClaimResponse:
    commands: tuple[CommandModel, ...]
    cancellations: tuple[UUID, ...]
    lease_seconds: int
    server_time: datetime
    invalid: tuple[InvalidCommand, ...] = ()


@dataclass(frozen=True)
class ResultReport:
    """回报结果后的服务端答复。conflict=True 表示服务端已记录了不同的结果（409）。"""

    command_id: UUID
    duplicate: bool
    conflict: bool
    recorded: dict[str, Any] | None


EventStatus = Literal["accepted", "duplicate", "rejected"]


@dataclass(frozen=True)
class EventReport:
    event_id: str
    status: EventStatus
    errors: tuple[dict[str, Any], ...] = ()


@dataclass
class Backoff:
    """指数退避：第 n 次连续失败后等待 min(base * factor^(n-1), max)，再乘以 [1-jitter, 1] 的随机因子。"""

    base_seconds: float = 1.0
    factor: float = 2.0
    max_seconds: float = 300.0
    jitter: float = 0.2
    rng: Callable[[], float] = field(default=random.random)
    failures: int = 0
    next_at: datetime | None = None

    def delay(self) -> float:
        if self.failures <= 0:
            return 0.0
        raw = min(self.base_seconds * self.factor ** (self.failures - 1), self.max_seconds)
        return raw * (1 - self.jitter * self.rng())

    def failure(self, now: datetime) -> datetime:
        self.failures += 1
        self.next_at = now + timedelta(seconds=self.delay())
        return self.next_at

    def success(self) -> None:
        self.failures = 0
        self.next_at = None

    def ready(self, now: datetime) -> bool:
        return self.next_at is None or now >= self.next_at


def _parse_time(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


class CommandClient:
    """设备侧 HTTP 客户端。不做重试循环（由运行时按 Backoff 调度），只负责一次请求的形状与错误分类。

    on_contact(now) 在每次收到服务端 HTTP 响应（任何状态码）时调用，供离线检测使用。
    """

    def __init__(
        self,
        *,
        base_url: str,
        device_id: str,
        token: str,
        http: httpx.Client | None = None,
        transport: httpx.BaseTransport | None = None,
        now: Callable[[], datetime],
        on_contact: Callable[[datetime], None] | None = None,
        new_attempt_id: Callable[[], UUID] = uuid.uuid4,
    ) -> None:
        if not token:
            raise ValueError("设备令牌不能为空")
        self.device_id = device_id
        self._now = now
        self.on_contact = on_contact
        self._new_attempt_id = new_attempt_id
        self._http = http or httpx.Client(
            base_url=base_url.rstrip("/"),
            transport=transport,
            timeout=DEFAULT_TIMEOUT_SECONDS,
        )
        self._http.headers["Authorization"] = f"Bearer {token}"
        # 一次领取尝试的 attempt id：请求失败时下一次重试复用，成功后才换新的
        self._claim_attempt: UUID | None = None
        self.last_contact_at: datetime | None = None

    def close(self) -> None:
        self._http.close()

    # ------------------------------------------------------------------
    def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        idempotency_key: str | None = None,
        timeout: float | None = None,
        ok: Sequence[int] = (200,),
    ) -> httpx.Response:
        headers = {}
        if idempotency_key is not None:
            headers["Idempotency-Key"] = idempotency_key
        try:
            resp = self._http.request(
                method,
                path,
                json=json,
                headers=headers,
                timeout=timeout if timeout is not None else httpx.USE_CLIENT_DEFAULT,
            )
        except httpx.HTTPError as exc:  # 连接失败、超时、协议错误
            raise ServerUnavailable(f"{method} {path} 网络错误: {type(exc).__name__}") from exc
        now = self._now()
        self.last_contact_at = now
        if self.on_contact is not None:
            self.on_contact(now)
        if resp.status_code in ok:
            return resp
        problem = _problem(resp)
        msg = f"{method} {path} 返回 {resp.status_code}: {problem.get('code') or ''}"
        if resp.status_code >= 500 or resp.status_code == 429:
            raise ServerUnavailable(msg, status=resp.status_code, problem=problem)
        if resp.status_code == 401:
            raise Unauthorized(msg, status=401, problem=problem)
        raise RequestRejected(msg, status=resp.status_code, problem=problem)

    # ------------------------------------------------------------------
    def heartbeat(self, hb: DeviceHeartbeat) -> HeartbeatAck:
        if hb.device_id != self.device_id:
            raise ValueError("心跳中的 device_id 与客户端不一致")
        resp = self._request(
            "POST",
            f"/devices/{self.device_id}/heartbeat",
            json=hb.to_wire(),
            idempotency_key=heartbeat_key(self.device_id, hb.sent_at),
        )
        body = resp.json()
        return HeartbeatAck(
            server_time=_parse_time(body["server_time"]),
            paused=bool(body["paused"]),
            policy_version=body.get("policy_version"),
            cancellations=tuple(UUID(c) for c in body.get("cancellations", [])),
            account_confirmed=body.get("account_confirmed"),
        )

    def claim(self, *, account_id: str, max_commands: int = 1, wait_seconds: int = LONG_POLL_MAX_SECONDS) -> ClaimResponse:
        if not 1 <= max_commands <= 10:
            raise ValueError("max_commands 必须在 1–10")
        wait_seconds = max(0, min(int(wait_seconds), LONG_POLL_MAX_SECONDS))
        if self._claim_attempt is None:
            self._claim_attempt = self._new_attempt_id()
        resp = self._request(
            "POST",
            f"/devices/{self.device_id}/commands:claim",
            json={"account_id": account_id, "max_commands": max_commands, "wait_seconds": wait_seconds},
            idempotency_key=claim_key(self.device_id, self._claim_attempt),
            timeout=wait_seconds + LONG_POLL_GRACE_SECONDS,
        )
        self._claim_attempt = None
        body = resp.json()
        commands: list[CommandModel] = []
        invalid: list[InvalidCommand] = []
        for i, raw in enumerate(body.get("commands", [])):
            try:
                commands.append(validate_command(raw))
            except ContractValidationError as exc:
                cid = raw.get("command_id") if isinstance(raw, dict) else None
                invalid.append(InvalidCommand(i, str(cid) if cid else None, tuple(exc.errors)))
        return ClaimResponse(
            commands=tuple(commands),
            cancellations=tuple(UUID(c) for c in body.get("cancellations", [])),
            lease_seconds=int(body["lease_seconds"]),
            server_time=_parse_time(body["server_time"]),
            invalid=tuple(invalid),
        )

    def ack(self, command_id: UUID, *, ledger_state: str, received_at: datetime) -> None:
        self._request(
            "POST",
            f"/commands/{command_id}/ack",
            json={
                "device_id": self.device_id,
                "ledger_state": str(ledger_state),
                "received_at": received_at.isoformat(),
            },
            idempotency_key=command_ack_key(command_id),
        )

    def report_result(self, result: CommandResult) -> ResultReport:
        """回报结果。200（含 duplicate）与 409 result_conflict 都算"服务端已有结果"，其余按错误分类抛出。"""
        try:
            resp = self._request(
                "POST",
                f"/commands/{result.command_id}/result",
                json=result.to_wire(),
                idempotency_key=command_result_key(result.command_id),
            )
        except RequestRejected as exc:
            if exc.status == 409 and exc.code == "result_conflict":
                return ResultReport(result.command_id, duplicate=False, conflict=True, recorded=exc.problem.get("existing"))
            raise
        body = resp.json()
        return ResultReport(
            command_id=UUID(body["command_id"]),
            duplicate=bool(body["duplicate"]),
            conflict=False,
            recorded=body.get("recorded_result"),
        )

    def post_events(self, events: Sequence[EventModel]) -> list[EventReport]:
        if not 1 <= len(events) <= 100:
            raise ValueError("每批事件 1–100 条")
        ids = [e.event_id for e in events]
        resp = self._request(
            "POST",
            "/events",
            json={"device_id": self.device_id, "events": [e.to_wire() for e in events]},
            idempotency_key=events_batch_key(ids),
        )
        out: list[EventReport] = []
        for item in resp.json()["results"]:
            idx = int(item["index"])
            if not 0 <= idx < len(events):
                continue
            out.append(EventReport(ids[idx], item["status"], tuple(item.get("errors") or ())))
        return out

    def get_policy(self, account_id: str) -> Policy:
        resp = self._request("GET", f"/accounts/{account_id}/policy")
        return validate_policy(resp.json())


def _problem(resp: httpx.Response) -> dict[str, Any]:
    try:
        body = resp.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


def parse_recorded_result(recorded: dict[str, Any] | None) -> CommandResult | None:
    """把服务端回显的 recorded_result / existing 解析成 CommandResult（解析失败返回 None）。"""
    if not recorded:
        return None
    try:
        return validate_command_result(recorded)
    except ContractValidationError:
        return None
