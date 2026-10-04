"""结果里三个"动过界面"标志的唯一出口（契约 0.2.0，contracts.md 第四节）。

- navigation_performed：只改变本机界面的操作（打开会话、切页签、滚动、关闭弹层、在搜索框输入）。
- outbound_action_performed：对候选人或第三方可见的动作（发送、确认、提交转发、点击求简历/换电话/换微信）。
- externally_visible_side_effect：可能产生了对方可见的副作用；对外动作一定算，打开未读会话产生已读回执也算。

不变式：outbound ⇒ externally_visible。verify_only / 取消 / 限额只针对 outbound。
其他 core 代码只通过这里读写这三个标志。
"""

from __future__ import annotations

from typing import Any

from monitor_contracts import ActionResult, CommandResult

NAV = "navigation_performed"
OUTBOUND = "outbound_action_performed"
VISIBLE = "externally_visible_side_effect"


def flags(*, navigation: bool = False, outbound: bool = False, visible: bool = False) -> dict[str, Any]:
    """构造结果时的标志字段（用于 ActionResult(**...) 或 model_copy(update=...)）。自动满足 outbound ⇒ visible。"""
    return {NAV: bool(navigation), OUTBOUND: bool(outbound), VISIBLE: bool(visible or outbound)}


def none() -> dict[str, Any]:
    """什么都没做：白名单关闭、限额拒绝、过期、排队时取消。"""
    return flags()


def outbound(result: ActionResult | CommandResult) -> bool:
    """处理器 / 结果自己声明的对外动作。"""
    return bool(result.outbound_action_performed)


def merged(result: ActionResult, *, navigated: bool, outbound_done: bool, verify_only: bool) -> dict[str, Any]:
    """处理器声明与守卫记录取并集。

    verify_only 时 outbound 一律为 False：守卫保证对外动作与输入到不了 Driver。
    """
    out = False if verify_only else (outbound(result) or outbound_done)
    return flags(
        navigation=result.navigation_performed or navigated,
        outbound=out,
        visible=result.externally_visible_side_effect,
    )


# 成功本身不包含对外动作的指令：搜索只是导航与在搜索框输入
_NON_OUTBOUND_SUCCESS = frozenset({"search_candidates"})


def success_is_outbound(action: str) -> bool:
    """崩溃恢复时复核确认"动作已发生"，是否意味着发生过对外动作。"""
    return action not in _NON_OUTBOUND_SUCCESS


def counts_toward_limit(result: CommandResult) -> bool:
    """这条结果是否计入每日上限与最小间隔。

    对外动作一律计入；搜索没有对外动作，但只要动过界面（导航）也计入，平台对搜索同样限频。
    """
    if result.action in _NON_OUTBOUND_SUCCESS:
        return bool(result.navigation_performed or result.outbound_action_performed)
    return outbound(result)
