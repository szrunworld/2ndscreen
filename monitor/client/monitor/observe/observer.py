"""新投递观察器：实现契约 Observer Protocol（observe(driver, baseline) -> list[Event]）。

规则（用户 2026-10-04 确认，见任务 E 说明与 monitor-spec 8.1）：

1. 新投递 = 『新招呼(N)』页签里的会话。『全部』页签没有行级标记，不用于识别。
2. 列表只暴露最新约 10 行、后台滚动无效：每次只读当前可见行，不滚动。
3. 基线按时间：baseline.established=False 时记录基线时间与当时可见行的指纹，只建基线、不产生事件。
   之后露出的会话，列表上的最近消息时间早于基线时间的视为历史积压，不产生事件。
   时间文案无法解析 → 不确定：不产生事件，并上报一次 unsupported_presentation（scene=conversation_list）。
4. 只读：唯一允许的写操作是点击『新招呼』页签（导航）。绝不打开会话（会产生已读回执），
   绝不读取附件 PDF 预览的文字层（识别到预览页立即返回）。
5. 同一岗位下同名会话 → conversation_ambiguous，不产生 application_observed。
6. event_id 用 compute_event_id；bucket 用列表上该会话的消息时间（规范化到分钟）。
7. 无法分类的页面返回空并上报 unsupported_presentation，不猜。
8. 本版不产生 attachment_available、contact_exchange_updated。

页签的选中态在辅助功能树里不可见（capabilities.md 1.2），无法判断当前是哪个页签，
所以每次观察都先点一次『新招呼』页签，再读列表。

"上报"指写入 device_heartbeat.last_error：观察器通过注入的 report(code, message, scene) 回调交给 core；
同一呈现在同一代基线内只上报一次（去重键存在 baseline.data 里）。没有注入回调时只记在 issues 里。
"""

from __future__ import annotations

import hashlib
import json
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, tzinfo
from typing import Any
from zoneinfo import ZoneInfo

from monitor_contracts import (
    Baseline,
    Driver,
    EventModel,
    Snapshot,
    compute_event_id,
    validate_event,
)

from monitor.core.guard import ReadOnlyViolation

from .page import (
    LIST_PAGES,
    Layout,
    PageKind,
    classify_page,
    has_popup,
    is_new_greeting_tab,
    more_menu_open,
    new_greeting_tab,
)
from .rows import ListRow, parse_rows
from .timetext import ListTime, parse_list_time, time_shape

DEFAULT_TIMEZONE = "Asia/Shanghai"
DATA_VERSION = 1
# 已产生事件的会话指纹保留多久（列表只展示近 30 天的联系人）
EMITTED_RETENTION = timedelta(days=35)
MAX_REPORTED_KEYS = 200

# 上报码（device_heartbeat.last_error.code）
UNSUPPORTED = "unsupported_presentation"
NAVIGATION_BLOCKED = "observe_navigation_blocked"
BASELINE_PENDING = "observe_baseline_pending"
NOT_READY = "observe_not_ready"

ReportFn = Callable[[str, str, str | None], None]
Clock = Callable[[], datetime]


@dataclass(frozen=True)
class Issue:
    """一次上报（已按"只报一次"去重）。"""

    code: str
    message: str
    scene: str | None


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _nfc(text: str) -> str:
    return unicodedata.normalize("NFC", text.strip())


def conversation_fingerprint(candidate_name: str, job_title: str) -> str:
    """会话指纹：姓名 + 岗位的哈希（基线里不存明文姓名）。"""
    material = json.dumps([_nfc(candidate_name), _nfc(job_title)], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:24]


def _floor_minute(at: datetime) -> datetime:
    return at.replace(second=0, microsecond=0)


def classify_against_baseline(when: ListTime, baseline_at: datetime) -> str:
    """消息时间相对基线时间："new"（晚于基线）/ "backlog"（早于基线）/ "uncertain"（无法判断）。

    分钟精度：晚于基线所在分钟才算新；与基线同一分钟按积压处理（不猜）。
    日精度：晚于基线所在日期才算新；早于则积压；同一天无法判断先后，按不确定处理。
    """
    local_base = baseline_at.astimezone(when.start.tzinfo)
    if when.precision == "minute":
        return "new" if when.start > _floor_minute(local_base) else "backlog"
    base_day = local_base.date()
    if when.local_date > base_day:
        return "new"
    if when.local_date < base_day:
        return "backlog"
    return "uncertain"


class NewApplicationObserver:
    """从『新招呼』页签的可见行识别新投递。

    依赖注入：
    - device_id：事件的 device_id（契约必填）。可在构造时给出，或由 core 装配时调用 attach()。
    - report：上报回调，签名与 MonitorRuntime.record_error(code, message, scene) 相同。
    - clock：当前时间（带时区），测试注入固定时间。
    - timezone：客户端显示时间所用的时区。
    """

    def __init__(
        self,
        *,
        device_id: str | None = None,
        report: ReportFn | None = None,
        clock: Clock = _utcnow,
        timezone: str | tzinfo = DEFAULT_TIMEZONE,
    ) -> None:
        self.device_id = device_id
        self._report = report
        self.clock = clock
        self.tz: tzinfo = ZoneInfo(timezone) if isinstance(timezone, str) else timezone
        self.issues: list[Issue] = []

    def attach(self, *, device_id: str | None = None, report: ReportFn | None = None) -> None:
        """由 core 在装配时注入 device_id 与上报回调（create_observer() 不带参数时使用）。"""
        if device_id is not None:
            self.device_id = device_id
        if report is not None:
            self._report = report

    # ------------------------------------------------------------------
    # Observer Protocol
    # ------------------------------------------------------------------
    def observe(self, driver: Driver, baseline: Baseline) -> list[EventModel]:
        now = self.clock()
        if now.tzinfo is None:
            raise ValueError("clock() 必须返回带时区的时间")
        data = self._data(baseline)

        snap = driver.state()
        page = classify_page(snap)
        if not self._ready_for_tab(snap, page, baseline, data):
            return []
        layout = Layout.of(snap)
        assert layout is not None  # LIST_PAGES 的分类已保证可换算坐标
        tab = new_greeting_tab(snap, layout)
        if tab is None:
            self._issue(data, UNSUPPORTED, f"{page.value}: 找不到唯一的『新招呼』页签", page.value, key=f"tab:{page}")
            return []
        if not is_new_greeting_tab(tab, snap, layout):  # 防御：只点页签控件
            return []
        try:
            driver.click(tab)
        except ReadOnlyViolation:
            self._issue(
                data, NAVIGATION_BLOCKED, "观察时不允许点击『新招呼』页签（只读守卫）", page.value, key="nav_blocked"
            )
            return []

        snap = driver.state()
        page = classify_page(snap)
        layout = Layout.of(snap)
        if (
            page not in LIST_PAGES
            or layout is None
            or has_popup(snap)
            or more_menu_open(snap, layout)
            or new_greeting_tab(snap, layout) is None
        ):
            self._issue(
                data, UNSUPPORTED, f"切到『新招呼』后页面不是可读的会话列表（{page.value}）", page.value,
                key=f"after_nav:{page}",
            )
            return []
        rows, row_issues = parse_rows(snap, layout)
        if not baseline.established:
            self._establish(baseline, data, rows, now)
            return []
        if row_issues:
            missing = sorted({m for issue in row_issues for m in issue.missing})
            self._issue(
                data, UNSUPPORTED, f"会话行缺少字段: {','.join(missing)}", PageKind.CONVERSATION_LIST.value,
                key=f"row:{','.join(missing)}",
            )
        if baseline.account_id is None or not self.device_id:
            self._issue(data, NOT_READY, "缺少绑定账户或 device_id，暂不产生事件", PageKind.CONVERSATION_LIST.value,
                        key="not_ready")
            return []
        self._prune(data, now)
        events = self._detect(rows, baseline, data, snap, now)
        if events:
            baseline.updated_at = now
        return events

    # ------------------------------------------------------------------
    # 步骤
    # ------------------------------------------------------------------
    def _ready_for_tab(self, snap: Snapshot, page: PageKind, baseline: Baseline, data: dict[str, Any]) -> bool:
        """点击页签前的检查：只在有页签组、没有弹层的页面上导航。"""
        if page is PageKind.UNKNOWN:
            self._issue(data, UNSUPPORTED, "无法分类的页面", PageKind.UNKNOWN.value, key="page:unknown")
            return False
        if page not in LIST_PAGES:
            # 简历弹层、附件预览、搜索页：不导航、不读（附件预览的文字层绝不读取）
            if not baseline.established:
                self._issue(
                    data, BASELINE_PENDING, f"当前在{page.value}，无法建立基线", page.value, key=f"pending:{page}"
                )
            return False
        if has_popup(snap):
            self._issue(data, UNSUPPORTED, "有确认气泡或对话框，不点击", page.value, key=f"popup:{page}")
            return False
        return True

    def _establish(self, baseline: Baseline, data: dict[str, Any], rows: list[ListRow], now: datetime) -> None:
        data["baseline_at"] = now.astimezone(UTC).isoformat()
        initial: dict[str, int] = {}
        for r in rows:
            fp = conversation_fingerprint(r.candidate_name, r.job_title)
            initial[fp] = initial.get(fp, 0) + 1
        data["initial"] = initial
        data["emitted"] = {}
        data["ambiguous"] = {}
        baseline.established = True
        baseline.updated_at = now

    def _detect(
        self, rows: list[ListRow], baseline: Baseline, data: dict[str, Any], snap: Snapshot, now: datetime
    ) -> list[EventModel]:
        baseline_at = datetime.fromisoformat(data["baseline_at"])
        initial: dict[str, int] = data["initial"]
        emitted: dict[str, Any] = data["emitted"]
        ambiguous: dict[str, Any] = data["ambiguous"]

        groups: dict[str, list[ListRow]] = {}
        for row in rows:
            groups.setdefault(conversation_fingerprint(row.candidate_name, row.job_title), []).append(row)

        times: dict[int, ListTime] = {}
        is_new: dict[int, bool] = {}
        for row in rows:
            fp = conversation_fingerprint(row.candidate_name, row.job_title)
            is_new[row.position] = False
            if len(groups[fp]) <= initial.get(fp, 0) or row.own_status is not None:
                # 基线时已可见（同名同岗位的行数没有超过基线时的数量）/ 我方已回复（不是新招呼）。
                # 行数超过基线时说明出现了同名的新会话，逐行按消息时间判断。
                continue
            when = parse_list_time(row.time_text, now, self.tz)
            if when is None:
                self._issue(
                    data, UNSUPPORTED, f"无法解析的列表时间文案（形态 {time_shape(row.time_text)}）",
                    PageKind.CONVERSATION_LIST.value, key=f"time:{time_shape(row.time_text)}",
                )
                continue
            times[row.position] = when
            is_new[row.position] = classify_against_baseline(when, baseline_at) == "new"

        tab_label = self._tab_label(snap)
        events: list[EventModel] = []
        for fp, members in groups.items():
            fresh = [r for r in members if is_new[r.position]]
            if not fresh:
                continue
            bucket = max((times[r.position] for r in fresh), key=lambda t: t.start).bucket()
            if len(members) >= 2:
                if fp in ambiguous:
                    continue
                events.append(self._ambiguous_event(members, baseline, bucket, now))
                ambiguous[fp] = {"bucket": bucket, "at": now.astimezone(UTC).isoformat()}
                continue
            if fp in emitted or fp in ambiguous:
                continue  # 同一会话（例如候选人又发了一条）不重复产生；已判为歧义的不再按新投递上报
            events.append(self._application_event(members[0], baseline, bucket, tab_label, now))
            emitted[fp] = {"bucket": bucket, "at": now.astimezone(UTC).isoformat()}
        return events

    # ------------------------------------------------------------------
    # 事件构造
    # ------------------------------------------------------------------
    def _event(
        self, kind: str, conversation: dict[str, Any], payload: dict[str, Any], baseline: Baseline, bucket: str,
        now: datetime,
    ) -> EventModel:
        return validate_event(
            {
                "event_id": compute_event_id(baseline.account_id, kind, conversation, bucket),
                "device_id": self.device_id,
                "account_id": baseline.account_id,
                "kind": kind,
                "conversation": conversation,
                "bucket": bucket,
                "observed_at": now.isoformat(),
                "payload": payload,
            }
        )

    @staticmethod
    def _evidence(text: str, now: datetime, role: str = "AXGroup") -> dict[str, Any]:
        return {"text": text[:500], "role": role, "source": "list", "captured_at": now.isoformat()}

    def _application_event(
        self, row: ListRow, baseline: Baseline, bucket: str, tab_label: str | None, now: datetime
    ) -> EventModel:
        conversation = {"candidate_name": row.candidate_name, "job_title": row.job_title, "hints": []}
        evidence = [self._evidence(row.summary(), now)]
        if tab_label:
            evidence.insert(0, self._evidence(tab_label, now))
        payload = {"marker_text": (tab_label or "新招呼")[:100], "evidence": evidence}
        return self._event("application_observed", conversation, payload, baseline, bucket, now)

    def _ambiguous_event(self, members: list[ListRow], baseline: Baseline, bucket: str, now: datetime) -> EventModel:
        first = members[0]
        conversation = {"candidate_name": first.candidate_name, "job_title": first.job_title, "hints": []}
        payload = {
            "match_count": len(members),
            "candidates": [{"position": r.position, "hints": [r.time_text[:100]]} for r in members[:20]],
            "evidence": [self._evidence(r.summary(), now) for r in members[:50]],
        }
        return self._event("conversation_ambiguous", conversation, payload, baseline, bucket, now)

    @staticmethod
    def _tab_label(snap: Snapshot) -> str | None:
        layout = Layout.of(snap)
        if layout is None:
            return None
        tab = new_greeting_tab(snap, layout)
        return tab.label.strip() if tab is not None else None

    # ------------------------------------------------------------------
    # 基线数据与上报
    # ------------------------------------------------------------------
    @staticmethod
    def _data(baseline: Baseline) -> dict[str, Any]:
        data = baseline.data
        if data.get("version") != DATA_VERSION:
            # 未知或旧格式的基线数据不沿用：清空后按未建立处理，不猜它的含义
            data.clear()
            data["version"] = DATA_VERSION
            baseline.established = False
        data.setdefault("reported", [])
        if baseline.established and ("baseline_at" not in data or not isinstance(data.get("initial"), dict)):
            baseline.established = False
        return data

    @staticmethod
    def _prune(data: dict[str, Any], now: datetime) -> None:
        cutoff = now - EMITTED_RETENTION
        for name in ("emitted", "ambiguous"):
            table = data[name]
            for fp in [fp for fp, rec in table.items() if datetime.fromisoformat(rec["at"]) < cutoff]:
                del table[fp]

    def _issue(self, data: dict[str, Any], code: str, message: str, scene: str | None, *, key: str) -> None:
        reported: list[str] = data["reported"]
        full_key = f"{code}:{key}"
        if full_key in reported:
            return
        reported.append(full_key)
        del reported[:-MAX_REPORTED_KEYS]
        issue = Issue(code=code, message=message[:500], scene=scene)
        self.issues.append(issue)
        if self._report is not None:
            self._report(issue.code, issue.message, issue.scene)


def create_observer(
    *,
    device_id: str | None = None,
    report: ReportFn | None = None,
    clock: Clock = _utcnow,
    timezone: str | tzinfo = DEFAULT_TIMEZONE,
) -> NewApplicationObserver:
    """D2 的 __main__ 按 monitor.observe:create_observer 装配（不带参数）；之后由 core 调 attach() 注入。"""
    return NewApplicationObserver(device_id=device_id, report=report, clock=clock, timezone=timezone)
