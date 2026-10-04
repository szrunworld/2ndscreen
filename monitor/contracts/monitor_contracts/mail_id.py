"""邮件记录主键 mail_message_id 的计算规则（0.3.0）。

mail_message_id 由邮件接入（G）确定性生成，保证重试时 PUT /mail-messages/{id}
幂等。它是 mail_messages 记录的主键，不是邮件头 Message-ID。两种来源：

- 有 Message-ID：``"mail:" + sha256(邮箱 + "\\n" + 规范化 Message-ID)[:32]``
- 没有 Message-ID：``"mail:" + sha256(邮箱 + "\\n\\n" + UIDVALIDITY + ":" + UID)[:32]``

邮箱地址去首尾空白后转小写；Message-ID 做 NFC、去首尾空白、去掉外层尖括号。
规范化后的 Message-ID 不会以换行开头，所以两种来源的哈希输入不会混淆。
修改本规则属于契约变更（版本号 +1）。
"""

from __future__ import annotations

import hashlib
import unicodedata

MAIL_MESSAGE_ID_PATTERN = r"^mail:[0-9a-f]{32}$"


def normalize_mailbox(mailbox: str) -> str:
    """邮箱地址：去首尾空白，转小写。"""
    return mailbox.strip().lower()


def normalize_message_id(message_id: str | None) -> str | None:
    """邮件头 Message-ID：NFC、去首尾空白、去外层尖括号。为空时返回 None。"""
    if message_id is None:
        return None
    text = unicodedata.normalize("NFC", message_id).strip()
    if text.startswith("<") and text.endswith(">"):
        text = text[1:-1].strip()
    return text or None


def compute_mail_message_id(
    mailbox: str,
    message_id: str | None = None,
    *,
    uidvalidity: int | None = None,
    uid: int | None = None,
) -> str:
    """计算 mail_message_id。有 Message-ID 时只用它；没有时必须给出 uidvalidity 与 uid。"""
    box = normalize_mailbox(mailbox)
    if not box:
        raise ValueError("mailbox 不能为空")
    mid = normalize_message_id(message_id)
    if mid is not None:
        material = f"{box}\n{mid}"
    else:
        if uidvalidity is None or uid is None or uidvalidity < 1 or uid < 1:
            raise ValueError("缺少 Message-ID 时必须给出正整数 uidvalidity 与 uid")
        material = f"{box}\n\n{uidvalidity}:{uid}"
    return "mail:" + hashlib.sha256(material.encode("utf-8")).hexdigest()[:32]
