"""契约 0.3.2 汇总补丁：搜索算对外动作、工作时段外换微信顺延、yaml 缺口、人工输入有效期。"""

from __future__ import annotations

import json

import yaml
from vector_helpers import CONTRACTS_DIR

import monitor_contracts as mc

OPENAPI = CONTRACTS_DIR / "openapi.yaml"

# server 一致性测试 KNOWN_YAML_GAPS（F2、F3 报告）在 0.3.2 全部补齐
SERVER_GAPS_031 = {
    "confirmCommandSent": {"401", "422"},
    "recheckCommand": {"401", "422"},
    "getCase": {"401", "422"},
    "stopCase": {"401", "422"},
    "listCases": {"422"},
    "getPolicy": {"401", "422"},
    "putPolicy": {"401", "404"},
    "getOverview": {"401", "422"},
    "createSearchRun": {"401"},
    "listSearchRuns": {"401", "422"},
    "getSearchRun": {"401", "422"},
    "getLoginQr": {"401", "422"},
    "withdrawLoginQr": {"401", "403", "422"},
    "listLoginQrViews": {"401", "404", "422"},
    "respondInputRequest": {"401", "422"},
    "getResumeDocument": {"401", "422"},
    "listResumeDocuments": {"401", "422"},
    "postParseResult": {"401"},
    "linkResumeDocument": {"401", "422"},
}


def _spec():
    return yaml.safe_load(OPENAPI.read_text(encoding="utf-8"))


def _ops():
    return {
        op["operationId"]: op
        for item in _spec()["paths"].values()
        for op in item.values()
        if isinstance(op, dict) and "operationId" in op
    }


def test_version_is_032():
    assert mc.__version__ == "0.3.2"


def test_server_yaml_gaps_are_filled():
    ops = _ops()
    for op_id, codes in SERVER_GAPS_031.items():
        assert codes <= set(ops[op_id]["responses"]), op_id


def test_service_token_can_read_policy_and_resume_documents():
    ops = _ops()
    for op_id in ("getPolicy", "listResumeDocuments"):
        schemes = {name for req in ops[op_id]["security"] for name in req}
        assert {"consoleSession", "serviceToken"} <= schemes, op_id
    # 只读：写接口没有因此放开
    assert {name for req in ops["putPolicy"].get("security", _spec()["security"]) for name in req} == {"consoleSession"}


def test_manual_command_created_has_scheduled_for():
    schema = _spec()["components"]["schemas"]["ManualCommandCreated"]
    assert schema["properties"]["scheduled_for"]["type"] == ["string", "null"]
    assert "scheduled_for" not in schema["required"]


def test_resume_document_has_candidate_case_ids():
    schema = _spec()["components"]["schemas"]["ResumeDocument"]
    assert schema["properties"]["candidate_case_ids"]["type"] == "array"


def test_claim_documents_issued_at_rule():
    assert "issued_at 之前不下发" in _ops()["claimCommands"]["description"]


def test_search_is_outward_and_bound_by_work_hours():
    assert "search_candidates" in mc.OUTWARD_ACTIONS
    assert "work_hours" in _ops()["createSearchRun"]["description"]
    policy = json.loads((CONTRACTS_DIR / "schemas" / "policy.json").read_text(encoding="utf-8"))
    assert "search_candidates" in policy["properties"]["work_hours"]["description"]


def test_input_request_ttl():
    assert mc.INPUT_REQUEST_TTL_SECONDS == 600
