"""request_resume：在目标会话里点『求简历』。

流程：打开会话 → 聊天区已有系统提示『简历请求已发送』→ skipped_precondition/precondition_already_done
      （请求后『求简历』按钮仍可用，capabilities.md 1.3，所以不能看按钮状态）
      → 点『求简历』（对外动作）
      → 出现确认气泡：只有文案匹配 RESUME_CONFIRM_PATTERN、按钮只有『取消 / 确认』时点一次『确认』；
        其他任何弹窗 → unknown_dialog，不点击
      → 等待聊天区出现『简历请求已发送』→ succeeded；超时 → unknown（不重发）。

界面假设（真机的求简历确认流程尚未观察，N 阶段实测后修订）：
- 『求简历』在输入框上方的按钮条里，文案恰为『求简历』（夹具 conversation_detail#0）。
- 若有确认气泡，形态与『附件简历』的索取气泡一致（attachment_entry#1：静态文本『确定向牛人索取简历吗？』
  + AXButton『取消』『确认』）；文案按任务要求放宽为 /确定向牛人(请求|索取)(附件)?简历/。
- 请求成功后聊天区居中出现系统提示『简历请求已发送』（conversation_detail#0 是请求过的会话）。
"""

from __future__ import annotations

import re

from monitor_contracts import ActionResult

from .common import (
    Blocker,
    ConversationActionHandler,
    ConversationSession,
    Stop,
    View,
    detect_blockers,
    norm,
    system_notices,
    toolbar_button,
    unique,
)

RESUME_BUTTON = "求简历"
RESUME_REQUESTED_NOTICE = "简历请求已发送"
RESUME_CONFIRM_PATTERN = re.compile(r"确定向牛人(请求|索取)(附件)?简历")
CONFIRM_BUTTON = "确认"
CONFIRM_DIALOG_BUTTONS = frozenset({"取消", CONFIRM_BUTTON})


def is_resume_confirm(blocker: Blocker) -> bool:
    """求简历确认气泡：普通弹窗、文案匹配、按钮只有『取消 / 确认』且『确认』恰好一个。"""
    labels = blocker.button_labels
    return (
        blocker.kind == "dialog"
        and RESUME_CONFIRM_PATTERN.search(norm(blocker.text)) is not None
        and set(labels) <= CONFIRM_DIALOG_BUTTONS
        and labels.count(CONFIRM_BUTTON) == 1
    )


def _settled(view: View, *, confirmed: bool) -> tuple[str, list[Blocker]] | None:
    """点击后的界面是否已可识别：出现提示 → done；出现弹窗 → blocked；都没有 → None（继续等）。"""
    if system_notices(view, RESUME_REQUESTED_NOTICE):
        return ("done", [])
    blockers = detect_blockers(view)
    if not blockers:
        return None
    if confirmed and len(blockers) == 1 and is_resume_confirm(blockers[0]):
        return None  # 已点过确认，气泡可能还在消失过程中：继续等，不再点
    return ("blocked", blockers)


class RequestResumeHandler(ConversationActionHandler):
    action = "request_resume"

    def _notice(self, session: ConversationSession, view: View, *, after: bool) -> bool:
        notices = system_notices(view, RESUME_REQUESTED_NOTICE)
        record = session.fact_after if after else session.fact_before
        if notices:
            record("resume_request_notice_present")
            session.evidence.element(notices[-1], source="chat")
            return True
        record("resume_request_notice_absent")
        return False

    def _execute(self, session: ConversationSession) -> ActionResult:
        view = session.open_conversation()
        if self._notice(session, view, after=False):
            return session.result("skipped_precondition", "precondition_already_done", "聊天区已有『简历请求已发送』")

        button = unique(toolbar_button(view, RESUME_BUTTON), "『求简历』按钮")
        with session.outbound():
            session.driver.click(button)

        confirmed = False
        while True:
            state, view = session.waiter.poll(session.driver, lambda v, c=confirmed: _settled(v, confirmed=c))
            if state is None:
                if confirmed:
                    session.fact_after("resume_confirm_clicked")
                self._notice(session, view, after=True)
                raise Stop("unknown", "timeout", "点击后 10 秒内没有出现『简历请求已发送』")
            kind, blockers = state
            if kind == "done":
                if confirmed:
                    session.fact_after("resume_confirm_clicked")
                self._notice(session, view, after=True)
                return session.result("succeeded")
            if not confirmed and len(blockers) == 1 and is_resume_confirm(blockers[0]):
                dialog = blockers[0]
                session.evidence.blocker(dialog)
                session.fact_after("resume_confirm_dialog", dialog.text)
                confirm = [b for b in dialog.buttons if norm(b.text) == CONFIRM_BUTTON]
                with session.outbound():
                    session.driver.click(confirm[0])
                confirmed = True
                continue  # 确认后重新等待一个完整的结果窗口
            session.stop_if_blocked(view, phase="after")

    def _verify(self, session: ConversationSession) -> ActionResult:
        view = session.open_conversation()
        if self._notice(session, view, after=True):
            return session.result("succeeded")
        return session.result("failed", "verification_failed", "聊天区没有『简历请求已发送』")
