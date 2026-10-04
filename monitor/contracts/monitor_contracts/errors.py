"""契约层的异常类型：字段级校验错误与非法状态迁移。"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class FieldError:
    """一条字段级错误。

    path 用点号与下标表示，例如 ``payload.text``、``items[0].result_ref``；
    根对象本身的错误 path 为空串。layer 区分错误来源：
    ``schema``（JSON Schema 结构校验）或 ``model``（pydantic 语义校验）。
    """

    path: str
    message: str
    code: str
    layer: str = "schema"

    def __str__(self) -> str:
        where = self.path or "<root>"
        return f"{where}: {self.message} [{self.code}]"


class ContractValidationError(ValueError):
    """契约校验失败。errors 至少有一条，每条带字段路径。"""

    def __init__(self, contract: str, errors: list[FieldError]):
        if not errors:
            raise ValueError("ContractValidationError 至少需要一条 FieldError")
        self.contract = contract
        self.errors = list(errors)
        lines = "\n".join(f"  - {e}" for e in self.errors)
        super().__init__(f"{contract} 校验失败（{len(self.errors)} 处）：\n{lines}")

    @property
    def paths(self) -> list[str]:
        return [e.path for e in self.errors]


class IllegalTransition(ValueError):
    """状态机不允许的迁移。layer 为 case / command / delivery。"""

    def __init__(self, layer: str, src: str, dst: str):
        self.layer = layer
        self.src = src
        self.dst = dst
        super().__init__(f"{layer} 状态不允许从 {src} 迁移到 {dst}")
