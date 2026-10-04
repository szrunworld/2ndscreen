"""BOSS 窗口归属：remote 引导（建屏、启动、绑定、防休眠）与 local 接管/归还（方案第三节、8.5 第 1 步）。

- RemoteSession：启动时建专用屏、在其上启动 BOSS（app launch --bundle；已在运行则 window move 自己的实例）、
  绑定窗口、启动 caffeinate；之后定期用 driver.screen_ok() 检查，窗口或屏幕丢失时重新引导。
- LocalSession：只在策略工作时段内、且没有被用户暂停/登录失效时，把用户自己的 BOSS 窗口 window move 到专用屏
  （takeOver）；暂停、时段结束、退出时 window release 归还。local 从不启动或退出用户的 BOSS。

失败一律经 run_with_retry 有上限地退避重试并 record_error 上报；用尽 max_rounds 轮后停止自动重试，
直到用户点"重试"或恢复（reset_budget）。没有无限循环。

GateDriver：运行时拿到的 Driver 外包一层闸门。窗口不归 Monitor 时（local 归还后、时段外）所有界面调用
直接抛 WindowLostError，不会碰到用户的窗口。
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from monitor_contracts import Driver, WindowLostError, WindowSelector

from .caffeinate import Caffeinate
from .retry import BootstrapFailed, RetryPolicy, StepFailed, run_with_retry
from .screen import AppAlreadyRunning, ScreenOps
from .workhours import in_work_hours

Report = Callable[[str, str], None]

# local：这些暂停原因下窗口要还给用户（用户要自己操作或登录）
LOCAL_RELEASE_PAUSE_REASONS = frozenset({"user_request", "account_switched", "login_required"})


class GateDriver:
    """Driver 闸门。open=False 时所有界面方法抛 WindowLostError；其他属性透传给内部 Driver。"""

    _METHODS = ("state", "click", "type_text", "key", "scroll", "bind_window", "screenshot_region")

    def __init__(self, inner: Driver, *, open: bool = False) -> None:
        self.inner = inner
        self._open = threading.Event()
        if open:
            self._open.set()

    @property
    def is_open(self) -> bool:
        return self._open.is_set()

    def open(self) -> None:
        self._open.set()

    def close(self) -> None:
        self._open.clear()

    def screen_ok(self) -> bool:
        return self._open.is_set() and self.inner.screen_ok()

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self.inner, name)
        if name in GateDriver._METHODS:

            def gated(*args: Any, **kwargs: Any) -> Any:
                if not self._open.is_set():
                    raise WindowLostError("BOSS 窗口当前不归 Monitor（已归还用户或不在工作时段）")
                return attr(*args, **kwargs)

            return gated
        return attr


@dataclass
class RuntimeView:
    """Session 需要从运行时读取 / 调用的东西（都在运行时线程里使用）。"""

    report: Report
    policy: Callable[[], Any]
    pause_state: Callable[[], tuple[bool, str | None]]
    gui_lock: Any
    now: Callable[[], datetime]
    sleep: Callable[[float], None]
    # 运行时的窗口挂起接口（D2c）：窗口不归 Monitor 时调用 suspend_gui，接管成功后 resume_gui
    suspend_gui: Callable[[str], None] = lambda reason: None
    resume_gui: Callable[[], None] = lambda: None


class _BaseSession:
    mode = "local"

    def __init__(
        self,
        *,
        ops: ScreenOps,
        driver: Any,
        gate: GateDriver,
        view: RuntimeView,
        bundle_id: str,
        retry: RetryPolicy | None = None,
        max_rounds: int = 3,
        check_interval: float = 30.0,
    ) -> None:
        self.ops = ops
        self.driver = driver
        self.gate = gate
        self.view = view
        self.bundle_id = bundle_id
        self.retry = retry or RetryPolicy()
        self.max_rounds = max_rounds
        self.check_interval = check_interval
        self.rounds_failed = 0
        self.pid: int | None = None
        self.state = "starting"
        self.detail = ""
        self._next_check: datetime | None = None
        self._stop = threading.Event()

    # ---- 公共 ----
    @property
    def held(self) -> bool:
        return self.gate.is_open

    @property
    def gave_up(self) -> bool:
        return self.rounds_failed >= self.max_rounds

    def reset_budget(self) -> None:
        self.rounds_failed = 0
        self._next_check = None
        if self.state == "failed":
            self.state = "starting"
            self.detail = ""

    def stop(self) -> None:
        self._stop.set()

    def seconds_until_check(self, now: datetime) -> float:
        if self._next_check is None:
            return 0.0
        return max(0.0, (self._next_check - now).total_seconds())

    def snapshot(self) -> dict[str, Any]:
        return {"window_held": self.held, "boss_pid": self.pid, "session_state": self.state, "session_detail": self.detail}

    def _retry(self, step: str, fn: Callable[[], Any]) -> Any:
        try:
            return run_with_retry(
                step, fn, policy=self.retry, sleep=self.view.sleep, report=self.view.report, should_stop=self._stop.is_set
            )
        except BootstrapFailed as exc:
            self.rounds_failed += 1
            self.state = "failed"
            self.detail = str(exc)[:300]
            if self.gave_up:
                self.view.report(f"bootstrap_{step}", f"{exc}；{self.max_rounds} 轮均失败，等待人工点『重试』"[:500])
            raise

    def _due(self, now: datetime) -> bool:
        return self._next_check is None or now >= self._next_check

    def _schedule(self, now: datetime) -> None:
        self._next_check = now + timedelta(seconds=self.check_interval)

    def _bind(self, pid: int) -> None:
        self.driver.bind_window(WindowSelector(pid=pid))


class RemoteSession(_BaseSession):
    mode = "remote"

    def __init__(self, *, caffeinate: Caffeinate, **kw: Any) -> None:
        super().__init__(**kw)
        self.caffeinate = caffeinate

    def _start_once(self) -> None:
        try:
            self.ops.ensure_screen()
        except Exception as exc:
            raise StepFailed(f"建屏: {exc}") from exc
        try:
            pid = self.ops.launch(self.bundle_id)
            self.ops.move(pid, fill=True)  # 确保窗口在屏上（launch 已放上来时幂等）
        except AppAlreadyRunning:
            pids = self.ops.find_pids(self.bundle_id)
            if not pids:
                raise StepFailed("BOSS 报告已在运行，但找不到它的进程") from None
            pid = pids[0]
            try:
                self.ops.move(pid, fill=True)
            except Exception as exc:
                raise StepFailed(f"移动 BOSS 窗口: {exc}") from exc
        except Exception as exc:
            raise StepFailed(f"启动 BOSS: {exc}") from exc
        self.gate.open()
        try:
            self._bind(pid)
        except Exception as exc:
            raise StepFailed(f"绑定窗口: {exc}") from exc
        self.pid = pid

    def start(self) -> bool:
        """引导一次（有上限重试）。返回是否成功；失败已上报。"""
        if self.gave_up:
            return False
        if not self.caffeinate.ensure():
            self.view.report("caffeinate_failed", "防休眠进程无法启动")
        self.state = "starting"
        with self.view.gui_lock.hold("action"):
            try:
                self._retry("remote", self._start_once)
            except BootstrapFailed:
                return False
        self.state = "ok"
        self.detail = f"BOSS pid {self.pid}"
        self._schedule(self.view.now())
        return True

    def tick(self, now: datetime) -> None:
        if not self._due(now) or self.gave_up:
            return
        self._schedule(now)
        if not self.caffeinate.ensure():
            self.view.report("caffeinate_failed", "防休眠进程已退出且重启次数用尽")
        healthy = False
        if self.state == "ok":
            with self.view.gui_lock.hold("action", timeout=0) as ok:
                if not ok:
                    return  # 有人在用界面，说明还活着；下个周期再查
                healthy = self.gate.screen_ok()
        if not healthy:
            self.start()

    def shutdown(self) -> None:
        self.stop()
        self.caffeinate.stop()


class LocalSession(_BaseSession):
    mode = "local"

    def __init__(self, **kw: Any) -> None:
        super().__init__(**kw)
        self.state = "idle"
        self.user_hold = threading.Event()

    def wants_window(self, now: datetime) -> bool:
        if self.user_hold.is_set():
            return False
        paused, reason = self.view.pause_state()
        if paused and reason in LOCAL_RELEASE_PAUSE_REASONS:
            return False
        policy = self.view.policy()
        return policy is not None and in_work_hours(policy.work_hours, now)

    def start(self) -> bool:
        self.view.suspend_gui("尚未接管")  # local 启动时不碰窗口，由 tick 按时段决定
        return True

    def tick(self, now: datetime) -> None:
        """每轮都重新判断（不调用 CLI，很便宜），状态变化时立即接管或归还；
        只有失败后的下一轮重试才按 check_interval 节流。"""
        want = self.wants_window(now)
        if want and not self.held and not self.gave_up and self._due(now):
            self._take_over()
            if not self.held:
                self._schedule(now)
        elif not want and (self.held or (self.state == "release_failed" and self._due(now))):
            self._give_back("时段外" if not self.user_hold.is_set() else "用户暂停")
            if self.state == "release_failed":
                self._schedule(now)

    def seconds_until_check(self, now: datetime) -> float:
        # 时段边界没有事件通知，至少每 check_interval 秒醒来重新判断一次
        if self._next_check is None:
            return self.check_interval
        return min(self.check_interval, max(0.0, (self._next_check - now).total_seconds()))

    def _take_over_once(self) -> None:
        self.ops.ensure_screen()
        pids = self.ops.find_pids(self.bundle_id)
        if not pids:
            raise StepFailed("BOSS 未运行（local 模式不替用户启动），请先打开 BOSS 并登录")
        pid = pids[0]
        self.ops.move(pid, fit=True)
        self.pid = pid
        self.gate.open()
        try:
            self._bind(pid)
        except Exception:
            self.gate.close()
            raise

    def _take_over(self) -> None:
        with self.view.gui_lock.hold("action"):
            if self.user_hold.is_set():
                return
            try:
                self._retry("takeover", self._take_over_once)
            except BootstrapFailed:
                self._release_quietly()
                return
            self.view.resume_gui()
        self.state = "held"
        self.detail = "工作时段内，BOSS 窗口在专用屏幕上"

    def _release_quietly(self) -> None:
        """接管失败后的兜底：窗口可能已被移过去，尽力还回去。"""
        self.view.suspend_gui("接管失败")
        self.gate.close()
        if self.pid is not None:
            try:
                self.ops.release(self.pid)
            except Exception as exc:
                self.view.report("bootstrap_release", f"接管失败后归还窗口也失败：{exc}"[:500])

    def _give_back(self, why: str) -> None:
        with self.view.gui_lock.hold("action"):
            self._give_back_locked(why)

    def _give_back_locked(self, why: str) -> None:
        self.view.suspend_gui(why)
        self.gate.close()  # 先关闸：此后运行时的任何界面调用都不会碰到窗口
        if self.pid is None:
            self.state = "released"
            return
        pid = self.pid
        try:
            self._retry("release", lambda: self.ops.release(pid))
        except BootstrapFailed:
            self.state = "release_failed"
            self.detail = "归还窗口失败：可在 2ndscreen 菜单里取回，或退出 Monitor（退出时专用屏自动销毁，窗口回到主屏）"
            return
        self.state = "released"
        self.detail = f"已归还（{why}）"

    def release_now(self) -> None:
        """用户点"暂停并归还窗口"：任何线程可调用。等当前动作结束（GUI 锁）后立刻归还。"""
        self.user_hold.set()
        self._next_check = None
        self._give_back("用户暂停")

    def resume_hold(self) -> None:
        """用户恢复：允许在时段内重新接管。"""
        self.user_hold.clear()
        self.reset_budget()

    def shutdown(self) -> None:
        self.stop()
        self.user_hold.set()
        try:
            with self.view.gui_lock.hold("action", timeout=30) as ok:
                if ok and (self.held or self.state == "release_failed"):
                    self.gate.close()
                    if self.pid is not None:
                        self.ops.release(self.pid)
        except Exception as exc:
            self.view.report("bootstrap_release", f"退出时归还窗口失败：{exc}"[:500])
        try:
            self.ops.destroy_screen()
        except Exception:
            pass  # --owner-pid 兜底：进程退出后 2ndscreen 自动销毁
