"""send_greeting：在目标会话里发送服务端渲染好的问候文本。

流程：打开会话 → 聊天区已有同一文本的我方消息 → skipped_precondition（避免重复问候）
      → 在输入框输入 payload.text、点『发送』（对外动作）→ 等待聊天区出现该文本的我方消息
      → succeeded；等不到 → unknown（不重发）。

界面假设（夹具 conversation_detail#0，真机发送后的变化待 N 实测）：输入框是唯一的 AXTextArea；
『发送』在输入框右下角；我方消息在聊天区右半边，左侧同一行有『送达 / 已读』状态文字。
"""

from __future__ import annotations

from monitor_contracts import ActionResult

from .common import (
    ConversationActionHandler,
    ConversationSession,
    Stop,
    chat_input,
    detect_blockers,
    own_messages,
    send_button,
    unique,
)


class SendGreetingHandler(ConversationActionHandler):
    action = "send_greeting"

    def _text(self, session: ConversationSession) -> str:
        return session.command.payload.text  # type: ignore[union-attr]

    def _execute(self, session: ConversationSession) -> ActionResult:
        text = self._text(session)
        view = session.open_conversation()

        existing = own_messages(view, text)
        if existing:
            session.fact_before("greeting_text_present", f"聊天区已有 {len(existing)} 条相同的我方消息")
            session.evidence.element(existing[-1], source="chat")
            return session.result("skipped_precondition", "precondition_already_done", "聊天区已有相同问候")
        session.fact_before("greeting_text_absent")

        textarea = chat_input(view)
        if textarea is None:
            raise Stop("failed", "target_not_found", "找不到聊天输入框")
        unique(send_button(view), "『发送』按钮")  # 先确认按钮存在，再开始输入

        with session.outbound():
            session.driver.type_text(textarea, text)
            # 输入后重新读取，用最新快照里的『发送』（旧快照的元素可能已过期）
            typed = session.read()
            session.stop_if_blocked(typed, phase="after")
            session.driver.click(unique(send_button(typed), "『发送』按钮"))

        def sent(v):
            if detect_blockers(v):
                return "blocked"
            return "sent" if own_messages(v, text) else None

        state, after = session.waiter.poll(session.driver, sent)
        if state == "blocked":
            session.stop_if_blocked(after, phase="after")
        if state is None:
            session.fact_after("greeting_text_absent")
            raise Stop("unknown", "timeout", "发送后 10 秒内聊天区没有出现该问候")
        messages = own_messages(after, text)
        session.fact_after("greeting_text_present")
        session.evidence.element(messages[-1], source="chat")
        return session.result("succeeded")

    def _verify(self, session: ConversationSession) -> ActionResult:
        text = self._text(session)
        view = session.open_conversation()
        messages = own_messages(view, text)
        if messages:
            session.fact_after("greeting_text_present")
            session.evidence.element(messages[-1], source="chat")
            return session.result("succeeded")
        session.fact_after("greeting_text_absent")
        return session.result("failed", "verification_failed", "聊天区没有该问候")
