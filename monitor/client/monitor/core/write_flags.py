"""结果里"是否动过界面"标记的唯一出口。

契约 0.1.x 只有一个字段 gui_write_performed（任何点击、输入、按键）。协调者已预告 0.2.0
会把它拆成 navigation_performed 与 outbound_action_performed，verify_only / 取消 / 白名单 /
限额规则改为针对后者。届时只需要改本文件：其他 core 代码只通过这里读写该标记。
"""

from __future__ import annotations

from typing import Any

from monitor_contracts import ActionResult, CommandResult


def flags(wrote: bool) -> dict[str, Any]:
    """构造结果时的标记字段（用于 ActionResult(**...) 或 model_copy(update=...)）。"""
    return {"gui_write_performed": bool(wrote)}


def declared(result: ActionResult | CommandResult) -> bool:
    """处理器 / 结果自己声明的"动过界面"。"""
    return bool(result.gui_write_performed)


def merged(result: ActionResult, *, guard_wrote: bool, verify_only: bool) -> dict[str, Any]:
    """处理器声明与守卫计数取并集；verify_only 一律为 False（守卫保证没有写调用到达 Driver）。"""
    if verify_only:
        return flags(False)
    return flags(declared(result) or guard_wrote)


def counts_toward_limit(result: CommandResult) -> bool:
    """这条结果是否计入每日上限与最小间隔（真正发生过对外动作）。"""
    return declared(result)
