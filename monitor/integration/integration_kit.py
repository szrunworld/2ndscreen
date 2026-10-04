"""集成与混沌测试的装配工具（任务 M）。

把真实的服务端（FastAPI 应用 + SQLite 文件库，进程内 ASGI）与真实的 Monitor 客户端运行时
（MonitorRuntime + SQLite 账本 + 观察器 E + 动作处理器 H1–H3）接起来，界面由 FakeDriver 回放
任务 B 的夹具（以及在夹具上派生的"动作之后"的步骤，派生规则与 H1/H2 的测试一致）。

约定：
- 时间全部走同一个 ManualClock（服务端、运行时、观察器、动作处理器共用），不用 sleep。
- 客户端与服务端之间的 HTTP 经过 ``Cluster.transport``：可以注入"请求没到服务端就 500 / 断网"
  "服务端处理了但响应变成 500"，也可以把服务端整个换成新进程（同一个 SQLite 文件）模拟重启。
- 长轮询的等待时间设为 0（RuntimeConfig.claim_wait_seconds=0），服务端的长轮询用真实时间等待，
  集成测试里不需要它。
- 编排的后台定时推进只在 uvicorn 的 lifespan 里启动，这里不进入 lifespan，需要时直接调
  ``server.ctx.orchestrator.tick()``。

本模块不修改 client / server / contracts 的任何源码，只通过它们的公开入口装配。
"""

from __future__ import annotations

import copy
import json
import os
import uuid
from collections.abc import Callable, Iterable, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import warnings

with warnings.catch_warnings():
    warnings.filterwarnings("ignore", message="Using `httpx` with `starlette.testclient`")
    from fastapi.testclient import TestClient

from monitor_contracts import Frame, Locator

from app.db import SqliteStore
from app.main import StaticTokenAuthenticator, create_app
from monitor.actions import create_handlers
from monitor.core import CommandClient, ManualClock, MonitorRuntime, RuntimeConfig
from monitor.driver import Advance, FakeDriver
from monitor.install.register import build_registration, register_device
from monitor.ledger import open_ledger
from monitor.observe import create_observer

MONITOR_DIR = Path(__file__).resolve().parents[1]
FIXTURES = MONITOR_DIR / "fixtures" / "ax"

BASE_URL = "http://monitor.test/api/v1"
CONSOLE_TOKEN = "console-token-recruiter"
SERVICE_TOKEN = "service-token-mail"
CONSOLE_ACTOR = "recruiter@example.com"
ACCOUNT = "acct_boss_1"

# B 的夹具录制于 2026-10-04 19:10（上海）。T0 = 19:05（上海）：在『候选人L』19:11 到达之前建立基线。
T0 = datetime(2026, 10, 4, 11, 5, tzinfo=UTC)
WORK_HOURS_ALL_DAY = {
    "timezone": "Asia/Shanghai",
    "windows": [{"days": [1, 2, 3, 4, 5, 6, 7], "start": "08:00", "end": "23:30"}],
}
GREETING_TEMPLATE = "{candidate_name} 你好，方便发一份简历吗？"
JOB = "Vue 前端 研发工程师"
CANDIDATE = "候选人L"


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


def new_key() -> str:
    return "m-" + uuid.uuid4().hex


# ---------------------------------------------------------------------------
# 服务端（进程内 ASGI，SQLite 文件库）
# ---------------------------------------------------------------------------


class Server:
    """一个服务端"进程"：同一个 db 文件可以先后起多个实例（模拟重启）。"""

    def __init__(self, db_path: Path, clock: ManualClock):
        self.db_path = db_path
        self.clock = clock
        self.store = SqliteStore(db_path)
        self.app = create_app(
            store=self.store,
            clock=clock,
            console_auth=StaticTokenAuthenticator({CONSOLE_TOKEN: CONSOLE_ACTOR}),
            service_auth=StaticTokenAuthenticator({SERVICE_TOKEN: "mail-ingest"}),
        )
        self.ctx = self.app.state.ctx
        # 不进入 lifespan：编排的后台定时线程不启动（测试里显式 tick）
        self.http = TestClient(self.app, base_url="http://monitor.test")
        self.closed = False

    def close(self) -> None:
        if not self.closed:
            self.http.close()
            self.store.close()
            self.closed = True

    # -- 控制台 ---------------------------------------------------------------

    def call(self, method: str, path: str, body: Any = None, *, token: str | None = CONSOLE_TOKEN, **headers: str) -> httpx.Response:
        h = {} if token is None else {"Authorization": f"Bearer {token}"}
        if method in ("POST", "PUT"):
            h["Idempotency-Key"] = new_key()
        h.update(headers)
        kwargs: dict[str, Any] = {"headers": h}
        if body is not None:
            kwargs["json"] = body
        return self.http.request(method, "/api/v1" + path, **kwargs)

    def ok(self, method: str, path: str, body: Any = None, *, status: int | tuple[int, ...] = (200, 201), **kw: Any) -> Any:
        resp = self.call(method, path, body, **kw)
        allowed = (status,) if isinstance(status, int) else status
        assert resp.status_code in allowed, f"{method} {path} → {resp.status_code}: {resp.text}"
        return resp.json()

    def enroll(self, mode: str = "local") -> str:
        return self.ok("POST", "/device-enrollments", {"mode": mode}, status=201)["enrollment_code"]

    def bind(self, device_id: str, account_id: str = ACCOUNT) -> Any:
        return self.ok("PUT", f"/devices/{device_id}/account-binding", {"account_id": account_id, "note": "集成测试"})

    def policy(self, account_id: str = ACCOUNT) -> dict[str, Any]:
        return self.ok("GET", f"/accounts/{account_id}/policy")

    def set_policy(self, account_id: str = ACCOUNT, **changes: Any) -> dict[str, Any]:
        body = self.policy(account_id)
        body.update(changes)
        return self.ok(
            "PUT", f"/accounts/{account_id}/policy", body, status=200, **{"If-Match": str(body["policy_version"])}
        )

    def commands(self, **params: Any) -> list[dict[str, Any]]:
        q = "&".join(f"{k}={v}" for k, v in params.items())
        return self.ok("GET", "/commands" + (f"?{q}" if q else ""))["items"]

    def command(self, command_id: Any) -> dict[str, Any]:
        return self.ok("GET", f"/commands/{command_id}")

    def cases(self) -> list[dict[str, Any]]:
        return self.ok("GET", "/cases")["items"]

    def case(self, case_id: str) -> dict[str, Any]:
        return self.ok("GET", f"/cases/{case_id}")

    def device(self, device_id: str) -> dict[str, Any]:
        return self.ok("GET", f"/devices/{device_id}")

    def events(self, **params: Any) -> list[dict[str, Any]]:
        q = "&".join(f"{k}={v}" for k, v in params.items())
        return self.ok("GET", "/events" + (f"?{q}" if q else ""))["items"]


# ---------------------------------------------------------------------------
# 网络：可切换服务端实例、可注入故障的 httpx 传输
# ---------------------------------------------------------------------------


@dataclass
class Fault:
    """一条故障规则。route 是请求路径里要包含的片段（例如 "/result"）。

    kind：
    - "drop"：请求没到服务端，直接返回 status（默认 500）——服务端没有任何记录；
    - "lose_response"：服务端已经处理并落库，但返回给客户端的响应换成 status；
    - "down"：连接失败（httpx.ConnectError）。
    """

    route: str
    kind: str = "drop"
    status: int = 500
    times: int = 1
    method: str | None = None
    hits: int = 0

    def matches(self, request: httpx.Request) -> bool:
        if self.times <= 0:
            return False
        if self.method is not None and request.method != self.method:
            return False
        return self.route in request.url.path


class Cluster(httpx.BaseTransport):
    """客户端看到的"网络 + 服务端"。server 可以整个替换（重启），down=True 时全部连接失败。"""

    def __init__(self, workdir: Path, clock: ManualClock):
        self.workdir = workdir
        self.clock = clock
        self.server_db = workdir / "server.db"
        self.server: Server | None = Server(self.server_db, clock)
        self.faults: list[Fault] = []
        self.down = False
        self.requests: list[tuple[str, str, int | None]] = []  # (method, path, 客户端看到的状态码)

    # -- 故障 ----------------------------------------------------------------

    def fail(self, route: str, *, kind: str = "drop", status: int = 500, times: int = 1, method: str | None = None) -> Fault:
        f = Fault(route=route, kind=kind, status=status, times=times, method=method)
        self.faults.append(f)
        return f

    def stop_server(self) -> None:
        """服务端进程退出：之后的请求连接失败。"""
        assert self.server is not None
        self.server.close()
        self.server = None

    def start_server(self) -> Server:
        """在同一个 SQLite 文件上起一个新的服务端实例（内存里的状态全部丢失）。"""
        assert self.server is None, "先 stop_server()"
        self.server = Server(self.server_db, self.clock)
        return self.server

    def restart_server(self) -> Server:
        self.stop_server()
        return self.start_server()

    def shutdown(self) -> None:
        if self.server is not None:
            self.server.close()
            self.server = None

    def close(self) -> None:
        """httpx.Client 关闭时会关闭它的传输；集群被多个客户端共用，这里什么都不做（用 shutdown()）。"""

    # -- httpx.BaseTransport -------------------------------------------------

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        fault = next((f for f in self.faults if f.matches(request)), None)
        if fault is not None:
            fault.times -= 1
            fault.hits += 1
        if self.down or self.server is None or (fault is not None and fault.kind == "down"):
            self.requests.append((request.method, request.url.path, None))
            raise httpx.ConnectError("服务端不可达（集成测试注入）", request=request)
        if fault is not None and fault.kind == "drop":
            self.requests.append((request.method, request.url.path, fault.status))
            return _problem_response(fault.status)
        request.read()
        resp = self.server.http.send(request)
        content = resp.read()
        if fault is not None and fault.kind == "lose_response":
            self.requests.append((request.method, request.url.path, fault.status))
            return _problem_response(fault.status)
        self.requests.append((request.method, request.url.path, resp.status_code))
        return httpx.Response(resp.status_code, headers=resp.headers, content=content)

    def count(self, route: str, method: str = "POST", status: int | None = None) -> int:
        return sum(
            1
            for m, p, s in self.requests
            if m == method and route in p and (status is None or s == status)
        )


def _problem_response(status: int) -> httpx.Response:
    return httpx.Response(
        status,
        headers={"content-type": "application/problem+json"},
        content=json.dumps({"code": "injected", "message": "集成测试注入的故障"}).encode(),
    )


# ---------------------------------------------------------------------------
# 界面：可换场景、可挂钩子、可落盘写调用记录的 FakeDriver 外壳
# ---------------------------------------------------------------------------


WRITE_METHODS = ("click", "type_text", "key", "scroll")


@dataclass(frozen=True)
class WriteRecord:
    """一次到达 FakeDriver 的写调用（跨场景、跨重启累计）。kind 见 classify_write。"""

    method: str
    step: str
    text: str
    kind: str

    def to_json(self) -> str:
        return json.dumps(
            {"method": self.method, "step": self.step, "text": self.text, "kind": self.kind}, ensure_ascii=False
        )


class Screen:
    """Driver：把调用转给当前场景的 FakeDriver。

    - ``show(fake)`` 换场景（例如从会话页切到搜索页）；
    - ``hooks``：写调用成功到达 FakeDriver 之后依次调用 ``hook(record, screen)``，用来在"点击发生之后"
      注入外部事件（取消到达、进程被杀）；
    - ``journal``：每条写调用追加写入并 fsync 的 JSONL 文件，子进程被 os._exit 杀掉后父进程仍能读到。
    """

    def __init__(self, fake: FakeDriver, *, journal: Path | None = None):
        self.fake = fake
        self.records: list[WriteRecord] = []
        self.hooks: list[Callable[[WriteRecord, Screen], None]] = []
        self.journal = journal

    def show(self, fake: FakeDriver) -> None:
        self.fake = fake

    # -- 读 -------------------------------------------------------------------

    def state(self, include_tree: bool = False):
        return self.fake.state(include_tree)

    def bind_window(self, selector=None):
        return self.fake.bind_window(selector)

    def screen_ok(self) -> bool:
        return self.fake.screen_ok()

    def screenshot_region(self, rect, out_path):
        return self.fake.screenshot_region(rect, out_path)

    # -- 写 -------------------------------------------------------------------

    def _after_write(self, method: str) -> None:
        call = self.fake.calls[-1]
        rec = WriteRecord(method=method, step=call.step, text=_call_text(call), kind=classify_write(call))
        self.records.append(rec)
        if self.journal is not None:
            with open(self.journal, "a", encoding="utf-8") as fh:
                fh.write(rec.to_json() + "\n")
                fh.flush()
                os.fsync(fh.fileno())
        for hook in list(self.hooks):
            hook(rec, self)

    def click(self, target, mode="auto"):
        receipt = self.fake.click(target, mode)
        self._after_write("click")
        return receipt

    def type_text(self, target, text):
        receipt = self.fake.type_text(target, text)
        self._after_write("type_text")
        return receipt

    def key(self, keys):
        receipt = self.fake.key(keys)
        self._after_write("key")
        return receipt

    def scroll(self, target, direction, amount):
        receipt = self.fake.scroll(target, direction, amount)
        self._after_write("scroll")
        return receipt

    # -- 断言辅助 ---------------------------------------------------------------

    def kinds(self) -> list[str]:
        return [r.kind for r in self.records]

    def count(self, kind: str) -> int:
        return sum(1 for r in self.records if r.kind == kind)

    def outbound(self) -> list[str]:
        """对外动作类写调用（问候输入/发送、求简历、换微信、搜索输入/提交）。"""
        return [r.kind for r in self.records if r.kind in OUTBOUND_KINDS]


def read_journal(path: Path) -> list[WriteRecord]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        d = json.loads(line)
        out.append(WriteRecord(**d))
    return out


def _call_text(call: Any) -> str:
    if call.method == "type_text":
        return str(call.args.get("text", ""))
    if call.method == "key":
        return str(call.args.get("keys", ""))
    e = call.element
    if e is None:
        return ""
    return (e.label or e.value or "").strip()


# 会话详情里按钮的位置（夹具全局坐标，窗口在 x=3360、y=25）
SEND_GROUP = Frame(x=4663, y=862, w=66, h=28)
RESUME_GROUP = Frame(x=4084, y=780, w=57, h=24)
WECHAT_TEXT = Frame(x=4227, y=786, w=39, h=15)
SEARCH_BUTTON = Frame(x=4480, y=57, w=92, h=42)
ROW_W = 384

OUTBOUND_KINDS = frozenset(
    {"greeting_type", "greeting_send", "resume_request", "resume_confirm", "wechat_request", "search_type", "search_submit", "search_clear"}
)


def _center_in(frame: Frame, box: Frame, slack: float = 4) -> bool:
    cx, cy = frame.x + frame.w / 2, frame.y + frame.h / 2
    return box.x - slack <= cx <= box.x + box.w + slack and box.y - slack <= cy <= box.y + box.h + slack


def classify_write(call: Any) -> str:
    """把一次写调用归类，便于断言"对外动作恰好发生了几次"。"""
    if call.method == "type_text":
        e = call.element
        if e is not None and e.role == "AXTextField":
            return "search_type"
        return "greeting_type"
    if call.method == "key":
        return "search_clear"
    if call.method == "scroll":
        return "scroll"
    e = call.element
    if e is None:
        return "click_other"
    text = (e.label or e.value or "").strip()
    if text.startswith("新招呼"):
        return "tab_new_greeting"
    if text in ("全部", "沟通中"):
        return "tab_other"
    if text == "确认":
        return "resume_confirm"
    if _center_in(e.frame, SEND_GROUP):
        return "greeting_send"
    if _center_in(e.frame, RESUME_GROUP):
        return "resume_request"
    if _center_in(e.frame, WECHAT_TEXT, slack=8):
        return "wechat_request"
    if _center_in(e.frame, SEARCH_BUTTON):
        return "search_submit"
    if text == "搜索" and e.role.startswith("AXLink"):
        return "search_nav"
    if e.role.startswith("AXGroup") and e.frame.w == ROW_W:
        return "open_row"
    if e.role == "AXTextField":
        return "search_focus"
    return "click_other"


# ---------------------------------------------------------------------------
# 夹具派生（与 client/tests/test_actions_common.py 的派生规则一致：只追加或删除元素、重新编号）
# ---------------------------------------------------------------------------


def load_raw(scene: str) -> dict[str, Any]:
    return json.loads((FIXTURES / scene / "fixture.json").read_text(encoding="utf-8"))


def raw_step(scene: str, index: int) -> dict[str, Any]:
    return copy.deepcopy(load_raw(scene)["steps"][index])


def _origin(step: dict[str, Any]) -> tuple[float, float]:
    f = step["window"]["frame"]
    return f["x"], f["y"]


def el(step: dict[str, Any], role: str, rel: tuple[float, float, float, float], *, label: str = "", value: str = "") -> dict:
    ox, oy = _origin(step)
    x, y, w, h = rel
    return {"index": 0, "role": role, "label": label, "value": value, "frame": {"x": ox + x, "y": oy + y, "w": w, "h": h}}


def text(step: dict[str, Any], value: str, rel: tuple[float, float, float, float]) -> dict:
    return el(step, "AXStaticText", rel, value=value)


def reindex(step: dict[str, Any], label: str, elements: list[dict]) -> dict[str, Any]:
    new = copy.deepcopy(step)
    elements = [copy.deepcopy(e) for e in elements]
    for pos, e in enumerate(elements):
        e["index"] = pos
    new["elements"] = elements
    new["label"] = label
    new["annotations"] = {"page": step["annotations"]["page"]}
    return new


def derive(step: dict[str, Any], label: str, *, add: Iterable[dict] = (), drop: Callable[[dict], bool] | None = None) -> dict:
    kept = [e for e in step["elements"] if not (drop and drop(e))]
    return reindex(step, label, kept + list(add))


def own_message(step: dict[str, Any], body: str, y: float = 700) -> list[dict]:
    """我方消息：聊天区右半边的消息文本，左侧同一行有『送达』（H1 的派生假设）。"""
    return [text(step, "送达", (1160, y + 11, 24, 13)), text(step, body, (1201, y, 140, 16))]


def notice(step: dict[str, Any], body: str, y: float = 660) -> dict:
    """聊天区居中的系统提示（与 conversation_detail#0 的『简历请求已发送』同一水平位置）。"""
    return text(step, body, (905, y, 84, 14))


def _in_list_rows(e: dict) -> bool:
    f = e["frame"]
    return f["x"] >= 3480 and f["x"] + f["w"] <= 3864 and f["y"] >= 165


def detail_for_new_greeting(name: str = CANDIDATE) -> dict[str, Any]:
    """候选人L 的会话详情：conversation_detail#2（候选人发起、招聘方未回复）的详情区，
    左侧列表换成 new_application_marker#1（『新招呼』页签，候选人L 置顶），表头姓名换成候选人L。"""
    detail = raw_step("conversation_detail", 2)
    marker = raw_step("new_application_marker", 1)
    rows = [e for e in marker["elements"] if _in_list_rows(e)]
    first = next(i for i, e in enumerate(detail["elements"]) if _in_list_rows(e))
    rest = [e for e in detail["elements"][first:] if not _in_list_rows(e)]
    elements = detail["elements"][:first] + rows + rest
    for e in elements:
        if e["role"] == "AXStaticText" and e["value"] == "候选人A" and e["frame"]["y"] < 100:
            e["value"] = name
    return reindex(detail, f"会话详情（{name}，未回复）", elements)


def _row_of(call: Any, y: float) -> bool:
    e = call.element
    return e is not None and e.role.startswith("AXGroup") and e.frame.w == ROW_W and e.frame.y == y


def _hits(box: Frame) -> Callable[[Any], bool]:
    return lambda call: call.element is not None and _center_in(call.element.frame, box)


def make_fake(steps: list[dict[str, Any]], *, advances: Iterable[Advance] = (), clock: ManualClock, scene: str = "m_integration") -> FakeDriver:
    meta = load_raw("conversation_detail")
    fixture = {k: v for k, v in meta.items() if k != "steps"}
    fixture["scene"] = scene
    fixture["steps"] = steps
    return FakeDriver(fixture, advances=list(advances), clock=clock.now)


def greeting_text(name: str = CANDIDATE) -> str:
    return GREETING_TEMPLATE.replace("{candidate_name}", name)


def boss_new_greeting(
    clock: ManualClock, *, greeting: str | None = None, resume_confirm: bool = False, greet: bool = True
) -> FakeDriver:
    """主线场景：基线列表 → 候选人L 新到 → 打开会话 → 问候 → 求简历。

    步骤标签：list_baseline、list_new、detail、detail_greeted、detail_requested（resume_confirm=True 时
    另有 detail_confirm：点『求简历』后先出现确认气泡）。点『发送』后出现我方消息，点『求简历』后出现
    『简历请求已发送』——这些"之后"的界面是 H1 的派生假设，不是真机观察。
    """
    greeting = greeting or greeting_text()
    base = raw_step("new_application_marker", 0)
    base["label"] = "list_baseline"
    new = raw_step("new_application_marker", 1)
    new["label"] = "list_new"
    detail = detail_for_new_greeting()
    detail["label"] = "detail"
    greeted = derive(detail, "detail_greeted", add=own_message(detail, greeting))
    requested = derive(greeted, "detail_requested", add=[notice(greeted, "简历请求已发送")])
    steps = [base, new, detail, greeted, requested]
    advances = [
        Advance("click", on_step="list_new", when=lambda c: _row_of(c, 170), goto="detail"),
        Advance("click", on_step="detail", when=_hits(SEND_GROUP), goto="detail_greeted"),
    ]
    if not greet:
        # 问候关闭：会话打开后直接求简历，提示出现在未问候的详情上
        requested = derive(detail, "detail_requested", add=[notice(detail, "简历请求已发送")])
        steps = [base, new, detail, requested]
        advances = [advances[0], Advance("click", on_step="detail", when=_hits(RESUME_GROUP), goto="detail_requested")]
        return make_fake(steps, advances=advances, clock=clock, scene="m_new_greeting_no_greet")
    if resume_confirm:
        bubble = [text(greeted, "确定向牛人请求简历吗？", (700, 690, 154, 16))] + [
            el(greeted, "AXButton", (770 + 54 * i, 719, 44, 24), label=b) for i, b in enumerate(("取消", "确认"))
        ]
        confirm = derive(greeted, "detail_confirm", add=bubble)
        steps.insert(4, confirm)
        advances += [
            Advance("click", on_step="detail_greeted", when=_hits(RESUME_GROUP), goto="detail_confirm"),
            Advance("click", on_step="detail_confirm", when=lambda c: c.element is not None and c.element.label == "确认", goto="detail_requested"),
        ]
    else:
        advances.append(Advance("click", on_step="detail_greeted", when=_hits(RESUME_GROUP), goto="detail_requested"))
    fake = make_fake(steps, advances=advances, clock=clock, scene="m_new_greeting")
    return fake


def boss_wechat(clock: ManualClock) -> FakeDriver:
    """换微信场景：候选人L 已求过简历的会话 → 点『换微信』后出现『请求交换微信已发送』（H3 的判定文案，
    依据 capabilities.md 1.7；点击后的界面是派生假设）。"""
    detail = detail_for_new_greeting()
    greeted = derive(detail, "detail_greeted", add=own_message(detail, greeting_text()))
    requested = derive(greeted, "detail_requested", add=[notice(greeted, "简历请求已发送")])
    wechat = derive(requested, "detail_wechat_sent", add=[notice(requested, "请求交换微信已发送", y=620)])
    advances = [Advance("click", on_step="detail_requested", when=_hits(WECHAT_TEXT), goto="detail_wechat_sent")]
    return make_fake([requested, wechat], advances=advances, clock=clock, scene="m_wechat")


# -- 搜索页（与 client/tests/test_actions_search.py 的派生一致） ---------------------

_SEARCH_CARDS = {1: range(220, 243), 2: range(243, 272), 3: range(272, 278)}
_KEYWORD_W = 519


def _with_keyword(step: dict[str, Any], value: str, label: str) -> dict[str, Any]:
    new = derive(step, label)
    for e in new["elements"]:
        f = e["frame"]
        if e["role"] == "AXTextField" and f["w"] == _KEYWORD_W and f["y"] < 120:
            e["value"] = value
    return new


def _drop_cards(step: dict[str, Any], *cards: int, label: str, add: Iterable[dict] = ()) -> dict[str, Any]:
    gone = {i for c in cards for i in _SEARCH_CARDS[c]}
    return derive(step, label, drop=lambda e: e["index"] in gone, add=add)


def boss_search(clock: ManualClock, query: str, outcome: str) -> FakeDriver:
    """搜索场景：消息页 → 点『搜索』→ 输入 → 提交 → 结果。outcome：results / no_results / unreadable。

    results：只剩候选人S1 一张卡（H2 的派生）；no_results：卡片全部消失并出现『没有找到相关牛人』
    （**未观察到**的假设文案）；unreadable：提交后结果区一直不变（超时）。
    """
    start = raw_step("conversation_list", 0)
    page = raw_step("search_page", 0)
    typed = _with_keyword(page, query, "search_typed")
    if outcome == "results":
        after = _with_keyword(_drop_cards(page, 2, 3, label="tmp"), query, "search_results")
    elif outcome == "no_results":
        after = _with_keyword(
            _drop_cards(page, 1, 2, 3, label="tmp", add=[text(page, "没有找到相关牛人", (177, 480, 140, 16))]),
            query,
            "search_empty",
        )
    elif outcome == "unreadable":
        after = _with_keyword(page, query, "search_stuck")
    else:
        raise ValueError(outcome)
    page["label"] = "search_page"
    start["label"] = "message_page"
    steps = [start, page, typed, after]
    advances = [
        Advance("click", on_step="message_page", target=Locator(text="搜索", role="AXLink"), goto="search_page"),
        Advance("type_text", on_step="search_page", goto="search_typed"),
        Advance("click", on_step="search_typed", when=_hits(SEARCH_BUTTON), goto=after["label"]),
    ]
    return make_fake(steps, advances=advances, clock=clock, scene=f"m_search_{outcome}")


# ---------------------------------------------------------------------------
# Monitor 设备（真实运行时 + SQLite 账本）
# ---------------------------------------------------------------------------


@dataclass
class DeviceIdentity:
    device_id: str
    token: str
    mode: str = "local"


class Monitor:
    """一台 Monitor 设备的一个"进程"。restart() 用同一个账本文件新建运行时（内存状态全部丢失）。"""

    def __init__(
        self,
        cluster: Cluster,
        identity: DeviceIdentity,
        screen: Screen,
        *,
        ledger_path: Path,
        observe: bool = True,
        observe_interval: float = 45.0,
        heartbeat_interval: float = 30.0,
        handlers: Iterable[Any] | None = None,
        observer: Any = None,
    ):
        self.cluster = cluster
        self.identity = identity
        self.screen = screen
        self.clock = cluster.clock
        self.ledger_path = ledger_path
        self._observe = observe
        self._observe_interval = observe_interval
        self._heartbeat_interval = heartbeat_interval
        self._handlers = handlers
        self._observer = observer
        self.runtime = self._build()

    def _build(self) -> MonitorRuntime:
        self.ledger = open_ledger(self.ledger_path)
        handlers = list(self._handlers) if self._handlers is not None else create_handlers(clock=self.clock)
        observer = self._observer
        if observer is None and self._observe:
            observer = create_observer(clock=self.clock.now)
        client = CommandClient(
            base_url=BASE_URL,
            device_id=self.identity.device_id,
            token=self.identity.token,
            transport=self.cluster,
            now=self.clock.now,
        )
        runtime = MonitorRuntime(
            config=RuntimeConfig(
                device_id=self.identity.device_id,
                mode=self.identity.mode,  # type: ignore[arg-type]
                heartbeat_interval=self._heartbeat_interval,
                observe_interval=self._observe_interval,
                claim_wait_seconds=0,
            ),
            ledger=self.ledger,
            driver=self.screen,
            client=client,
            handlers={h.action: h for h in handlers},
            clock=self.clock,
            observer=observer,
        )
        runtime.start()
        return runtime

    def restart(self) -> MonitorRuntime:
        self.runtime.client.close()
        self.ledger.close()
        self.runtime = self._build()
        return self.runtime

    def close(self) -> None:
        self.runtime.client.close()
        self.ledger.close()

    # -- 驱动 -----------------------------------------------------------------

    def step(self) -> float:
        """与 run_forever 的一轮相同：run_once，然后按建议时间"等待"（推进可控时钟）。"""
        idle = self.runtime.run_once()
        if idle > 0:
            self.clock.sleep(idle)
        return idle

    def run(self, rounds: int) -> None:
        for _ in range(rounds):
            self.step()

    def run_until(self, pred: Callable[[], bool], *, max_rounds: int = 200, what: str = "") -> int:
        for n in range(max_rounds):
            if pred():
                return n
            self.step()
        if pred():
            return max_rounds
        raise AssertionError(f"{max_rounds} 轮后仍未满足条件：{what}；last_error={self.runtime.last_error}")

    # -- 观察账本 ---------------------------------------------------------------

    def ledger_command(self, command_id: Any):
        return self.ledger.get_command(uuid.UUID(str(command_id)))

    def results_pending(self) -> int:
        return len(self.ledger.pending_results(limit=10_000))

    def events_pending(self) -> int:
        return len(self.ledger.pending_events(limit=10_000))


# ---------------------------------------------------------------------------
# 一次集成测试的整体环境
# ---------------------------------------------------------------------------


class World:
    """服务端 + 一台 Monitor + 屏幕。常用操作：注册与绑定、开策略、跑到某个条件。"""

    def __init__(self, workdir: Path, *, start: datetime = T0):
        self.workdir = workdir
        self.clock = ManualClock(start)
        self.cluster = Cluster(workdir, self.clock)
        self.monitors: list[Monitor] = []

    @property
    def server(self) -> Server:
        assert self.cluster.server is not None, "服务端已停止"
        return self.cluster.server

    def close(self) -> None:
        for m in self.monitors:
            try:
                m.close()
            except Exception:
                pass
        self.cluster.shutdown()

    # -- 注册与绑定（api.md 3.1） ----------------------------------------------------

    def register(self, mode: str = "local", device_name: str = "招聘部 Mac mini") -> DeviceIdentity:
        """控制台生成注册码 → Monitor 安装流程（J 的 register_device）用注册码换令牌。"""
        code = self.server.enroll(mode)
        body = build_registration(
            enrollment_code=code,
            device_name=device_name,
            mode=mode,  # type: ignore[arg-type]
            capabilities=["observe", "send_greeting", "request_resume", "request_contact_exchange", "search_candidates"],
            os_version="15.1",
            arch="arm64",
        )
        reg = register_device(BASE_URL, body, transport=self.cluster, allow_insecure_http=True)
        return DeviceIdentity(device_id=reg.device_id, token=reg.device_token, mode=mode)

    def monitor(self, identity: DeviceIdentity, screen: Screen, *, name: str = "monitor", **kw: Any) -> Monitor:
        m = Monitor(self.cluster, identity, screen, ledger_path=self.workdir / f"{name}.db", **kw)
        self.monitors.append(m)
        return m

    def enable_automation(self, **changes: Any) -> dict[str, Any]:
        values: dict[str, Any] = {
            "allowed_actions": ["send_greeting", "request_resume", "request_contact_exchange", "search_candidates"],
            "job_scope": {"mode": "all", "job_titles": []},
            "greeting": {"enabled": True, "template": GREETING_TEMPLATE},
            "auto_request_resume": True,
            "work_hours": WORK_HOURS_ALL_DAY,
        }
        values.update(changes)
        return self.server.set_policy(**values)

    def bound_monitor(self, screen: Screen, *, mode: str = "local", automation: bool = True, **kw: Any) -> Monitor:
        """注册 → 控制台确认绑定 → 本机保存绑定账户（见 bind_locally 的说明）→ 开策略。"""
        ident = self.register(mode)
        self.server.bind(ident.device_id)
        if automation:
            self.enable_automation()
        m = self.monitor(ident, screen, **kw)
        bind_locally(m)
        return m


def bind_locally(m: Monitor, account_id: str = ACCOUNT) -> None:
    """把控制台确认的绑定写进本机（runtime.bind_account）。

    缺陷 M-1：客户端没有任何途径得知控制台确认的账户——HeartbeatAck 只有 account_confirmed，
    install/bootstrap 也没有询问或拉取 account_id，所以真实部署里没有代码会调用 bind_account。
    集成测试在这里替它做这一步，端到端的期望写在 test_e2e_registration.py 的 strict xfail 里。
    """
    m.runtime.bind_account(account_id, confirmed_by=CONSOLE_ACTOR)


@contextmanager
def world(tmp_path: Path, **kw: Any):
    w = World(tmp_path, **kw)
    try:
        yield w
    finally:
        w.close()


def find(items: Iterable[Mapping[str, Any]], **match: Any) -> list[Mapping[str, Any]]:
    return [i for i in items if all(i.get(k) == v for k, v in match.items())]


def at_local(hh: int, mm: int = 0, day: int = 4) -> datetime:
    """2026-10-<day> 上海时间 hh:mm 对应的 UTC 时间。"""
    return datetime(2026, 10, day, hh, mm, tzinfo=UTC) - timedelta(hours=8)


__all__ = [name for name in dir() if not name.startswith("_")]
