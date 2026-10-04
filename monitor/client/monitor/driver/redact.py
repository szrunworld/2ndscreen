"""脱敏：把元素文本里的个人信息去掉，供录制夹具使用。

两类处理：

1. 替换表：姓名等无法用正则识别的信息由调用方提供 ``{"张三": "候选人A"}``，
   按原文长度从长到短替换（避免"张三丰"先被"张三"替换掉一半）。
2. 正则删除：手机号、微信号、邮箱直接删成占位符 ``[手机号]``/``[微信号]``/``[邮箱]``。

正则只覆盖常见写法，不保证删净；录制出的夹具提交前仍需人工抽查。
"""

from __future__ import annotations

import re
from collections.abc import Mapping

PHONE_MARK = "[手机号]"
WECHAT_MARK = "[微信号]"
EMAIL_MARK = "[邮箱]"

_EMAIL = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+")
# 中国大陆手机号：可带 +86/86 前缀，数字间可有空格或连字符（138 1234 5678、138-1234-5678）。
_PHONE = re.compile(r"(?<!\d)(?:\+?86[\s\-]?)?1[3-9]\d(?:[\s\-]?\d){8}(?!\d)")
# 微信号：wxid_ 开头的系统号，或"微信 / 微信号 / wx / WeChat"标签后跟的号码。
_WXID = re.compile(r"\bwxid_[A-Za-z0-9_\-]{4,}")
_WECHAT_LABELLED = re.compile(
    r"(?P<label>(?:微信号?|[Ww][Xx]|[Ww]e[Cc]hat)\s*(?:ID|id)?\s*[:：]?\s*)(?P<id>[A-Za-z][A-Za-z0-9_\-]{5,19})"
)


def redact_text(text: str, replacements: Mapping[str, str] | None = None) -> str:
    """对一段文本应用替换表与正则删除。"""
    for original in sorted(replacements or {}, key=len, reverse=True):
        if original:
            text = text.replace(original, replacements[original])  # type: ignore[index]
    text = _EMAIL.sub(EMAIL_MARK, text)
    text = _WXID.sub(WECHAT_MARK, text)
    text = _WECHAT_LABELLED.sub(lambda m: m.group("label") + WECHAT_MARK, text)
    text = _PHONE.sub(PHONE_MARK, text)
    return text


def redact_optional(text: str | None, replacements: Mapping[str, str] | None = None) -> str | None:
    return None if text is None else redact_text(text, replacements)
