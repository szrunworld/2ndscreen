"""search_candidates 处理器测试：FakeDriver 回放 search_page 夹具，用 Advance 把"点『搜索』/ 输入 / 提交后"切到派生步骤。

真实夹具（任务 B）：search_page#0 进入搜索页、未输入关键词（热门词结果，3 张卡，第 3 张被窗口底边裁切）；
search_page#1 结果区滚动 10 格后（第 1–2 张滚出视口、frame 高度 1 或贴顶，第 7 张被底边裁切）。
输入关键词后的结果、无结果文案、加载中状态都**没有观察到**，下面的派生步骤是 H2 的假设，
真机形态以 N 阶段为准（见 docs/monitor/agent-reports/H2.md 第五节）。
"""

from __future__ import annotations

import copy
import importlib.util
import sys
import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from monitor_contracts import ActionHandler, DriverError, Frame, Locator, validate_command

from monitor.actions import create_handlers
from monitor.actions.common import detect_blockers
from monitor.actions.search import (
    SearchCandidatesHandler,
    classify,
    keyword_field,
    readable,
    result_cards,
    search_buttons,
    search_entries,
    visible_cards,
)
from monitor.core import ManualClock
from monitor.driver import Advance, FakeDriver


def _helpers():
    name = "h1_action_test_helpers"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name("test_actions_common.py"))
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


h = _helpers()

ACTION = "search_candidates"
QUERY = "前端开发"
SEARCH_ID = "srch_001"

# search_page#0 的元素位置（夹具全局坐标）
KEYWORD_FIELD = Frame(x=3952, y=57, w=519, h=40)
SEARCH_BUTTON = Locator(role="AXGroup", region=Frame(x=4480, y=57, w=92, h=42))
SEARCH_NAV = Locator(text="搜索", role="AXLink")
CARD_RANGES = {1: range(220, 243), 2: range(243, 272), 3: range(272, 278)}  # 每张卡：AXLink + 子元素


def base():
    return h.raw_step("search_page", 0)


def scrolled():
    return h.raw_step("search_page", 1)


def _is_keyword_field(e):
    f = e["frame"]
    return e["role"] == "AXTextField" and f["w"] == KEYWORD_FIELD.w and f["y"] < 120


def with_keyword(step, value, label=None):
    """关键词输入框的 value 改为 value（其余不变）。"""
    new = h.derive(step, label or f"输入框={value!r}")
    for e in new["elements"]:
        if _is_keyword_field(e):
            e["value"] = value
    return new


def _card_indexes(*cards):
    return {i for c in cards for i in CARD_RANGES[c]}


def drop_cards(step, *cards, label=None, add=()):
    """删掉 search_page#0 的若干张卡（按原夹具 index），add 追加在末尾。"""
    gone = _card_indexes(*cards)
    return h.derive(step, label or f"去掉卡片{cards}", drop=lambda e: e["index"] in gone, add=add)


def insert_after(step, index, elements, label):
    """在原夹具第 index 个元素后面插入元素（卡片子元素必须紧跟在卡片 AXLink 之后，与树的展开顺序一致）。"""
    new = copy.deepcopy(step)
    pos = next(p for p, e in enumerate(new["elements"]) if e["index"] == index)
    new["elements"][pos + 1 : pos + 1] = [copy.deepcopy(e) for e in elements]
    return h.derive(new, label)


def searched(step=None, *, query=QUERY):
    """提交后的派生结果：热门词结果换成搜索结果（这里只剩候选人S1 一张卡，结果区签名因此与提交前不同）。"""
    step = step or base()
    return with_keyword(drop_cards(step, 2, 3), query, "搜索结果")


def empty_page(step=None, text="没有找到相关牛人"):
    """假设的无结果界面：卡片全部消失，结果区出现一行无结果文案（**未观察到**）。"""
    step = step or base()
    return with_keyword(drop_cards(step, 1, 2, 3, add=[h.text(step, text, (177, 480, 140, 16))]), QUERY, "无结果")


def flow_steps(after, *, start=None, typed_value=QUERY):
    """[搜索页（空输入框）, 已输入, 提交后]，以及对应的 Advance。"""
    start = start or base()
    steps = [start, with_keyword(start, typed_value, "已输入"), after]
    advances = [
        Advance("type_text", on_step=0, goto=1),
        Advance("click", on_step=1, target=SEARCH_BUTTON, goto=2),
    ]
    return steps, advances


def command(payload=None):
    return validate_command(
        {
            "command_id": str(uuid.uuid4()),
            "workflow_id": None,
            "account_id": "acct-1",
            "action": ACTION,
            "execution_mode": "execute",
            "target": {"scope": "current_page"},
            "payload": payload or {"search_id": SEARCH_ID, "query": QUERY, "max_results": 20},
            "issued_at": (h.START - timedelta(minutes=1)).isoformat(),
            "expires_at": (h.START + timedelta(minutes=10)).isoformat(),
            "depends_on": None,
        }
    )


def run(steps, *, advances=(), allowed=(ACTION,), payload=None, clock=None, driver=None):
    clock = clock or ManualClock(h.START)
    driver = driver or h.fake(steps, advances=advances, clock=clock)
    guard, ctx = h.context(driver, clock, allowed=allowed)
    cmd = command(payload)
    result = SearchCandidatesHandler(clock=clock).run(cmd, guard, ctx)
    result.to_command_result(cmd, reported_at=clock.now())  # 契约跨字段规则（succeeded 必带 snapshot 等）
    return result, driver, guard, clock


def snap(result):
    return result.output.snapshot if result.output is not None else None


def clicked(driver):
    return [c.element for c in driver.writes if c.method == "click"]


def submit_clicks(driver):
    return [e for e in clicked(driver) if e.role == "AXGroup" and e.frame.x == SEARCH_BUTTON.region.x]


def assert_search_outbound(result, guard, *, outbound_calls, navigation_calls=1):
    """搜索算对外动作（用户 2026-10-04 决定）：点『搜索』入口是导航，清空、输入、提交都在 outbound 里。"""
    assert result.navigation_performed == (navigation_calls > 0)
    assert result.outbound_action_performed and result.externally_visible_side_effect
    assert (guard.navigation_calls, guard.outbound_calls) == (navigation_calls, outbound_calls)


# ---------------------------------------------------------------------------
# 页面识别（真实夹具）
# ---------------------------------------------------------------------------


def test_real_fixture_page_elements():
    for step in (base(), scrolled()):
        view = h.view_of(step)
        assert detect_blockers(view) == []  # 搜索页上只有窗口按钮，不会被误判为弹窗
        assert [e.label for e in search_entries(view)] == ["搜索"]
        field = keyword_field(view)
        assert field is not None and field.frame.w == 519 and field.value == ""  # 『编程』是占位文字，不在 value 里
        assert len(search_buttons(view, field)) == 1


def test_real_fixture_step0_reads_two_fully_visible_cards():
    view = h.view_of(base())
    assert len(result_cards(view)) == 3
    cards = visible_cards(view)  # 第 3 张底边贴着窗口底边（被裁切），不取
    assert [c.link.label.split()[1] for c in cards] == ["候选人S1**", "候选人S2**"]
    assert classify(view) == "results"


def test_real_fixture_step1_filters_scrolled_out_and_clipped_cards():
    view = h.view_of(scrolled())
    assert len(result_cards(view)) == 7
    names = [c.link.label.split()[1] for c in visible_cards(view)]
    assert names == ["候选人S3**", "候选人S4**", "候选人S5**", "候选人S6**"]  # S1、S2 滚出（高度 1 / 贴顶），S7 被裁切


# ---------------------------------------------------------------------------
# 有结果
# ---------------------------------------------------------------------------


def test_success_from_message_page_navigates_types_and_submits():
    start = h.raw_step("conversation_list", 0)
    b = base()
    steps = [start, b, with_keyword(b, QUERY, "已输入"), searched(b)]
    advances = [
        Advance("click", on_step=0, target=SEARCH_NAV, goto=1),
        Advance("type_text", on_step=1, goto=2),
        Advance("click", on_step=2, target=SEARCH_BUTTON, goto=3),
    ]
    result, driver, guard, clock = run(steps, advances=advances)
    assert result.status == "succeeded" and result.reason is None
    s = snap(result)
    assert (s.coverage, s.outcome, s.scope, s.query, s.search_id) == ("partial", "results", "current_page", QUERY, SEARCH_ID)
    assert len(s.items) == 1
    item = s.items[0]
    assert (item.result_ref, item.position, item.masked_name) == (f"{SEARCH_ID}:item_1", 1, "候选人S1**")
    texts = [f.text for f in item.fields]
    assert texts[:3] == ["候选人S1**", "热搜", "刚刚活跃"]  # 图标字体字符 U+E682 不算可读文本
    assert "期望城市" in texts and "计算机科学与技术" in texts and texts[-1] == "该牛人"
    assert all(f.label is None for f in item.fields)  # 不自行配对或命名
    assert item.prop_card_texts == []
    # 写调用：点『搜索』、输入关键词、点搜索按钮；没有点任何结果卡片
    assert [c.method for c in driver.writes] == ["click", "type_text", "click"]
    assert driver.writes[1].args["text"] == QUERY
    assert len(submit_clicks(driver)) == 1
    assert not any(e.role.startswith("AXLink") and e.frame.w >= 500 for e in clicked(driver))
    assert driver.count("scroll") == 0
    assert_search_outbound(result, guard, outbound_calls=2)
    assert result.executed_at is not None and result.executed_at <= clock.now()


def test_success_on_scrolled_page_returns_only_visible_cards_in_order():
    # 提交后的界面直接用真实 search_page#1（滚出与裁切的卡片在树里），输入框换成关键词
    steps, advances = flow_steps(with_keyword(scrolled(), QUERY, "提交后（滚动形态）"))
    result, _, _, _ = run(steps, advances=advances)
    s = snap(result)
    assert result.status == "succeeded" and s.coverage == "partial"
    assert [i.masked_name for i in s.items] == ["候选人S3**", "候选人S4**", "候选人S5**", "候选人S6**"]
    assert [i.position for i in s.items] == [1, 2, 3, 4]
    assert [i.result_ref for i in s.items] == [f"{SEARCH_ID}:item_{n}" for n in range(1, 5)]
    assert "45-50K" in [f.text for f in s.items[0].fields]


def test_max_results_truncates():
    steps, advances = flow_steps(with_keyword(scrolled(), QUERY, "提交后"))
    result, _, _, _ = run(steps, advances=advances, payload={"search_id": SEARCH_ID, "query": QUERY, "max_results": 2})
    assert [i.masked_name for i in snap(result).items] == ["候选人S3**", "候选人S4**"]
    assert snap(result).coverage == "partial"


def test_only_clipped_card_still_reports_results_with_visible_part():
    # 只剩被底边裁切的第 3 张：没有完整可见的卡片时退而取可见部分，保证"有结果"不漏报
    b = base()
    steps, advances = flow_steps(with_keyword(drop_cards(b, 1, 2), QUERY, "只剩裁切卡"))
    result, _, _, _ = run(steps, advances=advances)
    s = snap(result)
    assert result.status == "succeeded" and s.coverage == "partial"
    assert [[f.text for f in i.fields] for i in s.items] == [["候选人S3**", "热搜", "今日活跃"]]


def test_prop_card_texts_on_card():
    b = base()
    extra = [h.text(b, "畅聊卡可用", (420, 485, 70, 14))]
    # 先删掉第 2、3 张卡（它们排在第 1 张之后，第 1 张的 index 不变），再紧跟第 1 张卡最后一个子元素（242）插入
    after = with_keyword(insert_after(drop_cards(b, 2, 3), 242, extra, "卡片带道具卡文案"), QUERY, "提交后")
    steps, advances = flow_steps(after)
    result, _, _, _ = run(steps, advances=advances)
    s = snap(result)
    assert result.status == "succeeded"
    item = s.items[0]
    texts = [f.text for f in item.fields]
    assert "畅聊卡可用" in texts and item.prop_card_texts == ["畅聊卡可用"]  # 同时留在 fields 里


def test_readable_strips_icon_glyphs_and_contacts():
    # 夹具校验不允许出现手机号，所以兜底删除只能直接测：快照里不能出现手机号样式的 11 位数字（契约会拒绝）
    assert readable("\ue682 候选人S1** ") == "候选人S1**"
    assert "13812345678" not in readable("电话13812345678")
    assert readable("\ue682") == ""


def test_waits_through_loading_until_results_are_stable():
    """提交后先是"加载中"（卡片消失、无文案），几次读取后才出现结果；不能把加载中当成无结果或读不到。"""
    b = base()
    loading = with_keyword(drop_cards(b, 1, 2, 3), QUERY, "加载中")
    steps = [b, with_keyword(b, QUERY, "已输入"), loading, searched(b)]
    advances = [Advance("type_text", on_step=0, goto=1), Advance("click", on_step=1, target=SEARCH_BUTTON, goto=2)]
    clock = ManualClock(h.START)
    driver = _SwitchAfterReads(h.fake(steps, advances=advances, clock=clock), on_step=2, reads=4, goto=3)
    result, _, _, _ = run(steps, clock=clock, driver=driver)
    assert result.status == "succeeded" and len(snap(result).items) == 1


def test_stale_hot_word_results_are_not_taken_as_new_results():
    """提交后前几次读取仍是提交前的热门词结果（签名不变），必须继续等，直到结果区换成新内容。"""
    b = base()
    typed = with_keyword(b, QUERY, "已输入")
    steps = [b, typed, with_keyword(b, QUERY, "提交后仍是旧结果"), searched(b)]
    advances = [Advance("type_text", on_step=0, goto=1), Advance("click", on_step=1, target=SEARCH_BUTTON, goto=2)]
    clock = ManualClock(h.START)
    driver = _SwitchAfterReads(h.fake(steps, advances=advances, clock=clock), on_step=2, reads=3, goto=3)
    result, _, _, _ = run(steps, clock=clock, driver=driver)
    assert [i.masked_name for i in snap(result).items] == ["候选人S1**"]  # 不是旧结果里的 S1+S2


class _SwitchAfterReads:
    """包一层 FakeDriver：在 on_step 上读了 reads 次之后自动切到 goto（模拟界面随时间刷新，无需写调用）。"""

    def __init__(self, inner: FakeDriver, *, on_step: int, reads: int, goto: int):
        self.inner, self.on_step, self.reads, self.target = inner, on_step, reads, goto
        self.seen = 0

    def state(self, include_tree=False):
        if self.inner.step_index == self.on_step:
            self.seen += 1
            if self.seen > self.reads:
                self.inner.goto(self.target)
        return self.inner.state(include_tree)

    def __getattr__(self, name):
        return getattr(self.inner, name)


# ---------------------------------------------------------------------------
# 旧关键词与输入核对
# ---------------------------------------------------------------------------


def test_old_keyword_is_cleared_before_typing():
    b = base()
    steps = [with_keyword(b, "java", "旧关键词"), with_keyword(b, "", "已清空"), with_keyword(b, QUERY, "已输入"), searched(b)]
    advances = [
        Advance("key", on_step=0, when=lambda c: c.args["keys"] == "delete", goto=1),
        Advance("type_text", on_step=1, goto=2),
        Advance("click", on_step=2, target=SEARCH_BUTTON, goto=3),
    ]
    result, driver, guard, _ = run(steps, advances=advances)
    assert result.status == "succeeded"
    calls = [(c.method, c.args.get("keys")) for c in driver.writes]
    assert calls == [("click", None), ("click", None), ("key", "cmd+a"), ("key", "delete"), ("type_text", None), ("click", None)]
    assert driver.writes[1].element.role == "AXTextField"  # 先点输入框再全选删除
    codes = [f.code for f in result.observed.before]
    assert "search_keyword_present" in codes and "search_keyword_cleared" in codes
    assert_search_outbound(result, guard, outbound_calls=5)  # 点输入框、cmd+a、delete、输入、提交


def test_old_keyword_not_cleared_fails_without_typing():
    b = base()
    result, driver, guard, _ = run([with_keyword(b, "java", "旧关键词删不掉")])
    assert (result.status, result.reason) == ("failed", "verification_failed")
    assert result.output is None
    assert driver.count("type_text") == 0 and submit_clicks(driver) == []
    assert "search_keyword_not_cleared" in [f.code for f in result.observed.before]
    assert_search_outbound(result, guard, outbound_calls=3)  # 已进入 outbound（清空属于输入），标志如实为 true


def test_typed_value_mismatch_fails_without_submit():
    steps, advances = flow_steps(searched(), typed_value=QUERY + "x")
    result, driver, guard, _ = run(steps, advances=advances)
    assert (result.status, result.reason) == ("failed", "verification_failed")
    assert result.output is None
    assert driver.count("type_text") == 1 and submit_clicks(driver) == []
    assert "search_keyword_mismatch" in [f.code for f in result.observed.before]
    assert_search_outbound(result, guard, outbound_calls=1)  # 只输入、没提交；状态仍是 failed（可安全重试）


def test_typing_has_no_effect_fails_without_submit():
    result, driver, _, clock = run([base()])  # 输入后 value 仍为空
    assert (result.status, result.reason) == ("failed", "verification_failed")
    assert submit_clicks(driver) == []
    assert clock.now() - h.START <= timedelta(seconds=10)


# ---------------------------------------------------------------------------
# 无结果（派生场景：无结果文案未观察到）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("wording", ["没有找到相关牛人", "暂无符合条件的牛人", "未搜索到相关结果"])
def test_empty_confirmed(wording):
    steps, advances = flow_steps(empty_page(text=wording))
    result, _, guard, _ = run(steps, advances=advances)
    s = snap(result)
    assert result.status == "succeeded" and result.reason is None
    assert (s.coverage, s.outcome, s.items, s.unreadable_reason) == ("empty_confirmed", "no_results", [], None)
    assert any(wording in i.text for i in result.evidence)
    assert_search_outbound(result, guard, outbound_calls=2)


def test_cards_and_empty_text_together_is_unreadable():
    b = base()
    after = with_keyword(drop_cards(b, 2, 3, add=[h.text(b, "没有找到相关牛人", (177, 700, 140, 16))]), QUERY, "矛盾")
    steps, advances = flow_steps(after)
    result, _, _, _ = run(steps, advances=advances)
    assert (result.status, result.reason, snap(result).coverage) == ("failed", "unreadable", "unreadable")


# ---------------------------------------------------------------------------
# 读不到 / 超时
# ---------------------------------------------------------------------------


def _assert_unreadable(result):
    s = snap(result)
    assert (result.status, result.reason) == ("failed", "unreadable")
    assert (s.coverage, s.outcome, s.items) == ("unreadable", "unreadable", [])
    assert s.unreadable_reason


def test_timeout_when_result_area_never_changes():
    steps, advances = flow_steps(with_keyword(base(), QUERY, "提交后无变化"))
    result, driver, guard, clock = run(steps, advances=advances)
    _assert_unreadable(result)
    assert "超时" in snap(result).unreadable_reason
    assert "search_result_timeout" in [f.code for f in result.observed.after]
    assert len(submit_clicks(driver)) == 1  # 不重复提交
    assert timedelta(seconds=10) <= clock.now() - h.START <= timedelta(seconds=11)
    assert_search_outbound(result, guard, outbound_calls=2)


def test_no_cards_and_no_empty_text_is_unreadable():
    steps, advances = flow_steps(with_keyword(drop_cards(base(), 1, 2, 3), QUERY, "什么都没有"))
    result, _, _, _ = run(steps, advances=advances)
    _assert_unreadable(result)


def test_cards_without_readable_text_are_unreadable():
    """结果卡在但没有任何静态文本（例如结果是图片）：不能回报部分结果，也不能当成空。"""
    b = base()
    texts = {i for i in _card_indexes(1, 2, 3) if b["elements"][i]["role"] == "AXStaticText"}
    after = with_keyword(h.derive(b, "卡片无文字", drop=lambda e: e["index"] in texts), QUERY, "卡片无文字")
    steps, advances = flow_steps(after)
    result, _, _, _ = run(steps, advances=advances)
    _assert_unreadable(result)


def test_only_scrolled_out_cards_is_unreadable():
    """树里只剩滚出视口的第 1 张卡（高度 1）：视口内什么都读不到。"""
    s1 = scrolled()
    gone = {e["index"] for e in s1["elements"] if 269 <= e["index"] <= 414}  # 第 2 张（顶边裁切）到第 7 张
    after = with_keyword(h.derive(s1, "只剩滚出的卡片", drop=lambda e: e["index"] in gone), QUERY, "只剩滚出的卡片")
    steps, advances = flow_steps(after)
    result, _, _, _ = run(steps, advances=advances)
    _assert_unreadable(result)


# ---------------------------------------------------------------------------
# 入口、弹窗、白名单
# ---------------------------------------------------------------------------


def test_ambiguous_search_entry_does_not_click():
    b = base()
    dup = h.el(b, "AXLink", (6, 580, 108, 42), label="搜索")
    result, driver, _, _ = run([h.derive(b, "两个搜索入口", add=[dup])])
    assert (result.status, result.reason) == ("failed", "target_ambiguous")
    assert driver.count() == 0 and result.output is None
    assert not result.navigation_performed


def test_missing_search_entry():
    b = base()
    result, driver, _, _ = run([h.derive(b, "没有搜索入口", drop=lambda e: e["index"] == 15)])
    assert (result.status, result.reason) == ("failed", "target_not_found")
    assert driver.count() == 0


def test_search_page_never_appears_is_timeout():
    start = h.raw_step("conversation_list", 0)
    result, driver, _, _ = run([start])  # 点了『搜索』但界面不变
    assert (result.status, result.reason) == ("failed", "timeout")
    assert driver.count() == 1 and driver.count("type_text") == 0
    assert result.navigation_performed and result.output is None


def test_missing_search_button_fails_before_typing():
    b = base()
    result, driver, _, _ = run([h.derive(b, "没有搜索按钮", drop=lambda e: e["index"] == 38)])
    assert (result.status, result.reason) == ("failed", "target_not_found")
    assert driver.count("type_text") == 0


def test_dialog_before_start_touches_nothing():
    b = base()
    bubble = h.dialog(b, "今日搜索次数已达上限", ["知道了"], x=600, y=400)
    result, driver, _, _ = run([h.derive(b, "弹窗", add=bubble)])
    assert (result.status, result.reason) == ("failed", "unknown_dialog")
    assert driver.count() == 0


def test_dialog_after_submit_is_not_clicked():
    b = base()
    after = with_keyword(h.derive(b, "提交后弹窗", add=h.dialog(b, "今日搜索次数已达上限", ["知道了"], x=600, y=400)), QUERY)
    steps, advances = flow_steps(after)
    result, driver, guard, _ = run(steps, advances=advances)
    assert (result.status, result.reason) == ("failed", "unknown_dialog")
    assert not any(e.role == "AXButton" for e in clicked(driver))
    assert "unknown_dialog" in [f.code for f in result.observed.after]
    assert_search_outbound(result, guard, outbound_calls=2)


def test_whitelist_closed_never_touches_driver():
    clock = ManualClock(h.START)
    driver = h.fake([base()], clock=clock)
    driver.fail_next("state", DriverError("不应读取界面"))  # 连 state 都不能调用
    result, _, guard, _ = run([base()], allowed=("send_greeting",), driver=driver, clock=clock)
    assert (result.status, result.reason) == ("failed", "action_not_allowed")
    assert driver.count() == 0 and driver.calls == []
    assert guard.outbound_calls == 0 and guard.navigation_calls == 0
    assert not (result.navigation_performed or result.outbound_action_performed or result.externally_visible_side_effect)


def test_driver_error_is_left_to_pipeline():
    steps, advances = flow_steps(searched())
    clock = ManualClock(h.START)
    driver = h.fake(steps, advances=advances, clock=clock)
    driver.fail_next("type_text", DriverError("cli failed"))
    with pytest.raises(DriverError):
        run(steps, driver=driver, clock=clock)


def test_verify_only_is_unsupported_without_driver():
    clock = ManualClock(h.START)
    driver = h.fake([base()], clock=clock)
    guard, ctx = h.context(driver, clock, allowed=(), verify=True)
    result = SearchCandidatesHandler(clock=clock).verify_only(command(), guard, ctx)
    assert (result.status, result.reason) == ("failed", "unsupported")
    assert driver.calls == []


def test_wrong_action_is_unsupported():
    clock = ManualClock(h.START)
    driver = h.fake([base()], clock=clock)
    guard, ctx = h.context(driver, clock, allowed=(ACTION,))
    cmd = h.command("send_greeting", h.CONV_P, {"text": "你好"})
    result = SearchCandidatesHandler(clock=clock).run(cmd, guard, ctx)
    assert (result.status, result.reason) == ("failed", "unsupported") and driver.count() == 0


# ---------------------------------------------------------------------------
# 注册与接入 D2
# ---------------------------------------------------------------------------


def test_registered_through_create_handlers():
    handlers = {hd.action: hd for hd in create_handlers(clock=ManualClock(h.START))}
    assert isinstance(handlers[ACTION], SearchCandidatesHandler)
    assert isinstance(handlers[ACTION], ActionHandler)


def _runtime_command(env, payload=None):
    now = env.clock.now()
    return {
        "command_id": str(uuid.uuid4()),
        "workflow_id": None,
        "account_id": env.cmd("request_resume")["account_id"],
        "action": ACTION,
        "execution_mode": "execute",
        "target": {"scope": "current_page"},
        "payload": payload or {"search_id": SEARCH_ID, "query": QUERY, "max_results": 20},
        "issued_at": now.isoformat(),
        "expires_at": (now + timedelta(minutes=10)).isoformat(),
        "depends_on": None,
    }


def test_runtime_end_to_end_success():
    steps, advances = flow_steps(searched())
    env, driver = h._runtime_env(steps, advances, allowed=[ACTION])
    cmd = _runtime_command(env)
    env.server.enqueue(cmd)
    result = h._result_of(env, cmd)
    assert result["status"] == "succeeded" and result["reason"] is None
    snapshot = result["output"]["snapshot"]
    assert snapshot["coverage"] == "partial" and snapshot["items"][0]["masked_name"] == "候选人S1**"
    assert result["navigation_performed"]
    assert result["outbound_action_performed"] and result["externally_visible_side_effect"]
    assert len(submit_clicks(driver)) == 1


def test_runtime_unreadable_reports_failed_with_snapshot():
    steps, advances = flow_steps(with_keyword(base(), QUERY, "提交后无变化"))
    env, _ = h._runtime_env(steps, advances, allowed=[ACTION])
    cmd = _runtime_command(env)
    env.server.enqueue(cmd)
    result = h._result_of(env, cmd)
    assert (result["status"], result["reason"]) == ("failed", "unreadable")
    assert result["output"]["snapshot"]["coverage"] == "unreadable" and result["output"]["snapshot"]["items"] == []


def test_runtime_whitelist_closed():
    env, driver = h._runtime_env([base()], (), allowed=["request_resume"])
    cmd = _runtime_command(env)
    env.server.enqueue(cmd)
    result = h._result_of(env, cmd)
    assert (result["status"], result["reason"]) == ("failed", "action_not_allowed")
    assert driver.count() == 0
    assert not (result["navigation_performed"] or result["outbound_action_performed"])


@pytest.mark.xfail(
    strict=True,
    reason="等待 core/契约跟进：用户 2026-10-04 决定搜索算对外动作，core write_flags 仍把 search 当作"
    "『成功不含对外动作』（崩溃恢复复核成功时 outbound=false）",
)
def test_core_treats_search_success_as_outbound():
    from monitor.core.write_flags import success_is_outbound

    assert success_is_outbound(ACTION)
