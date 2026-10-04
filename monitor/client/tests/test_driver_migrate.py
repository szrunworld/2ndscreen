"""旧形状夹具迁移工具的测试。"""

from __future__ import annotations

import json

import pytest
from monitor_contracts import ContractValidationError

from monitor.driver.tools.migrate_legacy_fixture import (
    DEFAULT_ROOT,
    main,
    migrate_element,
    migrate_file,
    migrate_text_file,
    split_text,
)


@pytest.mark.parametrize(
    "role,text,expected",
    [
        ("AXCheckBox", "过滤近14天查看 | 0", ("过滤近14天查看", "0")),
        ("AXButton", "a | b | c", ("a", "b | c")),
        ("AXButton", "求简历", ("求简历", "")),
        ("AXLink", "消息620", ("消息620", "")),
        ("AXStaticText", "候选人A", ("", "候选人A")),
        ("AXTextField", "搜索内容", ("", "搜索内容")),
        ("AXTextArea/AXSomething", "草稿", ("", "草稿")),
        ("AXComboBox", "12", ("", "12")),
        ("AXSearchField", "前端", ("", "前端")),
        ("AXGroup", "", ("", "")),
    ],
)
def test_split_text(role, text, expected):
    assert split_text(role, text) == expected


def test_migrate_element_keeps_order_and_extra_fields():
    old = {"index": 3, "role": "AXButton", "text": "确定", "frame": {"x": 1, "y": 2, "w": 3, "h": 4}, "enabled": True, "depth": 2}
    new = migrate_element(old)
    assert list(new) == ["index", "role", "label", "value", "frame", "enabled", "depth"]
    assert new["label"] == "确定" and new["value"] == "" and new["enabled"] is None and new["depth"] == 2


def test_migrate_element_already_new_is_untouched():
    new = {"index": 0, "role": "AXButton", "label": "x", "value": "", "frame": {"x": 0, "y": 0, "w": 1, "h": 1}, "enabled": None}
    assert migrate_element(new) is new


def legacy_text(elements_lines: list[str]) -> str:
    head = {
        "fixture_version": 1,
        "scene": "legacy_demo",
        "description": "旧形状",
        "recorded_at": "2026-10-04T19:10:00+08:00",
        "source": {"app": "Demo", "driver": "2ndscreen-cli"},
        "redaction": {"names_replaced": True, "phones_removed": True, "wechat_removed": True},
    }
    body = ",\n".join("        " + line for line in elements_lines)
    lines = [json.dumps(head, ensure_ascii=False, indent=2)[:-2] + ","]
    lines.append('  "steps": [\n    {\n      "label": "一步",\n      "window": null,\n'
                 '      "annotations": {"page": "other", "x_refs": {"btn": 1}},\n      "elements": [')
    lines.append(body)
    lines.append("      ]\n    }\n  ]\n}\n")
    return "\n".join(lines)


ELEMENTS = [
    '{"index": 0, "role": "AXStaticText", "text": "候选人A", "frame": {"x": 0, "y": 0, "w": 10, "h": 10}, "enabled": true}',
    '{"index": 1, "role": "AXButton", "text": "求简历", "frame": {"x": 20, "y": 0, "w": 10, "h": 10}, "enabled": true}',
    '{"index": 2, "role": "AXCheckBox", "text": "未读 | 1", "frame": {"x": 40, "y": 0, "w": 10, "h": 10}, "enabled": true}',
]


def test_line_migration_only_touches_element_lines():
    raw = legacy_text(ELEMENTS)
    text, report = migrate_text_file(raw)
    old_lines, new_lines = raw.splitlines(), text.splitlines()
    changed = [i for i, (a, b) in enumerate(zip(old_lines, new_lines, strict=True)) if a != b]
    assert len(changed) == 3 and all('"index"' in old_lines[i] for i in changed)
    data = json.loads(text)
    els = data["steps"][0]["elements"]
    assert (els[0]["label"], els[0]["value"]) == ("", "候选人A")
    assert (els[1]["label"], els[1]["value"]) == ("求简历", "")
    assert (els[2]["label"], els[2]["value"]) == ("未读", "1")
    assert all(e["enabled"] is None for e in els)
    assert data["steps"][0]["annotations"] == {"page": "other", "x_refs": {"btn": 1}}
    assert (report.elements, report.migrated, report.split, report.to_value) == (3, 3, 1, 1)
    # 迁移是幂等的。
    again, report2 = migrate_text_file(text)
    assert again == text and report2.migrated == 0


def test_multiline_elements_are_refused():
    raw = legacy_text(ELEMENTS).replace('"text": "求简历", ', '"text": "求简历",\n ')
    with pytest.raises((ValueError, json.JSONDecodeError)):
        migrate_text_file(raw)


def test_invalid_result_is_not_written(tmp_path):
    bad = ELEMENTS[:1] + ['{"index": 5, "role": "AXButton", "text": "x", "frame": {"x": 0, "y": 0, "w": 1, "h": 1}, "enabled": true}']
    path = tmp_path / "fixture.json"
    path.write_text(legacy_text(bad))
    before = path.read_text()
    with pytest.raises(ContractValidationError):
        migrate_file(path)
    assert path.read_text() == before


def test_main_check_does_not_write(tmp_path, capsys):
    path = tmp_path / "fixture.json"
    path.write_text(legacy_text(ELEMENTS))
    before = path.read_text()
    assert main(["--check", str(path)]) == 0
    assert path.read_text() == before and "迁移 3" in capsys.readouterr().out
    assert main([str(path)]) == 0
    assert '"label": "未读"' in path.read_text()


def test_repository_fixtures_are_migrated():
    # 仓库里的 B 夹具已迁移：再跑一遍没有可迁移的元素。
    paths = sorted(DEFAULT_ROOT.glob("**/fixture.json"))
    assert paths
    for path in paths:
        assert migrate_file(path, write=False).migrated == 0
