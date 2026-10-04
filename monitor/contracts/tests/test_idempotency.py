"""Idempotency-Key 生成规则。"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

import pytest

from monitor_contracts import (
    claim_key,
    command_ack_key,
    command_result_key,
    events_batch_key,
    heartbeat_key,
    is_valid_idempotency_key,
    login_qr_key,
    resume_document_key,
)

CID = UUID("00000000-0000-4000-8000-000000000001")


def test_keys_are_valid_and_deterministic():
    keys = [
        command_result_key(CID),
        command_ack_key(CID),
        claim_key("dev_mac_01", CID),
        heartbeat_key("dev_mac_01", datetime(2026, 10, 4, tzinfo=UTC)),
        events_batch_key(["b" * 64, "a" * 64]),
        login_qr_key("dev_mac_01", 3),
        resume_document_key("<abc@mail.example.com>", "f" * 64),
    ]
    for key in keys:
        assert is_valid_idempotency_key(key), key
    assert command_result_key(CID) == command_result_key(str(CID)) == f"result:{CID}"
    assert command_result_key(CID) != command_ack_key(CID)


def test_events_batch_key_is_order_insensitive():
    assert events_batch_key(["a" * 64, "b" * 64]) == events_batch_key(["b" * 64, "a" * 64, "a" * 64])
    assert events_batch_key(["a" * 64]) != events_batch_key(["b" * 64])
    with pytest.raises(ValueError):
        events_batch_key([])


def test_unsafe_parts_fall_back_to_hash():
    key = claim_key("设备 一号", CID)
    assert is_valid_idempotency_key(key) and key.startswith("claim:")
    long_key = login_qr_key("d" * 200, 1)
    assert is_valid_idempotency_key(long_key)


def test_validator():
    assert not is_valid_idempotency_key("short")
    assert not is_valid_idempotency_key("has space in it")
    assert is_valid_idempotency_key("result:abc-123")
