"""任务 J：状态窗口的视图模型（纯函数）与窗口装配（fake Tk，测试中不弹出真实窗口）。"""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime

import pytest

from monitor.statusbar import StatusSnapshot, build_view
from monitor.statusbar.window import StatusWindow


def snap(**kw) -> StatusSnapshot:
    base = dict(
        device_id="dev_1", mode="local", account_id="acct_1", client_state="running", paused=False, pause_reason=None,
        needs_baseline=False, online=True, revoked=False, current_action=None, current_command_id=None,
        current_started_at=None, queued=0, undelivered=0, outbox=0, last_error_code=None, last_error_message=None,
        last_error_at=None, monitor_version="0.1.0", session={"session_state": "held"}, console_url="https://c.test/",
    )
    base.update(kw)
    return StatusSnapshot(**base)


def rows(view) -> dict[str, str]:
    return dict(view.rows)


def keys(view) -> list[tuple[str, str, bool]]:
    return [(b.key, b.label, b.enabled) for b in view.buttons]


def test_local_running_view():
    v = build_view(snap(queued=2, undelivered=1, outbox=3, current_action="send_greeting",
                        current_started_at=datetime(2026, 10, 4, 1, 2, 3, tzinfo=UTC)))
    r = rows(v)
    assert r["模式"] == "本机模式" and r["账户"] == "acct_1" and r["连接"] == "在线"
    assert r["状态"] == "自动运行"
    assert r["BOSS 客户端"] == "运行中 · 已接管窗口"
    assert r["当前动作"].startswith("问候（")
    assert r["待执行 / 待回传"] == "2 条指令 / 1 个结果、3 个事件"
    assert r["最近异常"] == "无"
    assert keys(v) == [("pause", "暂停并归还窗口", True), ("console", "打开控制台", True)]
    assert v.alert is None and v.title == "招聘 Monitor · 本机模式"


def test_remote_pause_button_label_and_paused_resume():
    v = build_view(snap(mode="remote", session={"session_state": "ok"}))
    assert keys(v)[0] == ("pause", "暂停自动操作", True)
    v = build_view(snap(mode="remote", paused=True, pause_reason="user_request"))
    assert rows(v)["状态"] == "已暂停：用户暂停"
    assert keys(v)[0] == ("resume", "恢复自动操作", True)


def test_login_required_differs_by_mode():
    local = build_view(snap(paused=True, pause_reason="login_required", client_state="login_required"))
    assert keys(local)[0][1] == "我已登录，继续"
    assert "在 BOSS 窗口里登录" in local.alert
    remote = build_view(snap(mode="remote", paused=True, pause_reason="login_required"))
    assert keys(remote)[0][1] == "恢复自动操作"
    assert "扫码" in remote.alert


def test_errors_and_failures():
    at = datetime(2026, 10, 4, 1, 0, tzinfo=UTC)
    v = build_view(snap(last_error_code="bootstrap_takeover", last_error_message="BOSS 未运行" * 40, last_error_at=at,
                        session={"session_state": "failed", "session_detail": "takeover 连续失败 3 次"}))
    assert "bootstrap_takeover" in rows(v)["最近异常"] and len(rows(v)["最近异常"]) < 200
    assert ("retry", "重试", True) in keys(v)
    assert v.alert.startswith("引导失败：takeover")
    v = build_view(snap(session={"session_state": "release_failed", "session_detail": "归还窗口失败：可在菜单取回"}))
    assert v.alert == "归还窗口失败：可在菜单取回"


@pytest.mark.parametrize(
    ("kw", "row", "text"),
    [
        ({"revoked": True}, "连接", "令牌已吊销"),
        ({"online": None}, "连接", "连接中"),
        ({"online": False}, "连接", "离线（自动重试）"),
        ({"needs_baseline": True}, "状态", "建立观察基线中"),
        ({"account_id": None}, "账户", "未绑定（请在控制台确认绑定）"),
        ({"client_state": "blocked_by_dialog", "session": {}}, "BOSS 客户端", "被弹窗挡住"),
    ],
)
def test_row_variants(kw, row, text):
    assert rows(build_view(snap(**kw)))[row] == text


def test_alert_priority_and_disabled_buttons():
    assert "吊销" in build_view(snap(revoked=True, account_id=None)).alert
    assert "绑定" in build_view(snap(account_id=None)).alert
    v = build_view(snap(console_url=None, stopping=True))
    assert keys(v) == [("pause", "暂停并归还窗口", False), ("console", "打开控制台", False)]


# ---------------------------------------------------------------------------
# 窗口：fake Tk（记录控件），验证能启动、渲染、按钮回调、退出
# ---------------------------------------------------------------------------


class FakeWidget:
    registry: list[FakeWidget] = []

    def __init__(self, master=None, **kw):
        self.master = master
        self.kw = dict(kw)
        self.children: list[FakeWidget] = []
        self.destroyed = False
        if isinstance(master, FakeWidget):
            master.children.append(self)
        FakeWidget.registry.append(self)

    def grid(self, **kw):
        self.kw["grid"] = kw

    def pack(self, **kw):
        self.kw["pack"] = kw

    def configure(self, **kw):
        self.kw.update(kw)

    def winfo_children(self):
        return [c for c in self.children if not c.destroyed]

    def destroy(self):
        self.destroyed = True


class FakeTkRoot(FakeWidget):
    def __init__(self):
        super().__init__()
        self.afters = []
        self.quit_called = False
        self.loops = 0

    def title(self, text=None):
        self.kw["title"] = text

    def protocol(self, name, fn):
        self.kw[name] = fn

    def resizable(self, *a):
        pass

    def iconify(self):
        self.kw["iconified"] = True

    def after(self, ms, fn):
        self.afters.append(fn)

    def quit(self):
        self.quit_called = True

    def mainloop(self):
        self.loops += 1


class FakeTk:
    Label = FakeWidget
    Frame = FakeWidget
    Button = FakeWidget

    def __init__(self):
        self.root = None

    def Tk(self):  # noqa: N802 - 与 tkinter 同名
        self.root = FakeTkRoot()
        return self.root


class Ctl:
    def __init__(self, s: StatusSnapshot):
        self.s = s
        self.clicks: list[str] = []
        self.stopping = False

    def snapshot(self):
        return self.s

    def on_button(self, key):
        self.clicks.append(key)


def texts(widgets, cls_filter=None):
    return [w.kw.get("text") for w in widgets if not w.destroyed and "text" in w.kw]


def test_window_starts_renders_and_routes_buttons():
    tk = FakeTk()
    ctl = Ctl(snap())
    w = StatusWindow(ctl, tk_module=tk)
    w.run()
    root = tk.root
    assert root.loops == 1 and root.kw["title"] == "招聘 Monitor · 本机模式"
    shown = texts(FakeWidget.registry)
    assert "暂停并归还窗口" in shown and "本机模式" in shown and "acct_1" in shown
    btn = next(b for b in w._buttons_frame.winfo_children() if b.kw["text"] == "暂停并归还窗口")
    btn.kw["command"]()
    assert ctl.clicks == ["pause"]
    # 关窗只最小化
    root.kw["WM_DELETE_WINDOW"]()
    assert root.kw["iconified"]
    # 状态变化后按钮更新
    ctl.s = replace(ctl.s, paused=True, pause_reason="user_request")
    root.afters.pop(0)()
    labels = [b.kw["text"] for b in w._buttons_frame.winfo_children()]
    assert labels == ["恢复自动操作", "打开控制台"]
    # 进程停止时退出主循环
    ctl.stopping = True
    root.afters.pop(0)()
    assert root.quit_called
