"""openapi 一致性：从代码导出的 openapi.json 与 contracts/openapi.yaml 对比。

比较范围是 F1 实现的操作（F2/F3 实现后把各自的 operationId 加进 IMPLEMENTED 即可复用）：
路径与方法、operationId、参数（name/in/required）、认证方式、请求体与各响应码的
content-type 与 schema 形状。schema 先展开内部引用、统一可空写法、去掉 title/description
等注释性关键字后逐字段比较；对契约 schema 文件（./schemas/*.json）的引用作为叶子按引用比较。
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from server_testkit import load_openapi_yaml

from app.main import create_app, export_openapi, main

METHODS = ("get", "put", "post", "patch", "delete")

# F1 负责的操作（monitor-agent-tasks.md 第五节 F1；其余由 F2/F3/G 实现）
IMPLEMENTED = {
    "createDeviceEnrollment",
    "registerDevice",
    "listDevices",
    "getDevice",
    "revokeDeviceToken",
    "confirmAccountBinding",
    "pauseDevice",
    "resumeDevice",
    "postHeartbeat",
    "claimCommands",
    "listCommands",
    "getCommand",
    "ackCommand",
    "reportCommandResult",
    "cancelCommand",
    "postEvents",
    "listEvents",
}

# 已知的 yaml 缺口：代码如实声明、运行时会返回，但 contracts/openapi.yaml 0.2.0 还没列出的响应码。
# 由下一版契约任务统一补（清单见 agent-reports/F1.md「0.2.0 适配」）；补上后从这里删除对应条目，
# 测试会因白名单条目已不再是差异而失败（KNOWN_YAML_GAPS 必须与实际差异完全一致）。
KNOWN_YAML_GAPS: dict[str, set[str]] = {}  # 契约 0.3.0 已补齐 401/403/422

_KEEP = (
    "format",
    "pattern",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "const",
    "uniqueItems",
)


def _resolve(doc: dict[str, Any], ref: str) -> Any:
    node: Any = doc
    for part in ref[2:].split("/"):
        node = node[part]
    return node


def norm(node: Any, doc: dict[str, Any]) -> Any:
    """把 schema 归一化成便于比较的形状。"""
    if not isinstance(node, dict):
        return node
    if "$ref" in node:
        ref = node["$ref"]
        if ref.startswith("#/"):
            return norm(_resolve(doc, ref), doc)
        return {"ref": ref, "nullable": False}
    for comb in ("anyOf", "oneOf"):
        if comb in node:
            options = node[comb]
            non_null = [o for o in options if o != {"type": "null"}]
            nullable = len(non_null) < len(options)
            if len(non_null) == 1:
                inner = norm(non_null[0], doc)
                return {**inner, "nullable": nullable or inner["nullable"]}
            return {"oneOf": sorted((norm(o, doc) for o in non_null), key=json.dumps), "nullable": nullable}
    if "allOf" in node and len(node["allOf"]) == 1:
        return norm(node["allOf"][0], doc)
    out: dict[str, Any] = {}
    nullable = False
    t = node.get("type")
    if isinstance(t, list):
        nullable = "null" in t
        rest = [x for x in t if x != "null"]
        t = rest[0] if len(rest) == 1 else sorted(rest)
    if t is not None:
        out["type"] = t
    if "enum" in node:
        values = [v for v in node["enum"] if v is not None]
        nullable = nullable or len(values) < len(node["enum"])
        out["enum"] = sorted(values)
    for key in _KEEP:
        if key in node:
            out[key] = node[key]
    if "properties" in node or "required" in node:
        out["properties"] = {k: norm(v, doc) for k, v in node.get("properties", {}).items()}
        out["required"] = sorted(node.get("required", []))
    if node.get("additionalProperties") is False:
        out["additionalProperties"] = False
    if "items" in node:
        out["items"] = norm(node["items"], doc)
    out["nullable"] = nullable
    return out


def operations(spec: dict[str, Any]) -> dict[str, tuple[str, str, dict[str, Any]]]:
    out = {}
    for path, item in spec["paths"].items():
        for method in METHODS:
            if method in item:
                # 路径级参数并入操作
                op = {**item[method], "parameters": [*item.get("parameters", []), *item[method].get("parameters", [])]}
                out[op["operationId"]] = (path, method, op)
    return out


def params(op: dict[str, Any], doc: dict[str, Any]) -> set[tuple[str, str, bool]]:
    out = set()
    for p in op.get("parameters", []):
        if "$ref" in p:
            p = _resolve(doc, p["$ref"])
        out.add((p["name"], p["in"], bool(p.get("required", False))))
    return out


def security(op: dict[str, Any], doc: dict[str, Any]) -> set[frozenset[str]]:
    reqs = op.get("security", doc.get("security", []))
    return {frozenset(r) for r in reqs}


def body_schema(op: dict[str, Any], doc: dict[str, Any]) -> tuple[bool, dict[str, Any]] | None:
    rb = op.get("requestBody")
    if rb is None:
        return None
    required = bool(rb.get("required", False))
    content = {ct: norm(c["schema"], doc) for ct, c in rb["content"].items()}
    if not required:  # 可选请求体：代码侧会多一个 null 分支
        content = {ct: {**s, "nullable": False} for ct, s in content.items()}
    return required, content


def response_schemas(op: dict[str, Any], doc: dict[str, Any]) -> dict[str, dict[str, Any]]:
    out = {}
    for code, resp in op["responses"].items():
        if "$ref" in resp:
            resp = _resolve(doc, resp["$ref"])
        out[code] = {ct: norm(c.get("schema", {}), doc) for ct, c in resp.get("content", {}).items()}
    return out


@pytest.fixture(scope="module")
def specs() -> tuple[dict[str, Any], dict[str, Any]]:
    return export_openapi(create_app()), load_openapi_yaml()


def test_implemented_operations_match_task_scope(specs):
    code, yaml_spec = specs
    code_ops, yaml_ops = operations(code), operations(yaml_spec)
    assert set(code_ops) == IMPLEMENTED
    for op_id in IMPLEMENTED:
        assert op_id in yaml_ops, f"{op_id} 不在 openapi.yaml 中"
        assert code_ops[op_id][:2] == yaml_ops[op_id][:2], f"{op_id} 路径或方法不一致"


@pytest.mark.parametrize("op_id", sorted(IMPLEMENTED))
def test_operation_consistent_with_yaml(specs, op_id: str):
    code, yaml_spec = specs
    _, _, c = operations(code)[op_id]
    _, _, y = operations(yaml_spec)[op_id]
    assert params(c, code) == params(y, yaml_spec), "参数不一致"
    assert security(c, code) == security(y, yaml_spec), "认证方式不一致"
    assert body_schema(c, code) == body_schema(y, yaml_spec), "请求体不一致"
    c_resp, y_resp = response_schemas(c, code), response_schemas(y, yaml_spec)
    for status, content in y_resp.items():
        assert status in c_resp, f"缺少响应码 {status}"
        assert c_resp[status] == content, f"响应 {status} 不一致"
    assert set(c_resp) - set(y_resp) == KNOWN_YAML_GAPS.get(op_id, set()), "与已知 yaml 缺口白名单不一致"


def test_comparison_detects_differences(specs):
    """比较器本身要能发现差异（防止归一化把所有东西都抹平）。"""
    _, yaml_spec = specs
    device = yaml_spec["components"]["schemas"]["Device"]
    changed = json.loads(json.dumps(device))
    changed["required"] = changed["required"][:-1]
    assert norm(device, yaml_spec) != norm(changed, yaml_spec)
    changed = json.loads(json.dumps(device))
    changed["properties"]["paused"] = {"type": ["boolean", "null"]}
    assert norm(device, yaml_spec) != norm(changed, yaml_spec)
    assert norm({"$ref": "./schemas/command.json"}, yaml_spec) != norm({"$ref": "./schemas/event.json"}, yaml_spec)


def test_export_contract_refs_and_servers(specs):
    code, _ = specs
    assert code["info"]["version"] == load_openapi_yaml()["info"]["version"]
    assert code["servers"] == [{"url": "/api/v1"}]
    text = json.dumps(code)
    assert "x-contract-ref" not in text
    assert "./schemas/command_result.json" in text
    assert "HTTPValidationError" not in text


def test_cli_exports_openapi_json(tmp_path):
    out = tmp_path / "openapi.json"
    assert main(["export-openapi", str(out)]) == 0
    exported = json.loads(out.read_text(encoding="utf-8"))
    assert set(operations(exported)) == IMPLEMENTED


def test_cli_usage_error():
    assert main([]) == 2
    assert main(["bogus"]) == 2
