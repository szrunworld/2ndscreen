"""本机状态窗口（Tk）。

选 Tk 而不是 rumps：Tk 随 Python 自带（uv 的 CPython 也带），不新增依赖；rumps 需要 pyobjc。
Tk 窗口在 launchd 的 Aqua 会话（LimitLoadToSessionType=Aqua）里可以正常显示。

窗口只读快照（每秒刷新）并把按钮事件交给 controller；不直接调用运行时。
关窗按钮只最小化，避免用户误关后找不到"暂停并归还窗口"。
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Protocol

from .viewmodel import StatusSnapshot, StatusView, build_view

REFRESH_MS = 1000


class Controller(Protocol):
    def snapshot(self) -> StatusSnapshot: ...

    def on_button(self, key: str) -> None: ...

    @property
    def stopping(self) -> bool: ...


class StatusWindow:
    def __init__(self, controller: Controller, *, tk_module: Any = None) -> None:
        if tk_module is None:
            import tkinter as tk_module  # 延迟导入：无界面模式与测试不需要 Tk
        self.tk = tk_module
        self.controller = controller
        self.root = tk_module.Tk()
        self.root.title("招聘 Monitor")
        self.root.protocol("WM_DELETE_WINDOW", self.root.iconify)
        self.root.resizable(False, False)
        self._alert = tk_module.Label(self.root, text="", fg="#b00020", wraplength=420, justify="left")
        self._alert.grid(row=0, column=0, columnspan=2, sticky="w", padx=12, pady=(10, 4))
        self._labels: dict[str, Any] = {}
        self._buttons_frame = tk_module.Frame(self.root)
        self._button_keys: tuple[tuple[str, str, bool], ...] = ()
        self._row_base = 1

    def _render(self, view: StatusView) -> None:
        self.root.title(view.title)
        self._alert.configure(text=view.alert or "")
        for i, (name, value) in enumerate(view.rows):
            if name not in self._labels:
                self.tk.Label(self.root, text=name, anchor="w", width=14).grid(
                    row=self._row_base + i, column=0, sticky="w", padx=(12, 4), pady=1
                )
                lbl = self.tk.Label(self.root, text="", anchor="w", justify="left", wraplength=320)
                lbl.grid(row=self._row_base + i, column=1, sticky="w", padx=(0, 12), pady=1)
                self._labels[name] = lbl
            self._labels[name].configure(text=value)
        keys = tuple((b.key, b.label, b.enabled) for b in view.buttons)
        if keys != self._button_keys:
            for child in self._buttons_frame.winfo_children():
                child.destroy()
            for key, label, enabled in keys:
                btn = self.tk.Button(self._buttons_frame, text=label, command=self._clicker(key))
                if not enabled:
                    btn.configure(state="disabled")
                btn.pack(side="left", padx=4)
            self._buttons_frame.grid(row=self._row_base + len(view.rows), column=0, columnspan=2, pady=(8, 12))
            self._button_keys = keys

    def _clicker(self, key: str) -> Callable[[], None]:
        return lambda: self.controller.on_button(key)

    def refresh(self) -> None:
        if self.controller.stopping:
            self.root.quit()
            return
        try:
            self._render(build_view(self.controller.snapshot()))
        finally:
            self.root.after(REFRESH_MS, self.refresh)

    def run(self) -> None:
        self.refresh()
        self.root.mainloop()
        try:
            self.root.destroy()
        except Exception:
            pass
