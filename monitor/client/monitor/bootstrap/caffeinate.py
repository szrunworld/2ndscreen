"""防休眠：Monitor 持有一个 caffeinate 子进程，退出时结束它。

`caffeinate -d -i -s -w <Monitor pid>`：阻止显示器休眠、空闲休眠、接电时的系统休眠；
-w 让 caffeinate 在 Monitor 进程消失（含崩溃、kill -9）后自行退出，不会留下孤儿进程。
"""

from __future__ import annotations

import os
import subprocess
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

CAFFEINATE = "/usr/bin/caffeinate"
STOP_TIMEOUT_SECONDS = 5.0


@dataclass
class Caffeinate:
    binary: str = CAFFEINATE
    flags: Sequence[str] = ("-d", "-i", "-s")
    watch_pid: int = field(default_factory=os.getpid)
    popen: Callable[..., Any] = subprocess.Popen
    max_restarts: int = 5
    restarts: int = 0
    _proc: Any = None

    @property
    def argv(self) -> list[str]:
        return [self.binary, *self.flags, "-w", str(self.watch_pid)]

    def alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def start(self) -> None:
        if self.alive():
            return
        self._proc = self.popen(self.argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def ensure(self) -> bool:
        """子进程意外退出时重启，最多 max_restarts 次。返回当前是否在运行。"""
        if self.alive():
            return True
        if self._proc is not None:
            if self.restarts >= self.max_restarts:
                return False
            self.restarts += 1
        try:
            self.start()
        except OSError:
            return False
        return self.alive()

    def stop(self) -> None:
        proc, self._proc = self._proc, None
        if proc is None or proc.poll() is not None:
            return
        proc.terminate()
        try:
            proc.wait(timeout=STOP_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=STOP_TIMEOUT_SECONDS)
