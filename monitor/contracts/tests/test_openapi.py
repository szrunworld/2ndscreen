"""openapi.yaml 通过 openapi-spec-validator，且满足 API 规则。"""

from __future__ import annotations

import yaml
from openapi_spec_validator import validate
from openapi_spec_validator.readers import read_from_filename
from vector_helpers import CONTRACTS_DIR

import monitor_contracts as mc

OPENAPI = CONTRACTS_DIR / "openapi.yaml"
WRITE_METHODS = {"post", "put", "patch", "delete"}


def _spec():
    return yaml.safe_load(OPENAPI.read_text(encoding="utf-8"))


def test_openapi_validates_with_external_refs():
    spec, base_uri = read_from_filename(str(OPENAPI))
    validate(spec, base_uri=base_uri)


def test_version_matches_contracts():
    assert _spec()["info"]["version"] == mc.__version__


def test_required_endpoints_exist():
    paths = _spec()["paths"]
    required = [
        ("post", "/devices"),
        ("post", "/devices/{device_id}/heartbeat"),
        ("post", "/devices/{device_id}/commands:claim"),
        ("post", "/commands/{command_id}/result"),
        ("post", "/commands/{command_id}/ack"),
        ("post", "/events"),
        ("post", "/resume-documents"),
        ("post", "/search-runs"),
        ("get", "/cases"),
        ("get", "/cases/{case_id}"),
        ("post", "/commands/{command_id}:confirm-sent"),
        ("post", "/resume-documents/{doc_id}:link"),
        ("post", "/cases/{case_id}:stop"),
        ("post", "/login-qr"),
        ("get", "/devices/{device_id}/login-qr"),
        ("post", "/devices/{device_id}/login-qr:withdraw"),
        ("get", "/accounts/{account_id}/policy"),
        ("put", "/accounts/{account_id}/policy"),
    ]
    for method, path in required:
        assert path in paths and method in paths[path], f"{method.upper()} {path}"


def test_every_write_operation_requires_idempotency_key():
    spec = _spec()
    for path, item in spec["paths"].items():
        for method, op in item.items():
            if method not in WRITE_METHODS:
                continue
            refs = [p.get("$ref") for p in op.get("parameters", [])]
            assert "#/components/parameters/IdempotencyKey" in refs, f"{method.upper()} {path}"
    assert spec["components"]["parameters"]["IdempotencyKey"]["required"] is True
    assert spec["components"]["parameters"]["IdempotencyKey"]["schema"]["pattern"] == mc.IDEMPOTENCY_KEY_PATTERN


def test_qr_read_has_gone_response():
    op = _spec()["paths"]["/devices/{device_id}/login-qr"]["get"]
    assert "410" in op["responses"]


def test_contract_bodies_reference_schema_files():
    spec = _spec()

    def body_ref(path, method):
        return spec["paths"][path][method]["requestBody"]["content"]["application/json"]["schema"]["$ref"]

    assert body_ref("/devices", "post") == "./schemas/device_registration.json"
    assert body_ref("/devices/{device_id}/heartbeat", "post") == "./schemas/device_heartbeat.json"
    assert body_ref("/commands/{command_id}/result", "post") == "./schemas/command_result.json"
    assert body_ref("/login-qr", "post") == "./schemas/login_qr.json"
    assert body_ref("/accounts/{account_id}/policy", "put") == "./schemas/policy.json"


# ---------------------------------------------------------------------------
# 0.3.0：邮箱路线、错误码补齐
# ---------------------------------------------------------------------------

import json  # noqa: E402

import pytest  # noqa: E402
from jsonschema import Draft202012Validator  # noqa: E402
from referencing import Registry, Resource  # noqa: E402
from referencing.jsonschema import DRAFT202012  # noqa: E402


def _component_validator(name: str) -> Draft202012Validator:
    """用 openapi.yaml 的组件 schema 构造校验器，./schemas/*.json 的外部引用按文件解析。"""
    base = OPENAPI.resolve().as_uri()
    resources = [(base, Resource.from_contents(_spec(), default_specification=DRAFT202012))]
    for path in sorted((CONTRACTS_DIR / "schemas").glob("*.json")):
        contents = json.loads(path.read_text(encoding="utf-8"))
        resources.append((path.resolve().as_uri(), Resource.from_contents(contents, default_specification=DRAFT202012)))
    registry = Registry().with_resources(resources)
    schema = {"$ref": f"{base}#/components/schemas/{name}"}
    return Draft202012Validator(schema, registry=registry, format_checker=Draft202012Validator.FORMAT_CHECKER)


def test_forward_resume_is_gone_from_openapi():
    spec = _spec()
    spec.pop("info")  # 版本说明里提到"forward_resume 移除"
    assert "forward" not in json.dumps(spec, ensure_ascii=False)


def test_mail_endpoints_exist():
    paths = _spec()["paths"]
    for method, path in [
        ("get", "/mail-messages"),
        ("put", "/mail-messages/{mail_message_id}"),
        ("post", "/mail-verifications"),
        ("get", "/mail-verifications"),
    ]:
        assert path in paths and method in paths[path], f"{method.upper()} {path}"
    put = paths["/mail-messages/{mail_message_id}"]["put"]
    assert put["requestBody"]["content"]["application/json"]["schema"]["$ref"] == "./schemas/mail_message.json"
    assert put["security"] == [{"serviceToken": []}]
    post = paths["/mail-verifications"]["post"]
    assert post["requestBody"]["content"]["application/json"]["schema"]["$ref"] == "./schemas/mail_verification.json"


# F1 报告「0.2.0 适配」列出的 yaml 缺口，0.3.0 补齐
F1_GAPS = {
    "getDevice": {"401", "422"},
    "revokeDeviceToken": {"401", "422"},
    "confirmAccountBinding": {"401"},
    "pauseDevice": {"401", "422"},
    "resumeDevice": {"401", "422"},
    "getCommand": {"401", "422"},
    "cancelCommand": {"401", "422"},
    "listEvents": {"401", "422"},
    "listCommands": {"422"},
    "ackCommand": {"403", "422"},
}


def test_f1_response_code_gaps_are_filled():
    ops = {
        op["operationId"]: op
        for item in _spec()["paths"].values()
        for method, op in item.items()
        if isinstance(op, dict) and "operationId" in op
    }
    for op_id, codes in F1_GAPS.items():
        assert codes <= set(ops[op_id]["responses"]), op_id


def _doc_create(**overrides):
    body = {
        "variant": "original",
        "mail_message_id": "mail:3f6c2a9e-1b4d-4e8a-9c7f-2d5e8b1a0c44",
        "mail": {"mailbox": "hr@example.com", "message_id": "<a@b>", "received_at": "2026-10-04T10:00:00+08:00"},
        "attachment": {
            "filename": "resume.pdf",
            "sha256": "f" * 64,
            "size_bytes": 1024,
            "content_type": "application/pdf",
            "storage_uri": "file:///var/monitor/doc/1.pdf",
        },
        "link": {"method": "resume_request", "case_id": "case_1", "command_id": "00000000-0000-4000-8000-000000000002"},
    }
    body.update(overrides)
    return {k: v for k, v in body.items() if v is not ...}


@pytest.mark.parametrize(
    ("body", "ok"),
    [
        (_doc_create(), True),
        (_doc_create(variant=...), True),  # 默认 original
        (_doc_create(mail_message_id=...), False),  # 原件必须带 mail_message_id
        (_doc_create(link=...), False),
        (_doc_create(derived_from="doc_0"), False),  # 原件不能有 derived_from
        (_doc_create(link={"method": "forward_record", "case_id": "case_1"}), False),
        (_doc_create(variant="branded", derived_from="doc_1", mail=..., link=..., mail_message_id=...), True),
        (_doc_create(variant="branded", derived_from="doc_1", link=..., mail_message_id=...), False),  # 品牌化不带 mail
        (_doc_create(variant="branded", mail=..., link=..., mail_message_id=...), False),  # 缺 derived_from
    ],
)
def test_resume_document_create_variants(body, ok):
    errors = list(_component_validator("ResumeDocumentCreate").iter_errors(body))
    assert (not errors) is ok, [e.message for e in errors]


def test_mail_verification_record_wraps_contract():
    v = _component_validator("MailVerificationRecord")
    verification = {
        "verification_id": "verify-1234",
        "mailbox": "hr@example.com",
        "started_at": "2026-10-04T11:00:00+08:00",
        "finished_at": "2026-10-04T11:00:01+08:00",
        "outcome": "failed",
        "error": "imap_connect_timeout",
        "checks": [],
    }
    assert not list(v.iter_errors({"verification": verification, "received_at": "2026-10-04T11:00:02+08:00"}))
    assert list(v.iter_errors({"verification": verification}))


def test_request_wechat_is_manual_console_endpoint():
    op = _spec()["paths"]["/cases/{case_id}:request-wechat"]["post"]
    assert op["requestBody"]["content"]["application/json"]["schema"]["$ref"] == "#/components/schemas/RequiredNoteBody"
    assert "security" not in op  # 继承全局 consoleSession：只有控制台能触发
    assert {"201", "401", "404", "409", "422"} <= set(op["responses"])
    enum = _spec()["components"]["schemas"]["ManualAction"]["properties"]["type"]["enum"]
    assert "request_wechat" in enum


def test_timeline_records_resume_linked_independent_of_stage():
    enum = _spec()["components"]["schemas"]["TimelineEntry"]["properties"]["type"]["enum"]
    assert "resume_linked" in enum
