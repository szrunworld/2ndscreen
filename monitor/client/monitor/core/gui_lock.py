"""GUI 执行权：观察与动作共用一把锁，动作优先（方案第五节）。

- 动作（ACTION）申请时排队等待，持有者释放后优先拿到。
- 观察（OBSERVE）只在锁空闲且没有动作在排队时才能拿到；通常用 timeout=0 试一次，
  拿不到就跳过本轮观察。
- 不可重入：同一线程重复申请直接报错，避免死锁。

observe、actions、login 等模块只能通过 core 提供的这把锁获得执行权。
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Literal

GuiUse = Literal["action", "observe"]
ACTION: GuiUse = "action"
OBSERVE: GuiUse = "observe"


class GuiLock:
    def __init__(self) -> None:
        self._cond = threading.Condition()
        self._holder: GuiUse | None = None
        self._owner: int | None = None
        self._actions_waiting = 0

    @property
    def holder(self) -> GuiUse | None:
        return self._holder

    @property
    def actions_waiting(self) -> int:
        return self._actions_waiting

    def acquire(self, use: GuiUse, timeout: float | None = None) -> bool:
        """申请执行权。timeout=None 一直等；0 表示只试一次。返回是否拿到。"""
        if use not in (ACTION, OBSERVE):
            raise ValueError(f"未知的 GUI 用途: {use!r}")
        me = threading.get_ident()
        with self._cond:
            if self._owner == me:
                raise RuntimeError("GuiLock 不可重入：当前线程已持有执行权")
            if use == ACTION:
                self._actions_waiting += 1
                try:
                    ok = self._cond.wait_for(lambda: self._holder is None, timeout)
                finally:
                    self._actions_waiting -= 1
            else:
                ok = self._cond.wait_for(
                    lambda: self._holder is None and self._actions_waiting == 0, timeout
                )
            if ok:
                self._holder = use
                self._owner = me
            return ok

    def release(self) -> None:
        with self._cond:
            if self._holder is None:
                raise RuntimeError("GuiLock 未被持有")
            if self._owner != threading.get_ident():
                raise RuntimeError("只能由持有执行权的线程释放")
            self._holder = None
            self._owner = None
            self._cond.notify_all()

    @contextmanager
    def hold(self, use: GuiUse, timeout: float | None = None) -> Iterator[bool]:
        """with lock.hold(OBSERVE, timeout=0) as ok: ... ；ok 为 False 时没有拿到，不要操作界面。"""
        ok = self.acquire(use, timeout)
        try:
            yield ok
        finally:
            if ok:
                self.release()
