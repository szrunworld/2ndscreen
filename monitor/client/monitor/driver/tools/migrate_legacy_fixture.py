"""一次性迁移：把任务 B 早期夹具的元素形状 ``{index, role, text, frame, enabled}``
改成契约的 ``{index, role, label, value, frame, enabled}``。只改形状，不改观察结论。

规则（协调者裁决，2026-10-04）：

1. ``text`` 含 `` | ``：按第一个分隔符拆成 label 与 value（B 的约定是 ``label | value``）。
2. 否则按角色放：文本类角色（``TEXT_VALUE_ROLES``，比较子角色前的基础角色）放 value，
   其余放 label，另一边置空串。AXStaticText 归文本类：CLI 只在静态文本有 value 时才列出它，
   真机上它的文字总在 value 上。
3. ``enabled`` 一律改为 null（CLI 不提供可用状态，旧夹具里的 true 不是观察结果）。
4. 其他字段（parent_index、depth、annotations……）原样保留。

B 的夹具每个元素占一行，迁移逐行改写元素行，其余行原样保留，diff 只落在元素上。
写回前用 validate_ax_fixture 校验整份夹具，不通过就不写。

用法::

    uv run python -m monitor.driver.tools.migrate_legacy_fixture [--check] [PATH ...]

不给 PATH 时处理 monitor/fixtures/ax/**/fixture.json；``--check`` 只报告不写。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from monitor_contracts import validate_ax_fixture

SEPARATOR = " | "
TEXT_VALUE_ROLES = frozenset({"AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXStaticText"})
DEFAULT_ROOT = Path(__file__).resolve().parents[4] / "fixtures" / "ax"

_ELEMENT_LINE = re.compile(r'^(?P<indent>\s*)(?P<body>\{"index": .*\})(?P<comma>,?)\s*$')


def split_text(role: str, text: str) -> tuple[str, str]:
    """按规则 1、2 把旧 text 拆成 (label, value)。"""
    label, sep, value = text.partition(SEPARATOR)
    if sep:
        return label, value
    if role.split("/", 1)[0] in TEXT_VALUE_ROLES:
        return "", text
    return text, ""


def migrate_element(element: dict[str, Any]) -> dict[str, Any]:
    """旧元素 → 新元素；已经是新形状的原样返回。键顺序 index, role, label, value, frame, enabled, …"""
    if "text" not in element:
        return element
    label, value = split_text(element["role"], element["text"] or "")
    out: dict[str, Any] = {"index": element["index"], "role": element["role"], "label": label, "value": value}
    for key, item in element.items():
        if key in ("index", "role", "text"):
            continue
        out[key] = None if key == "enabled" else item
    out.setdefault("enabled", None)
    return out


@dataclass
class Report:
    path: Path
    elements: int = 0
    migrated: int = 0
    split: int = 0
    to_value: int = 0


def migrate_text_file(raw: str, path: Path = Path("<memory>")) -> tuple[str, Report]:
    """逐行迁移文件内容，返回新内容与统计。元素不是一行一个时抛 ValueError。"""
    report = Report(path)
    lines = raw.splitlines(keepends=True)
    out = []
    for line in lines:
        m = _ELEMENT_LINE.match(line.rstrip("\n"))
        if not m:
            out.append(line)
            continue
        element = json.loads(m.group("body"))
        if json.dumps(element, ensure_ascii=False) != m.group("body"):
            raise ValueError(f"{path}: 元素行不是标准紧凑格式，无法逐行改写：{m.group('body')[:80]}")
        report.elements += 1
        new = migrate_element(element)
        if new is not element:
            report.migrated += 1
            report.split += SEPARATOR in (element.get("text") or "")
            report.to_value += bool(new["value"]) and SEPARATOR not in (element.get("text") or "")
        ending = "\n" if line.endswith("\n") else ""
        out.append(f"{m.group('indent')}{json.dumps(new, ensure_ascii=False)}{m.group('comma')}{ending}")
    text = "".join(out)
    # 逐行改写的结果必须与整体迁移一致，且通过契约校验。
    expected = json.loads(raw)
    for step in expected.get("steps") or ():
        step["elements"] = [migrate_element(e) for e in step.get("elements") or ()]
    if json.loads(text) != expected:
        raise ValueError(f"{path}: 逐行迁移结果与整体迁移不一致（元素可能跨行）")
    count = sum(len(s.get("elements") or ()) for s in expected.get("steps") or ())
    if count != report.elements:
        raise ValueError(f"{path}: 只找到 {report.elements}/{count} 个单行元素")
    validate_ax_fixture(expected)
    return text, report


def migrate_file(path: Path, write: bool = True) -> Report:
    raw = path.read_text()
    text, report = migrate_text_file(raw, path)
    if write and text != raw:
        path.write_text(text)
    return report


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="迁移旧形状 ax 夹具（text → label/value，enabled → null）")
    parser.add_argument("paths", nargs="*", type=Path)
    parser.add_argument("--check", action="store_true", help="只报告，不写回")
    args = parser.parse_args(argv)
    paths = args.paths or sorted(DEFAULT_ROOT.glob("**/fixture.json"))
    if not paths:
        print("没有找到夹具", file=sys.stderr)
        return 1
    for path in paths:
        r = migrate_file(path, write=not args.check)
        print(f"{path}: 元素 {r.elements}，迁移 {r.migrated}，拆分 {r.split}，放 value {r.to_value}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
