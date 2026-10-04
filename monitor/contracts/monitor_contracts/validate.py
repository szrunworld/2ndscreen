"""validate_*：先按 JSON Schema 做结构校验，再用 pydantic 做语义校验。

两层错误都转成字段级 FieldError；任何一处失败都抛 ContractValidationError。
结构错误存在时不再运行语义层（避免同一问题报两遍）。
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

from jsonschema.exceptions import ValidationError as SchemaError
from pydantic import TypeAdapter
from pydantic import ValidationError as PydanticError

from ._schemas import AX_FIXTURE_SCHEMA, CONTRACT_SCHEMAS, validator_for
from .errors import ContractValidationError, FieldError
from .fixtures import AxFixture
from .models import (
    Command,
    CommandModel,
    CommandResult,
    DeviceHeartbeat,
    DeviceRegistration,
    Event,
    HeartbeatAck,
    EventModel,
    LoginQr,
    MailMessage,
    MailVerification,
    Policy,
    SearchSnapshot,
)

_ADAPTERS: dict[str, TypeAdapter[Any]] = {
    "command": TypeAdapter(Command),
    "command_result": TypeAdapter(CommandResult),
    "event": TypeAdapter(Event),
    "search_snapshot": TypeAdapter(SearchSnapshot),
    "policy": TypeAdapter(Policy),
    "device_registration": TypeAdapter(DeviceRegistration),
    "device_heartbeat": TypeAdapter(DeviceHeartbeat),
    "heartbeat_ack": TypeAdapter(HeartbeatAck),
    "login_qr": TypeAdapter(LoginQr),
    "mail_message": TypeAdapter(MailMessage),
    "mail_verification": TypeAdapter(MailVerification),
    "ax_fixture": TypeAdapter(AxFixture),
}

_SCHEMA_FILES = {**CONTRACT_SCHEMAS, "ax_fixture": AX_FIXTURE_SCHEMA}

CONTRACT_NAMES: tuple[str, ...] = tuple(_SCHEMA_FILES)

# 判别联合的标签名会出现在 pydantic 错误路径的开头，需要去掉
_UNION_TAGS = {
    "command": set(TypeAdapter(Command).json_schema()["discriminator"]["mapping"]),
    "event": set(TypeAdapter(Event).json_schema()["discriminator"]["mapping"]),
}


def _join(parts: list[Any]) -> str:
    out = ""
    for p in parts:
        if isinstance(p, int):
            out += f"[{p}]"
        else:
            out += f".{p}" if out else str(p)
    return out


def _fmt(v: Any) -> str:
    return ", ".join(map(repr, v)) if isinstance(v, (list, tuple)) else repr(v)


def _schema_errors(err: SchemaError) -> list[FieldError]:
    """把一条 jsonschema 错误转成一或多条字段级错误。"""
    base = list(err.absolute_path)
    kw = err.validator
    val = err.validator_value
    inst = err.instance

    if kw == "required" and isinstance(inst, Mapping):
        missing = [p for p in val if p not in inst]
        return [FieldError(_join([*base, p]), "缺少必填字段", "required") for p in missing]
    if kw in ("oneOf", "anyOf") and err.context:
        # 可空对象（oneOf: [对象, null]）等情形：只剩一个分支在形状上匹配时，
        # 报告该分支内部的字段级错误，而不是笼统的"不符合任一形状"。
        branches: dict[int, list[SchemaError]] = {}
        for sub in err.context:
            branches.setdefault(sub.relative_schema_path[0], []).append(sub)
        plausible = [
            subs
            for subs in branches.values()
            if not any(s.validator in ("type", "const") and not s.relative_path for s in subs)
        ]
        if len(plausible) == 1:
            return [fe for s in plausible[0] for fe in _schema_errors(s)]
    if kw == "additionalProperties" and isinstance(inst, Mapping):
        known = set(err.schema.get("properties", {}))
        patterns = [re.compile(p) for p in err.schema.get("patternProperties", {})]
        extras = [k for k in inst if k not in known and not any(p.search(k) for p in patterns)]
        return [FieldError(_join([*base, k]), "不允许的字段", "additional_property") for k in extras]

    messages = {
        "type": lambda: f"类型错误，应为 {_fmt(val)}",
        "enum": lambda: f"取值必须是 {_fmt(val)} 之一，实际为 {inst!r}",
        "const": lambda: f"取值必须为 {val!r}，实际为 {inst!r}",
        "minLength": lambda: f"长度不能少于 {val}",
        "maxLength": lambda: f"长度不能超过 {val}",
        "minimum": lambda: f"不能小于 {val}",
        "maximum": lambda: f"不能大于 {val}",
        "minItems": lambda: f"至少需要 {val} 项",
        "maxItems": lambda: (f"必须为空（实际 {len(inst)} 项）" if val == 0 else f"最多 {val} 项"),
        "maxProperties": lambda: "此处不允许有任何字段" if val == 0 else f"字段数不能超过 {val}",
        "uniqueItems": lambda: "存在重复项",
        "pattern": lambda: f"格式不符，应匹配 {val}",
        "format": lambda: f"格式不符，应为 {val}",
        "oneOf": lambda: "不符合任一允许的形状",
        "anyOf": lambda: "不符合任一允许的形状",
        "not": lambda: "取值不被允许",
        "contains": lambda: "缺少必须包含的元素",
        "false": lambda: "此处不允许出现该字段",
    }
    key = "false" if err.schema is False else kw
    custom = err.schema.get("x-message") if isinstance(err.schema, Mapping) else None
    msg = custom or messages.get(key, lambda: err.message)()
    return [FieldError(_join(base), msg, key or "invalid")]


def schema_errors(contract: str, data: Any) -> list[FieldError]:
    """只做 JSON Schema 层校验，返回字段级错误列表（按路径排序，去重）。"""
    validator = validator_for(_SCHEMA_FILES[contract])
    out: list[FieldError] = []
    seen: set[tuple[str, str]] = set()
    for err in validator.iter_errors(data):
        for fe in _schema_errors(err):
            if (fe.path, fe.code) not in seen:
                seen.add((fe.path, fe.code))
                out.append(fe)
    return sorted(out, key=lambda e: (e.path, e.code))


def _model_errors(contract: str, exc: PydanticError) -> list[FieldError]:
    tags = _UNION_TAGS.get(contract, set())
    out: list[FieldError] = []
    for e in exc.errors():
        loc = list(e["loc"])
        if loc and loc[0] in tags:
            loc = loc[1:]
        ctx = e.get("ctx") or {}
        if e["type"] == "contract_semantic":
            prefix = _join(loc)
            sub = ctx.get("path", "")
            path = f"{prefix}.{sub}" if prefix and sub else (prefix or sub)
            out.append(FieldError(path, ctx.get("message", e["msg"]), "semantic", "model"))
        else:
            out.append(FieldError(_join(loc), e["msg"], e["type"], "model"))
    return out


def check(contract: str, data: Any) -> list[FieldError]:
    """返回全部字段级错误；空列表表示合法。"""
    if contract not in _ADAPTERS:
        raise KeyError(f"未知契约: {contract!r}，可选 {CONTRACT_NAMES}")
    errors = schema_errors(contract, data)
    if errors:
        return errors
    try:
        _ADAPTERS[contract].validate_python(data)
    except PydanticError as exc:
        return _model_errors(contract, exc)
    return []


def validate(contract: str, data: Any) -> Any:
    """校验并返回模型实例；不合法抛 ContractValidationError。"""
    errors = check(contract, data)
    if errors:
        raise ContractValidationError(contract, errors)
    return _ADAPTERS[contract].validate_python(data)


def validate_command(data: Any) -> CommandModel:
    return validate("command", data)


def validate_command_result(data: Any) -> CommandResult:
    return validate("command_result", data)


def validate_event(data: Any) -> EventModel:
    return validate("event", data)


def validate_search_snapshot(data: Any) -> SearchSnapshot:
    return validate("search_snapshot", data)


def validate_policy(data: Any) -> Policy:
    return validate("policy", data)


def validate_device_registration(data: Any) -> DeviceRegistration:
    return validate("device_registration", data)


def validate_device_heartbeat(data: Any) -> DeviceHeartbeat:
    return validate("device_heartbeat", data)


def validate_heartbeat_ack(data: Any) -> HeartbeatAck:
    return validate("heartbeat_ack", data)


def validate_login_qr(data: Any) -> LoginQr:
    return validate("login_qr", data)


def validate_mail_message(data: Any) -> MailMessage:
    return validate("mail_message", data)


def validate_mail_verification(data: Any) -> MailVerification:
    return validate("mail_verification", data)


def validate_ax_fixture(data: Any) -> AxFixture:
    return validate("ax_fixture", data)
