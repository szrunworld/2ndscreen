"""search_candidates：在搜索页输入关键词，返回当前视口内结果卡片的快照（不识别身份）。

方案 8.4、契约 0.3.1 第五节：Monitor 只回答"有 / 没有"，并把每张结果卡片上界面已有的全部可读文本原样返回；
不翻页、不滚动加载更多、不点击任何结果卡片、不打开候选人详情、不使用道具卡。

流程：

    白名单检查（关闭 → failed/action_not_allowed，不调用 driver）
      → 读界面，有弹窗 / 遮罩 → failed/unknown_dialog，不点任何控件
      → 点左侧导航『搜索』（导航；0 个 → target_not_found，多个 → target_ambiguous，都不点击）
      → 等搜索页出现唯一的关键词输入框（上限 10 秒）
      → 输入框里有旧关键词：点输入框、cmd+a、delete，核对已清空
      → 输入关键词，核对输入框 value 等于关键词（不等 → failed/verification_failed，不提交）
      → 记下提交前的结果区签名，点输入框右侧的搜索按钮
      → 等待可识别的结果状态（上限 10 秒，注入时钟轮询；结果区与提交前不同，且连续两次读取一致）
      → 有结果：只取视口内完整可见的卡片 → succeeded，coverage=partial
        界面明确显示无结果 → succeeded，coverage=empty_confirmed
        读不到 / 超时 / 有卡片但读不出文字 → failed/unreadable，coverage=unreadable，items 为空

执行标志（用户 2026-10-04 决定，协调者转达）：搜索算对外动作。清空旧关键词、输入关键词、核对与提交都包在
ctx.outbound() 里；点左侧『搜索』入口是导航。提交后的结果三标志为 navigation / outbound / externally_visible
全 true。契约第四节"在搜索框输入关键词属于导航"的释义与 core 里 search 的特例由协调者另派任务修改，本模块不改。
输入后、提交前就失败（核对不通过等）时也已进入过 outbound，标志如实为 true；状态仍按 failed 回报
（搜索没有需要防重复的对方可见效果，重试只会多一次搜索计数）。

界面规则来自任务 B 的 search_page 夹具（BOSS直聘 1.7.4，窗口 1440×875，capabilities.md 1.6）。
输入关键词后的结果、无结果文案、加载中状态都没有观察到，相关规则是假设，见
docs/monitor/agent-reports/H2.md 第五节，留给 N 阶段核对。
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from collections.abc import Iterator
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

from monitor_contracts import (
    ActionContext,
    ActionHandler,
    ActionResult,
    CardField,
    CommandModel,
    Driver,
    Element,
    Fact,
    Observed,
    Reason,
    ResultStatus,
    SearchItem,
    SearchOutput,
    SearchSnapshot,
)

from monitor.core.clock import Clock, SystemClock
from monitor.driver.redact import redact_text

from .common import (
    FACT_DETAIL_MAX_CHARS,
    POLL_INTERVAL_SECONDS,
    RESULT_TIMEOUT_SECONDS,
    TAB_SWITCH_TIMEOUT_SECONDS,
    Evidence,
    Stop,
    View,
    Waiter,
    detect_blockers,
    norm,
    not_allowed,
    read_view,
    squash,
)

ACTION = "search_candidates"

# 左侧导航『搜索』入口（search_page#0：AXLink，label 恰为『搜索』，窗口相对 x≈6、宽 108）
SEARCH_NAV_LABEL = "搜索"
NAV_COLUMN_MAX_X = 120.0
# 关键词输入框：顶部（窗口相对 y<80）、宽度 ≥300 的 AXTextField（search_page#0：(592,32) 宽 519；城市输入框宽 66）
KEYWORD_FIELD_MAX_REL_Y = 80.0
KEYWORD_FIELD_MIN_WIDTH = 300.0
# 搜索按钮：输入框右侧 40pt 内、无 label 的 AXGroup（search_page#0：(1120,32) 92×42）
SEARCH_BUTTON_MAX_GAP = 40.0
SEARCH_BUTTON_WIDTH = (40.0, 160.0)
# 结果卡：宽 ≥500 的 AXLink（search_page#0–1：宽 1003；导航与『查看详情』宽 ≈100）
CARD_MIN_WIDTH = 500.0
# 滚出视口的元素 frame 被裁成高度 1（capabilities.md 1.6），高度不超过它的一律视为不可见
CLIPPED_HEIGHT = 1.0
# 卡片贴在视口边缘 1pt 内视为被裁切（search_page#0 第 3 张卡底边 = 窗口底边；#1 第 2 张卡顶边 = 窗口顶边）
EDGE_TOLERANCE = 1.0

# 界面明确显示无结果的文案。**未观察到**（只读阶段不允许输入），按 BOSS 常见写法推断，N 阶段核对后改为原文。
EMPTY_RESULT_PATTERN = re.compile(r"^(暂无|没有找到|未找到|没有搜到|未搜到|没有搜索到|未搜索到)\S{0,12}(牛人|结果)")
# 卡片上与道具卡相关的文案。卡片上**未观察到**这类元素（『搜索畅聊卡』在右栏，不在卡片上），按关键词推断。
PROP_CARD_PATTERN = re.compile(r"道具|畅聊|直聊|聊卡|卡券|使用\S{0,4}卡")
# 平台打码姓名：一段不含空白的文字后跟 1–4 个星号（真机『X**』，夹具替换为『候选人S1**』）
MASKED_NAME_PATTERN = re.compile(r"^[^\s*]{1,12}\*{1,4}$")
# 图标字体字符（Unicode 私用区，例如卡片上的 U+E682）不是可读文本
_PRIVATE_USE = re.compile("[-]")

FIELD_TEXT_MAX = 500
FIELDS_MAX = 60
PROP_TEXT_MAX = 200
PROP_TEXTS_MAX = 20
MASKED_NAME_MAX = 64

SearchState = Literal["results", "empty", "conflict", "blocked"]


def _role_base(el: Element) -> str:
    return el.role.split("/", 1)[0]


def readable(text: str | None) -> str:
    """卡片文本的可读部分：去掉图标字体字符，清理空白，删除手机号 / 微信号 / 邮箱（兜底，Monitor 本来就不读联系方式）。"""
    return redact_text(squash(_PRIVATE_USE.sub("", text or "")))


# ---------------------------------------------------------------------------
# 搜索页元素
# ---------------------------------------------------------------------------


def search_entries(view: View) -> list[Element]:
    """左侧导航里 label 恰为『搜索』的 AXLink。"""
    ox = view.origin[0]
    return [
        e
        for e in view.elements
        if _role_base(e) == "AXLink" and norm(e.label) == SEARCH_NAV_LABEL and e.frame.x - ox < NAV_COLUMN_MAX_X
    ]


def keyword_fields(view: View) -> list[Element]:
    return [
        e
        for e in view.elements
        if _role_base(e) == "AXTextField"
        and view.rel_y(e) < KEYWORD_FIELD_MAX_REL_Y
        and e.frame.w >= KEYWORD_FIELD_MIN_WIDTH
        and e.frame.h > CLIPPED_HEIGHT
    ]


def keyword_field(view: View) -> Element | None:
    fields = keyword_fields(view)
    return fields[0] if len(fields) == 1 else None


def field_value(view: View) -> str | None:
    """唯一关键词输入框的内容（规范化后）；输入框不唯一时为 None。占位文字是相邻的静态文本，不在 value 里。"""
    f = keyword_field(view)
    return norm(f.value) if f is not None else None


def search_buttons(view: View, field_el: Element) -> list[Element]:
    right = field_el.frame.x + field_el.frame.w
    top, bottom = field_el.frame.y, field_el.frame.y + field_el.frame.h
    lo, hi = SEARCH_BUTTON_WIDTH
    return [
        e
        for e in view.elements
        if e.role == "AXGroup"
        and not norm(e.label)
        and right - 1 <= e.frame.x <= right + SEARCH_BUTTON_MAX_GAP
        and top <= e.frame.center()[1] <= bottom
        and lo <= e.frame.w <= hi
    ]


# ---------------------------------------------------------------------------
# 结果卡
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Viewport:
    top: float
    bottom: float

    def shows(self, el: Element) -> bool:
        """元素在视口内且没有被裁成高度 1。"""
        f = el.frame
        return f.h > CLIPPED_HEIGHT and f.y + f.h > self.top and f.y < self.bottom

    def fully_shows(self, el: Element) -> bool:
        f = el.frame
        return (
            self.shows(el)
            and f.y > self.top + EDGE_TOLERANCE
            and f.y + f.h < self.bottom - EDGE_TOLERANCE
        )


def viewport(view: View) -> Viewport:
    """结果区的可见范围：取窗口的纵向范围（search_page#1 滚出的元素贴在窗口顶边 y=25）。"""
    window = view.snapshot.window
    if window is None:
        return Viewport(float("-inf"), float("inf"))
    return Viewport(window.frame.y, window.frame.y + window.frame.h)


@dataclass(frozen=True)
class ResultCard:
    """一张结果卡：AXLink 与它后面连续的子元素（深度优先展开时后代紧跟在祖先之后）。"""

    link: Element
    children: tuple[Element, ...]

    def texts(self, port: Viewport) -> list[str]:
        """卡片上可见的可读文本，按元素出现顺序（夹具里先左栏再右栏，与界面阅读顺序一致）。"""
        out = []
        for e in self.children:
            if _role_base(e) != "AXStaticText" or not port.shows(e):
                continue
            t = readable(e.value or e.label)
            if t:
                out.append(t)
        return out


def _is_card_link(el: Element) -> bool:
    return _role_base(el) == "AXLink" and el.frame.w >= CARD_MIN_WIDTH


def _belongs(card: Element, el: Element) -> bool:
    """子元素中心落在卡片框内（滚出视口的卡片与子元素都贴在同一条边上，同样成立）。容差 2pt。"""
    cx, cy = el.frame.center()
    f = card.frame
    return f.x - 2 <= cx <= f.x + f.w + 2 and f.y - 2 <= cy <= f.y + f.h + 2


def result_cards(view: View) -> list[ResultCard]:
    """当前树里全部结果卡（含滚出视口的），按树中顺序。"""
    elements = view.elements
    cards = []
    for pos, el in enumerate(elements):
        if not _is_card_link(el):
            continue
        children = []
        for child in elements[pos + 1 :]:
            if _is_card_link(child) or not _belongs(el, child):
                break
            children.append(child)
        cards.append(ResultCard(el, tuple(children)))
    return cards


def visible_cards(view: View) -> list[ResultCard]:
    """视口内的结果卡，自上而下。

    优先只取完整可见的卡片（被视口边缘裁切的卡片文字不全）；一张完整可见的都没有、但有被裁切且有可见文字的
    卡片时，退而取这些卡片的可见部分，保证"有结果"不被漏报。
    """
    port = viewport(view)
    cards = [c for c in result_cards(view) if port.shows(c.link)]
    full = [c for c in cards if port.fully_shows(c.link)]
    chosen = full or [c for c in cards if c.texts(port)]
    return sorted(chosen, key=lambda c: (c.link.frame.y, c.link.frame.x))


def empty_texts(view: View) -> list[str]:
    """视口内明确表示"无结果"的文案（规则未经真机观察，见 EMPTY_RESULT_PATTERN）。"""
    port = viewport(view)
    return [
        squash(e.value or e.label)
        for e in view.elements
        if _role_base(e) == "AXStaticText" and port.shows(e) and EMPTY_RESULT_PATTERN.match(norm(e.value or e.label))
    ]


def results_signature(view: View) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """结果区签名：全部结果卡的 label（卡片 AXLink 的 label 串联了整张卡的文字）与无结果文案。

    用来判断提交后结果区是否已经换成新内容：与提交前相同就继续等，避免把旧结果（例如热门词结果）当成新结果。
    """
    return tuple(norm(c.link.label) for c in result_cards(view)), tuple(norm(t) for t in empty_texts(view))


def card_item(card: ResultCard, port: Viewport, search_id: str, position: int) -> SearchItem | None:
    """把一张卡片转成快照条目；读不出任何文字时返回 None。"""
    texts = card.texts(port)
    if not texts:
        return None
    names = [t for t in texts if MASKED_NAME_PATTERN.match(t)]
    props = [t[:PROP_TEXT_MAX] for t in texts if PROP_CARD_PATTERN.search(t)]
    return SearchItem(
        result_ref=f"{search_id}:item_{position}",
        position=position,
        # label 只在界面上确有可见标签时填写（契约第五节）。卡片上的『期望城市』『职位』『院校』本身就是
        # 独立的静态文本，原样按顺序放进 fields，不自行配对或命名。
        fields=[CardField(text=t[:FIELD_TEXT_MAX]) for t in texts[:FIELDS_MAX]],
        masked_name=names[0][:MASKED_NAME_MAX] if len(names) == 1 else None,
        prop_card_texts=props[:PROP_TEXTS_MAX],
    )


def classify(view: View) -> SearchState | None:
    """一次读取的结果区状态；None 表示还认不出（加载中、旧结果未刷新、只有滚出视口的卡片）。"""
    if detect_blockers(view):
        return "blocked"
    cards = visible_cards(view)
    empty = empty_texts(view)
    if cards and empty:
        return "conflict"
    if cards:
        return "results"
    if empty:
        return "empty"
    return None


# ---------------------------------------------------------------------------
# 执行过程
# ---------------------------------------------------------------------------


@dataclass
class SearchSession:
    command: CommandModel
    driver: Driver
    ctx: ActionContext
    waiter: Waiter
    navigated: bool = False
    outbound_done: bool = False
    in_outbound: bool = False
    executed_at: datetime | None = None
    before: list[Fact] = field(default_factory=list)
    after: list[Fact] = field(default_factory=list)
    evidence: Evidence = field(init=False)

    def __post_init__(self) -> None:
        # 打码姓名不是身份，搜索没有需要替换的候选人姓名；Evidence 仍会删除手机号 / 微信号 / 邮箱
        self.evidence = Evidence(self.ctx.clock)

    @property
    def search_id(self) -> str:
        return self.command.payload.search_id  # type: ignore[union-attr]

    @property
    def query(self) -> str:
        return self.command.payload.query  # type: ignore[union-attr]

    @property
    def max_results(self) -> int:
        return self.command.payload.max_results  # type: ignore[union-attr]

    def _fact(self, code: str, detail: str | None) -> Fact:
        return Fact(code=code, detail=self.evidence.clean(detail)[:FACT_DETAIL_MAX_CHARS] if detail else None)

    def fact_before(self, code: str, detail: str | None = None) -> None:
        if len(self.before) < 50:
            self.before.append(self._fact(code, detail))

    def fact_after(self, code: str, detail: str | None = None) -> None:
        if len(self.after) < 50:
            self.after.append(self._fact(code, detail))

    # ---- 写：outbound() 块外是导航（点『搜索』入口），块内是对外动作（输入与提交） ----

    def _wrote(self) -> None:
        if not self.in_outbound:
            self.navigated = True

    def click(self, target: Element) -> None:
        self._wrote()
        self.driver.click(target)

    def type_text(self, target: Element, text: str) -> None:
        self._wrote()
        self.driver.type_text(target, text)

    def key(self, keys: str) -> None:
        self._wrote()
        self.driver.key(keys)

    @contextmanager
    def outbound(self) -> Iterator[None]:
        """声明对外动作：转给 ctx.outbound()（core 的 ExecContext）或守卫的 outbound()；
        两者都没有时（直接用裸 Driver 调用处理器）只做本地记录。与 H1 的 ConversationSession.outbound 相同。"""
        scope: Any = getattr(self.ctx, "outbound", None) or getattr(self.driver, "outbound", None)
        with scope() if scope is not None else nullcontext():
            self.outbound_done = True
            self.in_outbound = True
            try:
                yield
            finally:
                self.in_outbound = False

    # ---- 读 ----

    def read(self) -> View:
        return read_view(self.driver)

    def stop_if_blocked(self, view: View, *, phase: Literal["before", "after"]) -> None:
        blockers = detect_blockers(view)
        if blockers:
            for b in blockers:
                self.evidence.blocker(b)
                (self.fact_after if phase == "after" else self.fact_before)("unknown_dialog", b.describe())
            raise Stop("failed", "unknown_dialog", f"{phase}: {blockers[0].describe()}")

    # ---- 结果 ----

    def snapshot(self, coverage: str, items: Iterable[SearchItem] = (), unreadable_reason: str | None = None) -> SearchOutput:
        return SearchOutput(
            snapshot=SearchSnapshot(
                search_id=self.search_id,
                query=self.query,
                scope="current_page",
                coverage=coverage,  # type: ignore[arg-type]
                unreadable_reason=unreadable_reason,
                items=list(items),
                captured_at=self.ctx.clock(),
            )
        )

    def result(
        self,
        status: ResultStatus,
        reason: Reason | None = None,
        detail: str | None = None,
        output: SearchOutput | None = None,
    ) -> ActionResult:
        executed_at = self.executed_at
        if executed_at is None and status in ("succeeded", "failed", "unknown"):
            executed_at = self.ctx.clock()
        return ActionResult(
            status=status,
            reason=None if status == "succeeded" else reason,
            reason_detail=self.evidence.clean(detail) if detail else None,
            observed=Observed(before=self.before, after=self.after),
            evidence=list(self.evidence.items),
            navigation_performed=self.navigated,
            outbound_action_performed=self.outbound_done,
            externally_visible_side_effect=self.outbound_done,
            executed_at=executed_at,
            output=output,
        )

    def unreadable(self, why: str, code: str = "search_unreadable") -> ActionResult:
        """读不出结果：failed/unreadable，快照 coverage=unreadable、items 为空（读取失败不得回报为空列表）。"""
        self.fact_after(code, why)
        return self.result("failed", "unreadable", why, self.snapshot("unreadable", unreadable_reason=why))


class SearchCandidatesHandler:
    """search_candidates 的 ActionHandler。不是会话类动作，不使用 ConversationSession。"""

    action = ACTION

    def __init__(
        self,
        *,
        clock: Clock | None = None,
        timeout: float = RESULT_TIMEOUT_SECONDS,
        poll_interval: float = POLL_INTERVAL_SECONDS,
    ) -> None:
        self.waiter = Waiter(clock or SystemClock(), timeout=timeout, interval=poll_interval)

    def run(self, command: CommandModel, driver: Driver, ctx: ActionContext) -> ActionResult:
        if not ctx.is_allowed(self.action):
            return not_allowed(self.action)
        if command.action != self.action:
            return ActionResult(
                status="failed", reason="unsupported", reason_detail=f"{self.action} 处理器收到 {command.action}"
            )
        session = SearchSession(command, driver, ctx, self.waiter)
        try:
            return self._execute(session)
        except Stop as stop:
            return session.result(stop.status, stop.reason, stop.detail)

    def verify_only(self, command: CommandModel, driver: Driver, ctx: ActionContext) -> ActionResult:
        """契约规定 search_candidates 只能 execute。崩溃恢复也会走到这里：搜索没有可复核的界面状态，
        不调用 driver，回报 unsupported（管线会改判为 unknown/crash_recovery）。"""
        return ActionResult(
            status="failed", reason="unsupported", reason_detail="search_candidates 没有可复核的界面状态，不支持 verify_only"
        )

    # ---- 步骤 ----

    def _execute(self, s: SearchSession) -> ActionResult:
        view = self._open_search_page(s)
        field_el = keyword_field(view)
        assert field_el is not None
        # 进入对外动作前先确认搜索按钮存在，避免输入了却提交不了
        self._search_button(s, view, field_el)
        with s.outbound():
            self._enter_keyword(s, view)
            before = self._submit(s)
        return self._read_results(s, before)

    def _open_search_page(self, s: SearchSession) -> View:
        view = s.read()
        s.stop_if_blocked(view, phase="before")
        entries = search_entries(view)
        if not entries:
            s.fact_before("target_not_found", "左侧导航没有『搜索』入口")
            raise Stop("failed", "target_not_found", "找不到左侧导航『搜索』入口")
        if len(entries) > 1:
            s.fact_before("target_ambiguous", f"左侧导航有 {len(entries)} 个『搜索』入口")
            raise Stop("failed", "target_ambiguous", f"左侧导航『搜索』入口有 {len(entries)} 个")
        s.click(entries[0])

        def ready(v: View) -> str | None:
            if detect_blockers(v):
                return "blocked"
            return "ok" if keyword_field(v) is not None else None

        state, view = s.waiter.poll(s.driver, ready)
        if state == "blocked":
            s.stop_if_blocked(view, phase="before")
        if state is None:
            count = len(keyword_fields(view))
            s.fact_before("search_page_not_ready", f"关键词输入框 {count} 个")
            reason: Reason = "target_ambiguous" if count > 1 else "timeout"
            raise Stop("failed", reason, f"点『搜索』后没有出现唯一的关键词输入框（{count} 个）")
        s.fact_before("search_page_opened")
        return view

    def _enter_keyword(self, s: SearchSession, view: View) -> None:
        """清空旧关键词、输入新关键词，并核对输入框 value 等于关键词。"""
        field_el = keyword_field(view)
        assert field_el is not None
        old = norm(field_el.value)
        if old:
            s.fact_before("search_keyword_present", old)
            s.click(field_el)
            s.key("cmd+a")
            s.key("delete")
            cleared, view = s.waiter.poll(
                s.driver,
                lambda v: "ok" if field_value(v) == "" else None,
                timeout=TAB_SWITCH_TIMEOUT_SECONDS,
            )
            s.stop_if_blocked(view, phase="before")
            if cleared is None:
                s.fact_before("search_keyword_not_cleared", field_value(view))
                raise Stop("failed", "verification_failed", "关键词输入框里的旧内容没有清空，未输入、未提交")
            s.fact_before("search_keyword_cleared")
            field_el = keyword_field(view)
            assert field_el is not None

        s.type_text(field_el, s.query)
        want = norm(s.query)
        matched, view = s.waiter.poll(
            s.driver,
            lambda v: "ok" if field_value(v) == want else None,
            timeout=TAB_SWITCH_TIMEOUT_SECONDS,
        )
        s.stop_if_blocked(view, phase="before")
        if matched is None:
            got = field_value(view)
            s.fact_before("search_keyword_mismatch", f"输入框内容为『{got}』" if got is not None else "输入框不唯一")
            raise Stop("failed", "verification_failed", "输入后关键词输入框的内容与关键词不一致，未提交")
        s.fact_before("search_keyword_entered", want)

    def _search_button(self, s: SearchSession, view: View, field_el: Element) -> Element:
        buttons = search_buttons(view, field_el)
        if not buttons:
            s.fact_before("target_not_found", "关键词输入框右侧没有搜索按钮")
            raise Stop("failed", "target_not_found", "找不到关键词输入框右侧的搜索按钮")
        if len(buttons) > 1:
            s.fact_before("target_ambiguous", f"关键词输入框右侧有 {len(buttons)} 个候选搜索按钮")
            raise Stop("failed", "target_ambiguous", f"搜索按钮有 {len(buttons)} 个")
        return buttons[0]

    def _submit(self, s: SearchSession) -> tuple:
        """提交前复核输入框，记下结果区签名后点搜索按钮。返回提交前的签名。"""
        view = s.read()
        s.stop_if_blocked(view, phase="before")
        current = keyword_field(view)
        if current is None or field_value(view) != norm(s.query):
            s.fact_before("search_keyword_mismatch", "提交前复核输入框内容不一致")
            raise Stop("failed", "verification_failed", "提交前复核：关键词输入框的内容与关键词不一致，未提交")
        button = self._search_button(s, view, current)
        before = results_signature(view)
        s.executed_at = s.ctx.clock()
        s.click(button)
        s.fact_after("search_submitted")
        return before

    def _read_results(self, s: SearchSession, before: tuple) -> ActionResult:
        last: list[tuple[SearchState, tuple]] = []

        def settled(v: View) -> SearchState | None:
            # 弹窗立即返回；其余状态要求结果区已与提交前不同，并且连续两次读取的签名一致（避免读到刷新中的半截列表）
            state = classify(v)
            if state == "blocked":
                return state
            sig = results_signature(v)
            if state is None or sig == before:
                last.clear()
                return None
            if last and last[-1] == (state, sig):
                return state
            last[:] = [(state, sig)]
            return None

        state, view = s.waiter.poll(s.driver, settled)
        if state == "blocked":
            s.stop_if_blocked(view, phase="after")
        if state is None:
            cards = len(result_cards(view))
            s.evidence.add(f"提交后 {self.waiter.timeout:g} 秒内结果区没有出现可识别的新状态（树中结果卡 {cards} 张）")
            return s.unreadable("等待结果超时：结果区没有出现可识别的新状态", code="search_result_timeout")
        if state == "conflict":
            for t in empty_texts(view):
                s.evidence.add(t)
            return s.unreadable("同时出现结果卡与无结果文案，无法判断")
        if state == "empty":
            for t in empty_texts(view):
                s.evidence.add(t)
                s.fact_after("search_empty_confirmed", t)
            return s.result("succeeded", output=s.snapshot("empty_confirmed"))
        return self._results(s, view)

    def _results(self, s: SearchSession, view: View) -> ActionResult:
        port = viewport(view)
        cards = visible_cards(view)
        items = []
        for card in cards[: s.max_results]:
            item = card_item(card, port, s.search_id, len(items) + 1)
            if item is None:
                # 有卡片却读不出文字（例如结果是图片）：不能回报部分结果，整体按读不出处理
                return s.unreadable(f"第 {len(items) + 1} 张结果卡没有可读文字")
            items.append(item)
        s.fact_after("search_results_visible", f"视口内 {len(cards)} 张，返回 {len(items)} 张")
        s.evidence.add(f"视口内结果卡 {len(cards)} 张，返回 {len(items)} 张（不翻页、不滚动）")
        # 不翻页、不滚动，无法确认是否已看到全部结果：一律 partial
        return s.result("succeeded", output=s.snapshot("partial", items))


def create_handlers(*, clock: Clock) -> list[ActionHandler]:
    """monitor.actions.create_handlers() 通过 EXTENSION_MODULES 自动装载。"""
    return [SearchCandidatesHandler(clock=clock)]
