"""event_id 计算规则：确定性、规范化、各输入都参与计算。"""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone

import pytest

from monitor_contracts import Conversation, compute_event_id, conversation_identity, observation_bucket

CONV = {"candidate_name": "候选人A", "job_title": "后端工程师", "hints": ["本科", "上海"]}
BUCKET = "2026-10-04T01:00:00Z/3600"

# 金标准值：任何实现（含服务端、其他语言）对同样输入都必须得到它。改规则 = 契约变更。
GOLDEN = "51696fd36487432a5cfc3df72b035786de3745414dcfd267c3c5e4a44f2c5704"
# 规则的字面展开：其他语言实现可直接对照这一行的字节串
GOLDEN_MATERIAL = '["monitor-event-v1","acct_demo","application_observed",["候选人A","后端工程师",["上海","本科"]],"2026-10-04T01:00:00Z/3600"]'


def test_golden_value():
    assert hashlib.sha256(GOLDEN_MATERIAL.encode("utf-8")).hexdigest() == GOLDEN
    assert compute_event_id("acct_demo", "application_observed", CONV, BUCKET) == GOLDEN


def test_deterministic_and_model_equivalent():
    a = compute_event_id("acct_demo", "application_observed", CONV, BUCKET)
    b = compute_event_id("acct_demo", "application_observed", Conversation(**CONV), BUCKET)
    assert a == b


def test_hint_order_whitespace_and_nfc_do_not_matter():
    base = compute_event_id("acct_demo", "application_observed", CONV, BUCKET)
    shuffled = {**CONV, "hints": ["上海 ", "本科", "本科"]}
    padded = {**CONV, "candidate_name": " 候选人A "}
    assert compute_event_id("acct_demo", "application_observed", shuffled, BUCKET) == base
    assert compute_event_id("acct_demo", "application_observed", padded, BUCKET) == base
    # NFC：é 的组合写法与预组合写法相同
    c1 = {**CONV, "candidate_name": "René"}
    c2 = {**CONV, "candidate_name": "René"}
    assert compute_event_id("a", "application_observed", c1, BUCKET) == compute_event_id(
        "a", "application_observed", c2, BUCKET
    )


@pytest.mark.parametrize(
    "change",
    [
        {"account_id": "acct_other"},
        {"kind": "attachment_available"},
        {"bucket": "2026-10-04T02:00:00Z/3600"},
        {"conversation": {**CONV, "job_title": "前端工程师"}},
        {"conversation": {**CONV, "hints": ["硕士"]}},
    ],
)
def test_every_input_changes_the_id(change):
    args = {"account_id": "acct_demo", "kind": "application_observed", "conversation": CONV, "bucket": BUCKET}
    base = compute_event_id(**args)
    assert compute_event_id(**{**args, **change}) != base


def test_none_account_and_conversation():
    a = compute_event_id(None, "login_required", None, BUCKET)
    b = compute_event_id("", "login_required", None, BUCKET)
    assert a == b
    assert conversation_identity(None) is None


def test_invalid_inputs():
    with pytest.raises(ValueError):
        compute_event_id("a", "message_received", None, BUCKET)
    with pytest.raises(ValueError):
        compute_event_id("a", "login_ok", None, "")


def test_observation_bucket():
    t = datetime(2026, 10, 4, 9, 59, 59, tzinfo=timezone(timedelta(hours=8)))
    assert observation_bucket(t) == "2026-10-04T01:00:00Z/3600"
    assert observation_bucket(t, 600) == "2026-10-04T01:50:00Z/600"
    assert observation_bucket(t + timedelta(seconds=1)) == "2026-10-04T02:00:00Z/3600"
    with pytest.raises(ValueError):
        observation_bucket(datetime(2026, 10, 4, 9, 0))
    with pytest.raises(ValueError):
        observation_bucket(t, 0)
