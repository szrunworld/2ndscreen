"""状态窗口的视图模型：把运行时的只读快照变成要显示的文字与按钮。纯函数，不依赖任何 GUI 库。"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

MODE_TEXT = {"local": "本机模式", "remote": "独立设备模式"}
CLIENT_TEXT = {
    "running": "运行中",
    "not_running": "未运行 / 窗口不在专用屏",
    "login_required": "需要登录",
    "blocked_by_dialog": "被弹窗挡住",
    "suspended": "窗口已归还（挂起）",
    "unknown": "未知",
}
PAUSE_TEXT = {
    "user_request": "用户暂停",
    "login_required": "登录失效",
    "account_switched": "账户变更，等待重新绑定",
    "anomaly": "异常暂停",
    "server_request": "控制台暂停",
    "rebaseline": "重建基线",
}
ACTION_TEXT = {
    "send_greeting": "问候",
    "request_resume": "求简历",
    "request_contact_exchange": "换联系方式",
    "search_candidates": "搜索",
    "forward_resume": "转发简历",
    "provide_input": "代填输入",
}
SESSION_TEXT = {
    "starting": "启动中",
    "ok": "已就绪",
    "idle": "待命（未接管窗口）",
    "held": "已接管窗口",
    "released": "窗口已归还",
    "release_failed": "归还窗口失败",
    "failed": "引导失败",
}


@dataclass(frozen=True)
class StatusSnapshot:
    """运行时线程发布的只读快照（MonitorApp.snapshot()）。"""

    device_id: str
    mode: str
    account_id: str | None
    client_state: str
    paused: bool
    pause_reason: str | None
    needs_baseline: bool
    online: bool | None
    revoked: bool
    current_action: str | None
    current_command_id: str | None
    current_started_at: datetime | None
    queued: int
    undelivered: int
    outbox: int
    last_error_code: str | None
    last_error_message: str | None
    last_error_at: datetime | None
    monitor_version: str
    session: dict[str, Any] = field(default_factory=dict)
    console_url: str | None = None
    stopping: bool = False


@dataclass(frozen=True)
class Button:
    key: str  # pause | resume | console | retry
    label: str
    enabled: bool = True


@dataclass(frozen=True)
class StatusView:
    title: str
    rows: tuple[tuple[str, str], ...]
    buttons: tuple[Button, ...]
    alert: str | None  # 需要用户注意的一句话（登录失效、引导失败等）


def _fmt_time(t: datetime | None) -> str:
    return t.astimezone().strftime("%H:%M:%S") if t else ""


def build_view(s: StatusSnapshot) -> StatusView:
    mode = MODE_TEXT.get(s.mode, s.mode)
    if s.revoked:
        conn = "令牌已吊销"
    elif s.online is None:
        conn = "连接中"
    else:
        conn = "在线" if s.online else "离线（自动重试）"
    if s.paused:
        status = f"已暂停：{PAUSE_TEXT.get(s.pause_reason or '', s.pause_reason or '')}"
    elif s.needs_baseline:
        status = "建立观察基线中"
    else:
        status = "自动运行"
    action = "空闲"
    if s.current_action:
        action = ACTION_TEXT.get(s.current_action, s.current_action)
        if s.current_started_at:
            action += f"（{_fmt_time(s.current_started_at)} 开始）"
    sess = s.session or {}
    sess_state = SESSION_TEXT.get(str(sess.get("session_state")), str(sess.get("session_state") or ""))
    client = CLIENT_TEXT.get(s.client_state, s.client_state)
    if sess_state:
        client = f"{client} · {sess_state}"
    err = "无"
    if s.last_error_code:
        err = f"{_fmt_time(s.last_error_at)} {s.last_error_code}"
        if s.last_error_message:
            err += f"：{s.last_error_message[:120]}"
    rows = (
        ("模式", mode),
        ("账户", s.account_id or "未绑定（请在控制台确认绑定）"),
        ("连接", conn),
        ("状态", status),
        ("BOSS 客户端", client),
        ("当前动作", action),
        ("待执行 / 待回传", f"{s.queued} 条指令 / {s.undelivered} 个结果、{s.outbox} 个事件"),
        ("最近异常", err),
    )

    buttons: list[Button] = []
    if s.paused:
        label = "我已登录，继续" if s.pause_reason == "login_required" and s.mode == "local" else "恢复自动操作"
        buttons.append(Button("resume", label, enabled=not s.stopping))
    else:
        label = "暂停并归还窗口" if s.mode == "local" else "暂停自动操作"
        buttons.append(Button("pause", label, enabled=not s.stopping))
    if sess.get("session_state") in ("failed", "release_failed"):
        buttons.append(Button("retry", "重试", enabled=not s.stopping))
    buttons.append(Button("console", "打开控制台", enabled=bool(s.console_url)))

    alert = None
    if s.revoked:
        alert = "设备令牌已被吊销，请在控制台重新连接设备。"
    elif s.paused and s.pause_reason == "login_required":
        alert = (
            "BOSS 需要登录：请在 BOSS 窗口里登录，然后点『我已登录，继续』。"
            if s.mode == "local"
            else "BOSS 需要登录：请在控制台用绑定账号的手机扫码。"
        )
    elif sess.get("session_state") == "release_failed":
        alert = str(sess.get("session_detail") or "归还窗口失败")
    elif sess.get("session_state") == "failed":
        alert = f"引导失败：{sess.get('session_detail') or ''}".rstrip("：")
    elif s.account_id is None:
        alert = "尚未绑定招聘账户：请在控制台确认这台设备的绑定。"
    title = f"招聘 Monitor · {mode}"
    return StatusView(title=title, rows=rows, buttons=tuple(buttons), alert=alert)
