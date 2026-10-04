"""契约 0.3.0：公司邮箱记录、核对结果、邮件状态机、搜索卡片、策略默认值与 forward_resume 移除。"""

from __future__ import annotations

import copy
import json

import pytest
from pydantic import ValidationError
from vector_helpers import VECTORS_DIR

from monitor_contracts import (
    MAIL_TRANSITIONS,
    TERMINAL_MAIL_STATES,
    ContractValidationError,
    IllegalTransition,
    MailState,
    Policy,
    can_transition_case,
    can_transition_mail,
    check,
    compute_mail_message_id,
    is_valid_idempotency_key,
    mail_message_key,
    mail_verification_key,
    normalize_mailbox,
    normalize_message_id,
    require_transition,
    resume_document_key,
    validate_command,
    validate_mail_message,
    validate_mail_verification,
    validate_policy,
    validate_search_snapshot,
)


def _vector(kind: str, name: str) -> dict:
    return json.loads((VECTORS_DIR / kind / f"{name}.json").read_text(encoding="utf-8"))["data"]


# ---------------------------------------------------------------------------
# mail_message_id
# ---------------------------------------------------------------------------


def test_mail_message_id_is_deterministic_and_normalised():
    a = compute_mail_message_id("HR@Example.com ", "<abc@mail.example>")
    b = compute_mail_message_id("hr@example.com", "  abc@mail.example ")
    assert a == b
    assert a.startswith("mail:") and len(a) == 5 + 32
    # 不同邮箱、不同 Message-ID 得到不同主键
    assert a != compute_mail_message_id("other@example.com", "<abc@mail.example>")
    assert a != compute_mail_message_id("hr@example.com", "<abd@mail.example>")


def test_mail_message_id_prefers_message_id_over_uid():
    with_uid = compute_mail_message_id("hr@example.com", "<x@y>", uidvalidity=1, uid=2)
    assert with_uid == compute_mail_message_id("hr@example.com", "<x@y>")


def test_mail_message_id_uid_fallback():
    a = compute_mail_message_id("hr@example.com", None, uidvalidity=7, uid=9)
    assert a == compute_mail_message_id("hr@example.com", "<>", uidvalidity=7, uid=9)  # 空 Message-ID 视为缺失
    assert a != compute_mail_message_id("hr@example.com", None, uidvalidity=8, uid=9)
    # 兜底与"恰好长得像 UID 的 Message-ID"不会撞
    assert a != compute_mail_message_id("hr@example.com", "7:9")


@pytest.mark.parametrize(
    ("mailbox", "message_id", "uidvalidity", "uid"),
    [
        ("hr@example.com", None, None, None),
        ("hr@example.com", None, 7, None),
        ("hr@example.com", "  ", None, 3),
        ("hr@example.com", None, 0, 3),
        ("   ", "<x@y>", None, None),
    ],
)
def test_mail_message_id_rejects_missing_identity(mailbox, message_id, uidvalidity, uid):
    with pytest.raises(ValueError):
        compute_mail_message_id(mailbox, message_id, uidvalidity=uidvalidity, uid=uid)


def test_normalizers():
    assert normalize_mailbox("  HR@Example.COM ") == "hr@example.com"
    assert normalize_message_id(" <a@b> ") == "a@b"
    assert normalize_message_id("< >") is None
    assert normalize_message_id(None) is None


# ---------------------------------------------------------------------------
# mail_message / mail_verification
# ---------------------------------------------------------------------------


def test_mail_message_round_trip():
    data = _vector("valid", "mail_message_pending")
    model = validate_mail_message(data)
    assert model.status == "pending"
    assert check("mail_message", model.to_wire()) == []


def test_mail_message_error_rules():
    data = _vector("valid", "mail_message_pending")
    processed_with_error = dict(data, status="processed", error="x")
    assert "error" in [e.path for e in check("mail_message", processed_with_error)]
    half_uid = dict(data, uid=None)
    errors = check("mail_message", half_uid)
    assert [e.path for e in errors] == ["uid"] and errors[0].layer == "model"
    early_update = dict(data, updated_at="2026-10-04T09:00:00+08:00")
    assert [e.path for e in check("mail_message", early_update)] == ["updated_at"]


def test_mail_verification_rules():
    ok = _vector("valid", "mail_verification_ok_with_overdue")
    assert validate_mail_verification(ok).outcome == "ok"
    # issues_found 但全部为 0
    no_issue = dict(ok, outcome="issues_found")
    assert [e.path for e in check("mail_verification", no_issue)] == ["outcome"]
    # 检查项重复
    dup = copy.deepcopy(ok)
    dup["checks"][1]["code"] = dup["checks"][0]["code"]
    assert "checks" in [e.path for e in check("mail_verification", dup)]
    # 时间倒序
    backwards = dict(ok, finished_at="2026-10-04T10:59:00+08:00")
    assert [e.path for e in check("mail_verification", backwards)] == ["finished_at"]
    # 只有 failed 能带 error
    with pytest.raises(ContractValidationError) as info:
        validate_mail_verification(dict(ok, error="x"))
    assert "error" in info.value.paths


# ---------------------------------------------------------------------------
# 邮件状态机
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("src", "dst", "allowed"),
    [
        ("pending", "processed", True),
        ("pending", "needs_review", True),
        ("pending", "failed", True),
        ("pending", "ignored", True),
        ("needs_review", "processed", True),
        ("failed", "pending", True),
        ("processed", "pending", False),
        ("ignored", "pending", False),
        ("needs_review", "failed", False),
        ("failed", "processed", False),
        ("pending", "pending", False),
    ],
)
def test_mail_transitions(src, dst, allowed):
    assert can_transition_mail(src, dst) is allowed


def test_mail_terminal_states_and_require():
    assert TERMINAL_MAIL_STATES == {MailState.PROCESSED, MailState.IGNORED}
    assert set(MAIL_TRANSITIONS) == set(MailState)
    require_transition("mail", "failed", "pending")
    with pytest.raises(IllegalTransition) as info:
        require_transition("mail", "processed", "pending")
    assert info.value.layer == "mail"
    with pytest.raises(ValueError):
        can_transition_mail("pending", "deleted")


def test_case_resume_main_path_via_mailbox():
    assert can_transition_case("resume_requested", "resume_linked")
    assert can_transition_case("resume_requested", "needs_human")  # 超时或关联歧义
    assert can_transition_case("resume_requested", "resume_received")  # 可选观察
    assert can_transition_case("needs_human", "resume_linked")  # 人工关联
    assert not can_transition_case("resume_requested", "contact_requested")


# ---------------------------------------------------------------------------
# 幂等键
# ---------------------------------------------------------------------------


def test_mail_keys():
    mid = compute_mail_message_id("hr@example.com", "<x@y>")
    k1 = mail_message_key(mid, "pending", 0)
    assert is_valid_idempotency_key(k1)
    assert k1 == mail_message_key(mid, "pending", 0)
    assert k1 != mail_message_key(mid, "pending", 1)
    assert k1 != mail_message_key(mid, "processed", 0)
    assert is_valid_idempotency_key(mail_verification_key("verify-20261004T1100"))
    # 不安全字符退化为哈希
    assert is_valid_idempotency_key(mail_verification_key("核对 一"))
    orig = resume_document_key(mid, "f" * 64)
    branded = resume_document_key("branded:doc_1", "f" * 64)
    assert orig != branded and is_valid_idempotency_key(branded)


# ---------------------------------------------------------------------------
# 搜索快照 0.3.0
# ---------------------------------------------------------------------------


def test_search_item_carries_card_texts_only():
    snap = validate_search_snapshot(_vector("valid", "snapshot_partial"))
    item = snap.items[0]
    assert item.position == 1 and item.masked_name
    assert [f.text for f in item.fields][:2] == ["王**", "5年"]
    assert not hasattr(item, "display_name") and not hasattr(item, "stable_candidate_id")


def test_search_item_phone_in_masked_name_or_prop_text_rejected():
    snap = _vector("valid", "snapshot_partial")
    a = copy.deepcopy(snap)
    a["items"][0]["prop_card_texts"] = ["联系 13912345678"]
    assert "items[0].prop_card_texts[0]" in [e.path for e in check("search_snapshot", a)]
    b = copy.deepcopy(snap)
    b["items"][0]["masked_name"] = "13912345678"
    assert check("search_snapshot", b)


def test_search_item_semantic_phone_check_matches_schema():
    """pydantic 层与 schema 层用同一条规则：直接构造模型也会拒绝手机号。"""
    from monitor_contracts import CardField, SearchItem

    with pytest.raises(ValidationError):
        SearchItem(
            result_ref="s_1:item_1",
            position=1,
            fields=[CardField(text="13912345678")],
            prop_card_texts=[],
        )


def test_greeting_cannot_target_search_result():
    data = _vector("valid", "command_send_greeting")
    data["target"]["result_ref"] = "s_42:item_1"
    with pytest.raises(ContractValidationError) as info:
        validate_command(data)
    assert info.value.paths == ["target.result_ref"]


# ---------------------------------------------------------------------------
# 策略
# ---------------------------------------------------------------------------


def test_policy_defaults():
    data = _vector("valid", "policy_default")
    model = validate_policy(data)
    assert model.after_resume_received.action == "none"
    assert model.resume_mail_timeout_days == 3
    assert model.company_mailbox == "hr@example.com"
    # 模型层默认值：未提供时收到简历后不自动交换联系方式、超时 3 天、未配置邮箱
    trimmed = {k: v for k, v in data.items() if k not in ("after_resume_received", "resume_mail_timeout_days", "company_mailbox")}
    defaults = Policy.model_validate(trimmed)
    assert defaults.after_resume_received.action == "none"
    assert defaults.resume_mail_timeout_days == 3
    assert defaults.company_mailbox is None
    # 线上必须写全
    assert {e.path for e in check("policy", trimmed)} == {
        "after_resume_received",
        "resume_mail_timeout_days",
        "company_mailbox",
    }


def test_policy_mailbox_must_be_email_or_null():
    data = _vector("valid", "policy_default")
    assert check("policy", dict(data, company_mailbox=None)) == []
    assert check("policy", dict(data, company_mailbox="not-an-email"))


# ---------------------------------------------------------------------------
# 换微信（0.3.0 追加，用户确认）
# ---------------------------------------------------------------------------


def test_contact_exchange_is_wechat_only():
    data = _vector("valid", "command_contact_exchange")
    assert validate_command(data).payload.exchange_type == "wechat"
    data["payload"]["exchange_type"] = "phone"
    assert [e.path for e in check("command", data)] == ["payload.exchange_type"]


def test_policy_cannot_auto_request_contact_exchange():
    data = _vector("valid", "policy_default")
    data["after_resume_received"]["action"] = "request_contact_exchange"
    assert [e.path for e in check("policy", data)] == ["after_resume_received.action"]
