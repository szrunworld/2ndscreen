"""设备令牌的存放：优先 macOS keychain，不可用时退回 0600 文件。

keychain 通过系统自带的 `security` 工具访问。写入用 `security -i` 从 stdin 读命令，
令牌不出现在进程参数里（`ps` 看不到）。为了让 stdin 命令行不需要转义，只接受
URL 安全字符集的令牌；其他字符的令牌直接走文件。
"""

from __future__ import annotations

import os
import re
import stat
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .paths import TokenStoreKind

KEYCHAIN_SERVICE = "com.recruit-monitor.device-token"
_SAFE_TOKEN = re.compile(r"^[A-Za-z0-9._~+/=-]{8,512}$")
_SAFE_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")

Runner = Callable[..., subprocess.CompletedProcess[str]]


class TokenStoreError(Exception):
    """令牌读写失败。"""


class TokenStore(Protocol):
    kind: TokenStoreKind

    def save(self, device_id: str, token: str) -> None: ...

    def load(self, device_id: str) -> str: ...

    def delete(self, device_id: str) -> None: ...


@dataclass
class KeychainStore:
    """login keychain 里的通用密码项：service=KEYCHAIN_SERVICE，account=device_id。"""

    runner: Runner = subprocess.run
    binary: str = "security"
    service: str = KEYCHAIN_SERVICE
    kind: TokenStoreKind = "keychain"

    def available(self) -> bool:
        try:
            done = self.runner([self.binary, "default-keychain"], capture_output=True, text=True, timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            return False
        return done.returncode == 0 and bool((done.stdout or "").strip())

    def save(self, device_id: str, token: str) -> None:
        if not _SAFE_TOKEN.match(token) or not _SAFE_ID.match(device_id):
            raise TokenStoreError("令牌或设备 ID 含有 keychain 命令行无法安全传递的字符")
        line = f"add-generic-password -U -a {device_id} -s {self.service} -w {token}\n"
        try:
            done = self.runner([self.binary, "-i"], input=line, capture_output=True, text=True, timeout=20)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise TokenStoreError(f"无法调用 security: {type(exc).__name__}") from None
        # security -i 遇到错误时退出码仍可能为 0，错误写在 stderr；再读一次确认。
        if done.returncode != 0 or (done.stderr or "").strip():
            raise TokenStoreError(f"写入 keychain 失败: {(done.stderr or '').strip()[:200]}")
        if self.load(device_id) != token:
            raise TokenStoreError("写入 keychain 后读回的令牌不一致")

    def load(self, device_id: str) -> str:
        try:
            done = self.runner(
                [self.binary, "find-generic-password", "-a", device_id, "-s", self.service, "-w"],
                capture_output=True,
                text=True,
                timeout=20,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise TokenStoreError(f"无法调用 security: {type(exc).__name__}") from None
        token = (done.stdout or "").strip()
        if done.returncode != 0 or not token:
            raise TokenStoreError("keychain 中没有本设备的令牌")
        return token

    def delete(self, device_id: str) -> None:
        try:
            self.runner(
                [self.binary, "delete-generic-password", "-a", device_id, "-s", self.service],
                capture_output=True,
                text=True,
                timeout=20,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass


@dataclass
class FileStore:
    """0600 文件；目录 0700。读取时拒绝权限过宽的文件（与 __main__.read_token 的规则一致）。"""

    path: Path
    kind: TokenStoreKind = "file"

    def save(self, device_id: str, token: str) -> None:
        if not token.strip():
            raise TokenStoreError("令牌为空")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(token)
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        except OSError as exc:
            raise TokenStoreError(f"写入令牌文件失败: {exc}") from None

    def load(self, device_id: str) -> str:
        try:
            st = self.path.stat()
        except FileNotFoundError:
            raise TokenStoreError(f"令牌文件不存在: {self.path}") from None
        if st.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
            raise TokenStoreError(f"令牌文件权限过宽（{oct(st.st_mode & 0o777)}），应为 0600")
        token = self.path.read_text(encoding="utf-8").strip()
        if not token:
            raise TokenStoreError("令牌文件为空")
        return token

    def delete(self, device_id: str) -> None:
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass


def save_token(device_id: str, token: str, *, keychain: KeychainStore | None, file_store: FileStore) -> TokenStore:
    """先试 keychain，失败或不可用时写文件。返回实际使用的存放方式。两者都失败抛 TokenStoreError。"""
    if keychain is not None and keychain.available():
        try:
            keychain.save(device_id, token)
            return keychain
        except TokenStoreError:
            pass
    file_store.save(device_id, token)
    return file_store


def store_for(kind: TokenStoreKind, *, keychain: KeychainStore, file_store: FileStore) -> TokenStore:
    return keychain if kind == "keychain" else file_store
