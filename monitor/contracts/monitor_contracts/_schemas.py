"""定位并加载 JSON Schema，构建带引用注册表的校验器。

schemas/ 目录在源码中位于包外（monitor/contracts/schemas），打 wheel 时被
复制进包内（monitor_contracts/schemas）。两处都查找，包内优先。
"""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

# 对外的契约名 → schema 文件名
CONTRACT_SCHEMAS: dict[str, str] = {
    "command": "command.json",
    "command_result": "command_result.json",
    "event": "event.json",
    "search_snapshot": "search_snapshot.json",
    "policy": "policy.json",
    "device_registration": "device_registration.json",
    "device_heartbeat": "device_heartbeat.json",
    "login_qr": "login_qr.json",
    "mail_message": "mail_message.json",
    "mail_verification": "mail_verification.json",
}

AX_FIXTURE_SCHEMA = "ax-fixture.schema.json"

_PKG_DIR = Path(__file__).resolve().parent


def schemas_dir() -> Path:
    """返回契约 schema 所在目录。"""
    for candidate in (_PKG_DIR / "schemas", _PKG_DIR.parent / "schemas"):
        if (candidate / "common.json").is_file():
            return candidate
    raise FileNotFoundError("找不到 monitor_contracts 的 schemas 目录")


def ax_fixture_schema_path() -> Path:
    """返回夹具格式 schema 的路径（monitor/fixtures/schema/ax-fixture.schema.json）。"""
    for candidate in (
        _PKG_DIR / "schemas" / AX_FIXTURE_SCHEMA,
        _PKG_DIR.parent.parent / "fixtures" / "schema" / AX_FIXTURE_SCHEMA,
    ):
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(f"找不到 {AX_FIXTURE_SCHEMA}")


def _read(path: Path) -> Any:
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


@cache
def load_schema(file_name: str) -> dict[str, Any]:
    """按文件名读取 schema（ax-fixture 单独定位）。"""
    if file_name == AX_FIXTURE_SCHEMA:
        return _read(ax_fixture_schema_path())
    return _read(schemas_dir() / file_name)


@cache
def registry() -> Registry:
    """以文件名为键注册全部 schema，使 "common.json#/$defs/x" 这类相对引用可解析。"""
    resources = []
    for path in sorted(schemas_dir().glob("*.json")):
        resources.append((path.name, Resource.from_contents(_read(path), default_specification=DRAFT202012)))
    return Registry().with_resources(resources)


@cache
def validator_for(file_name: str) -> Draft202012Validator:
    schema = load_schema(file_name)
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(
        schema,
        registry=registry(),
        format_checker=Draft202012Validator.FORMAT_CHECKER,
    )
