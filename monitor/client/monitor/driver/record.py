"""录制模式：把 Driver.state() 的快照脱敏后写成 ax 夹具（monitor/fixtures/schema/ax-fixture.schema.json）。

用法::

    recorder = FixtureRecorder("conversation_list_basic", "会话列表首屏", app="BOSS直聘",
                               replacements={"张三": "候选人A"})
    driver.record_step(recorder, "初始", {"page": "conversation_list"})
    recorder.write(path)

脱敏：元素 label/value 与窗口标题先按替换表替换（姓名等由调用方提供），再用正则删除
手机号、微信号、邮箱（见 redact.py）。夹具里的 ``redaction`` 三项声明恒为 true，这是对
"已经做过脱敏"的声明：姓名只有调用方给了替换表才会被替换，提交前仍需人工抽查。
元素的 snapshot_id 不写入夹具（schema 不允许）。写出前用契约的 validate_ax_fixture 校验。
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from monitor_contracts import AxFixture, Snapshot, StepAnnotations, validate_ax_fixture

from .redact import redact_text


class FixtureRecorder:
    def __init__(
        self,
        scene: str,
        description: str,
        *,
        app: str,
        replacements: Mapping[str, str] | None = None,
        app_version: str | None = None,
        driver_name: str = "2ndscreen-cli",
        recorded_by: str | None = None,
        notes: str | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ):
        self.scene = scene
        self.description = description
        self.replacements = dict(replacements or {})
        self.source = {"app": app, "app_version": app_version, "driver": driver_name, "recorded_by": recorded_by}
        self.notes = notes
        self.clock = clock
        self.steps: list[dict[str, Any]] = []

    def _redact(self, text: str) -> str:
        return redact_text(text, self.replacements)

    def add_step(
        self, snapshot: Snapshot, label: str, annotations: Mapping[str, Any] | StepAnnotations | None = None
    ) -> dict[str, Any]:
        """把一次快照脱敏后追加为一步。annotations 缺省为 ``{"page": "other"}``。"""
        if isinstance(annotations, StepAnnotations):
            annotations = annotations.model_dump(mode="json", exclude_none=True)
        elements = []
        for element in snapshot.elements:
            data = element.model_dump(mode="json", exclude={"snapshot_id"})
            data["label"] = self._redact(element.label)
            data["value"] = self._redact(element.value)
            if data.get("enabled") is None:
                # 夹具 schema 要求 enabled 为布尔；CLI 不提供时按可用记录，并在 notes 里说明。
                data["enabled"] = True
            if data.get("parent_index") is None:
                data.pop("parent_index", None)
            if data.get("depth") is None:
                data.pop("depth", None)
            elements.append(data)
        window = None
        if snapshot.window is not None:
            window = snapshot.window.model_dump(mode="json")
            window["title"] = self._redact(window.get("title") or "")
        step = {
            "label": label,
            "window": window,
            "elements": elements,
            "annotations": dict(annotations or {"page": "other"}),
        }
        self.steps.append(step)
        return step

    def to_dict(self) -> dict[str, Any]:
        return {
            "fixture_version": 1,
            "scene": self.scene,
            "description": self.description,
            "recorded_at": self.clock().isoformat(),
            "source": self.source,
            "redaction": {
                "names_replaced": True,
                "phones_removed": True,
                "wechat_removed": True,
                "notes": self.notes
                or "由 monitor.driver.record 录制：姓名按调用方替换表替换，手机号/微信号/邮箱正则删除；"
                "CLI 不输出 enabled，一律记为 true。",
            },
            "steps": self.steps,
        }

    def fixture(self) -> AxFixture:
        """校验并返回契约模型；不合格时抛 ContractValidationError。"""
        return validate_ax_fixture(self.to_dict())

    def write(self, path: str | Path) -> Path:
        data = self.to_dict()
        validate_ax_fixture(data)
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
        return path
