"""邮件记录主键 mail_message_id 的计算规则（0.3.1）。

Monitor 不直接接 Resend，而是公司邮件服务 mail（amplifistudio/remotedesk-resend）的订阅方：
mail.ready webhook 推来 mail 的 message_id（UUID），邮件接入（G）用它回取邮件与附件。
因此 mail_message_id = ``"mail:" + mail 的 message_id``（小写 UUID）。同一封邮件的 webhook
可能投递多次，主键不变，所以 PUT /mail-messages/{id} 天然幂等。

邮件头 Message-ID 仍保留在 mail_message.message_id，只用于展示和排查，不参与主键。
修改本规则属于契约变更（版本号 +1）。
"""

from __future__ import annotations

import unicodedata
from uuid import UUID

MAIL_PROVIDER = "remotedesk-mail"
MAIL_MESSAGE_ID_PATTERN = r"^mail:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"


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


def compute_mail_message_id(provider_message_id: str | UUID) -> str:
    """mail 的 message_id（UUID）→ mail_message_id。不是合法 UUID 时抛 ValueError。"""
    try:
        value = provider_message_id if isinstance(provider_message_id, UUID) else UUID(str(provider_message_id).strip())
    except ValueError:
        raise ValueError(f"mail 的 message_id 必须是 UUID：{provider_message_id!r}") from None
    return f"mail:{value}"
