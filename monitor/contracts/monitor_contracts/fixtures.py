"""脱敏元素树夹具（monitor/fixtures/ax/**/fixture.json）的模型。

格式由 monitor/fixtures/schema/ax-fixture.schema.json 定义；本模块补充语义检查：
每步 elements[i].index == i，标注引用的 element_index 必须存在。
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

from .driver import Element, WindowInfo
from .models import Conversation, Frame, _fail

PageKind = Literal[
    "conversation_list",
    "conversation_detail",
    "search",
    "login",
    "login_qr",
    "captcha",
    "unknown_dialog",
    "resume_overlay",
    "other",
]


class FixtureElement(BaseModel):
    """夹具中的元素：与 Element 相同但没有 snapshot_id（回放时由 FakeDriver 填写）。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    index: Annotated[int, Field(ge=0)]
    role: Annotated[str, Field(min_length=1, max_length=64)]
    label: str
    value: str
    frame: Frame
    enabled: bool | None = None
    parent_index: Annotated[int, Field(ge=0)] | None = None
    depth: Annotated[int, Field(ge=0)] | None = None

    def to_element(self, snapshot_id: str | None = None) -> Element:
        return Element(**self.model_dump(), snapshot_id=snapshot_id)


class ConversationAnnotation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    element_index: Annotated[int, Field(ge=0)]
    conversation: Conversation
    is_new_application: bool
    unread: bool | None = None
    ambiguous: bool = False


class StepAnnotations(BaseModel):
    """一步的标注。允许 x_ 前缀的扩展键，供夹具作者记录尚未进入契约的信息。"""

    model_config = ConfigDict(extra="allow")

    page: PageKind
    conversations: list[ConversationAnnotation] = Field(default_factory=list)
    is_new_application: list[Annotated[int, Field(ge=0)]] = Field(default_factory=list)
    qr_region: Frame | None = None
    expected_events: list[str] = Field(default_factory=list)
    notes: str | None = None

    @model_validator(mode="after")
    def _check_extra(self) -> StepAnnotations:
        for key in self.model_extra or {}:
            if not key.startswith("x_"):
                raise _fail(key, "未知标注键；扩展标注请以 x_ 开头")
        return self


class FixtureStep(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: Annotated[str, Field(min_length=1, max_length=120)]
    window: WindowInfo | None
    elements: list[FixtureElement]
    annotations: StepAnnotations

    @model_validator(mode="after")
    def _check(self) -> FixtureStep:
        for pos, el in enumerate(self.elements):
            if el.index != pos:
                raise _fail(f"elements[{pos}].index", f"index 必须等于位置 {pos}")
        n = len(self.elements)
        for i, conv in enumerate(self.annotations.conversations):
            if conv.element_index >= n:
                raise _fail(f"annotations.conversations[{i}].element_index", "引用的元素不存在")
        for i, idx in enumerate(self.annotations.is_new_application):
            if idx >= n:
                raise _fail(f"annotations.is_new_application[{i}]", "引用的元素不存在")
        return self


class FixtureSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    app: Annotated[str, Field(min_length=1)]
    app_version: str | None = None
    driver: Annotated[str, Field(min_length=1)]
    recorded_by: str | None = None


class Redaction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    names_replaced: Literal[True]
    phones_removed: Literal[True]
    wechat_removed: Literal[True]
    notes: str | None = None


class AxFixture(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fixture_version: Literal[1]
    scene: Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9_]{0,63}$")]
    description: str
    recorded_at: AwareDatetime
    source: FixtureSource
    redaction: Redaction
    steps: Annotated[list[FixtureStep], Field(min_length=1)]
