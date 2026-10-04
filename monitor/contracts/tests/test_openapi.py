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
