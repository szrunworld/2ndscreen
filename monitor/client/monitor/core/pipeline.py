"""执行管线（方案第七节）。

    领取 → 写入账本（queued）→ 按 command_id 去重 → 有效期 / 账户 / 依赖 / 白名单 / 限额
      → 获取 GUI 执行权 → running（先落账）→ 调用注入的 ActionHandler → 本地持久化结果
      → （由运行时）回传 → delivered

关键约束：
- 先把 running 写进账本再调用处理器。进程在处理器里被杀，重启后看到 running，
  只做 verify_only 复核（可导航，不做输入与对外动作），绝不重做；复核仍不明 → unknown(crash_recovery)。
- execution_mode=verify_only 只调用 handler.verify_only，不受白名单与限额约束，
  Driver 外包 verify 模式守卫：允许导航（click / scroll），拒绝输入（type_text / key）与对外动作。
- 对外动作由处理器用 ctx.outbound() 显式声明（见 guard.py）；未声明的写调用记为导航。
- running 中被取消：没有发生对外动作 → cancelled（导航与对方可见如实记录）；已发生 → 回报实际结果。
- 前置检查失败（过期、账户不符、依赖未满足、白名单、限额）直接 queued → 终态，不碰 Driver。
- 只捕获 Exception：KeyboardInterrupt / SystemExit 等照常向上抛，账本停在 running，交给恢复流程。
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
import threading
from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import UUID

from monitor_contracts import (
    OUTWARD_ACTIONS,
    ActionHandler,
    ActionResult,
    CommandModel,
    CommandResult,
    CommandState,
    Driver,
    DriverError,
    Fact,
    Ledger,
    LedgerCommand,
    Observed,
    Policy,
)

from .clock import Clock
from .gui_lock import ACTION, GuiLock
from .guard import CommandCancelled, ExecContext, GuardedDriver
from .limits import check_rate
from . import write_flags

# 处理器返回这些原因时，运行时需要暂停相应执行并上报（方案第七节"登录失效、验证码、未知弹窗"
# 与"用户切换账户"）。target_ambiguous 只影响本条指令，不暂停设备。
ANOMALY_REASONS = frozenset({"login_required", "captcha", "unknown_dialog", "account_mismatch"})

ErrorSink = Callable[[str, str], None]


@dataclass(frozen=True)
class Gate:
    """执行前检查需要的运行时状态快照。"""

    account_id: str | None
    policy: Policy | None
    mode: Literal["local", "remote"]
    device_id: str
    local_allowed: frozenset[str]

    def allowed_actions(self) -> frozenset[str]:
        """本地白名单与策略白名单的交集；没有策略时为空（全部关闭）。"""
        if self.policy is None:
            return frozenset()
        return frozenset(self.policy.allowed_actions) & self.local_allowed


@dataclass(frozen=True)
class ExecOutcome:
    record: LedgerCommand
    executed: bool  # 是否调用过处理器
    anomaly: str | None = None


@dataclass(frozen=True)
class _Reject:
    status: Literal["failed", "expired"]
    reason: str | None
    detail: str | None = None


@dataclass(frozen=True)
class _Defer:
    until: datetime | None  # None：等依赖完成


_GO = object()


class Pipeline:
    def __init__(
        self,
        *,
        ledger: Ledger,
        driver: Driver,
        handlers: Mapping[str, ActionHandler],
        gui_lock: GuiLock,
        clock: Clock,
        on_error: ErrorSink | None = None,
        gui_available: Callable[[], bool] | None = None,
    ) -> None:
        for name, h in handlers.items():
            if h.action != name:
                raise ValueError(f"处理器注册名 {name} 与其 action {h.action} 不一致")
        self.ledger = ledger
        self.driver = driver
        self.handlers = dict(handlers)
        self.gui_lock = gui_lock
        self.clock = clock
        self._on_error = on_error or (lambda code, msg: None)
        # 拿到 GUI 锁后再确认一次窗口仍归 Monitor（锁可能刚被归还窗口的一方释放）；不归则指令留在队列
        self._gui_available = gui_available or (lambda: True)
        # 最近一次 run_next 中被推迟的指令最早何时可以再看（限额间隔）
        self.wake_at: datetime | None = None
        # 正在执行的指令（供心跳 current_action 与状态窗口）
        self.current: tuple[CommandModel, datetime] | None = None
        # 执行中收到的取消请求（可能来自其他线程，例如状态窗口或独立心跳线程）
        self._cancel_lock = threading.Lock()
        self._cancel_requested: set[UUID] = set()

    # ------------------------------------------------------------------
    # 入账与取消
    # ------------------------------------------------------------------
    def intake(self, command: CommandModel, *, received_at: datetime) -> tuple[LedgerCommand, bool]:
        """按 command_id 幂等写入账本。重复送达时返回已有记录（含已有结果），不产生新迁移。"""
        return self.ledger.put_command(command, received_at=received_at)

    def cancel(self, command_id: UUID) -> LedgerCommand | None:
        """取消一条指令。返回迁移后的记录或 None。

        - 排队中：直接 cancelled（三个标志都为 false）。
        - 正在执行：登记取消请求，返回 None。守卫在下一次写调用或进入 outbound() 时打断处理器；
          执行结束时若没有发生对外动作则落 cancelled，否则回报实际结果。
        - 已结束：不动（回报实际结果）。
        """
        current = self.current
        if current is not None and current[0].command_id == command_id:
            with self._cancel_lock:
                self._cancel_requested.add(command_id)
            return None
        rec = self.ledger.get_command(command_id)
        if rec is None or rec.state != CommandState.QUEUED:
            return None
        result = self._result(rec.command, status="cancelled", reason=None, detail="排队时被取消")
        return self.ledger.transition_command(command_id, CommandState.CANCELLED, at=self.clock.now(), result=result)

    # ------------------------------------------------------------------
    # 崩溃恢复
    # ------------------------------------------------------------------
    def running_commands(self) -> list[LedgerCommand]:
        return self.ledger.list_commands(states=[CommandState.RUNNING])

    def recover(self, gate: Gate) -> list[LedgerCommand]:
        """把上次进程遗留的 running 指令逐条只读复核并落终态。调用前不得持有 GUI 锁。"""
        out: list[LedgerCommand] = []
        for rec in self.running_commands():
            with self.gui_lock.hold(ACTION):
                result = self._recover_one(rec, gate)
            out.append(
                self.ledger.transition_command(
                    rec.command.command_id, CommandState(result.status), at=self.clock.now(), result=result
                )
            )
        return out

    def _recover_one(self, rec: LedgerCommand, gate: Gate) -> CommandResult:
        cmd = rec.command
        started = rec.updated_at
        handler = self.handlers.get(cmd.action)
        verified: ActionResult | None = None
        if handler is not None:
            guarded = GuardedDriver(self.driver, mode="verify")
            try:
                verified = handler.verify_only(cmd, guarded, self._ctx(cmd, gate, guarded))
            except Exception as exc:  # 复核本身出错 → 仍不明
                self._on_error("crash_recovery_failed", f"{cmd.command_id} 复核出错: {type(exc).__name__}")
                verified = None

        recovery_fact = Fact(code="crash_recovery", detail="进程在执行中退出，重启后只读复核")
        if cmd.execution_mode == "verify_only":
            # 只读指令重做复核是安全的，直接采用复核结果
            if verified is not None:
                built = self._build(cmd, verified, navigated=guarded.navigated, outbound_done=False)
                if built is not None:
                    return built
            return self._result(cmd, status="unknown", reason="crash_recovery", detail="复核仍无法确认")

        # 上次进程里是否做过对外动作已无从得知（守卫计数没有落账），按保守值：导航与对方可见都记 true；
        # 复核确认动作已发生时对外动作为 true（0.3.2 起搜索同样），确认未发生时为 false，不明时为 true。
        if verified is not None and verified.status == "succeeded":
            built = self._build(
                cmd,
                verified.model_copy(
                    update={
                        **write_flags.flags(
                            navigation=True, outbound=write_flags.success_is_outbound(cmd.action), visible=True
                        ),
                        "executed_at": verified.executed_at or started,
                        "observed": Observed(
                            before=verified.observed.before, after=[*verified.observed.after, recovery_fact]
                        ),
                    }
                ),
                navigated=True,
                outbound_done=write_flags.success_is_outbound(cmd.action),
            )
            if built is not None:
                return built
        if verified is not None and verified.status == "failed" and verified.reason == "verification_failed":
            return self._result(
                cmd,
                status="failed",
                reason="verification_failed",
                detail="崩溃恢复：复核确认动作未发生；不自动重做",
                flags=write_flags.flags(navigation=True, visible=True),
                executed_at=started,
                observed=Observed(before=verified.observed.before, after=[*verified.observed.after, recovery_fact]),
                evidence=verified.evidence,
            )
        return self._result(
            cmd,
            status="unknown",
            reason="crash_recovery",
            detail="崩溃恢复：复核仍无法确认动作是否发生；停止自动重试",
            flags=write_flags.flags(navigation=True, outbound=True, visible=True),
            executed_at=started,
            observed=Observed(after=[recovery_fact]),
            evidence=verified.evidence if verified is not None else [],
        )

    # ------------------------------------------------------------------
    # 执行
    # ------------------------------------------------------------------
    def run_next(self, gate: Gate) -> ExecOutcome | None:
        """处理排队中最早的一条可处理指令（前置拒绝或真正执行），没有则返回 None。

        被推迟的指令（等依赖、等最小间隔）跳过，最早可重试时间记在 wake_at。
        """
        self.wake_at = None
        queued = sorted(self.ledger.list_commands(states=[CommandState.QUEUED]), key=lambda r: r.received_at)
        for rec in queued:
            now = self.clock.now()
            decision = self._precheck(rec, gate, now)
            if isinstance(decision, _Defer):
                if decision.until is not None and (self.wake_at is None or decision.until < self.wake_at):
                    self.wake_at = decision.until
                continue
            if isinstance(decision, _Reject):
                result = self._result(rec.command, status=decision.status, reason=decision.reason, detail=decision.detail)
                done = self.ledger.transition_command(
                    rec.command.command_id, CommandState(decision.status), at=now, result=result
                )
                return ExecOutcome(done, executed=False)
            return self._execute(rec, gate)
        return None

    def has_pending_work(self) -> bool:
        return bool(self.ledger.list_commands(states=[CommandState.QUEUED, CommandState.RUNNING]))

    def _precheck(self, rec: LedgerCommand, gate: Gate, now: datetime) -> _Reject | _Defer | object:
        cmd = rec.command
        if now >= cmd.expires_at:
            return _Reject("expired", None, "指令已过期，未执行")
        if gate.account_id is None or cmd.account_id != gate.account_id:
            return _Reject("failed", "account_mismatch", "指令账户与本机绑定账户不一致")
        if cmd.depends_on is not None:
            dep = self.ledger.get_command(cmd.depends_on)
            if dep is not None:
                if dep.state in (CommandState.QUEUED, CommandState.RUNNING):
                    return _Defer(None)
                if dep.state != CommandState.SUCCEEDED:
                    return _Reject(
                        "failed", "dependency_not_satisfied", f"前置指令 {cmd.depends_on} 的结果是 {dep.state}"
                    )
        if cmd.action not in self.handlers:
            return _Reject("failed", "unsupported", f"本机没有 {cmd.action} 的处理器")
        if cmd.execution_mode == "verify_only":
            return _GO  # 只读复核：不看白名单与限额
        if cmd.action in OUTWARD_ACTIONS:
            if cmd.action not in gate.allowed_actions():
                return _Reject("failed", "action_not_allowed", "白名单未开启该动作")
            decision = check_rate(
                cmd.action, now=now, history=self.ledger.list_commands(), policy=gate.policy
            )
            if decision.kind == "daily_cap":
                return _Reject("failed", "rate_limited", decision.detail())
            if decision.kind == "min_interval":
                assert decision.retry_at is not None
                if decision.retry_at >= cmd.expires_at:
                    return _Reject("failed", "rate_limited", decision.detail() + "，且等待会超过有效期")
                return _Defer(decision.retry_at)
        return _GO

    def _ctx(self, cmd: CommandModel, gate: Gate, guard: GuardedDriver) -> ExecContext:
        return ExecContext(
            account_id=cmd.account_id,
            device_id=gate.device_id,
            mode=gate.mode,
            allowed_actions=gate.allowed_actions(),
            deadline=cmd.expires_at,
            clock=self.clock.now,
            guard=guard,
        )

    def _execute(self, rec: LedgerCommand, gate: Gate) -> ExecOutcome | None:
        cmd = rec.command
        cid = cmd.command_id
        handler = self.handlers[cmd.action]
        verify = cmd.execution_mode == "verify_only"
        with self.gui_lock.hold(ACTION):
            if not self._gui_available():
                return None
            started = self.clock.now()
            self.ledger.transition_command(cid, CommandState.RUNNING, at=started)
            self.current = (cmd, started)
            guarded = GuardedDriver(
                self.driver, mode="verify" if verify else "execute", cancelled=lambda: self._is_cancel_requested(cid)
            )
            ctx = self._ctx(cmd, gate, guarded)
            try:
                ar: ActionResult | None
                try:
                    if verify:
                        ar = handler.verify_only(cmd, guarded, ctx)
                    else:
                        ar = handler.run(cmd, guarded, ctx)
                except CommandCancelled:
                    ar = None
                except DriverError as exc:
                    ar = self._error_result(guarded, started, f"{exc.code}: {exc}"[:500])
                except Exception as exc:  # 处理器缺陷：不让守护进程崩溃
                    self._on_error("handler_error", f"{cmd.action} 处理器异常: {type(exc).__name__}")
                    ar = self._error_result(guarded, started, f"处理器异常 {type(exc).__name__}")
                result = self._finish(cmd, ar, guarded, started)
                done = self.ledger.transition_command(cid, CommandState(result.status), at=self.clock.now(), result=result)
            finally:
                self.current = None
                with self._cancel_lock:
                    self._cancel_requested.discard(cid)
        anomaly = result.reason if result.reason in ANOMALY_REASONS else None
        return ExecOutcome(done, executed=True, anomaly=anomaly)

    def _is_cancel_requested(self, command_id: UUID) -> bool:
        with self._cancel_lock:
            return command_id in self._cancel_requested

    def _finish(
        self, cmd: CommandModel, ar: ActionResult | None, guarded: GuardedDriver, started: datetime
    ) -> CommandResult:
        """处理器结束后定终态：取消优先（仅当没有对外动作），其次处理器结果，不合契约时保守兜底。"""
        outbound_done = guarded.outbound_performed or (ar is not None and write_flags.outbound(ar))
        if self._is_cancel_requested(cmd.command_id) and not outbound_done:
            return self._result(
                cmd,
                status="cancelled",
                reason=None,
                detail="执行中被取消，未发生对外动作",
                flags=write_flags.flags(
                    navigation=guarded.navigated or (ar is not None and ar.navigation_performed),
                    visible=ar is not None and ar.externally_visible_side_effect,
                ),
                observed=ar.observed if ar is not None else None,
                evidence=ar.evidence if ar is not None else None,
            )
        if ar is None:  # CommandCancelled 却查不到取消请求：不应发生，按处理器缺陷兜底
            ar = self._error_result(guarded, started, "处理器在没有取消请求时被打断")
        result = self._build(cmd, ar, navigated=guarded.navigated, outbound_done=guarded.outbound_performed)
        if result is None:
            self._on_error("handler_contract", f"{cmd.action} 处理器返回的结果不符合契约")
            # 处理器自己声明过对外动作的，也按"可能已发生"兜底
            fallback = self._error_result(guarded, started, "处理器返回的结果不符合契约", declared_outbound=outbound_done)
            result = self._build(cmd, fallback, navigated=guarded.navigated, outbound_done=guarded.outbound_performed)
            assert result is not None
        return result

    def _error_result(
        self, guarded: GuardedDriver, started: datetime, detail: str, *, declared_outbound: bool = False
    ) -> ActionResult:
        if guarded.outbound_performed or declared_outbound:
            # 已经开始对外动作，结果不明：unknown，停止自动重试
            return ActionResult(
                status="unknown",
                reason="driver_error",
                reason_detail=detail,
                executed_at=started,
                **write_flags.flags(navigation=guarded.navigated, outbound=True),
            )
        # 只导航过（或什么都没做）：对外动作肯定没发生，失败即可
        return ActionResult(
            status="failed", reason="driver_error", reason_detail=detail, **write_flags.flags(navigation=guarded.navigated)
        )

    def _build(
        self, cmd: CommandModel, ar: ActionResult, *, navigated: bool, outbound_done: bool
    ) -> CommandResult | None:
        """把处理器结果转成 CommandResult。三个标志取处理器声明与守卫记录的并集（write_flags.merged）。

        不符合契约时返回 None（调用方用保守的兜底结果）。
        """
        now = self.clock.now()
        update: dict = write_flags.merged(
            ar, navigated=navigated, outbound_done=outbound_done, verify_only=cmd.execution_mode == "verify_only"
        )
        if ar.status == "succeeded" and ar.executed_at is None:
            update["executed_at"] = now
        try:
            return ar.model_copy(update=update).to_command_result(cmd, reported_at=now)
        except ValueError:
            return None

    def _result(
        self,
        cmd: CommandModel,
        *,
        status: str,
        reason: str | None,
        detail: str | None = None,
        flags: dict | None = None,
        executed_at: datetime | None = None,
        observed: Observed | None = None,
        evidence: list | None = None,
    ) -> CommandResult:
        ar = ActionResult(
            status=status,
            reason=reason,
            reason_detail=detail,
            executed_at=executed_at,
            **(flags or write_flags.none()),
            observed=observed or Observed(),
            evidence=evidence or [],
        )
        return ar.to_command_result(cmd, reported_at=self.clock.now())
