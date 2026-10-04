"""我方副本存储。接口化，第一版是本地目录（``file://`` URI），以后可换对象存储。"""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path
from typing import Protocol
from urllib.parse import unquote, urlparse


class StorageError(Exception):
    """存储读写失败（视为可重试的处理失败）。"""


class BlobStorage(Protocol):
    def put(self, key: str, data: bytes) -> str:
        """写入并返回存储 URI。同一个 key 重复写入覆盖（内容由 key 决定，崩溃重领幂等）。"""
        ...

    def get(self, uri: str) -> bytes | None:
        """读出内容；不存在时返回 None。"""
        ...

    def delete(self, uri: str) -> bool:
        """删除；返回是否真的删了东西。"""
        ...


_SAFE_KEY = re.compile(r"^[A-Za-z0-9._/-]+$")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class LocalDirStorage:
    """把副本写到本地目录。写入先落临时文件再原子改名，崩溃不会留下半个文件。"""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _path_for_key(self, key: str) -> Path:
        if not _SAFE_KEY.match(key) or ".." in key.split("/") or key.startswith("/"):
            raise StorageError(f"存储 key 不合法：{key!r}")
        return self.root / key

    def _path_for_uri(self, uri: str) -> Path:
        parsed = urlparse(uri)
        if parsed.scheme != "file":
            raise StorageError(f"不是本地存储 URI：{uri!r}")
        path = Path(unquote(parsed.path)).resolve()
        if self.root not in path.parents:
            raise StorageError(f"URI 不在存储根目录下：{uri!r}")
        return path

    def put(self, key: str, data: bytes) -> str:
        path = self._path_for_key(key)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_bytes(data)
            os.replace(tmp, path)
        except OSError as exc:
            raise StorageError(f"写入失败：{exc}") from exc
        return path.as_uri()

    def get(self, uri: str) -> bytes | None:
        path = self._path_for_uri(uri)
        try:
            return path.read_bytes()
        except FileNotFoundError:
            return None
        except OSError as exc:
            raise StorageError(f"读取失败：{exc}") from exc

    def delete(self, uri: str) -> bool:
        path = self._path_for_uri(uri)
        try:
            path.unlink()
            return True
        except FileNotFoundError:
            return False
        except OSError as exc:
            raise StorageError(f"删除失败：{exc}") from exc
