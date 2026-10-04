"""合法 / 非法样本：合法样本两层校验都通过且可往返序列化；非法样本给出字段级错误。"""

from __future__ import annotations

from collections import Counter

import pytest
from vector_helpers import load_vectors

from monitor_contracts import CONTRACT_NAMES, ContractValidationError, check, schema_errors, validate

VALID = load_vectors("valid")
INVALID = load_vectors("invalid")


def test_vector_counts():
    assert len(VALID) >= 10
    assert len(INVALID) >= 10


def test_every_contract_has_valid_and_invalid_vectors():
    valid_contracts = Counter(v["contract"] for _, v in VALID)
    invalid_contracts = Counter(v["contract"] for _, v in INVALID)
    for name in CONTRACT_NAMES:
        assert valid_contracts[name] >= 1, f"{name} 缺少合法样本"
        assert invalid_contracts[name] >= 1, f"{name} 缺少非法样本"


@pytest.mark.parametrize(("name", "vector"), VALID, ids=[n for n, _ in VALID])
def test_valid_vector(name, vector):
    contract, data = vector["contract"], vector["data"]
    assert check(contract, data) == []
    model = validate(contract, data)
    # 往返：模型序列化后仍符合 JSON Schema 与语义规则
    wire = model.model_dump(mode="json")
    assert schema_errors(contract, wire) == []
    assert check(contract, wire) == []


@pytest.mark.parametrize(("name", "vector"), INVALID, ids=[n for n, _ in INVALID])
def test_invalid_vector_reports_field_errors(name, vector):
    contract, data = vector["contract"], vector["data"]
    with pytest.raises(ContractValidationError) as info:
        validate(contract, data)
    err = info.value
    assert err.contract == contract
    paths = err.paths
    for expected in vector["expected_error_paths"]:
        assert expected in paths, f"期望字段 {expected} 报错，实际 {paths}"
    for fe in err.errors:
        assert fe.message, "错误信息不能为空"
        assert fe.layer in ("schema", "model")
    # 字段级：期望的错误不能落在根对象上
    assert all(p for p in vector["expected_error_paths"])
    assert any(e.path in vector["expected_error_paths"] for e in err.errors)
    # 异常文本里带字段路径，便于日志定位
    for expected in vector["expected_error_paths"]:
        assert expected in str(err)


def test_semantic_errors_are_marked_model_layer():
    semantic = {n: v for n, v in INVALID if "语义" in v["description"]}
    assert semantic, "至少要有语义层样本"
    for name, vector in semantic.items():
        errors = check(vector["contract"], vector["data"])
        assert errors and all(e.layer == "model" for e in errors), name


def test_unknown_contract_name():
    with pytest.raises(KeyError):
        check("no_such_contract", {})
