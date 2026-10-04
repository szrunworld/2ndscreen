"""契约 0.3.3：心跳回执 heartbeat_ack 纳入契约，增加 account_binding（集成缺陷 M-1）。"""

from __future__ import annotations

import pytest
import yaml
from vector_helpers import CONTRACTS_DIR

import monitor_contracts as mc

OPENAPI = CONTRACTS_DIR / "openapi.yaml"

BINDING = {"account_id": "acct_demo", "bound_at": "2026-10-04T09:00:00+08:00", "confirmed_by": "ops_li"}


def _ack(**over):
    base = {
        "server_time": "2026-10-04T09:31:20+08:00",
        "paused": False,
        "policy_version": None,
        "cancellations": [],
        "account_confirmed": False,
        "account_binding": None,
    }
    return {**base, **over}


def test_heartbeat_ack_is_a_contract():
    assert "heartbeat_ack" in mc.CONTRACT_NAMES
    ack = mc.validate_heartbeat_ack(_ack(account_binding=BINDING))
    assert isinstance(ack, mc.HeartbeatAck)
    assert ack.account_binding is not None and ack.account_binding.account_id == "acct_demo"


def test_ack_binding_fields_match_local_monitor_state_binding():
    # 设备拿回执里的绑定直接写本机 monitor_state.account_binding，两边字段必须一致
    assert set(mc.HeartbeatAccountBinding.model_fields) == set(mc.AccountBinding.model_fields)
    ack = mc.validate_heartbeat_ack(_ack(account_binding=BINDING))
    assert ack.account_binding is not None
    local = mc.AccountBinding.model_validate(ack.account_binding.model_dump())
    assert local.account_id == "acct_demo" and local.confirmed_by == "ops_li"


def test_binding_may_be_present_while_unconfirmed():
    # 设备还没写入本机绑定（心跳 account_id 为 null）或绑定刚变更：未确认，但回执如实给出绑定
    assert mc.check("heartbeat_ack", _ack(account_binding=BINDING)) == []


@pytest.mark.parametrize(
    ("data", "path"),
    [
        (_ack(account_confirmed=True), "account_binding"),
        (_ack(policy_version=2), "policy_version"),
        ({k: v for k, v in _ack().items() if k != "account_binding"}, "account_binding"),
        (_ack(account_binding={**BINDING, "confirmed_by": ""}), "account_binding.confirmed_by"),
        (_ack(account_binding={**BINDING, "bound_at": "2026-10-04T09:00:00"}), "account_binding.bound_at"),
        (_ack(account_binding={**BINDING, "device_id": "dev_1"}), "account_binding"),
    ],
)
def test_invalid_acks(data, path):
    with pytest.raises(mc.ContractValidationError) as info:
        mc.validate_heartbeat_ack(data)
    assert any(p == path or p.startswith(path + ".") for p in info.value.paths), info.value.paths


def test_account_confirmed_is_optional_for_compatibility():
    data = _ack()
    del data["account_confirmed"]
    assert mc.check("heartbeat_ack", data) == []


def test_openapi_heartbeat_ack_refs_contract_schema():
    spec = yaml.safe_load(OPENAPI.read_text(encoding="utf-8"))
    assert spec["components"]["schemas"]["HeartbeatAck"] == {"$ref": "./schemas/heartbeat_ack.json"}
    op = spec["paths"]["/devices/{device_id}/heartbeat"]["post"]
    assert op["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/HeartbeatAck"
    }
    assert "account_binding" in op["description"]
    assert spec["info"]["version"] == mc.__version__
