"""邮件 → 招聘流程的关联（方案 8.2 第 6 条"关联"）。

规则：从邮件里取出账户、岗位、候选人姓名，在 [收信时间 - 窗口, 收信时间] 内
**request_resume 已成功**的指令里查找（``GET /commands?action=request_resume&status=succeeded``）。
账户 + 岗位 + 姓名都一致、且只落在**一个**流程上时才自动关联（method=resume_request，带 command_id）；
同名多流程、多岗位、找不到、或邮件里取不到姓名与岗位时一律 method=none 进入人工关联队列，
不按姓名硬匹配。附件哈希只用于去重，不参与身份判断。
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from .clock import parse_time
from .config import MailSettings
from .server_api import ServerApi


def normalize_text(value: str | None) -> str:
    """NFC、去首尾空白、连续空白合成一个。"""
    if not value:
        return ""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", value)).strip()


@dataclass(frozen=True)
class MailHints:
    candidate_name: str | None
    job_title: str | None
    account_id: str | None
    #: 邮件里出现了多个不同账户的标识（不猜，按"账户不确定"处理）。
    account_conflict: bool = False


def extract_hints(subject: str | None, text: str | None, settings: MailSettings) -> MailHints:
    """按配置的主题规则取姓名与岗位；按账户别名取账户。取不到就是 None，不猜。"""
    name = job = None
    subject_n = normalize_text(subject)
    for pattern in settings.subject_patterns:
        match = re.search(pattern, subject_n)
        if match:
            name = normalize_text(match.group("name")) or None
            job = normalize_text(match.group("job")) or None
            break
    haystack = f"{subject_n}\n{normalize_text(text)}"
    accounts = {account for alias, account in _sorted_aliases(settings.account_aliases) if alias and alias in haystack}
    account_id = next(iter(accounts)) if len(accounts) == 1 else None
    return MailHints(candidate_name=name, job_title=job, account_id=account_id, account_conflict=len(accounts) > 1)


def _sorted_aliases(aliases: Mapping[str, str]) -> Iterable[tuple[str, str]]:
    return sorted(((normalize_text(a), acc) for a, acc in aliases.items()), key=lambda item: -len(item[0]))


@dataclass(frozen=True)
class LinkDecision:
    method: str  # resume_request | none
    case_id: str | None
    command_id: str | None
    candidate_case_ids: tuple[str, ...] = field(default_factory=tuple)
    reason: str | None = None

    @property
    def linked(self) -> bool:
        return self.method != "none"

    def to_wire(self) -> dict[str, Any]:
        body: dict[str, Any] = {"method": self.method, "case_id": self.case_id, "command_id": self.command_id}
        if self.method == "none":
            body["candidate_case_ids"] = list(self.candidate_case_ids)
        return body

    @classmethod
    def unlinked(cls, reason: str, candidates: Iterable[str] = ()) -> LinkDecision:
        return cls("none", None, None, tuple(sorted(set(candidates))), reason)


@dataclass(frozen=True)
class _Request:
    case_id: str
    command_id: str
    account_id: str
    candidate_name: str
    job_title: str
    executed_at: datetime


def _requests_from_records(records: Iterable[dict[str, Any]], start: datetime, end: datetime) -> list[_Request]:
    found: list[_Request] = []
    for record in records:
        command = record.get("command") or {}
        result = record.get("result") or {}
        if command.get("action") != "request_resume" or result.get("status") != "succeeded":
            continue
        conversation = (command.get("target") or {}).get("conversation") or {}
        case_id = record.get("case_id") or command.get("workflow_id")
        executed = result.get("executed_at")
        if not case_id or not executed:
            continue
        executed_at = parse_time(executed)
        if not (start <= executed_at <= end):
            continue
        found.append(
            _Request(
                case_id=str(case_id),
                command_id=str(command.get("command_id")),
                account_id=str(command.get("account_id") or ""),
                candidate_name=normalize_text(conversation.get("candidate_name")),
                job_title=normalize_text(conversation.get("job_title")),
                executed_at=executed_at,
            )
        )
    return found


def decide_link(hints: MailHints, *, received_at: datetime, server: ServerApi, settings: MailSettings) -> LinkDecision:
    """在求简历记录里唯一命中才关联；否则 none 并给出可供人工选择的候选流程。"""
    start = received_at - timedelta(days=settings.request_window_days)
    records = server.list_commands(
        action="request_resume",
        statuses=["succeeded"],
        executed_after=start,
        executed_before=received_at,
        account_id=hints.account_id,
    )
    requests = _requests_from_records(records, start, received_at)
    if hints.account_id:
        requests = [r for r in requests if r.account_id == hints.account_id]
    if not hints.candidate_name or not hints.job_title:
        # 取不到姓名或岗位：不猜，按姓名（如果有）给出候选。
        candidates = [r.case_id for r in requests if hints.candidate_name and r.candidate_name == hints.candidate_name]
        return LinkDecision.unlinked("hints_missing", candidates)
    same_name = [r for r in requests if r.candidate_name == hints.candidate_name]
    exact = [r for r in same_name if r.job_title == hints.job_title]
    cases = {r.case_id for r in exact}
    if hints.account_conflict:
        return LinkDecision.unlinked("account_ambiguous", [r.case_id for r in same_name])
    if len(cases) == 1:
        latest = max(exact, key=lambda r: (r.executed_at, r.command_id))
        return LinkDecision("resume_request", latest.case_id, latest.command_id)
    if len(cases) > 1:
        return LinkDecision.unlinked("ambiguous_cases", cases)
    if same_name:
        return LinkDecision.unlinked("job_mismatch", [r.case_id for r in same_name])
    return LinkDecision.unlinked("no_resume_request")
