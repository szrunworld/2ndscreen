"""NewApplicationObserver：基线、新投递识别、歧义、只读约束与上报。

夹具来自任务 B（monitor/fixtures/ax）。合成场景（改时间文案、改名制造同名等）在本文件里由夹具派生，
不修改夹具文件本身。FakeDriver 只回放夹具：夹具通过不等于真机通过。
"""

from __future__ import annotations

import copy
import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from monitor_contracts import (
    Baseline,
    Locator,
    Observer,
    compute_event_id,
    validate_device_heartbeat,
    validate_event,
)

from monitor.core.guard import GuardedDriver
from monitor.driver import Advance, FakeDriver
from monitor.observe import (
    BASELINE_PENDING,
    NAVIGATION_BLOCKED,
    NOT_READY,
    UNSUPPORTED,
    NewApplicationObserver,
    conversation_fingerprint,
    create_observer,
)

AX = Path(__file__).resolve().parents[2] / "fixtures" / "ax"
SH = ZoneInfo("Asia/Shanghai")
ACCOUNT = "acct-test"
DEVICE = "dev-test"
NEW_TAB = Locator(text_contains="新招呼")

# new_application_marker#0（新招呼 504）各行的元素下标：行容器、姓名组、姓名文本、岗位组、时间、预览
NAM0_ROWS = {
    "候选人B": (51, 54, 55, 56, 53, 58),
    "候选人C": (59, 62, 63, 64, 61, 66),
    "候选人D": (67, 70, 71, 72, 69, 74),
    "候选人G": (91, 94, 95, 96, 93, 98),
}


def local(*args: int) -> datetime:
    return datetime(*args, tzinfo=SH)


def raw(scene: str) -> dict[str, Any]:
    return json.loads((AX / scene / "fixture.json").read_text())


def step_of(scene: str, index: int, mutate: Callable[[dict[str, Any]], None] | None = None) -> dict[str, Any]:
    step = copy.deepcopy(raw(scene)["steps"][index])
    if mutate is not None:
        mutate(step)
    return step


def compose(*steps: dict[str, Any]) -> dict[str, Any]:
    """用若干步骤拼一个夹具（沿用 new_application_marker 的头部）。"""
    data = raw("new_application_marker")
    data["steps"] = list(steps)
    return data


def set_time(row: str, text: str) -> Callable[[dict[str, Any]], None]:
    def mutate(step: dict[str, Any]) -> None:
        step["elements"][NAM0_ROWS[row][4]]["value"] = text

    return mutate


def rename(row: str, name: str) -> Callable[[dict[str, Any]], None]:
    def mutate(step: dict[str, Any]) -> None:
        _, group, text, *_ = NAM0_ROWS[row]
        step["elements"][group]["label"] = name
        step["elements"][text]["value"] = name

    return mutate


def chain(*mutations: Callable[[dict[str, Any]], None]) -> Callable[[dict[str, Any]], None]:
    def mutate(step: dict[str, Any]) -> None:
        for m in mutations:
            m(step)

    return mutate


class Clock:
    def __init__(self, now: datetime) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


class Reports:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str | None]] = []

    def __call__(self, code: str, message: str, scene: str | None) -> None:
        # 与 MonitorRuntime.record_error 同签名；上报内容必须能放进 heartbeat.last_error
        validate_device_heartbeat(heartbeat_with(code, message, scene))
        self.calls.append((code, message, scene))

    def codes(self) -> list[tuple[str, str | None]]:
        return [(c, s) for c, _, s in self.calls]


def heartbeat_with(code: str, message: str, scene: str | None) -> dict[str, Any]:
    return {
        "device_id": DEVICE,
        "sent_at": "2026-10-04T19:20:00+08:00",
        "mode": "local",
        "account_id": ACCOUNT,
        "client_state": "running",
        "paused": False,
        "pause_reason": None,
        "needs_baseline": False,
        "current_action": None,
        "queue": {"queued_commands": 0, "undelivered_results": 0, "outbox_events": 0},
        "last_error": {"code": code, "message": message, "scene": scene, "at": "2026-10-04T19:20:00+08:00"},
        "monitor_version": "0.1.0",
    }


def make_observer(now: datetime, **kwargs: Any) -> tuple[NewApplicationObserver, Clock, Reports]:
    clock, reports = Clock(now), Reports()
    kwargs.setdefault("device_id", DEVICE)
    obs = create_observer(report=reports, clock=clock, **kwargs)
    return obs, clock, reports


def established(baseline_at: datetime, initial: tuple[str, ...] = ()) -> Baseline:
    """已建立的基线（直接构造，用于只测识别规则）。"""
    return Baseline(
        account_id=ACCOUNT,
        established=True,
        generation=1,
        data={
            "version": 1,
            "baseline_at": baseline_at.astimezone(UTC).isoformat(),
            "initial": {conversation_fingerprint(n, j): 1 for n, j in initial},
            "emitted": {},
            "ambiguous": {},
            "reported": [],
        },
    )


def assert_only_tab_clicks(driver: FakeDriver) -> None:
    """观察器唯一的写操作是点击『新招呼』页签。"""
    for call in driver.writes:
        assert call.method == "click"
        assert call.element is not None and call.element.label.startswith("新招呼")
        assert call.element.role == "AXGroup"


def names(events: list[Any], kind: str = "application_observed") -> list[str]:
    return [e.conversation.candidate_name for e in events if e.kind == kind]


# ---------------------------------------------------------------------------
# 基本形态
# ---------------------------------------------------------------------------


def test_create_observer_satisfies_protocol() -> None:
    obs = create_observer()
    assert isinstance(obs, Observer)
    assert obs.device_id is None
    obs.attach(device_id=DEVICE)
    assert obs.device_id == DEVICE


def test_naive_clock_rejected() -> None:
    obs = create_observer(device_id=DEVICE, clock=lambda: datetime(2026, 10, 4, 19, 20))
    with pytest.raises(ValueError):
        obs.observe(FakeDriver(compose(step_of("new_application_marker", 0))), Baseline(account_id=ACCOUNT))


# ---------------------------------------------------------------------------
# 基线
# ---------------------------------------------------------------------------


def test_first_observe_only_builds_baseline_after_switching_tab() -> None:
    # 起点在『全部』页签；点『新招呼』后进入新招呼列表
    driver = FakeDriver(
        compose(step_of("conversation_list", 0), step_of("new_application_marker", 0)),
        advances=[Advance(method="click", target=NEW_TAB, goto=1)],
    )
    obs, _, reports = make_observer(local(2026, 10, 4, 19, 10, 30))
    baseline = Baseline(account_id=ACCOUNT)
    assert obs.observe(driver, baseline) == []
    assert baseline.established
    assert baseline.updated_at == local(2026, 10, 4, 19, 10, 30)
    assert datetime.fromisoformat(baseline.data["baseline_at"]) == local(2026, 10, 4, 19, 10, 30)
    assert len(baseline.data["initial"]) == 10
    assert driver.count() == 1
    assert_only_tab_clicks(driver)
    assert reports.calls == []
    json.dumps(baseline.data)  # 基线数据必须可 JSON 序列化（core 落库）
    # 基线里不存明文姓名
    assert "候选人" not in json.dumps(baseline.data, ensure_ascii=False)


def test_baseline_on_empty_list() -> None:
    driver = FakeDriver(compose(step_of("conversation_list", 4)))
    obs, _, _ = make_observer(local(2026, 10, 4, 19, 10))
    baseline = Baseline(account_id=ACCOUNT)
    assert obs.observe(driver, baseline) == []
    assert baseline.established and baseline.data["initial"] == {}


def test_new_arrival_after_baseline_produces_one_event() -> None:
    """基线建在 504，之后新到候选人L（19:11）：只对L产生 application_observed。"""
    driver = FakeDriver(compose(step_of("new_application_marker", 0), step_of("new_application_marker", 1)))
    obs, clock, reports = make_observer(local(2026, 10, 4, 19, 10, 30))
    baseline = Baseline(account_id=ACCOUNT)
    assert obs.observe(driver, baseline) == []

    driver.goto(1)
    clock.now = local(2026, 10, 4, 19, 12)
    events = obs.observe(driver, baseline)
    assert names(events) == ["候选人L"]
    ev = events[0]
    assert ev.account_id == ACCOUNT and ev.device_id == DEVICE
    assert ev.conversation.job_title == "Vue 前端 研发工程师"
    assert ev.conversation.hints == []
    assert ev.bucket == "2026-10-04T11:11Z"
    assert ev.event_id == compute_event_id(ACCOUNT, "application_observed", ev.conversation, ev.bucket)
    assert ev.payload.marker_text == "新招呼(505)"
    assert any("候选人L" in item.text for item in ev.payload.evidence)
    assert validate_event(ev.to_wire()) == ev
    assert reports.calls == []
    assert_only_tab_clicks(driver)

    # 再观察一次：不重复
    clock.now = local(2026, 10, 4, 19, 13)
    assert obs.observe(driver, baseline) == []


def test_same_conversation_yields_same_event_id_across_observations() -> None:
    """同一会话在两次独立观察（例如进程重启、基线数据回滚）中得到同一个 event_id。"""
    driver = FakeDriver(compose(step_of("new_application_marker", 1)))
    first, _, _ = make_observer(local(2026, 10, 4, 19, 12, 5))
    second, _, _ = make_observer(local(2026, 10, 4, 19, 14, 50))
    ev1 = first.observe(driver, established(local(2026, 10, 4, 19, 10, 30)))
    ev2 = second.observe(driver, established(local(2026, 10, 4, 19, 10, 30)))
    assert names(ev1) == names(ev2) == ["候选人L"]
    assert ev1[0].event_id == ev2[0].event_id
    assert ev1[0].observed_at != ev2[0].observed_at


def test_all_annotated_new_applications_are_detected() -> None:
    """夹具标注 is_new_application 的行，在基线早于它们时全部产生 application_observed。"""
    for step in (0, 1):
        ann = raw("new_application_marker")["steps"][step]["annotations"]["conversations"]
        expected = [c["conversation"]["candidate_name"] for c in ann if c["is_new_application"]]
        driver = FakeDriver(compose(step_of("new_application_marker", step)))
        obs, _, reports = make_observer(local(2026, 10, 4, 19, 20))
        events = obs.observe(driver, established(local(2026, 10, 4, 16, 0)))
        assert names(events) == expected
        assert reports.calls == []
        # 识别结果与标注的会话身份（姓名 + 岗位）一致
        assert [(e.conversation.candidate_name, e.conversation.job_title) for e in events] == [
            (c["conversation"]["candidate_name"], c["conversation"]["job_title"]) for c in ann
        ]


def test_backlog_older_than_baseline_time_is_ignored() -> None:
    driver = FakeDriver(compose(step_of("new_application_marker", 0)))
    obs, _, reports = make_observer(local(2026, 10, 4, 19, 20))
    events = obs.observe(driver, established(local(2026, 10, 4, 17, 30)))
    # 基线 17:30：只有 19:03、18:10、17:52、17:31 四行晚于基线
    assert names(events) == ["候选人B", "候选人C", "候选人D", "候选人E"]
    assert reports.calls == []


def test_rows_visible_at_baseline_never_emit() -> None:
    initial = (("候选人B", "Vue 前端 研发工程师"), ("候选人C", "Vue 前端 研发工程师"))
    driver = FakeDriver(compose(step_of("new_application_marker", 0)))
    obs, _, _ = make_observer(local(2026, 10, 4, 19, 20))
    events = obs.observe(driver, established(local(2026, 10, 4, 17, 0), initial))
    # B、C 基线时已可见（即使消息时间晚于基线也不产生）；K 16:52 早于基线
    assert names(events) == ["候选人D", "候选人E", "候选人F", "候选人G", "候选人H", "候选人I", "候选人J"]


@pytest.mark.parametrize(
    ("text", "emits"),
    [
        ("19:15", True),
        ("18:00", False),  # 早于基线：历史积压
        ("19:10", False),  # 与基线同一分钟：按积压
        ("昨天", False),
        ("昨天 23:59", False),
        ("10月3日", False),
        ("10月4日", False),  # 与基线同一天、只有日期：无法判断，不产生、也不按不支持上报
    ],
)
def test_newly_exposed_row_uses_message_time(text: str, emits: bool) -> None:
    """基线之后露出一个基线时不可见的会话（候选人X）：按列表上的消息时间判断。"""
    step = step_of("new_application_marker", 0, chain(rename("候选人B", "候选人X"), set_time("候选人B", text)))
    driver = FakeDriver(compose(step))
    obs, _, reports = make_observer(local(2026, 10, 4, 19, 20))
    initial = tuple((n, "Vue 前端 研发工程师") for n in ("候选人C", "候选人D", "候选人E", "候选人F", "候选人I",
                                                     "候选人J", "候选人K"))
    initial += (("候选人G", "视觉算法工程师"), ("候选人H", "视觉算法工程师"))
    events = obs.observe(driver, established(local(2026, 10, 4, 19, 10, 30), initial))
    assert names(events) == (["候选人X"] if emits else [])
    assert reports.calls == []


def test_unparseable_time_is_uncertain_and_reported_once() -> None:
    step = step_of("new_application_marker", 0, set_time("候选人B", "周三"))
    driver = FakeDriver(compose(step))
    obs, clock, reports = make_observer(local(2026, 10, 4, 19, 20))
    baseline = established(local(2026, 10, 4, 16, 0))
    events = obs.observe(driver, baseline)
    assert "候选人B" not in names(events)
    assert len(names(events)) == 9
    assert reports.codes() == [(UNSUPPORTED, "conversation_list")]
    assert "周三" in reports.calls[0][1]

    clock.now += timedelta(minutes=1)
    assert obs.observe(driver, baseline) == []
    assert len(reports.calls) == 1  # 同一呈现只上报一次


def test_unread_but_not_new_greeting_does_not_emit() -> None:
    """『全部』页签里的未读会话（候选人L）不在『新招呼』里：不产生新投递。"""
    driver = FakeDriver(
        compose(step_of("conversation_list", 0), step_of("new_application_marker", 0)),
        advances=[Advance(method="click", target=NEW_TAB, goto=1)],
    )
    obs, _, _ = make_observer(local(2026, 10, 4, 19, 20))
    events = obs.observe(driver, established(local(2026, 10, 4, 16, 0)))
    assert "候选人L" not in names(events)
    assert len(events) == 10
    assert_only_tab_clicks(driver)


def test_replied_row_is_not_new() -> None:
    """我方已回复（预览带『[送达]』/『[已读]』前缀）的行不是新招呼。"""

    def replied(step: dict[str, Any]) -> None:
        step["elements"][NAM0_ROWS["候选人C"][5]]["value"] = "[送达]"

    driver = FakeDriver(compose(step_of("new_application_marker", 0, replied)))
    obs, _, _ = make_observer(local(2026, 10, 4, 19, 20))
    events = obs.observe(driver, established(local(2026, 10, 4, 16, 0)))
    assert "候选人C" not in names(events) and len(events) == 9


def test_emitted_records_are_pruned_after_retention() -> None:
    driver = FakeDriver(compose(step_of("new_application_marker", 1)))
    obs, clock, _ = make_observer(local(2026, 10, 4, 19, 20))
    baseline = established(local(2026, 10, 4, 19, 10, 30))
    assert names(obs.observe(driver, baseline)) == ["候选人L"]
    assert len(baseline.data["emitted"]) == 1
    # 40 天后（会话早已不在列表里），记录被清理
    clock.now = local(2026, 11, 13, 9, 0)
    driver2 = FakeDriver(compose(step_of("conversation_list", 4)))
    assert obs.observe(driver2, baseline) == []
    assert baseline.data["emitted"] == {}


# ---------------------------------------------------------------------------
# 歧义
# ---------------------------------------------------------------------------


def test_same_name_same_job_yields_ambiguity_not_application() -> None:
    step = step_of("new_application_marker", 0, rename("候选人C", "候选人B"))
    driver = FakeDriver(compose(step))
    obs, clock, _ = make_observer(local(2026, 10, 4, 19, 20))
    baseline = established(local(2026, 10, 4, 16, 0))
    events = obs.observe(driver, baseline)
    amb = [e for e in events if e.kind == "conversation_ambiguous"]
    assert len(amb) == 1
    assert "候选人B" not in names(events)
    ev = amb[0]
    assert (ev.conversation.candidate_name, ev.conversation.job_title) == ("候选人B", "Vue 前端 研发工程师")
    assert ev.payload.match_count == 2
    assert [(c.position, c.hints) for c in ev.payload.candidates] == [(0, ["19:03"]), (1, ["18:10"])]
    assert ev.bucket == "2026-10-04T11:03Z"  # 取歧义行中最新的消息时间
    assert validate_event(ev.to_wire()) == ev
    assert len(names(events)) == 8

    clock.now += timedelta(minutes=1)
    assert obs.observe(driver, baseline) == []  # 不重复


def test_same_name_different_job_is_not_ambiguous() -> None:
    step = step_of("new_application_marker", 0, rename("候选人G", "候选人B"))  # G 的岗位是视觉算法工程师
    driver = FakeDriver(compose(step))
    obs, _, _ = make_observer(local(2026, 10, 4, 19, 20))
    events = obs.observe(driver, established(local(2026, 10, 4, 16, 0)))
    assert not [e for e in events if e.kind == "conversation_ambiguous"]
    assert names(events).count("候选人B") == 2


def test_new_row_with_same_name_as_baseline_row_is_ambiguous() -> None:
    """基线时已可见的候选人B 与新露出的同名同岗位行同时可见：歧义。"""
    step = step_of("new_application_marker", 0, chain(rename("候选人C", "候选人B"), set_time("候选人C", "19:15")))
    driver = FakeDriver(compose(step))
    obs, _, _ = make_observer(local(2026, 10, 4, 19, 20))
    initial = (("候选人B", "Vue 前端 研发工程师"),)
    events = obs.observe(driver, established(local(2026, 10, 4, 19, 10, 30), initial))
    assert [e.kind for e in events] == ["conversation_ambiguous"]


def test_ambiguity_among_backlog_rows_only_is_silent() -> None:
    step = step_of("new_application_marker", 0, rename("候选人C", "候选人B"))
    driver = FakeDriver(compose(step))
    obs, _, _ = make_observer(local(2026, 10, 4, 19, 20))
    assert obs.observe(driver, established(local(2026, 10, 4, 19, 10))) == []


# ---------------------------------------------------------------------------
# 页面与只读约束
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("scene", "step", "scene_code"),
    [
        ("resume_overlay", 1, "resume_overlay"),
        ("attachment_entry", 4, "attachment_preview"),
        ("search_page", 0, "search"),
    ],
)
def test_known_non_list_pages_do_not_navigate(scene: str, step: int, scene_code: str) -> None:
    driver = FakeDriver(compose(step_of(scene, step)))
    obs, _, reports = make_observer(local(2026, 10, 4, 19, 20))
    # 已建立基线：静默返回空
    assert obs.observe(driver, established(local(2026, 10, 4, 16, 0))) == []
    assert reports.calls == []
    # 未建立基线：返回空，上报一次"无法建立基线"（core 会一直等基线，需要可见）
    baseline = Baseline(account_id=ACCOUNT)
    assert obs.observe(driver, baseline) == []
    assert obs.observe(driver, baseline) == []
    assert not baseline.established
    assert reports.codes() == [(BASELINE_PENDING, scene_code)]
    assert driver.count() == 0


def test_unknown_page_returns_empty_and_reports_unsupported_once() -> None:
    def strip_tabs(step: dict[str, Any]) -> None:
        for el in step["elements"]:
            el["label"] = "" if el["role"] == "AXGroup" else el["label"]

    driver = FakeDriver(compose(step_of("conversation_list", 0, strip_tabs)))
    obs, _, reports = make_observer(local(2026, 10, 4, 19, 20))
    baseline = Baseline(account_id=ACCOUNT)
    assert obs.observe(driver, baseline) == []
    assert obs.observe(driver, baseline) == []
    assert reports.codes() == [(UNSUPPORTED, "unknown")]
    assert driver.count() == 0
    assert not baseline.established


def test_popup_blocks_navigation() -> None:
    driver = FakeDriver(compose(step_of("attachment_entry", 1)))
    obs, _, reports = make_observer(local(2026, 10, 4, 19, 20))
    assert obs.observe(driver, established(local(2026, 10, 4, 16, 0))) == []
    assert driver.count() == 0
    assert reports.codes() == [(UNSUPPORTED, "conversation_detail")]


def test_detail_page_switches_tab_without_opening_conversations() -> None:
    """会话详情页（左侧仍有列表）：只点页签，读左侧列表，不点任何会话行。"""
    driver = FakeDriver(
        compose(step_of("conversation_detail", 2), step_of("new_application_marker", 0)),
        advances=[Advance(method="click", target=NEW_TAB, goto=1)],
    )
    obs, _, _ = make_observer(local(2026, 10, 4, 19, 20))
    events = obs.observe(driver, established(local(2026, 10, 4, 16, 0)))
    assert len(events) == 10
    assert driver.count() == 1
    assert_only_tab_clicks(driver)


def test_page_after_navigation_must_be_list() -> None:
    driver = FakeDriver(
        compose(step_of("conversation_list", 0), step_of("resume_overlay", 1)),
        advances=[Advance(method="click", target=NEW_TAB, goto=1)],
    )
    obs, _, reports = make_observer(local(2026, 10, 4, 19, 20))
    baseline = Baseline(account_id=ACCOUNT)
    assert obs.observe(driver, baseline) == []
    assert not baseline.established
    assert reports.codes() == [(UNSUPPORTED, "resume_overlay")]
    assert driver.count() == 1


def test_menu_still_open_after_navigation_is_unsupported() -> None:
    driver = FakeDriver(compose(step_of("conversation_list", 5)))  # 点击后菜单仍展开
    obs, _, reports = make_observer(local(2026, 10, 4, 19, 20))
    assert obs.observe(driver, established(local(2026, 10, 4, 16, 0))) == []
    assert reports.codes() == [(UNSUPPORTED, "conversation_list")]


def test_row_shape_issue_is_reported_but_other_rows_still_processed() -> None:
    def drop_job(step: dict[str, Any]) -> None:
        step["elements"][NAM0_ROWS["候选人C"][3]]["label"] = ""

    driver = FakeDriver(compose(step_of("new_application_marker", 0, drop_job)))
    obs, _, reports = make_observer(local(2026, 10, 4, 19, 20))
    events = obs.observe(driver, established(local(2026, 10, 4, 16, 0)))
    assert len(events) == 9 and "候选人C" not in names(events)
    assert reports.codes() == [(UNSUPPORTED, "conversation_list")]


def test_read_only_guard_blocks_tab_click_and_is_reported() -> None:
    """core 目前以 read_only 守卫调用观察：点击被拒 → 返回空、上报，不建基线。"""
    fake = FakeDriver(compose(step_of("new_application_marker", 0)))
    guarded = GuardedDriver(fake, mode="read_only")
    obs, _, reports = make_observer(local(2026, 10, 4, 19, 20))
    baseline = Baseline(account_id=ACCOUNT)
    assert obs.observe(guarded, baseline) == []
    assert obs.observe(guarded, baseline) == []
    assert not baseline.established
    assert fake.count() == 0
    assert reports.codes() == [(NAVIGATION_BLOCKED, "conversation_list")]


def test_verify_guard_allows_tab_navigation_only() -> None:
    """改用 verify 守卫（允许导航、禁止输入与对外动作）后正常工作，且只有一次导航。"""
    fake = FakeDriver(compose(step_of("new_application_marker", 0), step_of("new_application_marker", 1)))
    guarded = GuardedDriver(fake, mode="verify")
    obs, clock, _ = make_observer(local(2026, 10, 4, 19, 10, 30))
    baseline = Baseline(account_id=ACCOUNT)
    assert obs.observe(guarded, baseline) == []
    fake.goto(1)
    clock.now = local(2026, 10, 4, 19, 12)
    assert names(obs.observe(guarded, baseline)) == ["候选人L"]
    assert guarded.navigation_calls == 2 and guarded.outbound_calls == 0
    assert_only_tab_clicks(fake)


def test_driver_errors_propagate_to_core() -> None:
    from monitor_contracts import WindowLostError

    driver = FakeDriver(compose(step_of("new_application_marker", 0)))
    driver.fail_next("state", WindowLostError("窗口不见了"))
    obs, _, _ = make_observer(local(2026, 10, 4, 19, 20))
    with pytest.raises(WindowLostError):
        obs.observe(driver, Baseline(account_id=ACCOUNT))


# ---------------------------------------------------------------------------
# 装配与基线数据
# ---------------------------------------------------------------------------


def test_missing_device_id_holds_events_until_attached() -> None:
    driver = FakeDriver(compose(step_of("new_application_marker", 1)))
    reports = Reports()
    obs = create_observer(clock=Clock(local(2026, 10, 4, 19, 20)))
    baseline = established(local(2026, 10, 4, 19, 10, 30))
    assert obs.observe(driver, baseline) == []
    assert [i.code for i in obs.issues] == [NOT_READY]  # 未注入回调时记在 issues
    obs.attach(device_id=DEVICE, report=reports)
    assert names(obs.observe(driver, baseline)) == ["候选人L"]  # 没有因此丢事件


def test_unbound_account_does_not_emit() -> None:
    driver = FakeDriver(compose(step_of("new_application_marker", 1)))
    obs, _, reports = make_observer(local(2026, 10, 4, 19, 20))
    baseline = established(local(2026, 10, 4, 19, 10, 30))
    baseline.account_id = None
    assert obs.observe(driver, baseline) == []
    assert reports.codes() == [(NOT_READY, "conversation_list")]


def test_unestablished_baseline_without_account_can_still_be_built() -> None:
    driver = FakeDriver(compose(step_of("new_application_marker", 0)))
    obs, _, _ = make_observer(local(2026, 10, 4, 19, 10))
    baseline = Baseline()
    assert obs.observe(driver, baseline) == []
    assert baseline.established


def test_foreign_baseline_data_is_rebuilt_not_trusted() -> None:
    """未知格式的基线数据（例如 core 的测试替身写的）不沿用：重新建基线，不产生事件。"""
    driver = FakeDriver(compose(step_of("new_application_marker", 1)))
    obs, _, _ = make_observer(local(2026, 10, 4, 19, 20))
    baseline = Baseline(account_id=ACCOUNT, established=True, data={"rows": 0})
    assert obs.observe(driver, baseline) == []
    assert baseline.established and baseline.data["version"] == 1
    assert len(baseline.data["initial"]) == 10


def test_established_flag_without_baseline_time_is_rebuilt() -> None:
    driver = FakeDriver(compose(step_of("new_application_marker", 1)))
    obs, _, _ = make_observer(local(2026, 10, 4, 19, 20))
    baseline = Baseline(account_id=ACCOUNT, established=True, data={"version": 1})
    assert obs.observe(driver, baseline) == []
    assert "baseline_at" in baseline.data
