"""Monitor 运行时：把指令客户端、执行管线、观察调度、暂停与离线检测串成一个循环。

单线程 tick 模型（run_once），每一轮按优先级做：
1. 服务端往来（未处于退避期时）：心跳（默认 30 秒）→ 必要时刷新策略 → 补发 ack → 回传结果 → 补传事件。
2. GUI 工作（未暂停时）：先做崩溃恢复，再执行排队指令（动作优先）。
3. 没有动作可做且到了观察周期（默认 45 秒，可配）：观察一次。
4. 什么都没做且允许领取：长轮询领取（等待时间不超过下一次心跳 / 观察的到期时间）。

暂停 = 停止领取、停止启动新指令与观察；心跳、结果回传、事件补传照常进行（方案第十节第 2 条）。
离线超过 24 小时：再次连上服务端后置 needs_baseline，先重建观察基线，再领取指令。
"""

from __future__ import annotations

import threading
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Literal
from uuid import UUID

from monitor_contracts import (
    OUTWARD_ACTIONS,
    ActionHandler,
    Baseline,
    CommandState,
    Driver,
    DriverError,
    EventModel,
    Ledger,
    MonitorState,
    Observer,
    Policy,
    ScreenLostError,
    WindowLostError,
    validate_device_heartbeat,
)

from .client import (
    Backoff,
    ClaimResponse,
    CommandClient,
    RequestRejected,
    ServerUnavailable,
    Unauthorized,
)
from .clock import Clock
from .events import make_event
from .gui_lock import OBSERVE, GuiLock
from .guard import GuardedDriver
from .pipeline import ExecOutcome, Gate, Pipeline

Mode = Literal["local", "remote"]
ClientState = Literal["running", "not_running", "login_required", "blocked_by_dialog", "unknown"]

# 这些暂停原因下界面已不归 Monitor（用户拿回窗口、换了账户），连观察也停止；
# 其他原因（登录失效、异常、服务端要求）仍继续只读观察，以便发现恢复。
_NO_OBSERVE_PAUSE_REASONS = frozenset({"user_request", "account_switched"})
# last_online_at 的落盘节流
_ONLINE_PERSIST_EVERY = timedelta(seconds=60)


@dataclass(frozen=True)
class RuntimeConfig:
    device_id: str
    mode: Mode = "local"
    monitor_version: str = "0.1.0"
    heartbeat_interval: float = 30.0
    observe_interval: float = 45.0
    offline_rebaseline_after: timedelta = timedelta(hours=24)
    claim_wait_seconds: int = 30
    max_idle_seconds: float = 30.0
    # 本地白名单：与策略白名单取交集。默认允许全部对外动作，实际是否执行由策略决定（策略默认全关）。
    local_allowed_actions: frozenset[str] = field(default_factory=lambda: frozenset(OUTWARD_ACTIONS))

    def __post_init__(self) -> None:
        if self.heartbeat_interval <= 0 or self.observe_interval <= 0:
            raise ValueError("心跳与观察周期必须为正")
        if not 0 <= self.claim_wait_seconds <= 30:
            raise ValueError("claim_wait_seconds 必须在 0–30")
        extra = set(self.local_allowed_actions) - set(OUTWARD_ACTIONS)
        if extra:
            raise ValueError(f"本地白名单只能包含对外动作: {sorted(extra)}")


@dataclass
class LastErrorInfo:
    code: str
    message: str
    at: datetime
    scene: str | None = None

    def to_wire(self) -> dict[str, Any]:
        d: dict[str, Any] = {"code": self.code, "message": self.message[:500], "at": self.at.isoformat()}
        if self.scene:
            d["scene"] = self.scene
        return d


class MonitorRuntime:
    def __init__(
        self,
        *,
        config: RuntimeConfig,
        ledger: Ledger,
        driver: Driver,
        client: CommandClient,
        handlers: Mapping[str, ActionHandler],
        clock: Clock,
        observer: Observer | None = None,
        gui_lock: GuiLock | None = None,
        backoff: Backoff | None = None,
    ) -> None:
        self.config = config
        self.ledger = ledger
        self.driver = driver
        self.client = client
        self.observer = observer
        self.clock = clock
        self.gui_lock = gui_lock or GuiLock()
        self.backoff = backoff or Backoff()
        self.pipeline = Pipeline(
            ledger=ledger, driver=driver, handlers=handlers, gui_lock=self.gui_lock, clock=clock, on_error=self.record_error
        )
        self.policy: Policy | None = None
        self.policy_stale = True
        self.account_confirmed: bool | None = None
        self.revoked = False
        self.online: bool | None = None
        self.client_state: ClientState = "unknown"
        self.last_error: LastErrorInfo | None = None
        self._unsent_error: LastErrorInfo | None = None
        self._next_heartbeat: datetime | None = None
        self._next_observe: datetime | None = None
        self._recovery_pending = False
        # 观察器（任务 E）由 create_observer() 无参构造，事件需要的 device_id 与
        # heartbeat.last_error 通道在这里注入。
        attach = getattr(observer, "attach", None)
        if callable(attach):
            attach(device_id=config.device_id, report=self.record_error)
        self._unacked: dict[UUID, tuple[str, datetime]] = {}
        self._parked_results: set[UUID] = set()
        self._parked_events: set[str] = set()
        self._started = False
        self._stop = threading.Event()
        self.state: MonitorState = ledger.load_state()
        if client.on_contact is None:
            client.on_contact = self.on_contact

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------
    def start(self) -> None:
        """加载本机状态，检查是否有崩溃遗留，检查停机是否超过离线阈值。可重复调用。"""
        if self._started:
            return
        self._started = True
        self.state = self.ledger.load_state()
        changed = False
        if self.state.mode is None:
            self.state.mode = self.config.mode
            changed = True
        now = self.clock.now()
        if self._offline_too_long(now):
            self._require_baseline()
            changed = True
        if changed:
            self.ledger.save_state(self.state)
        self._recovery_pending = bool(self.pipeline.running_commands())
        self._next_heartbeat = now
        self._next_observe = now

    def stop(self) -> None:
        self._stop.set()
        wake = getattr(self.clock, "wake", None)
        if callable(wake):
            wake()

    def run_forever(self) -> None:
        self.start()
        try:
            while not self._stop.is_set():
                idle = self.run_once()
                if idle > 0 and not self._stop.is_set():
                    self.clock.sleep(idle)
        finally:
            self.client.close()

    @property
    def mode(self) -> Mode:
        return self.state.mode or self.config.mode

    @property
    def account_id(self) -> str | None:
        b = self.state.account_binding
        return b.account_id if b is not None else None

    def gate(self) -> Gate:
        return Gate(
            account_id=self.account_id,
            policy=self.policy,
            mode=self.mode,
            device_id=self.config.device_id,
            local_allowed=self.config.local_allowed_actions,
        )

    # ------------------------------------------------------------------
    # 一轮
    # ------------------------------------------------------------------
    def run_once(self) -> float:
        """跑一轮，返回建议的空闲等待秒数（0 表示马上再跑）。"""
        self.start()
        now = self.clock.now()
        self._server_round(now)

        if self._gui_allowed():
            if self._recovery_pending:
                self.pipeline.recover(self.gate())
                self._recovery_pending = False
                return 0.0
            outcome = self.pipeline.run_next(self.gate())
            if outcome is not None:
                self._after_execution(outcome)
                return 0.0

        now = self.clock.now()
        if self._observe_allowed() and self._observe_due(now):
            self._observe()
            return 0.0

        if self._can_claim():
            wait = self._claim_wait(self.clock.now())
            t0 = self.clock.now()
            got = self._claim(wait)
            if got:
                return 0.0
            elapsed = (self.clock.now() - t0).total_seconds()
            # 长轮询正常情况下已经等过；服务端提前返回空列表时补足剩余时间，避免空转
            return max(0.0, min(wait - elapsed, self._idle_seconds(self.clock.now())))
        return self._idle_seconds(self.clock.now())

    def _idle_seconds(self, now: datetime) -> float:
        candidates = [self.config.max_idle_seconds]
        for t in (self._next_heartbeat, self.backoff.next_at, self.pipeline.wake_at):
            if t is not None:
                candidates.append((t - now).total_seconds())
        if self.observer is not None and self._observe_allowed() and self._next_observe is not None:
            candidates.append((self._next_observe - now).total_seconds())
        return max(0.0, min(candidates))

    # ------------------------------------------------------------------
    # 服务端往来
    # ------------------------------------------------------------------
    def _server_ready(self, now: datetime) -> bool:
        return not self.revoked and self.backoff.ready(now)

    def _server_call(self, fn, *args, **kwargs) -> Any:
        """统一处理连通性错误：ServerUnavailable → 退避并标记离线；Unauthorized → 停止服务端往来。"""
        try:
            out = fn(*args, **kwargs)
        except ServerUnavailable as exc:
            self.online = False
            at = self.backoff.failure(self.clock.now())
            self.record_error("server_unavailable", f"{exc}；{at.isoformat()} 后重试")
            raise
        except Unauthorized as exc:
            self.revoked = True
            self.record_error("token_revoked", str(exc))
            raise
        self.online = True
        self.backoff.success()
        return out

    def _server_round(self, now: datetime) -> None:
        if not self._server_ready(now):
            return
        try:
            if self._next_heartbeat is None or now >= self._next_heartbeat:
                self._heartbeat()
            if self.policy_stale and self.account_id is not None:
                self._refresh_policy()
            self._retry_acks()
            self._flush_results()
            self._flush_events()
        except (ServerUnavailable, Unauthorized):
            return

    def on_contact(self, now: datetime) -> None:
        """CommandClient 每收到一次服务端响应就回调这里（离线检测）。"""
        prev = self.state.last_online_at
        changed = False
        if self._offline_too_long(now):
            self._require_baseline()
            changed = True
        if prev is None or changed or now - prev >= _ONLINE_PERSIST_EVERY:
            self.state.last_online_at = now
            changed = True
        if changed:
            self.ledger.save_state(self.state)

    def _offline_too_long(self, now: datetime) -> bool:
        prev = self.state.last_online_at
        return prev is not None and now - prev > self.config.offline_rebaseline_after and not self.state.needs_baseline

    def _require_baseline(self) -> None:
        """置 needs_baseline，并让下一次观察从未建立的基线开始。"""
        self.state.needs_baseline = True
        old = self.state.baseline
        self.state.baseline = Baseline(account_id=self.account_id, established=False, generation=old.generation + 1)
        self._next_observe = self.clock.now()

    def _heartbeat(self) -> None:
        now = self.clock.now()
        counts = {
            "queued_commands": len(self.ledger.list_commands(states=[CommandState.QUEUED, CommandState.RUNNING])),
            "undelivered_results": len(self.ledger.pending_results(limit=10_000)),
            "outbox_events": len(self.ledger.pending_events(limit=10_000)),
        }
        current = None
        if self.pipeline.current is not None:
            cmd, started = self.pipeline.current
            current = {"command_id": str(cmd.command_id), "action": cmd.action, "started_at": started.isoformat()}
        err = self._unsent_error
        hb = validate_device_heartbeat(
            {
                "device_id": self.config.device_id,
                "sent_at": now.isoformat(),
                "mode": self.mode,
                "account_id": self.account_id,
                "client_state": self.client_state,
                "paused": self.state.paused,
                "pause_reason": self.state.pause_reason,
                "needs_baseline": self.state.needs_baseline,
                "current_action": current,
                "queue": counts,
                "last_error": err.to_wire() if err is not None else None,
                "monitor_version": self.config.monitor_version,
            }
        )
        ack = self._server_call(self.client.heartbeat, hb)
        self._next_heartbeat = now + timedelta(seconds=self.config.heartbeat_interval)
        if self._unsent_error is err:
            self._unsent_error = None
        self.account_confirmed = ack.account_confirmed
        if ack.paused and not self.state.paused:
            self.pause("server_request", by="server", detail="控制台要求暂停")
        elif not ack.paused and self.state.paused and self.state.pause_reason == "server_request":
            self.resume(by="server")
        if self.policy is None or ack.policy_version != self.policy.policy_version:
            self.policy_stale = True
        for cid in ack.cancellations:
            self.pipeline.cancel(cid)

    def _refresh_policy(self) -> None:
        assert self.account_id is not None
        try:
            policy = self._server_call(self.client.get_policy, self.account_id)
        except RequestRejected as exc:
            self.record_error("policy_unavailable", str(exc))
            return
        if policy.account_id != self.account_id:
            self.record_error("policy_account_mismatch", "策略账户与本机绑定账户不一致")
            return
        self.policy = policy
        self.policy_stale = False

    def _retry_acks(self) -> None:
        for cid, (state, received_at) in list(self._unacked.items()):
            try:
                self._server_call(self.client.ack, cid, ledger_state=state, received_at=received_at)
            except RequestRejected as exc:
                self.record_error("ack_rejected", f"{cid}: {exc}")
            self._unacked.pop(cid, None)

    def _flush_results(self) -> None:
        for result in self.ledger.pending_results(limit=100):
            if result.command_id in self._parked_results:
                continue
            try:
                rep = self._server_call(self.client.report_result, result)
            except RequestRejected as exc:
                # 4xx（非冲突）：重试无意义，本进程内不再重发，留在账本里待人处理
                self._parked_results.add(result.command_id)
                self.record_error("result_rejected", f"{result.command_id}: {exc}")
                continue
            if rep.conflict:
                self.record_error("result_conflict", f"{result.command_id} 服务端已记录不同的结果")
            self.ledger.mark_result_delivered(result.command_id)

    def _flush_events(self) -> None:
        while True:
            entries = [
                e
                for e in self.ledger.pending_events(limit=100 + len(self._parked_events))
                if e.event.event_id not in self._parked_events
            ][:100]
            if not entries:
                return
            try:
                reports = self._server_call(self.client.post_events, [e.event for e in entries])
            except RequestRejected as exc:
                for e in entries:
                    self._parked_events.add(e.event.event_id)
                self.record_error("events_rejected", str(exc))
                return
            delivered = [r.event_id for r in reports if r.status in ("accepted", "duplicate")]
            for r in reports:
                if r.status == "rejected":
                    self._parked_events.add(r.event_id)
                    self.record_error("event_rejected", f"{r.event_id[:12]}… 被服务端拒绝")
            answered = {r.event_id for r in reports}
            for e in entries:  # 服务端没有逐条答复的条目也视为待人处理，避免死循环
                if e.event.event_id not in answered:
                    self._parked_events.add(e.event.event_id)
            if delivered:
                self.ledger.mark_events_delivered(delivered)

    # ------------------------------------------------------------------
    # 领取
    # ------------------------------------------------------------------
    def _can_claim(self) -> bool:
        return (
            self._server_ready(self.clock.now())
            and self.account_id is not None
            and self.policy is not None
            and not self.policy_stale
            and self.account_confirmed is not False
            and not self.state.paused
            and not self.state.needs_baseline
            and not self._recovery_pending
            and not self.pipeline.has_pending_work()
        )

    def _claim_wait(self, now: datetime) -> int:
        limit = float(self.config.claim_wait_seconds)
        for t in (self._next_heartbeat, self._next_observe if self.observer is not None else None):
            if t is not None:
                limit = min(limit, (t - now).total_seconds())
        return max(0, int(limit))

    def _claim(self, wait: int) -> bool:
        assert self.account_id is not None
        try:
            resp: ClaimResponse = self._server_call(
                self.client.claim, account_id=self.account_id, max_commands=1, wait_seconds=wait
            )
        except (ServerUnavailable, Unauthorized):
            return False
        except RequestRejected as exc:
            self.record_error("claim_rejected", str(exc))
            return False
        self.handle_claim(resp)
        return bool(resp.commands)

    def handle_claim(self, resp: ClaimResponse) -> None:
        """入账 → ack。先全部入账再逐条 ack，ack 失败的留到下一轮补发。"""
        now = self.clock.now()
        for cid in resp.cancellations:
            self.pipeline.cancel(cid)
        for inv in resp.invalid:
            self.record_error("invalid_command", f"指令 {inv.command_id or inv.index} 不符合契约: {inv.errors[0]}")
        for cmd in resp.commands:
            rec, created = self.pipeline.intake(cmd, received_at=now)
            self._unacked[cmd.command_id] = (str(rec.state), rec.received_at)
            if not created and rec.result is not None:
                # 重复送达且已有结果：返回已有结果（不重做）。已回传过的再发一次，服务端按幂等返回 duplicate。
                try:
                    self._server_call(self.client.report_result, rec.result)
                    self.ledger.mark_result_delivered(cmd.command_id)
                except (ServerUnavailable, Unauthorized, RequestRejected):
                    pass
        try:
            self._retry_acks()
        except (ServerUnavailable, Unauthorized):
            pass

    # ------------------------------------------------------------------
    # 执行后处理：异常暂停
    # ------------------------------------------------------------------
    def _after_execution(self, outcome: ExecOutcome) -> None:
        rec = outcome.record
        if not outcome.executed:
            return
        result = rec.result
        assert result is not None
        if outcome.anomaly is None:
            if result.reason != "driver_error":
                self.client_state = "running"
            return
        now = self.clock.now()
        detail = (result.reason_detail or "")[:200] or None
        if outcome.anomaly == "login_required":
            self.client_state = "login_required"
            self._emit("login_required", {"reason": "unknown", "mode": self.mode}, now)
            self.pause("login_required", by="monitor", detail=detail)
        elif outcome.anomaly in ("captcha", "unknown_dialog"):
            self.client_state = "blocked_by_dialog"
            self._emit(
                "blocked_by_dialog",
                {
                    "dialog_kind": "captcha" if outcome.anomaly == "captcha" else "unknown",
                    "dialog_text": (result.reason_detail or "")[:500],
                    "buttons": [],
                    "command_id": str(rec.command.command_id),
                },
                now,
            )
            self.pause("anomaly", by="monitor", detail=detail)
        elif outcome.anomaly == "account_mismatch":
            self.pause("account_switched", by="monitor", detail="客户端当前账户与绑定账户不一致，等待重新绑定")

    # ------------------------------------------------------------------
    # 观察
    # ------------------------------------------------------------------
    def _observe_allowed(self) -> bool:
        if self.state.paused and self.state.pause_reason in _NO_OBSERVE_PAUSE_REASONS:
            return False
        return True

    def _observe_due(self, now: datetime) -> bool:
        if self.observer is None:
            return self.state.needs_baseline  # 没有观察模块时直接清掉 needs_baseline
        if self.state.needs_baseline:
            return True
        return self._next_observe is None or now >= self._next_observe

    def _observe(self) -> None:
        now = self.clock.now()
        self._next_observe = now + timedelta(seconds=self.config.observe_interval)
        if self.observer is None:
            self.state.needs_baseline = False
            self.state.baseline.established = True
            self.ledger.save_state(self.state)
            return
        baseline = self.state.baseline.model_copy(deep=True)
        if self.state.needs_baseline and baseline.established:
            baseline = Baseline(account_id=self.account_id, established=False, generation=baseline.generation + 1)
        elif baseline.account_id is None and self.account_id is not None:
            # 首次启动的默认基线不带账户；观察器在 account_id 为空时不产生事件。
            baseline.account_id = self.account_id
        with self.gui_lock.hold(OBSERVE, timeout=0) as ok:
            if not ok:
                return
            # 观察只允许导航（切到『新招呼』页签、滚动），禁止输入、按键与对外动作。
            guarded = GuardedDriver(self.driver, mode="verify")
            try:
                events = self.observer.observe(guarded, baseline)
            except DriverError as exc:
                if isinstance(exc, (WindowLostError, ScreenLostError)):
                    self.client_state = "not_running"
                self.record_error(exc.code, f"观察失败: {exc}")
                return
            except Exception as exc:
                self.record_error("observe_failed", f"观察模块异常: {type(exc).__name__}")
                return
        at = self.clock.now()
        for ev in events:
            self.ledger.append_event(ev, at=at)
        self.state.baseline = baseline
        if self.state.needs_baseline and baseline.established:
            self.state.needs_baseline = False
        self.ledger.save_state(self.state)
        for ev in events:
            self._react_to_event(ev)

    def _react_to_event(self, ev: EventModel) -> None:
        if ev.kind == "login_required":
            self.client_state = "login_required"
            if not self.state.paused:
                self.pause("login_required", by="monitor")
        elif ev.kind == "blocked_by_dialog":
            self.client_state = "blocked_by_dialog"
            if not self.state.paused:
                self.pause("anomaly", by="monitor", detail=ev.payload.dialog_kind)
        elif ev.kind == "login_ok":
            self.client_state = "running"
            if self.state.paused and self.state.pause_reason == "login_required":
                self.resume(by="monitor")

    # ------------------------------------------------------------------
    # 暂停、恢复、绑定
    # ------------------------------------------------------------------
    def _gui_allowed(self) -> bool:
        return not self.state.paused

    def pause(self, reason: str, *, by: Literal["user", "monitor", "server"], detail: str | None = None) -> None:
        """停止领取与启动新动作；已发生的动作照常记录与回传。重复暂停不覆盖首个原因。"""
        if self.state.paused:
            return
        self.state.paused = True
        self.state.pause_reason = reason  # type: ignore[assignment]
        self.ledger.save_state(self.state)
        payload: dict[str, Any] = {"reason": reason, "by": by}
        if detail:
            payload["detail"] = detail[:200]
        self._emit("device_paused", payload, self.clock.now())

    def resume(self, *, by: Literal["user", "monitor", "server"] = "user") -> None:
        if not self.state.paused:
            return
        self.state.paused = False
        self.state.pause_reason = None
        self.ledger.save_state(self.state)

    def bind_account(self, account_id: str, *, confirmed_by: str) -> None:
        """（重新）绑定招聘账户：清空策略缓存、要求重建基线；因换账户而暂停的设备恢复。"""
        from monitor_contracts import AccountBinding

        changed = self.account_id != account_id
        switched = self.state.paused and self.state.pause_reason == "account_switched"
        self.state.account_binding = AccountBinding(
            account_id=account_id, bound_at=self.clock.now(), confirmed_by=confirmed_by
        )
        if changed:
            self.policy = None
            self.policy_stale = True
        if changed or switched:
            # 换过账户的界面不能沿用旧基线
            self._require_baseline()
        if switched:
            self.state.paused = False
            self.state.pause_reason = None
        self.ledger.save_state(self.state)

    # ------------------------------------------------------------------
    # 杂项
    # ------------------------------------------------------------------
    def _emit(self, kind: str, payload: dict[str, Any], now: datetime) -> None:
        try:
            ev = make_event(
                kind, device_id=self.config.device_id, account_id=self.account_id, payload=payload, observed_at=now
            )
        except ValueError as exc:
            self.record_error("event_build_failed", f"{kind}: {exc}"[:500])
            return
        self.ledger.append_event(ev, at=now)

    def record_error(self, code: str, message: str, scene: str | None = None) -> None:
        info = LastErrorInfo(code=code, message=message, at=self.clock.now(), scene=scene)
        self.last_error = info
        self._unsent_error = info

    def status(self) -> dict[str, Any]:
        """给本机状态窗口（任务 J）的只读摘要；不含实现术语以外的个人信息。"""
        current = self.pipeline.current
        return {
            "mode": self.mode,
            "account_id": self.account_id,
            "client_state": self.client_state,
            "paused": self.state.paused,
            "pause_reason": self.state.pause_reason,
            "needs_baseline": self.state.needs_baseline,
            "online": self.online,
            "revoked": self.revoked,
            "current_action": current[0].action if current else None,
            "queued": len(self.ledger.list_commands(states=[CommandState.QUEUED, CommandState.RUNNING])),
            "undelivered": len(self.ledger.pending_results(limit=10_000)),
            "last_error": None if self.last_error is None else {"code": self.last_error.code, "at": self.last_error.at},
        }
