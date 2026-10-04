"""契约测试的公共路径与样本加载。"""

from __future__ import annotations

import json
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
CONTRACTS_DIR = TESTS_DIR.parent
VECTORS_DIR = TESTS_DIR / "vectors"


def load_vectors(kind: str) -> list[tuple[str, dict]]:
    out = []
    for path in sorted((VECTORS_DIR / kind).glob("*.json")):
        out.append((path.stem, json.loads(path.read_text(encoding="utf-8"))))
    return out
