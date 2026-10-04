"""脱敏测试。号码均为虚构。"""

from __future__ import annotations

import pytest

from monitor.driver.redact import EMAIL_MARK, PHONE_MARK, WECHAT_MARK, redact_optional, redact_text


@pytest.mark.parametrize(
    "raw",
    ["13812345678", "+86 138 1234 5678", "86-138-1234-5678", "电话：15900001111。"],
)
def test_phone_removed(raw):
    out = redact_text(raw)
    assert PHONE_MARK in out
    assert not any(ch.isdigit() for ch in out.replace(PHONE_MARK, ""))


def test_non_phone_numbers_kept():
    # 薪资、年份、12 位数字都不是手机号。
    for raw in ["15-25K", "2026年", "123456789012", "工作 3 年"]:
        assert redact_text(raw) == raw


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("微信号：abc_12345", f"微信号：{WECHAT_MARK}"),
        ("微信 zhang-san99", f"微信 {WECHAT_MARK}"),
        ("WeChat ID: someone_x1", f"WeChat ID: {WECHAT_MARK}"),
        ("wxid_ab12cd34ef", WECHAT_MARK),
    ],
)
def test_wechat_removed(raw, expected):
    assert redact_text(raw) == expected


def test_email_removed():
    assert redact_text("简历发到 hr.team+jobs@example.com.cn 谢谢") == f"简历发到 {EMAIL_MARK} 谢谢"


def test_replacement_table_longest_first():
    table = {"张三": "候选人A", "张三丰": "候选人B"}
    assert redact_text("张三丰与张三", table) == "候选人B与候选人A"


def test_replacement_then_regex():
    assert redact_text("李四 13900002222", {"李四": "候选人A"}) == f"候选人A {PHONE_MARK}"


def test_empty_key_ignored_and_none_passthrough():
    assert redact_text("abc", {"": "x"}) == "abc"
    assert redact_optional(None) is None
