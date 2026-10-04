"""集成测试公共夹具。工具都在 integration_kit.py；这里只提供 pytest fixture。

本目录不是 uv 工作区成员（没有 pyproject）：它只导入已安装的 monitor-client、monitor-server、
monitor-contracts，在 monitor/ 下执行 `uv run pytest integration` 即可。
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from integration_kit import World  # noqa: E402


@pytest.fixture
def w(tmp_path: Path):
    world = World(tmp_path)
    yield world
    world.close()
