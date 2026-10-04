"""request_contact_exchange：在目标会话里点『换微信』（只换微信、只由人工触发，monitor-spec.md 8.3）。

本处理器不判断"是否该交换"：服务端只在控制台人工点击时生成该指令（contracts.md 第三节），
到了 Monitor 仍要白名单开启才执行。不交换电话：exchange_type 在契约里只有 wechat，本模块也只认『换微信』。

流程：打开会话（common.py：姓名 + 岗位 + hints 全匹配，歧义不执行）
      → 读当前交换状态（read_exchange_state）：
        - 聊天区有『请求交换微信已发送』且『换微信』置灰 → skipped_precondition，exchange_state=pending_acceptance
        - 没有提示、『换微信』可用 → 未请求，继续
        - 没有提示、『换电话』『换微信』都置灰（招聘方未回复，contact_exchange_state#2）→ failed/target_not_found
        - 其他组合（含"已交换"——夹具未观察到，不猜）→ unknown/unreadable，不点击
      → 点『换微信』（对外动作）
      → 出现确认气泡：只有文案明确是交换微信、按钮只有『取消』加唯一的『确认 / 确定』时点一次；
        其他任何弹窗 → unknown_dialog，不点击
      → 等待聊天区出现『请求交换微信已发送』（上限 10 秒，注入时钟）→ succeeded，exchange_state=requested；
        超时 → unknown/timeout（不重点）。

output：succeeded → requested；skipped_precondition → pending_acceptance；unknown → unknown；failed 不带。

界面依据（任务 B，capabilities.md 1.3 / 1.7，夹具 contact_exchange_state#0–2）：
- 按钮条里『换微信』是 AXStaticText；可用时外层有 57×24 的可按 AXGroup，置灰时只剩裸 StaticText
  （CLI 不输出 enabled，这是从截图对照得出的规则）。点击目标是外层 AXGroup。
- 已请求待同意：聊天区居中系统提示『请求交换微信已发送』，同时『换微信』置灰。
未观察到（N 阶段实测后修订，见 docs/monitor/agent-reports/H3.md）：点击后的确认气泡是否存在及文案、
提示出现的时机、已交换 / 已拒绝的界面。
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Literal

from monitor_contracts import ActionContext, ActionHandler, ActionResult, CommandModel, ContactOutput, Driver, Element

from monitor.core.clock import Clock

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
)

WECHAT_BUTTON = "换微信"
PHONE_BUTTON = "换电话"
WECHAT_REQUESTED_NOTICE = "请求交换微信已发送"

# 可用按钮的外层可按 AXGroup：夹具里是 57×24，留少量余量
_PRESSABLE_W = (50.0, 64.0)
_PRESSABLE_H = (20.0, 28.0)

# 确认气泡白名单：文案必须明确是"交换微信"，且不能提到电话 / 手机；按钮只有『取消』和唯一的确认按钮
WECHAT_CONFIRM_PATTERN = re.compile(r"(交换|换)微信")
_CONFIRM_FORBIDDEN = re.compile(r"电话|手机")
CONFIRM_BUTTONS = frozenset({"确认", "确定"})
CONFIRM_DIALOG_BUTTONS = CONFIRM_BUTTONS | {"取消"}

ButtonState = Literal["enabled", "disabled", "missing", "ambiguous"]
StateKind = Literal["not_requested", "pending_acceptance", "unavailable", "unrecognized"]


def _is_pressable_group(el: Element) -> bool:
    return (
        el.role == "AXGroup"
        and not norm(el.label)
        and _PRESSABLE_W[0] <= el.frame.w <= _PRESSABLE_W[1]
        and _PRESSABLE_H[0] <= el.frame.h <= _PRESSABLE_H[1]
    )


@dataclass(frozen=True)
class ExchangeButton:
    """按钮条里的一个交换按钮。state=enabled 时 press 是要点击的外层 AXGroup。"""

    state: ButtonState
    text: Element | None = None
    press: Element | None = None


def exchange_button(view: View, label: str) -> ExchangeButton:
    """按 capabilities.md 1.3 的规则判断按钮可用 / 置灰：文案的中心落在一个 57×24 的无 label AXGroup 里即可用。"""
    hits = toolbar_button(view, label)
    if not hits:
        return ExchangeButton("missing")
    if len(hits) > 1:
        return ExchangeButton("ambiguous")
    text = hits[0]
    cx, cy = text.frame.center()
    groups = [
        e
        for e in view.elements
        if _is_pressable_group(e)
        and e.frame.x <= cx <= e.frame.x + e.frame.w
        and e.frame.y <= cy <= e.frame.y + e.frame.h
    ]
    if len(groups) > 1:
        return ExchangeButton("ambiguous", text)
    if groups:
        return ExchangeButton("enabled", text, groups[0])
    return ExchangeButton("disabled", text)


@dataclass(frozen=True)
class ExchangeReading:
    kind: StateKind
    notice: Element | None
    wechat: ExchangeButton
    phone: ExchangeButton

    def describe(self) -> str:
        return (
            f"提示『{WECHAT_REQUESTED_NOTICE}』{'有' if self.notice is not None else '无'}；"
            f"『{WECHAT_BUTTON}』{self.wechat.state}；『{PHONE_BUTTON}』{self.phone.state}"
        )


def read_exchange_state(view: View) -> ExchangeReading:
    """读当前会话的微信交换状态。只认夹具上观察到的三种组合，其余一律 unrecognized（不猜）。"""
    notices = system_notices(view, WECHAT_REQUESTED_NOTICE)
    notice = notices[-1] if notices else None
    wechat = exchange_button(view, WECHAT_BUTTON)
    phone = exchange_button(view, PHONE_BUTTON)
    if notice is not None and wechat.state == "disabled":
        kind: StateKind = "pending_acceptance"  # contact_exchange_state#1
    elif notice is None and wechat.state == "enabled":
        kind = "not_requested"  # contact_exchange_state#0
    elif notice is None and wechat.state == "disabled" and phone.state == "disabled":
        kind = "unavailable"  # contact_exchange_state#2（招聘方未回复）
    else:
        # 例如：提示在但按钮可用、只有『换微信』置灰而无提示（提示可能滚出可见区，也可能已交换）、按钮找不到。
        # 已交换 / 已拒绝的界面没有观察到，不能据此推断。
        kind = "unrecognized"
    return ExchangeReading(kind, notice, wechat, phone)


def is_wechat_confirm(blocker: Blocker) -> bool:
    """换微信确认气泡：普通弹窗，文案明确是交换微信且不提电话 / 手机，按钮只有『取消』和唯一一个『确认 / 确定』。"""
    text = norm(blocker.text)
    labels = blocker.button_labels
    return (
        blocker.kind == "dialog"
        and WECHAT_CONFIRM_PATTERN.search(text) is not None
        and _CONFIRM_FORBIDDEN.search(text) is None
        and set(labels) <= CONFIRM_DIALOG_BUTTONS
        and sum(1 for label in labels if label in CONFIRM_BUTTONS) == 1
    )


def _settled(view: View, *, confirmed: bool) -> tuple[str, list[Blocker]] | None:
    """点击后的界面是否已可识别：出现提示 → done；出现弹窗 → blocked；都没有 → None（继续等）。"""
    if system_notices(view, WECHAT_REQUESTED_NOTICE):
        return ("done", [])
    blockers = detect_blockers(view)
    if not blockers:
        return None
    if confirmed and len(blockers) == 1 and is_wechat_confirm(blockers[0]):
        return None  # 已点过确认，气泡可能还在消失过程中：继续等，不再点
    return ("blocked", blockers)


_STATE_FOR_STATUS = {"succeeded": "requested", "skipped_precondition": "pending_acceptance", "unknown": "unknown"}


class RequestContactExchangeHandler(ConversationActionHandler):
    action = "request_contact_exchange"

    def run(self, command: CommandModel, driver: Driver, ctx: ActionContext) -> ActionResult:
        return self._with_output(super().run(command, driver, ctx))

    def verify_only(self, command: CommandModel, driver: Driver, ctx: ActionContext) -> ActionResult:
        return self._with_output(super().verify_only(command, driver, ctx))

    @staticmethod
    def _with_output(result: ActionResult) -> ActionResult:
        """契约要求 succeeded / skipped_precondition 必须带 output.exchange_state；unknown 也带上 unknown 便于展示。"""
        if result.reason in ("action_not_allowed", "unsupported"):
            return result
        state = _STATE_FOR_STATUS.get(result.status)
        if state is None:
            return result
        return result.model_copy(update={"output": ContactOutput(exchange_type="wechat", exchange_state=state)})

    def _read_state(self, session: ConversationSession, view: View, *, after: bool) -> ExchangeReading:
        reading = read_exchange_state(view)
        record = session.fact_after if after else session.fact_before
        record("wechat_exchange_notice_present" if reading.notice is not None else "wechat_exchange_notice_absent")
        record(f"wechat_button_{reading.wechat.state}")
        record(f"phone_button_{reading.phone.state}")
        if reading.notice is not None:
            session.evidence.element(reading.notice, source="chat")
        session.evidence.add(reading.describe(), source="other")
        return reading

    def _precondition(self, session: ConversationSession, reading: ExchangeReading) -> ExchangeButton:
        """按读到的状态决定是否继续；继续时返回可点击的『换微信』。"""
        if reading.kind == "pending_acceptance":
            raise Stop("skipped_precondition", "precondition_already_done", "聊天区已有『请求交换微信已发送』且『换微信』置灰")
        if reading.kind == "unavailable":
            session.evidence.add(
                "『换电话』『换微信』都置灰且没有交换提示：与招聘方未回复时的界面一致（contact_exchange_state#2），"
                "界面不给原因；没有可点击的『换微信』，未点击",
                source="other",
            )
            raise Stop("failed", "target_not_found", "『换微信』置灰（疑为招聘方尚未回复），没有可点击的按钮")
        if reading.kind == "unrecognized":
            session.fact_before("wechat_exchange_state_unrecognized", reading.describe())
            raise Stop(
                "unknown",
                "unreadable",
                f"交换状态无法识别（{reading.describe()}）；已交换 / 已拒绝界面未观察到，不猜，未点击",
            )
        assert reading.wechat.press is not None
        return reading.wechat

    def _execute(self, session: ConversationSession) -> ActionResult:
        view = session.open_conversation()
        button = self._precondition(session, self._read_state(session, view, after=False))

        with session.outbound():
            session.driver.click(button.press)  # type: ignore[arg-type]

        confirmed = False
        while True:
            state, view = session.waiter.poll(session.driver, lambda v, c=confirmed: _settled(v, confirmed=c))
            if state is None:
                if confirmed:
                    session.fact_after("wechat_confirm_clicked")
                self._read_state(session, view, after=True)
                raise Stop("unknown", "timeout", f"点击后 10 秒内没有出现『{WECHAT_REQUESTED_NOTICE}』")
            kind, blockers = state
            if kind == "done":
                if confirmed:
                    session.fact_after("wechat_confirm_clicked")
                self._read_state(session, view, after=True)
                return session.result("succeeded")
            if not confirmed and len(blockers) == 1 and is_wechat_confirm(blockers[0]):
                dialog = blockers[0]
                session.evidence.blocker(dialog)
                session.fact_after("wechat_confirm_dialog", dialog.text)
                confirm = [b for b in dialog.buttons if norm(b.text) in CONFIRM_BUTTONS]
                with session.outbound():
                    session.driver.click(confirm[0])
                confirmed = True
                continue  # 确认后重新等待一个完整的结果窗口
            session.stop_if_blocked(view, phase="after")

    def _verify(self, session: ConversationSession) -> ActionResult:
        """只读判断是否已请求：提示在且按钮置灰 → succeeded；明确未请求 / 不可用 → verification_failed；其余 → unknown。"""
        view = session.open_conversation()
        reading = self._read_state(session, view, after=True)
        if reading.kind == "pending_acceptance":
            return session.result("succeeded")
        if reading.kind in ("not_requested", "unavailable"):
            return session.result("failed", "verification_failed", f"聊天区没有『{WECHAT_REQUESTED_NOTICE}』")
        session.fact_after("wechat_exchange_state_unrecognized", reading.describe())
        return session.result("unknown", "unreadable", f"交换状态无法识别（{reading.describe()}）")


def create_handlers(*, clock: Clock) -> Iterable[ActionHandler]:
    return [RequestContactExchangeHandler(clock=clock)]
