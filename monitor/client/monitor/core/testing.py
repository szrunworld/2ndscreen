"""符合契约的测试替身：内存账本、fake 服务端、记录调用的 Driver、脚本化的处理器与观察器。

供 core 的测试使用，也可供集成任务（M）与安装任务（J）复用。都只在内存里工作，
不访问网络、不碰 GUI。InMemoryLedger 只是 D1 SQLite 账本的替身，不保证与其性能或并发行为一致。
"""

from __future__ import annotations

import copy
import itertools
import re
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
from monitor_contracts import (
    ActionContext,
    ActionReceipt,
    ActionResult,
    Baseline,
    ClickMode,
    CommandModel,
    CommandResult,
    CommandState,
    ContractValidationError,
    DeliveryState,
    Driver,
    EventModel,
    Frame,
    LedgerCommand,
    Locator,
    MonitorState,
    OutboxEntry,
    ScrollDirection,
    Snapshot,
    Target,
    WindowInfo,
    WindowSelector,
    check,
    is_valid_idempotency_key,
    require_transition,
    validate_command,
)

from .clock import Clock

# ---------------------------------------------------------------------------
# 内存账本
# ---------------------------------------------------------------------------


class InMemoryLedger:
    """Ledger Protocol 的内存实现。每个方法相当于一个事务：要么全部生效，要么不生效。

    返回值都是深拷贝，调用方修改返回对象不会影响账本（与真实 SQLite 的读写语义一致）。
    """

    def __init__(self) -> None:
        self._commands: dict[UUID, LedgerCommand] = {}
        self._finished_order: dict[UUID, int] = {}
        self._events: list[OutboxEntry] = []
        self._event_ids: set[str] = set()
        self._state = MonitorState()
        self._seq = itertools.count(1)
        self._order = itertools.count(1)

    def put_command(self, command: CommandModel, *, received_at: datetime) -> tuple[LedgerCommand, bool]:
        existing = self._commands.get(command.command_id)
        if existing is not None:
            return existing.model_copy(deep=True), False
        rec = LedgerCommand(
            command=command, state=CommandState.QUEUED, received_at=received_at, updated_at=received_at
        )
        self._commands[command.command_id] = rec
        return rec.model_copy(deep=True), True

    def get_command(self, command_id: UUID) -> LedgerCommand | None:
        rec = self._commands.get(command_id)
        return rec.model_copy(deep=True) if rec is not None else None

    def list_commands(self, *, states: Iterable[CommandState] | None = None) -> list[LedgerCommand]:
        wanted = set(states) if states is not None else None
        return [
            r.model_copy(deep=True)
            for r in sorted(self._commands.values(), key=lambda r: r.received_at)
            if wanted is None or r.state in wanted
        ]

    def transition_command(
        self, command_id: UUID, to: CommandState, *, at: datetime, result: CommandResult | None = None
    ) -> LedgerCommand:
        rec = self._commands.get(command_id)
        if rec is None:
            raise KeyError(f"账本中没有指令 {command_id}")
        to = CommandState(to)
        require_transition("command", rec.state, to)
        terminal = to not in (CommandState.QUEUED, CommandState.RUNNING)
        if terminal and result is None:
            raise ValueError("迁移到终态必须给出 result")
        if not terminal and result is not None:
            raise ValueError("非终态不能带 result")
        new = LedgerCommand(
            command=rec.command,
            state=to,
            result=result,
            delivery=DeliveryState.PENDING if terminal else None,
            received_at=rec.received_at,
            updated_at=at,
        )
        self._commands[command_id] = new
        if terminal:
            self._finished_order[command_id] = next(self._order)
        return new.model_copy(deep=True)

    def pending_results(self, *, limit: int = 100) -> list[CommandResult]:
        pending = [r for r in self._commands.values() if r.delivery == DeliveryState.PENDING]
        pending.sort(key=lambda r: self._finished_order[r.command.command_id])
        return [r.result.model_copy(deep=True) for r in pending[:limit] if r.result is not None]

    def mark_result_delivered(self, command_id: UUID) -> None:
        rec = self._commands.get(command_id)
        if rec is None or rec.delivery is None:
            raise KeyError(f"指令 {command_id} 没有待回传结果")
        if rec.delivery == DeliveryState.DELIVERED:
            return
        require_transition("delivery", rec.delivery, DeliveryState.DELIVERED)
        self._commands[command_id] = rec.model_copy(update={"delivery": DeliveryState.DELIVERED})

    def append_event(self, event: EventModel, *, at: datetime) -> bool:
        if event.event_id in self._event_ids:
            return False
        self._event_ids.add(event.event_id)
        self._events.append(
            OutboxEntry(seq=next(self._seq), event=event, delivery=DeliveryState.PENDING, enqueued_at=at)
        )
        return True

    def pending_events(self, *, after_seq: int = 0, limit: int = 100) -> list[OutboxEntry]:
        out = [e for e in self._events if e.seq > after_seq and e.delivery == DeliveryState.PENDING]
        return [e.model_copy(deep=True) for e in out[:limit]]

    def mark_events_delivered(self, event_ids: Iterable[str]) -> None:
        ids = set(event_ids)
        self._events = [
            e.model_copy(update={"delivery": DeliveryState.DELIVERED}) if e.event.event_id in ids else e
            for e in self._events
        ]

    def outbox_cursor(self) -> int:
        cursor = 0
        for e in self._events:
            if e.delivery != DeliveryState.DELIVERED:
                break
            cursor = e.seq
        return cursor

    def load_state(self) -> MonitorState:
        return self._state.model_copy(deep=True)

    def save_state(self, state: MonitorState) -> None:
        self._state = MonitorState.model_validate(state.model_dump())

    # 测试辅助 -----------------------------------------------------------
    def all_events(self) -> list[OutboxEntry]:
        return [e.model_copy(deep=True) for e in self._events]


# ---------------------------------------------------------------------------
# 记录调用的 Driver
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DriverCall:
    method: str
    args: dict[str, Any]


class RecordingDriver:
    """最小 Driver：state() 返回空快照，写方法只记录调用。用来断言"写方法被调用了几次"。"""

    WRITE_METHODS = ("click", "type_text", "key", "scroll")

    def __init__(self, clock: Clock) -> None:
        self._clock = clock
        self._n = itertools.count(1)
        self.calls: list[DriverCall] = []

    @property
    def writes(self) -> list[DriverCall]:
        return [c for c in self.calls if c.method in self.WRITE_METHODS]

    def _receipt(self, op: str, target: Target | None) -> ActionReceipt:
        return ActionReceipt(op=op, method="fake", element=None, performed_at=self._clock.now())

    def state(self, include_tree: bool = False) -> Snapshot:
        self.calls.append(DriverCall("state", {"include_tree": include_tree}))
        return Snapshot(snapshot_id=f"snap_{next(self._n)}", taken_at=self._clock.now(), window=None)

    def click(self, target: Target, mode: ClickMode = "auto") -> ActionReceipt:
        self.calls.append(DriverCall("click", {"target": target, "mode": mode}))
        return self._receipt("click", target)

    def type_text(self, target: Target | None, text: str) -> ActionReceipt:
        self.calls.append(DriverCall("type_text", {"target": target, "text": text}))
        return self._receipt("type_text", target)

    def key(self, keys: str | Sequence[str]) -> ActionReceipt:
        self.calls.append(DriverCall("key", {"keys": keys}))
        return self._receipt("key", None)

    def scroll(self, target: Target | None, direction: ScrollDirection, amount: int) -> ActionReceipt:
        self.calls.append(DriverCall("scroll", {"target": target, "direction": direction, "amount": amount}))
        return self._receipt("scroll", target)

    def bind_window(self, selector: WindowSelector | None = None) -> WindowInfo:
        self.calls.append(DriverCall("bind_window", {"selector": selector}))
        return WindowInfo(window_id=1, frame=Frame(x=0, y=0, w=800, h=600), title="fake")

    def screen_ok(self) -> bool:
        return True

    def screenshot_region(self, rect: Frame, out_path: Path) -> Path:
        self.calls.append(DriverCall("screenshot_region", {"rect": rect}))
        return out_path


# ---------------------------------------------------------------------------
# 脚本化的处理器与观察器
# ---------------------------------------------------------------------------

HandlerFn = Callable[[CommandModel, Driver, ActionContext], ActionResult]


def click_and_succeed(command: CommandModel, driver: Driver, ctx: ActionContext) -> ActionResult:
    """默认的 run：声明对外动作后点一次"发送"，回报成功（三个标志由守卫记录并入）。"""
    with ctx.outbound():  # type: ignore[attr-defined]  # core 注入的是 ExecContext
        driver.click(Locator(text="发送"))
    return ActionResult(status="succeeded", executed_at=ctx.clock())


def verify_unknown(command: CommandModel, driver: Driver, ctx: ActionContext) -> ActionResult:
    driver.state()
    return ActionResult(status="unknown", reason="timeout", reason_detail="界面无法判断")


class ScriptedHandler:
    """ActionHandler 替身。遵守协议：白名单未开启时返回 action_not_allowed 且不调用写方法。"""

    def __init__(self, action: str, *, run: HandlerFn | None = None, verify: HandlerFn | None = None) -> None:
        self.action = action
        self._run = run or click_and_succeed
        self._verify = verify or verify_unknown
        self.run_calls: list[UUID] = []
        self.verify_calls: list[UUID] = []

    def run(self, command: CommandModel, driver: Driver, ctx: ActionContext) -> ActionResult:
        self.run_calls.append(command.command_id)
        if not ctx.is_allowed(command.action):
            return ActionResult(status="failed", reason="action_not_allowed")
        return self._run(command, driver, ctx)

    def verify_only(self, command: CommandModel, driver: Driver, ctx: ActionContext) -> ActionResult:
        self.verify_calls.append(command.command_id)
        return self._verify(command, driver, ctx)


class ScriptedObserver:
    """Observer 替身：每次 observe 读一次界面、建立基线，并按脚本返回事件。"""

    def __init__(self, scripts: Sequence[Sequence[EventModel]] = ()) -> None:
        self._scripts = list(scripts)
        self.calls: list[Baseline] = []

    def observe(self, driver: Driver, baseline: Baseline) -> list[EventModel]:
        self.calls.append(baseline.model_copy(deep=True))
        driver.state()
        if not baseline.established:
            baseline.established = True
            baseline.data = {"rows": 0}
            return []
        return list(self._scripts.pop(0)) if self._scripts else []


# ---------------------------------------------------------------------------
# fake 服务端（httpx.MockTransport）
# ---------------------------------------------------------------------------

_ROUTES: list[tuple[str, str, re.Pattern[str]]] = [
    ("heartbeat", "POST", re.compile(r"^/api/v1/devices/(?P<dev>[^/]+)/heartbeat$")),
    ("claim", "POST", re.compile(r"^/api/v1/devices/(?P<dev>[^/]+)/commands:claim$")),
    ("ack", "POST", re.compile(r"^/api/v1/commands/(?P<cid>[^/]+)/ack$")),
    ("result", "POST", re.compile(r"^/api/v1/commands/(?P<cid>[^/]+)/result$")),
    ("events", "POST", re.compile(r"^/api/v1/events$")),
    ("policy", "GET", re.compile(r"^/api/v1/accounts/(?P<acct>[^/]+)/policy$")),
]

BASE_URL = "https://monitor.test/api/v1"


@dataclass
class Recorded:
    route: str
    method: str
    path: str
    headers: dict[str, str]
    body: Any


@dataclass
class FakeServer:
    """按 openapi.yaml 的形状应答 Monitor 用到的 6 个接口，并校验请求体与必需头。

    - 请求体不合契约 → 422；缺少或不合法的 Idempotency-Key → 422；令牌不对 → 401；
      路径中的 device_id 与令牌不符 → 403。
    - fail(route, status, times) 让接下来 times 次该路由返回 status（0 表示网络错误）。
    - 结果按 command_id 只记首次：相同重放返回 duplicate=true，不同返回 409 result_conflict。
    - 领取按 Idempotency-Key 重放返回同一批指令。
    """

    device_id: str
    token: str
    clock: Clock
    policy: dict[str, Any] | None = None
    paused: bool = False
    account_confirmed: bool = True
    lease_seconds: int = 60
    queue: list[dict[str, Any]] = field(default_factory=list)
    cancellations: set[str] = field(default_factory=set)
    requests: list[Recorded] = field(default_factory=list)
    results: dict[str, dict[str, Any]] = field(default_factory=dict)
    result_posts: list[str] = field(default_factory=list)
    acks: list[dict[str, Any]] = field(default_factory=list)
    events: dict[str, dict[str, Any]] = field(default_factory=dict)
    heartbeats: list[dict[str, Any]] = field(default_factory=list)
    reject_event_ids: set[str] = field(default_factory=set)
    _failures: dict[str, list[int]] = field(default_factory=dict)
    _claim_replays: dict[str, dict[str, Any]] = field(default_factory=dict)

    # 控制 -----------------------------------------------------------------
    def enqueue(self, command: dict[str, Any]) -> None:
        validate_command(command)  # 只接受合法指令，免得测试本身写错
        self.queue.append(copy.deepcopy(command))

    def fail(self, route: str, status: int, times: int = 1) -> None:
        self._failures.setdefault(route, []).extend([status] * times)

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def count(self, route: str) -> int:
        return sum(1 for r in self.requests if r.route == route)

    # 处理 -----------------------------------------------------------------
    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        for route, method, pattern in _ROUTES:
            m = pattern.match(path)
            if m and request.method == method:
                break
        else:
            return _problem(404, "not_found", f"{request.method} {path}")
        body = None
        if request.content:
            try:
                import json

                body = json.loads(request.content)
            except ValueError:
                return _problem(422, "validation_failed", "请求体不是 JSON")
        self.requests.append(Recorded(route, request.method, path, dict(request.headers), body))

        if request.headers.get("Authorization") != f"Bearer {self.token}":
            return _problem(401, "unauthorized", "令牌无效")
        if "dev" in m.groupdict() and m["dev"] != self.device_id:
            return _problem(403, "forbidden", "device_id 与令牌不符")
        if method == "POST":
            key = request.headers.get("Idempotency-Key")
            if key is None or not is_valid_idempotency_key(key):
                return _problem(422, "validation_failed", "缺少或不合法的 Idempotency-Key")
        fails = self._failures.get(route)
        if fails:
            status = fails.pop(0)
            if status == 0:
                raise httpx.ConnectError("模拟网络错误", request=request)
            return _problem(status, "injected", f"注入的 {status}")
        return getattr(self, f"_{route}")(m, body, request)

    def _heartbeat(self, m: re.Match[str], body: Any, request: httpx.Request) -> httpx.Response:
        errs = check("device_heartbeat", body)
        if errs:
            return _problem(422, "validation_failed", "心跳不合契约", errs)
        self.heartbeats.append(body)
        return httpx.Response(
            200,
            json={
                "server_time": self.clock.now().isoformat(),
                "paused": self.paused,
                "policy_version": self.policy["policy_version"] if self.policy else None,
                "cancellations": sorted(self.cancellations),
                "account_confirmed": self.account_confirmed,
            },
        )

    def _claim(self, m: re.Match[str], body: Any, request: httpx.Request) -> httpx.Response:
        if not isinstance(body, dict) or set(body) != {"account_id", "max_commands", "wait_seconds"}:
            return _problem(422, "validation_failed", "ClaimRequest 字段不符")
        if not (1 <= body["max_commands"] <= 10 and 0 <= body["wait_seconds"] <= 30):
            return _problem(422, "validation_failed", "ClaimRequest 取值越界")
        key = request.headers["Idempotency-Key"]
        if key in self._claim_replays:
            return httpx.Response(200, json=self._claim_replays[key])
        commands: list[dict[str, Any]] = []
        if not self.paused and self.account_confirmed:
            while self.queue and len(commands) < body["max_commands"]:
                cmd = self.queue[0]
                if cmd["account_id"] != body["account_id"]:
                    break
                commands.append(self.queue.pop(0))
        resp = {
            "commands": commands,
            "cancellations": sorted(self.cancellations),
            "lease_seconds": self.lease_seconds,
            "server_time": self.clock.now().isoformat(),
        }
        self._claim_replays[key] = resp
        return httpx.Response(200, json=resp)

    def _ack(self, m: re.Match[str], body: Any, request: httpx.Request) -> httpx.Response:
        if not isinstance(body, dict) or set(body) != {"device_id", "ledger_state", "received_at"}:
            return _problem(422, "validation_failed", "AckRequest 字段不符")
        if body["ledger_state"] not in {s.value for s in CommandState}:
            return _problem(422, "validation_failed", "ledger_state 不合法")
        self.acks.append({"command_id": m["cid"], **body})
        return httpx.Response(200, json={"command_id": m["cid"], "server_status": "acked"})

    def _result(self, m: re.Match[str], body: Any, request: httpx.Request) -> httpx.Response:
        errs = check("command_result", body)
        if errs:
            return _problem(422, "validation_failed", "结果不合契约", errs)
        cid = m["cid"]
        if body["command_id"] != cid:
            return _problem(422, "validation_failed", "路径 command_id 与请求体不一致")
        self.result_posts.append(cid)
        first = self.results.get(cid)
        if first is None:
            self.results[cid] = body
            self.cancellations.discard(cid)
            return httpx.Response(200, json={"command_id": cid, "duplicate": False, "recorded_result": body})
        if first == body:
            return httpx.Response(200, json={"command_id": cid, "duplicate": True, "recorded_result": first})
        return _problem(409, "result_conflict", "与已记录结果不同", existing=first)

    def _events(self, m: re.Match[str], body: Any, request: httpx.Request) -> httpx.Response:
        if not isinstance(body, dict) or set(body) != {"device_id", "events"} or not 1 <= len(body["events"]) <= 100:
            return _problem(422, "validation_failed", "EventBatch 字段不符")
        out = []
        for i, ev in enumerate(body["events"]):
            eid = ev.get("event_id") if isinstance(ev, dict) else None
            errs = check("event", ev)
            if errs or eid in self.reject_event_ids:
                out.append({"index": i, "event_id": eid, "status": "rejected", "errors": [_fe(e) for e in errs]})
            elif eid in self.events:
                out.append({"index": i, "event_id": eid, "status": "duplicate"})
            else:
                self.events[eid] = ev
                out.append({"index": i, "event_id": eid, "status": "accepted"})
        return httpx.Response(200, json={"results": out})

    def _policy(self, m: re.Match[str], body: Any, request: httpx.Request) -> httpx.Response:
        if self.policy is None or self.policy["account_id"] != m["acct"]:
            return _problem(404, "not_found", "没有策略")
        return httpx.Response(200, json=self.policy, headers={"ETag": str(self.policy["policy_version"])})


def _fe(e: Any) -> dict[str, Any]:
    return {"path": e.path, "message": e.message, "code": e.code}


def _problem(status: int, code: str, message: str, errors: Iterable[Any] = (), existing: Any = None) -> httpx.Response:
    body: dict[str, Any] = {"code": code, "message": message}
    errs = [_fe(e) for e in errors]
    if errs:
        body["errors"] = errs
    if existing is not None:
        body["existing"] = existing
    return httpx.Response(status, json=body, headers={"Content-Type": "application/problem+json"})



# ---------------------------------------------------------------------------
# 组装好的测试环境
# ---------------------------------------------------------------------------

ACCOUNT = "acct_demo"
DEVICE = "dev_test"
TOKEN = "tok_secret_for_tests"


def make_policy(**overrides: Any) -> dict[str, Any]:
    """合法的策略（线上 JSON 形状）。默认开启问候与求简历，上限较宽、间隔取最小。"""
    per = {a: 0 for a in ("send_greeting", "request_resume", "request_contact_exchange", "search_candidates")}
    policy: dict[str, Any] = {
        "account_id": ACCOUNT,
        "policy_version": 1,
        "allowed_actions": ["send_greeting", "request_resume"],
        "job_scope": {"mode": "all", "job_titles": []},
        "greeting": {"enabled": True, "template": "你好"},
        "auto_request_resume": True,
        "after_resume_received": {"action": "none", "wait_for_parse": True},
        "resume_mail_timeout_days": 3,
        "mail_retention_days": 30,
        "company_mailbox": "zhaopin@example.com",
        "work_hours": {"timezone": "UTC", "windows": []},
        "daily_limits": {k: 1000 for k in per},
        "min_interval_seconds": dict(per),
        "pause_on_anomaly": True,
        "paused": False,
        "updated_at": "2026-10-04T00:00:00+00:00",
        "updated_by": "tester",
    }
    policy.update(overrides)
    return policy


_cid = itertools.count(1)


def make_command(
    action: str = "send_greeting",
    *,
    clock: Clock,
    ttl_seconds: float = 600,
    execution_mode: str = "execute",
    depends_on: str | None = None,
    account_id: str = ACCOUNT,
    command_id: str | None = None,
) -> dict[str, Any]:
    """合法的会话类指令（线上 JSON 形状）。"""
    from datetime import timedelta

    now = clock.now()
    payload: dict[str, Any] = {
        "send_greeting": {"text": "你好"},
        "request_resume": {},
        "request_contact_exchange": {"exchange_type": "wechat"},
    }[action]
    return {
        "command_id": command_id or f"00000000-0000-4000-8000-{next(_cid):012d}",
        "workflow_id": "case_001",
        "account_id": account_id,
        "action": action,
        "execution_mode": execution_mode,
        "target": {"conversation": {"candidate_name": "候选人A", "job_title": "后端工程师", "hints": []}},
        "payload": payload,
        "issued_at": now.isoformat(),
        "expires_at": (now + timedelta(seconds=ttl_seconds)).isoformat(),
        "depends_on": depends_on,
    }


@dataclass
class Env:
    clock: Any
    ledger: InMemoryLedger
    driver: Any  # RecordingDriver 或 monitor.driver.FakeDriver
    server: FakeServer
    handlers: dict[str, ScriptedHandler]
    observer: ScriptedObserver | None
    runtime: Any = None

    def new_runtime(self, **config: Any) -> Any:
        """用同一个账本、Driver、服务端构造一个新进程（模拟重启）。"""
        from .client import Backoff, CommandClient
        from .runtime import MonitorRuntime, RuntimeConfig

        client = CommandClient(
            base_url=BASE_URL,
            device_id=DEVICE,
            token=TOKEN,
            transport=self.server.transport(),
            now=self.clock.now,
        )
        self.runtime = MonitorRuntime(
            config=RuntimeConfig(device_id=DEVICE, **config),
            ledger=self.ledger,
            driver=self.driver,
            client=client,
            handlers=self.handlers,
            clock=self.clock,
            observer=self.observer,
            backoff=Backoff(rng=lambda: 0.0),
        )
        return self.runtime

    def cmd(self, action: str = "send_greeting", **kw: Any) -> dict[str, Any]:
        return make_command(action, clock=self.clock, **kw)

    def run(self, n: int = 1) -> None:
        for _ in range(n):
            self.runtime.run_once()

    def run_until(self, pred: Callable[[], bool], *, max_rounds: int = 50, advance: float = 0.0) -> None:
        """反复跑 run_once 直到条件成立；advance>0 时每轮后推进可控时钟（不是真实 sleep）。"""
        for _ in range(max_rounds):
            if pred():
                return
            self.runtime.run_once()
            if advance:
                self.clock.advance(advance)
        if not pred():
            raise AssertionError("条件在限定轮数内没有成立")


def make_env(
    *,
    policy: dict[str, Any] | None = None,
    handlers: Iterable[ScriptedHandler] | None = None,
    observer: ScriptedObserver | None = None,
    bind: bool = True,
    baseline_ready: bool = True,
    driver: Any = None,
    **config: Any,
) -> Env:
    """标准测试环境：账户已绑定、基线已建立、策略已在服务端。"""
    from .clock import ManualClock
    from monitor_contracts import AccountBinding

    clock = ManualClock()
    ledger = InMemoryLedger()
    state = ledger.load_state()
    if bind:
        state.account_binding = AccountBinding(account_id=ACCOUNT, bound_at=clock.now(), confirmed_by="tester")
    if baseline_ready:
        state.needs_baseline = False
        state.baseline = Baseline(account_id=ACCOUNT, established=True, generation=1)
        state.last_online_at = clock.now()
    ledger.save_state(state)
    hs = list(handlers) if handlers is not None else [
        ScriptedHandler("send_greeting"),
        ScriptedHandler("request_resume"),
    ]
    env = Env(
        clock=clock,
        ledger=ledger,
        driver=driver if driver is not None else RecordingDriver(clock),
        server=FakeServer(device_id=DEVICE, token=TOKEN, clock=clock, policy=policy if policy is not None else make_policy()),
        handlers={h.action: h for h in hs},
        observer=observer,
    )
    env.new_runtime(**config)
    return env


__all__ = [
    "ACCOUNT",
    "BASE_URL",
    "DEVICE",
    "Env",
    "TOKEN",
    "make_command",
    "make_env",
    "make_policy",
    "ContractValidationError",
    "DriverCall",
    "FakeServer",
    "InMemoryLedger",
    "RecordingDriver",
    "ScriptedHandler",
    "ScriptedObserver",
    "click_and_succeed",
    "verify_unknown",
]
