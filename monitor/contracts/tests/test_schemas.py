"""JSON Schema 本身的合法性，以及与 pydantic 模型枚举的一致性。"""

from __future__ import annotations

import json
import tomllib
from typing import get_args

import pytest
from vector_helpers import CONTRACTS_DIR
from jsonschema import Draft202012Validator

import monitor_contracts as mc
from monitor_contracts import models
from monitor_contracts._schemas import CONTRACT_SCHEMAS, ax_fixture_schema_path, load_schema, schemas_dir

SCHEMA_FILES = sorted(p.name for p in (CONTRACTS_DIR / "schemas").glob("*.json"))


def test_required_schema_files_exist():
    expected = {
        "command.json",
        "command_result.json",
        "event.json",
        "search_snapshot.json",
        "policy.json",
        "device_registration.json",
        "device_heartbeat.json",
        "login_qr.json",
        "mail_message.json",
        "mail_verification.json",
    }
    assert expected <= set(SCHEMA_FILES)
    assert set(CONTRACT_SCHEMAS.values()) == expected


@pytest.mark.parametrize("file_name", SCHEMA_FILES)
def test_schema_is_valid_draft_2020_12(file_name):
    schema = json.loads((schemas_dir() / file_name).read_text(encoding="utf-8"))
    assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    Draft202012Validator.check_schema(schema)


def test_ax_fixture_schema_is_valid():
    schema = json.loads(ax_fixture_schema_path().read_text(encoding="utf-8"))
    assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    Draft202012Validator.check_schema(schema)
    assert ax_fixture_schema_path().parent.name == "schema"


def _enum(file_name, *path):
    node = load_schema(file_name)
    for key in path:
        node = node[key]
    return [v for v in node["enum"] if v is not None]


def test_action_enum_matches_models():
    assert _enum("common.json", "$defs", "action") == list(get_args(models.Action))
    assert set(mc.ACTIONS) == {
        "send_greeting",
        "request_resume",
        "request_contact_exchange",
        "search_candidates",
        "provide_input",
    }
    # 0.3.0：forward_resume 从所有枚举中移除（名字保留，以后需要时再加回）
    assert "forward_resume" not in mc.ACTIONS
    for file_name, path in (
        ("policy.json", ("properties", "allowed_actions", "items")),
        ("device_registration.json", ("properties", "capabilities", "items")),
    ):
        assert "forward_resume" not in _enum(file_name, *path)
    assert "forward_resume" not in load_schema("policy.json")["$defs"]["per_action_counts"]["properties"]


def test_result_status_enum_matches_models():
    assert _enum("command_result.json", "properties", "status") == list(mc.RESULT_STATUSES)
    assert set(mc.RESULT_STATUSES) == {
        "succeeded",
        "failed",
        "cancelled",
        "expired",
        "skipped_precondition",
        "unknown",
    }


def test_reason_enum_matches_models_and_includes_required_codes():
    assert _enum("command_result.json", "$defs", "reason") == list(mc.REASONS)
    required = {
        "action_not_allowed",
        "rate_limited",
        "target_ambiguous",
        "target_not_found",
        "unknown_dialog",
        "login_required",
        "timeout",
        "unreadable",
        "unsupported",
        "precondition_already_done",
    }
    assert required <= set(mc.REASONS)


def test_event_kind_enum_matches_models():
    assert _enum("event.json", "properties", "kind") == list(mc.EVENT_KINDS)
    assert {
        "application_observed",
        "attachment_available",
        "contact_exchange_updated",
        "login_required",
        "login_qr",
        "login_ok",
        "human_input_required",
        "blocked_by_dialog",
        "device_paused",
        "conversation_ambiguous",
    } == set(mc.EVENT_KINDS)


def test_event_schema_has_payload_rule_for_every_kind():
    schema = load_schema("event.json")
    kinds_with_payload = set()
    for rule in schema["allOf"]:
        kind = rule["if"]["properties"]["kind"]
        if "const" in kind and "payload" in rule["then"]["properties"]:
            kinds_with_payload.add(kind["const"])
    assert kinds_with_payload == set(mc.EVENT_KINDS)


def test_command_schema_has_payload_rule_for_every_action():
    schema = load_schema("command.json")
    actions = set()
    for rule in schema["allOf"]:
        action = rule["if"]["properties"]["action"]
        if "const" in action and "payload" in rule["then"]["properties"]:
            actions.add(action["const"])
    assert actions == set(mc.ACTIONS)


def test_coverage_mode_exchange_enums_match_models():
    assert _enum("search_snapshot.json", "properties", "coverage") == list(get_args(models.Coverage))
    assert _enum("common.json", "$defs", "mode") == list(get_args(models.Mode))
    assert _enum("common.json", "$defs", "exchange_state") == list(get_args(models.ExchangeState))
    assert _enum("common.json", "$defs", "exchange_type") == ["wechat"]


def test_version_is_consistent():
    assert mc.__version__ == "0.3.0"
    pyproject = tomllib.loads((CONTRACTS_DIR / "pyproject.toml").read_text(encoding="utf-8"))
    assert pyproject["project"]["version"] == mc.__version__


def test_mail_status_and_check_enums_match_models():
    assert _enum("mail_message.json", "properties", "status") == list(mc.MAIL_STATUSES)
    assert set(mc.MAIL_STATUSES) == {str(s) for s in mc.MailState}
    code_enum = load_schema("mail_verification.json")["properties"]["checks"]["items"]["properties"]["code"]["enum"]
    assert code_enum == list(mc.MAIL_CHECK_CODES)


def test_policy_defaults_match_models():
    props = load_schema("policy.json")["properties"]
    assert props["resume_mail_timeout_days"]["default"] == models.Policy.model_fields["resume_mail_timeout_days"].default == 3
    assert props["after_resume_received"]["default"] == models.AfterResumeReceived().to_wire()
    assert props["after_resume_received"]["properties"]["action"]["default"] == "none"
    assert props["company_mailbox"]["readOnly"] is True
