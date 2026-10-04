"""Monitor 进程装配（launchd 与手动启动的入口）：`python -m monitor.bootstrap [--no-ui]`。

线程划分：
- 运行时线程：唯一调用 MonitorRuntime 与 Session 的线程。循环做：处理界面请求 → session.tick（窗口归属）
  → runtime.run_once() → 发布只读快照 → 按建议时间等待（可被 wake() 提前唤醒）。
- 取消线程（CancellationWatcher）：运行时单线程，动作执行期间不发心跳，服务端下发的取消收不到（D2b 报告）。
  这个线程只在有动作执行时，用独立的 CommandClient 发心跳（内容取自最近发布的快照），收到当前指令的取消就调用
  线程安全的 pipeline.cancel；其他指令的取消交回运行时线程处理（它们会改账本）。
- 主线程：Tk 状态窗口（有界面时）。按钮只把请求放进队列并唤醒运行时线程；local 的"暂停并归还窗口"另起一个
  短线程，等当前动作结束（GUI 锁）后立刻归还窗口，不必等长轮询返回。

设备令牌从安装时选择的存放处读取（keychain 或 0600 文件），不出现在命令行参数里。
"""

from __future__ import annotations

import argparse
import os
import queue
import signal
import sys
import threading
import webbrowser
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from monitor_contracts import OUTWARD_ACTIONS, validate_device_heartbeat

from monitor.core import (
    CommandClient,
    MonitorRuntime,
    RuntimeConfig,
    ServerError,
    SystemClock,
    Unauthorized,
)
from monitor.statusbar.viewmodel import StatusSnapshot

from .caffeinate import Caffeinate
from .retry import RetryPolicy
from .screen import ScreenOps
from .session import GateDriver, LocalSession, RemoteSession, RuntimeView

DEFAULT_CANCEL_POLL_SECONDS = 10.0


class MonitorApp:
    def __init__(
        self,
        *,
        runtime: MonitorRuntime,
        session: LocalSession | RemoteSession,
        console_url: str | None = None,
        opener: Callable[[str], Any] = webbrowser.open,
        spawn: Callable[[Callable[[], None]], Any] | None = None,
    ) -> None:
        self.runtime = runtime
        self.session = session
        self.console_url = console_url
        self.opener = opener
        self._spawn = spawn or (lambda fn: threading.Thread(target=fn, name="release-window", daemon=True).start())
        self._requests: queue.SimpleQueue[tuple[str, Any]] = queue.SimpleQueue()
        self._lock = threading.Lock()
        self._snapshot: StatusSnapshot | None = None
        self._published = threading.Event()
        self._stop = threading.Event()

    # ------------------------------------------------------------------
    # 任何线程可调用
    # ------------------------------------------------------------------
    @property
    def stopping(self) -> bool:
        return self._stop.is_set()

    def snapshot(self) -> StatusSnapshot:
        with self._lock:
            snap = self._snapshot
        if snap is None:
            raise RuntimeError("运行时尚未发布快照")
        return snap

    def on_button(self, key: str) -> None:
        if key == "console":
            if self.console_url:
                self.opener(self.console_url)
            return
        if key not in ("pause", "resume", "retry"):
            raise ValueError(f"未知按钮 {key!r}")
        if key == "pause" and isinstance(self.session, LocalSession):
            # 立刻关闸并归还窗口（等当前动作结束），不等运行时线程从长轮询里出来
            self.session.user_hold.set()
            self._spawn(self.session.release_now)
        self._requests.put((key, None))
        self._wake()

    def defer_cancel(self, command_id: UUID) -> None:
        self._requests.put(("cancel", command_id))
        self._wake()

    def stop(self) -> None:
        self._stop.set()
        self.session.stop()
        self._wake()

    def _wake(self) -> None:
        wake = getattr(self.runtime.clock, "wake", None)
        if callable(wake):
            wake()

    # ------------------------------------------------------------------
    # 运行时线程
    # ------------------------------------------------------------------
    def _drain(self) -> None:
        while True:
            try:
                key, arg = self._requests.get_nowait()
            except queue.Empty:
                return
            if key == "pause":
                self.runtime.pause("user_request", by="user", detail="状态窗口")
            elif key == "resume":
                if isinstance(self.session, LocalSession):
                    self.session.resume_hold()
                else:
                    self.session.reset_budget()
                self.runtime.resume(by="user")
            elif key == "retry":
                self.session.reset_budget()
            elif key == "cancel":
                self.runtime.pipeline.cancel(arg)

    def publish(self) -> StatusSnapshot:
        st = self.runtime.status()
        err = st["last_error"]
        snap = StatusSnapshot(
            device_id=st["device_id"],
            mode=st["mode"],
            account_id=st["account_id"],
            client_state=st["client_state"],
            paused=st["paused"],
            pause_reason=st["pause_reason"],
            needs_baseline=st["needs_baseline"],
            online=st["online"],
            revoked=st["revoked"],
            current_action=st["current_action"],
            current_command_id=st["current_command_id"],
            current_started_at=st["current_started_at"],
            queued=st["queued"],
            undelivered=st["undelivered"],
            outbox=st["outbox_events"],
            last_error_code=err["code"] if err else None,
            last_error_message=err["message"] if err else None,
            last_error_at=err["at"] if err else None,
            monitor_version=st["monitor_version"],
            session=self.session.snapshot(),
            console_url=self.console_url,
            stopping=self.stopping,
        )
        with self._lock:
            self._snapshot = snap
        self._published.set()
        return snap

    def wait_published(self, timeout: float | None = None) -> bool:
        """等第一张快照发布（状态等待，不是固定 sleep）。"""
        return self._published.wait(timeout)

    def start(self) -> None:
        self.runtime.start()
        self.publish()
        self.session.start()
        self.publish()

    def step(self) -> float:
        """一轮。返回建议等待秒数。"""
        self._drain()
        self.session.tick(self.runtime.clock.now())
        self.publish()
        if self._stop.is_set():
            return 0.0
        idle = self.runtime.run_once()
        self._drain()
        self.publish()
        return min(idle, self.session.seconds_until_check(self.runtime.clock.now()))

    def run(self) -> None:
        try:
            self.start()
            while not self._stop.is_set():
                idle = self.step()
                if idle > 0 and not self._stop.is_set():
                    self.runtime.clock.sleep(idle)
        finally:
            try:
                self.session.shutdown()
            finally:
                self.runtime.client.close()
                self._stop.set()
                try:
                    self.publish()
                finally:
                    self._published.set()  # 启动即失败时也放行等待者


@dataclass
class CancellationWatcher:
    """动作执行期间的旁路心跳，只为及时收到取消（见模块说明）。"""

    app: MonitorApp
    client: CommandClient
    now: Callable[[], datetime]
    interval: float = DEFAULT_CANCEL_POLL_SECONDS
    failures: int = 0

    def __post_init__(self) -> None:
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def heartbeat_body(self, snap: StatusSnapshot, current: tuple[Any, datetime]) -> Any:
        cmd, started = current
        body = {
            "device_id": snap.device_id,
            "sent_at": self.now().isoformat(),
            "mode": snap.mode,
            "account_id": snap.account_id,
            "client_state": snap.client_state,
            "paused": snap.paused,
            "pause_reason": snap.pause_reason,
            "needs_baseline": snap.needs_baseline,
            "current_action": {"command_id": str(cmd.command_id), "action": cmd.action, "started_at": started.isoformat()},
            "queue": {
                "queued_commands": snap.queued,
                "undelivered_results": snap.undelivered,
                "outbox_events": snap.outbox,
            },
            "last_error": None,
            "monitor_version": snap.monitor_version,
        }
        return validate_device_heartbeat(body)

    def poll_once(self) -> bool:
        """有动作在执行时发一次心跳并分发取消。返回是否发了心跳。"""
        current = self.app.runtime.pipeline.current
        if current is None:
            return False
        try:
            snap = self.app.snapshot()
        except RuntimeError:
            return False
        try:
            ack = self.client.heartbeat(self.heartbeat_body(snap, current))
        except Unauthorized:
            self.failures += 1
            self._stop.set()  # 令牌失效：运行时线程会处理，旁路不再发
            return False
        except (ServerError, ValueError):
            self.failures += 1
            return False
        running_id = current[0].command_id
        for cid in ack.cancellations:
            if cid == running_id:
                self.app.runtime.pipeline.cancel(cid)  # D2b：对执行中的指令线程安全
            else:
                self.app.defer_cancel(cid)
        return True

    def _loop(self) -> None:
        # 周期轮询（interval 秒）而非等待某个状态，因此用 Event.wait 计时；stop() 能立即打断。
        while not self._stop.wait(self.interval):
            if self.app.stopping:
                return
            self.poll_once()

    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, name="cancel-watcher", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self.client.close()


# ----------------------------------------------------------------------
# 装配
# ----------------------------------------------------------------------
class AppSetupError(Exception):
    pass


def build_parser() -> argparse.ArgumentParser:
    from monitor.__main__ import DEFAULT_HANDLERS, DEFAULT_LEDGER, DEFAULT_OBSERVER

    p = argparse.ArgumentParser(prog="monitor.bootstrap", description="招聘 Monitor 常驻进程（按安装配置启动）")
    p.add_argument("--no-ui", action="store_true", help="不显示状态窗口")
    p.add_argument("--ledger", default=DEFAULT_LEDGER, metavar="MODULE:FACTORY")
    p.add_argument("--observer", default=DEFAULT_OBSERVER, metavar="MODULE:FACTORY|none")
    p.add_argument("--handlers", default=DEFAULT_HANDLERS, metavar="MODULE:FACTORY|none")
    p.add_argument("--screen-size", help="专用屏幕尺寸 WxH（默认与主屏一致）")
    p.add_argument("--heartbeat-interval", type=float, default=30.0)
    p.add_argument("--observe-interval", type=float, default=45.0)
    p.add_argument("--allow-insecure-http", action="store_true", help=argparse.SUPPRESS)
    return p


def build_app(
    args: argparse.Namespace,
    *,
    paths: Any = None,
    keychain: Any = None,
    transport: Any = None,
    driver_factory: Callable[[str, str], Any] | None = None,
    cli_runner: Any = None,
    caffeinate: Caffeinate | None = None,
    clock: Any = None,
    pid_resolver: Callable[..., list[int]] | None = None,
) -> tuple[MonitorApp, CancellationWatcher]:
    """按安装配置装配运行时、Session 与取消线程（不启动）。参数注入仅供测试。"""
    from monitor.__main__ import SetupError, load_factory
    from monitor.driver import _cli
    from monitor.driver.cli_driver import DEFAULT_BINARY, CliDriver
    from monitor.install.paths import MonitorPaths, load_config
    from monitor.install.secrets import FileStore, KeychainStore, TokenStoreError, store_for

    paths = paths or MonitorPaths.from_env()
    try:
        config = load_config(paths)
    except ValueError as exc:
        raise AppSetupError(str(exc)) from None
    if config is None:
        raise AppSetupError("本机尚未安装：先运行 python -m monitor.install install")
    if not config.server_url.startswith("https://") and not args.allow_insecure_http:
        raise AppSetupError("服务端只接受 HTTPS 地址")
    store = store_for(config.token_store, keychain=keychain or KeychainStore(), file_store=FileStore(paths.token_file))
    try:
        token = store.load(config.device_id)
    except TokenStoreError as exc:
        raise AppSetupError(f"读取设备令牌失败：{exc}") from None

    clock = clock or SystemClock()
    try:
        ledger = load_factory(args.ledger)(paths.ledger)
        observer = None if args.observer == "none" else load_factory(args.observer)()
        handlers = {} if args.handlers == "none" else {h.action: h for h in load_factory(args.handlers)()}
    except SetupError as exc:
        raise AppSetupError(str(exc)) from None
    mode = ledger.load_state().mode or config.mode
    binary = config.cli_binary or DEFAULT_BINARY
    raw_driver = (driver_factory or (lambda screen, b: CliDriver(screen, binary=b)))(config.screen, binary)
    gate = GateDriver(raw_driver, open=False)
    client = CommandClient(
        base_url=config.server_url, device_id=config.device_id, token=token, transport=transport, now=clock.now
    )
    runtime = MonitorRuntime(
        config=RuntimeConfig(
            device_id=config.device_id,
            mode=mode,
            heartbeat_interval=args.heartbeat_interval,
            observe_interval=args.observe_interval,
            local_allowed_actions=frozenset(OUTWARD_ACTIONS),
        ),
        ledger=ledger,
        driver=gate,
        client=client,
        handlers=handlers,
        clock=clock,
        observer=observer,
    )
    view = RuntimeView(
        report=runtime.record_error,
        policy=lambda: runtime.policy,
        pause_state=lambda: (runtime.state.paused, runtime.state.pause_reason),
        gui_lock=runtime.gui_lock,
        now=clock.now,
        sleep=clock.sleep,
        suspend_gui=runtime.suspend_gui,
        resume_gui=runtime.resume_gui,
    )
    ops_kwargs: dict[str, Any] = {}
    if pid_resolver is not None:
        ops_kwargs["pid_resolver"] = pid_resolver
    ops = ScreenOps(
        cli=cli_runner or _cli.CliRunner(binary), screen=config.screen, owner_pid=os.getpid(),
        size=args.screen_size, **ops_kwargs,
    )
    common = dict(ops=ops, driver=raw_driver, gate=gate, view=view, bundle_id=config.boss_bundle_id, retry=RetryPolicy())
    session: LocalSession | RemoteSession
    if mode == "remote":
        session = RemoteSession(caffeinate=caffeinate or Caffeinate(), **common)
    else:
        session = LocalSession(**common)
    app = MonitorApp(runtime=runtime, session=session, console_url=config.console_url)
    side_client = CommandClient(
        base_url=config.server_url, device_id=config.device_id, token=token, transport=transport, now=clock.now
    )
    watcher = CancellationWatcher(app=app, client=side_client, now=clock.now)
    return app, watcher


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        app, watcher = build_app(args)
    except AppSetupError as exc:
        print(f"monitor: {exc}", file=sys.stderr)
        return 2
    signal.signal(signal.SIGTERM, lambda *_: app.stop())
    signal.signal(signal.SIGINT, lambda *_: app.stop())
    watcher.start()
    try:
        if args.no_ui:
            app.run()
        else:
            worker = threading.Thread(target=app.run, name="monitor-runtime")
            worker.start()
            ui_ok = True
            try:
                from monitor.statusbar.window import StatusWindow

                # 等第一张快照发布后再建窗（start() 里 runtime.start() 之后立即发布）
                if app.wait_published(timeout=60) and worker.is_alive():
                    StatusWindow(app).run()
            except Exception as exc:  # 没有图形会话等：退回无界面运行
                ui_ok = False
                print(f"monitor: 状态窗口无法启动（{type(exc).__name__}: {exc}），继续无界面运行", file=sys.stderr)
            if ui_ok:
                app.stop()  # 窗口退出即进程退出
            worker.join()
    finally:
        watcher.stop()
    return 0
