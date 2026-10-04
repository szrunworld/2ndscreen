"""动作公共层：会话类动作（问候、求简历，以及后续的换联系方式）共用的读取、定位、等待与结果组装。

公共流程（ConversationSession 按此顺序提供积木，各动作在 run / verify_only 里组合）：

    白名单检查（关闭 → failed/action_not_allowed，不调用 driver）
      → 读界面，有弹窗 / 遮罩 → 不点任何控件，unknown_dialog
      → 在会话列表里定位（姓名 + 岗位 + hints 全部一致；多命中 = target_ambiguous，不点击；
        找不到 = target_not_found）
      → 点击该行打开会话，等待表头显示同一姓名与岗位
      → 读状态、前置检查（已发生 → skipped_precondition）
      → 执行（对外动作一律包在 ctx.outbound() 里）
      → 等待可识别结果（上限 10 秒，用注入的时钟轮询，不用固定 sleep）
      → 组装 ActionResult 与脱敏 evidence

界面规则全部来自任务 B 的夹具（monitor/fixtures/ax/**，BOSS直聘 1.7.4，窗口 1440×875）。
这些只是"夹具上成立"的规则，真机写操作的界面变化要等 N 阶段实测；依赖的假设集中列在
docs/monitor/agent-reports/H1.md 第五节。

两条硬约束：

1. 绝不读取附件 PDF 预览的文字层（其中有电话、邮箱）。read_view() 在任何文本读取之前，
   按几何位置把『PDF预览』AXWebArea 里的元素整体剔除；后续定位、弹窗识别、evidence 都只看剔除后的视图。
2. 出现未知弹窗或遮罩时不点击任何控件。detect_blockers() 只负责识别，是否允许点击由各动作按
   精确文案白名单决定（目前只有求简历的确认气泡）。
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable, Iterator
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, TypeVar

from monitor_contracts import (
    ActionContext,
    ActionResult,
    CommandModel,
    Conversation,
    Driver,
    Element,
    EvidenceItem,
    Fact,
    Frame,
    Observed,
    Reason,
    ResultStatus,
    Snapshot,
)

from monitor.core.clock import Clock, SystemClock
from monitor.driver.redact import redact_text

# 等待可识别结果的上限（任务 H1 要求 10 秒）与轮询间隔。轮询间隔只是两次读取之间的间隔，
# 不是"等固定时间就当成功"：结果一律以重新读到的界面为准。
RESULT_TIMEOUT_SECONDS = 10.0
POLL_INTERVAL_SECONDS = 0.5
# 切换列表页签后等待列表刷新的上限（只是导航，不必等满 10 秒）
TAB_SWITCH_TIMEOUT_SECONDS = 2.0

# 定位会话时依次尝试的顶部页签（当前视图找不到时才切换）。『新招呼』放第一，因为新投递都在这里。
CONVERSATION_TABS: tuple[str, ...] = ("新招呼", "沟通中", "全部")
# 左侧导航『消息』入口（label 形如『消息620』，后面是未读数）
MESSAGE_NAV_PATTERN = re.compile(r"^消息\d*$")

# 窗口相对坐标：表头带的高度。会话详情的姓名在 y≈23（夹具 conversation_detail#0）。
HEADER_BAND_HEIGHT = 60.0
# 我方消息左侧的状态文字（capabilities.md 1.3：我方消息有『送达 / 已读』状态）
OWN_MESSAGE_STATUS = frozenset({"送达", "已读", "未读"})
# 系统提示居中显示：中心与聊天区中心的水平距离不超过聊天区宽度的这个比例
CENTERED_TOLERANCE = 0.15

EVIDENCE_MAX_ITEMS = 50
EVIDENCE_MAX_CHARS = 500
FACT_DETAIL_MAX_CHARS = 500
NAME_PLACEHOLDER = "[候选人]"

_BIDI = re.compile("[‎‏‪-‮⁦-⁩﻿]")
_WS = re.compile(r"\s+")
_UNREAD_BADGE = re.compile(r"^\d{1,3}\+?$")
_WINDOW_CHROME = frozenset({"AXCloseButton", "AXFullScreenButton", "AXMinimizeButton", "AXZoomButton"})

T = TypeVar("T")


def squash(text: str | None) -> str:
    """展示用的轻度清理：去方向控制符、合并空白、去首尾空白，保留全角标点（evidence 与弹窗文案用它）。"""
    if not text:
        return ""
    return _WS.sub(" ", _BIDI.sub("", text)).strip()


def norm(text: str | None) -> str:
    """文本规范化：去方向控制符、NFKC、合并空白、去首尾空白（与 Driver 的 Locator 规范化一致）。

    注意 NFKC 会把全角冒号『：』变成半角『:』，比较前两边都要经过 norm。
    """
    if not text:
        return ""
    return _WS.sub(" ", unicodedata.normalize("NFKC", _BIDI.sub("", text))).strip()


def _role_base(el: Element) -> str:
    return el.role.split("/", 1)[0]


def _subrole(el: Element) -> str:
    parts = el.role.split("/", 1)
    return parts[1] if len(parts) == 2 else ""


def _texts(el: Element) -> set[str]:
    return {t for t in (norm(el.label), norm(el.value)) if t}


def _inside(frame: Frame, point: tuple[float, float]) -> bool:
    x, y = point
    return frame.x <= x <= frame.x + frame.w and frame.y <= y <= frame.y + frame.h


# ---------------------------------------------------------------------------
# 视图：剔除 PDF 文字层后的快照
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class View:
    """一次 state() 的可用部分。elements 已剔除 PDF 预览区域内的全部元素（只保留预览容器本身）。"""

    snapshot: Snapshot
    elements: tuple[Element, ...]
    hidden_regions: tuple[Frame, ...] = ()

    @property
    def origin(self) -> tuple[float, float]:
        window = self.snapshot.window
        return (window.frame.x, window.frame.y) if window is not None else (0.0, 0.0)

    def rel_y(self, el: Element) -> float:
        return el.frame.y - self.origin[1]

    def with_text(self, text: str, *, role: str | None = None) -> list[Element]:
        """规范化后 label 或 value 等于 text 的元素；role 给出时按基础角色过滤。"""
        want = norm(text)
        return [e for e in self.elements if want in _texts(e) and (role is None or _role_base(e) == role)]


def is_pdf_preview(el: Element) -> bool:
    return _role_base(el) == "AXWebArea" and "PDF" in norm(el.label).upper()


def make_view(snapshot: Snapshot) -> View:
    """剔除附件 PDF 预览的文字层。

    只看预览容器的角色与 label（不读其中任何文字），把中心点落在容器内的元素整体丢掉。
    这样即使预览开着，后续任何定位、弹窗识别、evidence 也碰不到文字层。
    """
    regions = tuple(e.frame for e in snapshot.elements if is_pdf_preview(e))
    if not regions:
        return View(snapshot, snapshot.elements)
    kept = tuple(
        e for e in snapshot.elements if is_pdf_preview(e) or not any(_inside(r, e.frame.center()) for r in regions)
    )
    return View(snapshot, kept, regions)


def read_view(driver: Driver) -> View:
    return make_view(driver.state())


# ---------------------------------------------------------------------------
# 弹窗与遮罩
# ---------------------------------------------------------------------------

BlockerKind = Literal["dialog", "pdf_preview", "resume_overlay"]


@dataclass(frozen=True)
class Blocker:
    """会挡住动作的弹窗或遮罩。text 是界面原文（squash 清理、未脱敏，写 evidence 前要过 Evidence；
    做匹配时先 norm）。button_labels 已 norm。"""

    kind: BlockerKind
    text: str
    buttons: tuple[Element, ...] = ()

    @property
    def button_labels(self) -> tuple[str, ...]:
        return tuple(norm(b.text) for b in self.buttons)

    def describe(self) -> str:
        labels = "/".join(label or "?" for label in self.button_labels)
        return f"{self.kind}: {self.text}" + (f" [{labels}]" if labels else "")


def _is_plain_button(el: Element) -> bool:
    return _role_base(el) == "AXButton" and _subrole(el) not in _WINDOW_CHROME


def detect_blockers(view: View) -> list[Blocker]:
    """识别弹窗与遮罩。

    依据（7 个夹具的全部步骤）：会话列表与会话详情页上没有任何"普通" AXButton（窗口的关闭/缩放/
    最小化按钮除外）；出现普通 AXButton 的只有确认气泡（取消/确认）、PDF 预览（切图）与在线简历弹层
    （继续沟通）。所以：
    - AXWebArea『PDF预览』→ pdf_preview；
    - 角色或子角色含 Sheet / Dialog / Popover → dialog；
    - 普通 AXButton：label 为『继续沟通』的 → resume_overlay；其余按同一水平线分组，每组一个 dialog，
      文案取按钮上方 90pt 内、水平相邻的静态文本。
    只用 AXButton 识别弹窗是保守的：用 AXGroup 冒充按钮的弹窗认不出来，但那种情况下动作等不到预期结果，
    结局是 unknown/timeout，同样不会误点。
    """
    blockers: list[Blocker] = []
    for el in view.elements:
        if is_pdf_preview(el):
            blockers.append(Blocker("pdf_preview", squash(el.label)))
        elif any(k in el.role for k in ("Sheet", "Dialog", "Popover")):
            inner = [e for e in view.elements if e is not el and _inside(el.frame, e.frame.center())]
            text = " ".join(squash(e.text) for e in inner if _role_base(e) == "AXStaticText" and norm(e.text))
            buttons = tuple(e for e in inner if _role_base(e) == "AXButton")
            blockers.append(Blocker("dialog", text or squash(el.text), buttons))

    plain = [e for e in view.elements if _is_plain_button(e)]
    overlay = [e for e in plain if norm(e.text) == "继续沟通"]
    if overlay:
        blockers.append(Blocker("resume_overlay", "在线简历弹层", tuple(overlay)))
    rest = [e for e in plain if e not in overlay]
    # PDF 预览自己的工具按钮（切图）已随预览区域剔除；剩下的按水平线分组
    groups: list[list[Element]] = []
    for btn in sorted(rest, key=lambda e: (e.frame.y, e.frame.x)):
        cy = btn.frame.center()[1]
        for group in groups:
            if abs(group[0].frame.center()[1] - cy) <= 10:
                group.append(btn)
                break
        else:
            groups.append([btn])
    for group in groups:
        blockers.append(Blocker("dialog", _text_above(view, group), tuple(group)))
    return blockers


def _text_above(view: View, buttons: list[Element]) -> str:
    """弹窗文案：按钮上方、水平相邻的静态文本，从最近的一行往上连续取（行距超过 24pt 就停）。"""
    top = min(b.frame.y for b in buttons)
    left = min(b.frame.x for b in buttons) - 220
    right = max(b.frame.x + b.frame.w for b in buttons) + 40
    candidates = sorted(
        (
            e
            for e in view.elements
            if _role_base(e) == "AXStaticText"
            and norm(e.text)
            and e.frame.y + e.frame.h <= top + 2
            and e.frame.x < right
            and e.frame.x + e.frame.w > left
        ),
        key=lambda e: -(e.frame.y + e.frame.h),
    )
    picked: list[Element] = []
    edge = top
    for e in candidates:
        bottom = e.frame.y + e.frame.h
        if edge - bottom > (50 if not picked else 24):
            break
        picked.append(e)
        edge = min(edge, e.frame.y)
    return " ".join(squash(e.text) for e in sorted(picked, key=lambda e: (e.frame.y, e.frame.x)))


# ---------------------------------------------------------------------------
# 会话列表与会话详情
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ConversationRow:
    """会话列表的一行：外层 AXGroup（窗口相对宽 384、高 76）与中心落在其中的元素。"""

    container: Element
    elements: tuple[Element, ...]

    @property
    def texts(self) -> set[str]:
        out: set[str] = set()
        for el in self.elements:
            out |= _texts(el)
        return out

    def name_element(self, name: str) -> Element | None:
        hits = [e for e in self.elements if norm(name) in _texts(e)]
        return min(hits, key=lambda e: e.frame.x) if hits else None

    def unread(self, name: str) -> bool:
        """行内姓名左侧有纯数字静态文本（未读角标，夹具 conversation_detail#2 x≈167）即视为未读。"""
        anchor = self.name_element(name)
        limit = anchor.frame.x if anchor is not None else self.container.frame.x + 70
        return any(
            _role_base(e) == "AXStaticText" and _UNREAD_BADGE.match(norm(e.value or e.label)) and e.frame.center()[0] < limit
            for e in self.elements
        )

    def matches(self, conversation: Conversation) -> bool:
        texts = self.texts
        wanted = [conversation.candidate_name, conversation.job_title, *conversation.hints]
        return all(norm(w) in texts for w in wanted)


def chat_input(view: View) -> Element | None:
    areas = [e for e in view.elements if _role_base(e) == "AXTextArea"]
    return areas[0] if len(areas) == 1 else None


def find_rows(view: View) -> list[ConversationRow]:
    containers = [
        e
        for e in view.elements
        if e.role == "AXGroup" and not norm(e.label) and 300 <= e.frame.w <= 460 and 20 <= e.frame.h <= 120
    ]
    textarea = chat_input(view)
    if textarea is not None:  # 会话详情打开时，行只在输入框左侧的列表列里
        containers = [c for c in containers if c.frame.x + c.frame.w <= textarea.frame.x + 1]
    rows = []
    for c in containers:
        members = tuple(
            e for e in view.elements if e is not c and e not in containers and _inside(c.frame, e.frame.center())
        )
        # 行内至少有姓名、岗位两个带 label 的 AXGroup（排除顶部『全部职位』下拉等同尺寸容器）
        if sum(1 for e in members if e.role == "AXGroup" and norm(e.label)) >= 2:
            rows.append(ConversationRow(c, members))
    return rows


def match_rows(view: View, conversation: Conversation) -> list[ConversationRow]:
    """姓名、岗位、每个 hint 都要在同一行里有规范化后完全相等的文本（label 或 value）。"""
    return [r for r in find_rows(view) if r.matches(conversation)]


@dataclass(frozen=True)
class DetailHeader:
    names: frozenset[str]
    job_title: str | None


def detail_header(view: View) -> DetailHeader | None:
    """会话详情表头：输入框所在列、窗口顶部 60pt 内的静态文本（姓名），以及『沟通职位：』右侧的岗位。

    没有唯一输入框时认为不在会话详情页，返回 None。
    """
    textarea = chat_input(view)
    if textarea is None:
        return None
    left = textarea.frame.x - 30
    names = frozenset(
        norm(e.text)
        for e in view.elements
        if _role_base(e) == "AXStaticText" and e.frame.x >= left and view.rel_y(e) < HEADER_BAND_HEIGHT and norm(e.text)
    )
    job = None
    labels = [e for e in view.with_text("沟通职位：") if e.frame.x >= left]
    if len(labels) == 1:
        anchor = labels[0]
        cy = anchor.frame.center()[1]
        right = sorted(
            (
                e
                for e in view.elements
                if _role_base(e) == "AXStaticText"
                and e.frame.x >= anchor.frame.x + anchor.frame.w - 1
                and abs(e.frame.center()[1] - cy) <= anchor.frame.h
                and norm(e.text)
            ),
            key=lambda e: e.frame.x,
        )
        if right:
            job = norm(right[0].text)
    return DetailHeader(names, job)


def header_matches(view: View, conversation: Conversation) -> bool:
    header = detail_header(view)
    return (
        header is not None
        and norm(conversation.candidate_name) in header.names
        and header.job_title == norm(conversation.job_title)
    )


@dataclass(frozen=True)
class ChatArea:
    left: float
    right: float
    top: float
    bottom: float

    @property
    def center_x(self) -> float:
        return (self.left + self.right) / 2

    def contains(self, el: Element) -> bool:
        cx, cy = el.frame.center()
        return self.left <= cx <= self.right and self.top <= cy <= self.bottom


def chat_area(view: View) -> ChatArea | None:
    """聊天区：输入框的水平范围，表头带以下、输入框顶部以上。"""
    textarea = chat_input(view)
    if textarea is None:
        return None
    return ChatArea(
        left=textarea.frame.x,
        right=textarea.frame.x + textarea.frame.w,
        top=view.origin[1] + HEADER_BAND_HEIGHT,
        bottom=textarea.frame.y,
    )


def system_notices(view: View, text: str) -> list[Element]:
    """聊天区里居中的、文案完全等于 text 的系统提示（如『简历请求已发送』）。"""
    area = chat_area(view)
    if area is None:
        return []
    tolerance = (area.right - area.left) * CENTERED_TOLERANCE
    return [
        e
        for e in view.with_text(text, role="AXStaticText")
        if area.contains(e) and abs(e.frame.center()[0] - area.center_x) <= tolerance
    ]


def own_messages(view: View, text: str) -> list[Element]:
    """聊天区里我方发出的、文本完全等于 text 的消息。

    我方消息的识别：位于聊天区右半边，且左侧同一行有『送达 / 已读』状态文字
    （夹具 conversation_detail#0：状态 x=1160、消息 x=1201）。没有状态文字的（发送中、发送失败）不算。
    """
    area = chat_area(view)
    if area is None:
        return []
    statuses = [e for e in view.elements if _role_base(e) == "AXStaticText" and norm(e.text) in OWN_MESSAGE_STATUS]
    out = []
    for msg in view.with_text(text, role="AXStaticText"):
        if not area.contains(msg) or msg.frame.center()[0] <= area.center_x:
            continue
        for st in statuses:
            st_cy = st.frame.center()[1]
            if (
                st.frame.x + st.frame.w <= msg.frame.x + 1
                and msg.frame.x - (st.frame.x + st.frame.w) <= 60
                and msg.frame.y - 4 <= st_cy <= msg.frame.y + msg.frame.h + 12
            ):
                out.append(msg)
                break
    return out


def toolbar_button(view: View, label: str) -> list[Element]:
    """输入框上方按钮条（求简历 / 换电话 / 换微信 …）里文案完全等于 label 的元素。"""
    textarea = chat_input(view)
    if textarea is None:
        return []
    return [
        e
        for e in view.with_text(label)
        if textarea.frame.x - 30 <= e.frame.x <= textarea.frame.x + textarea.frame.w
        and textarea.frame.y - 60 <= e.frame.center()[1] < textarea.frame.y
    ]


def send_button(view: View) -> list[Element]:
    """输入区里的『发送』（夹具：在输入框右下角，中心落在输入框纵向范围内或其下方）。"""
    textarea = chat_input(view)
    if textarea is None:
        return []
    return [
        e
        for e in view.with_text("发送")
        if e.frame.center()[1] >= textarea.frame.y and textarea.frame.x <= e.frame.center()[0] <= textarea.frame.x + textarea.frame.w + 30
    ]


def find_tab(view: View, name: str) -> Element | None:
    """顶部页签：AXGroup，label 为 name 或『name(计数)』（如『新招呼(505)』）。"""
    pattern = re.compile(rf"^{re.escape(name)}(\(\d+\))?$")
    hits = [e for e in view.elements if e.role == "AXGroup" and pattern.match(norm(e.label))]
    return hits[0] if len(hits) == 1 else None


def find_message_nav(view: View) -> Element | None:
    hits = [e for e in view.elements if _role_base(e) == "AXLink" and MESSAGE_NAV_PATTERN.match(norm(e.label))]
    return hits[0] if len(hits) == 1 else None


# ---------------------------------------------------------------------------
# 等待
# ---------------------------------------------------------------------------


class Waiter:
    """用注入的时钟轮询界面，直到 check 返回非 None 或超时。

    每轮都重新 state()；两轮之间 clock.sleep(间隔)。测试注入 ManualClock，sleep 只推进虚拟时间。
    """

    def __init__(
        self,
        clock: Clock,
        *,
        timeout: float = RESULT_TIMEOUT_SECONDS,
        interval: float = POLL_INTERVAL_SECONDS,
    ) -> None:
        if timeout <= 0 or interval <= 0:
            raise ValueError("timeout 与 interval 必须为正数")
        self.clock = clock
        self.timeout = timeout
        self.interval = interval

    def poll(
        self, driver: Driver, check: Callable[[View], T | None], *, timeout: float | None = None
    ) -> tuple[T | None, View]:
        """返回 (check 的结果或 None, 最后一次读到的视图)。第一次读取不等待。"""
        limit = self.timeout if timeout is None else min(timeout, self.timeout)
        start = self.clock.now()
        while True:
            view = read_view(driver)
            found = check(view)
            if found is not None:
                return found, view
            remaining = limit - (self.clock.now() - start).total_seconds()
            if remaining <= 0:
                return None, view
            self.clock.sleep(min(self.interval, remaining))


# ---------------------------------------------------------------------------
# evidence 与结果
# ---------------------------------------------------------------------------


class Evidence:
    """脱敏 evidence 收集：手机号 / 微信号 / 邮箱删除，候选人姓名替换为占位，单条截断 500 字，最多 50 条。"""

    def __init__(self, now: Callable[[], datetime], *, names: tuple[str, ...] = ()) -> None:
        self._now = now
        self._replacements = {n: NAME_PLACEHOLDER for n in names if n and n.strip()}
        self.items: list[EvidenceItem] = []

    def clean(self, text: str) -> str:
        return redact_text(squash(text), self._replacements)[:EVIDENCE_MAX_CHARS]

    def add(self, text: str, *, role: str | None = None, source: str = "element") -> None:
        cleaned = self.clean(text)
        if not cleaned or len(self.items) >= EVIDENCE_MAX_ITEMS:
            return
        if any(i.text == cleaned and i.source == source for i in self.items):
            return
        self.items.append(
            EvidenceItem(text=cleaned, role=role[:64] if role else None, source=source, captured_at=self._now())  # type: ignore[arg-type]
        )

    def element(self, el: Element, *, source: str = "element") -> None:
        self.add(el.text, role=el.role, source=source)

    def blocker(self, blocker: Blocker) -> None:
        self.add(blocker.describe(), source="dialog")


class Stop(Exception):
    """提前结束一次执行。由 ConversationSession.result() 按当前进度修正 status。"""

    def __init__(self, status: ResultStatus, reason: Reason | None, detail: str | None = None) -> None:
        super().__init__(detail or reason or status)
        self.status = status
        self.reason = reason
        self.detail = detail


def not_allowed(action: str) -> ActionResult:
    """白名单关闭：不调用 driver，三个标志全 false。"""
    return ActionResult(status="failed", reason="action_not_allowed", reason_detail=f"白名单未开启 {action}")


@dataclass
class ConversationSession:
    """一次会话类动作的执行过程：记录导航 / 对外动作 / 对方可见副作用、界面事实与 evidence。"""

    command: CommandModel
    driver: Driver
    ctx: ActionContext
    waiter: Waiter
    verify: bool = False
    navigated: bool = False
    outbound_done: bool = False
    visible: bool = False
    executed_at: datetime | None = None
    before: list[Fact] = field(default_factory=list)
    after: list[Fact] = field(default_factory=list)
    evidence: Evidence = field(init=False)

    def __post_init__(self) -> None:
        self.evidence = Evidence(self.ctx.clock, names=(self.conversation.candidate_name,))

    @property
    def conversation(self) -> Conversation:
        return self.command.target.conversation  # type: ignore[union-attr]

    # ---- 事实 ----

    def _fact(self, code: str, detail: str | None) -> Fact:
        return Fact(code=code, detail=self.evidence.clean(detail)[:FACT_DETAIL_MAX_CHARS] if detail else None)

    def fact_before(self, code: str, detail: str | None = None) -> None:
        if len(self.before) < 50:
            self.before.append(self._fact(code, detail))

    def fact_after(self, code: str, detail: str | None = None) -> None:
        if len(self.after) < 50:
            self.after.append(self._fact(code, detail))

    # ---- 写 ----

    def navigate(self, target: Element) -> None:
        """导航类点击（打开会话、切页签）。verify_only 下也允许。"""
        self.navigated = True
        self.driver.click(target)

    @contextmanager
    def outbound(self) -> Iterator[None]:
        """声明对外动作：转给 ctx.outbound()（core 的 ExecContext）或守卫的 outbound()。

        两者都没有时（直接用裸 Driver 调用处理器的场景）只做本地记录。verify_only 下禁止。
        """
        if self.verify:
            raise RuntimeError("verify_only 不允许对外动作")
        scope: Any = getattr(self.ctx, "outbound", None) or getattr(self.driver, "outbound", None)
        with scope() if scope is not None else nullcontext():
            if self.executed_at is None:
                self.executed_at = self.ctx.clock()
            self.outbound_done = True
            yield

    # ---- 读 ----

    def read(self) -> View:
        return read_view(self.driver)

    def stop_if_blocked(self, view: View, *, phase: str) -> None:
        blockers = detect_blockers(view)
        if blockers:
            for b in blockers:
                self.evidence.blocker(b)
                (self.fact_after if phase == "after" else self.fact_before)("unknown_dialog", b.describe())
            raise Stop("failed", "unknown_dialog", f"{phase}: {blockers[0].describe()}")

    def open_conversation(self) -> View:
        """定位并打开目标会话，返回打开后（表头已核对）的视图。失败抛 Stop。"""
        conv = self.conversation
        view = self.read()
        self.stop_if_blocked(view, phase="before")
        rows = match_rows(view, conv)
        if not rows:
            rows, view = self._search_other_lists(view)
        if len(rows) > 1:
            self.fact_before("target_ambiguous", f"命中 {len(rows)} 个会话")
            raise Stop("failed", "target_ambiguous", f"会话列表里有 {len(rows)} 行同时匹配姓名、岗位与 hints")
        if not rows:
            self.fact_before("target_not_found", "会话列表里没有同时匹配姓名、岗位与 hints 的行")
            raise Stop("failed", "target_not_found", "可见会话列表中找不到目标")
        row = rows[0]
        if row.unread(conv.candidate_name):
            # 打开未读会话会产生已读回执（capabilities.md 1.2），对方可能看到
            self.visible = True
            self.fact_before("conversation_unread")
        self.navigate(row.container)

        def opened(v: View) -> str | None:
            if detect_blockers(v):
                return "blocked"
            return "ok" if header_matches(v, conv) else None

        state, view = self.waiter.poll(self.driver, opened)
        if state == "blocked":
            self.stop_if_blocked(view, phase="before")
        if state is None:
            self.fact_before("conversation_header_mismatch")
            raise Stop("failed", "timeout", "点击会话后表头没有显示目标姓名与岗位")
        self.fact_before("conversation_opened")
        return view

    def _search_other_lists(self, view: View) -> tuple[list[ConversationRow], View]:
        """当前列表找不到时：没有会话列表就先点左侧『消息』，再依次切换页签，各读一次。"""
        conv = self.conversation
        if not find_rows(view):
            nav = find_message_nav(view)
            if nav is not None:
                self.navigate(nav)
                found, view = self.waiter.poll(
                    self.driver,
                    lambda v: (match_rows(v, conv) or None) if not detect_blockers(v) else [],
                    timeout=TAB_SWITCH_TIMEOUT_SECONDS,
                )
                self.stop_if_blocked(view, phase="before")
                if found:
                    return found, view
        for name in CONVERSATION_TABS:
            tab = find_tab(view, name)
            if tab is None:
                continue
            self.navigate(tab)
            found, view = self.waiter.poll(
                self.driver,
                lambda v: (match_rows(v, conv) or None) if not detect_blockers(v) else [],
                timeout=TAB_SWITCH_TIMEOUT_SECONDS,
            )
            self.stop_if_blocked(view, phase="before")
            if found:
                return found, view
        return [], view

    # ---- 结果 ----

    def result(self, status: ResultStatus, reason: Reason | None = None, detail: str | None = None) -> ActionResult:
        """按进度修正 status 后组装结果。

        - 已经发生对外动作后的失败（未知弹窗、超时、找不到按钮）一律改判 unknown：动作可能已生效，不能让上游重试。
        - verify_only 里除"确认没有发生"（verification_failed）之外的失败都是"无法判断"，改判 unknown。
        """
        if status == "failed" and (self.outbound_done or (self.verify and reason != "verification_failed")):
            status = "unknown"
        executed_at = self.executed_at
        if executed_at is None and status in ("succeeded", "skipped_precondition", "failed", "unknown"):
            executed_at = self.ctx.clock()
        return ActionResult(
            status=status,
            reason=None if status == "succeeded" else reason,
            reason_detail=self.evidence.clean(detail) if detail else None,
            observed=Observed(before=self.before, after=self.after),
            evidence=list(self.evidence.items),
            navigation_performed=self.navigated,
            outbound_action_performed=self.outbound_done,
            externally_visible_side_effect=self.visible or self.outbound_done,
            executed_at=executed_at,
        )

    def stopped(self, stop: Stop) -> ActionResult:
        return self.result(stop.status, stop.reason, stop.detail)


class ConversationActionHandler:
    """会话类动作处理器的骨架：白名单检查、会话打开、Stop 转结果。子类实现 _execute / _verify。"""

    action: str = ""

    def __init__(
        self,
        *,
        clock: Clock | None = None,
        timeout: float = RESULT_TIMEOUT_SECONDS,
        poll_interval: float = POLL_INTERVAL_SECONDS,
    ) -> None:
        self.waiter = Waiter(clock or SystemClock(), timeout=timeout, interval=poll_interval)

    def _check_command(self, command: CommandModel) -> ActionResult | None:
        if command.action != self.action:
            return ActionResult(
                status="failed", reason="unsupported", reason_detail=f"{self.action} 处理器收到 {command.action}"
            )
        return None

    def run(self, command: CommandModel, driver: Driver, ctx: ActionContext) -> ActionResult:
        if not ctx.is_allowed(self.action):
            return not_allowed(self.action)
        wrong = self._check_command(command)
        if wrong is not None:
            return wrong
        session = ConversationSession(command, driver, ctx, self.waiter)
        try:
            return self._execute(session)
        except Stop as stop:
            return session.stopped(stop)

    def verify_only(self, command: CommandModel, driver: Driver, ctx: ActionContext) -> ActionResult:
        wrong = self._check_command(command)
        if wrong is not None:
            return wrong
        session = ConversationSession(command, driver, ctx, self.waiter, verify=True)
        try:
            return self._verify(session)
        except Stop as stop:
            return session.stopped(stop)

    def _execute(self, session: ConversationSession) -> ActionResult:  # pragma: no cover - 子类实现
        raise NotImplementedError

    def _verify(self, session: ConversationSession) -> ActionResult:  # pragma: no cover - 子类实现
        raise NotImplementedError


def unique(elements: list[Element], what: str) -> Element:
    """要点击的控件必须唯一：0 个 → target_not_found，多个 → target_ambiguous（都不点击）。"""
    if not elements:
        raise Stop("failed", "target_not_found", f"找不到{what}")
    if len(elements) > 1:
        raise Stop("failed", "target_ambiguous", f"{what}有 {len(elements)} 个")
    return elements[0]
