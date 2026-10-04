"""公司邮件服务 mail 的访问封装（integration API，头 ``X-Mail-Api-Key``）。

接口（remotedesk-resend ``docs/api-keys.md`` §5，网关前缀 ``/api/mail``，base_url 里自带）：
- ``GET /v1/integration/mailbox``：key 绑定的邮箱与 scope（接线自检）。
- ``GET /v1/integration/messages/{id}``：读一封信（含 ``is_auto_reply``、``attachments[]``）。
- ``GET /v1/integration/messages/{id}/attachments/{aid}/download``：取附件下载链接（附件未扫完 409）。
- ``GET /v1/integration/messages?since=``：列出邮件。**目前不存在**（任务 G0，待用户同意），
  调用得到 404/405 时抛 :class:`UpstreamListingUnavailable`，核对任务据此报"未执行"。

成功响应包在信封 ``{code, message, data}`` 里；失败是 ``{detail}`` + HTTP 状态码。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol

import httpx

from .clock import parse_time


class MailApiError(Exception):
    """访问 mail 失败。``transient`` 为 True 表示稍后重试可能成功。"""

    code = "mail_error"
    transient = True

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class MailAuthError(MailApiError):
    """key 无效 / 吊销 / 邮箱停用（401），或缺 scope（403）。"""

    code = "mail_auth_failed"
    transient = False


class MailNotFound(MailApiError):
    """邮件或附件不存在，或不属于这把 key 绑定的邮箱（mail 一律回 404）。"""

    code = "mail_not_found"
    transient = False


class AttachmentNotReady(MailApiError):
    """附件还没扫完或不是 clean（409，兼容 423）。"""

    code = "attachment_not_ready"


class DownloadLinkExpired(MailApiError):
    """下载链接已过期或被对象存储拒绝。"""

    code = "download_link_expired"


class MailUnavailable(MailApiError):
    """网络错误、超时、5xx、408、429。"""

    code = "mail_unavailable"


class UpstreamListingUnavailable(MailApiError):
    """mail 还没有"列出邮件"的 integration 接口（G0）。"""

    code = "upstream_listing_unavailable"
    transient = False


@dataclass(frozen=True)
class MailboxInfo:
    mailbox_id: str
    primary_address: str
    scopes: tuple[str, ...]
    key_name: str


@dataclass(frozen=True)
class AttachmentInfo:
    id: str
    filename: str
    content_type: str | None
    byte_size: int | None
    scan_status: str
    is_inline: bool = False
    downloadable: bool = False


@dataclass(frozen=True)
class MessageDetail:
    id: str
    mailbox_id: str
    rfc_message_id: str | None
    subject: str | None
    from_address: str | None
    received_at: datetime
    text: str | None
    is_auto_reply: bool
    raw_sha256: str | None
    purged: bool
    attachments: tuple[AttachmentInfo, ...]
    #: mail 返回的 data 原文；我方副本就是它的规范化 JSON。
    raw: dict[str, Any] = field(repr=False, compare=False, default_factory=dict)

    @classmethod
    def from_data(cls, data: dict[str, Any]) -> MessageDetail:
        try:
            attachments = tuple(
                AttachmentInfo(
                    id=str(a["id"]),
                    filename=str(a.get("filename") or "attachment"),
                    content_type=a.get("content_type"),
                    byte_size=a.get("byte_size"),
                    scan_status=str(a.get("scan_status") or "unknown"),
                    is_inline=bool(a.get("is_inline", False)),
                    downloadable=bool(a.get("downloadable", False)),
                )
                for a in data.get("attachments") or []
            )
            return cls(
                id=str(data["id"]),
                mailbox_id=str(data.get("mailbox_id") or ""),
                rfc_message_id=data.get("rfc_message_id"),
                subject=data.get("subject"),
                from_address=data.get("from_address"),
                received_at=parse_time(str(data["received_at"])),
                text=data.get("text"),
                is_auto_reply=bool(data.get("is_auto_reply", False)),
                raw_sha256=data.get("raw_sha256"),
                purged=bool(data.get("purged", False)),
                attachments=attachments,
                raw=data,
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise MailApiError(f"mail 返回的邮件详情格式不对：{exc}") from exc


@dataclass(frozen=True)
class DownloadLink:
    url: str
    expires_in_seconds: int
    filename: str


@dataclass(frozen=True)
class UpstreamMessage:
    message_id: str
    received_at: datetime


@dataclass(frozen=True)
class UpstreamPage:
    items: tuple[UpstreamMessage, ...]
    next_cursor: str | None


class MailApi(Protocol):
    def get_mailbox(self) -> MailboxInfo: ...

    def get_message(self, message_id: str) -> MessageDetail: ...

    def get_download_link(self, message_id: str, attachment_id: str) -> DownloadLink: ...

    def download(self, url: str) -> bytes: ...

    def list_messages(self, *, since: datetime, cursor: str | None = None, limit: int = 200) -> UpstreamPage:
        """可选能力（G0）：不存在时抛 UpstreamListingUnavailable。"""
        ...


@dataclass(frozen=True)
class DeliveryRecord:
    id: str
    event: str
    status: str
    message_id: str | None


class DeliveryLedger(Protocol):
    """mail 的 webhook 投递台账（admin 接口，需要 ``platform.mail.mailbox.provision`` 权限）。

    integration key 读不到台账，所以这是可选能力：没有配置管理凭据时核对报"未执行"。
    """

    def list_deliveries(self, *, since: datetime) -> Sequence[DeliveryRecord]: ...

    def replay_window(self, *, since: datetime, until: datetime) -> None: ...


def _detail(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.text[:200]
    if isinstance(body, dict) and "detail" in body:
        return str(body["detail"])[:200]
    return str(body)[:200]


class HttpMailApi:
    """mail integration API 的 HTTP 实现。下载链接是预签名地址，**不带** API key。"""

    def __init__(self, *, base_url: str, api_key: str, client: httpx.Client | None = None, timeout: float = 15.0) -> None:
        if not base_url or not api_key:
            raise ValueError("base_url 与 api_key 都必须配置")
        self._base = base_url.rstrip("/")
        self._key = api_key
        self._client = client or httpx.Client(timeout=timeout)

    def _get(self, path: str, params: dict[str, Any] | None = None, *, listing: bool = False) -> Any:
        try:
            response = self._client.get(self._base + path, params=params, headers={"X-Mail-Api-Key": self._key})
        except httpx.HTTPError as exc:
            raise MailUnavailable(f"连不上 mail：{exc}") from exc
        status = response.status_code
        if status in (200, 201):
            try:
                body = response.json()
            except ValueError as exc:
                raise MailApiError("mail 返回的不是 JSON", status=status) from exc
            if not isinstance(body, dict) or "data" not in body:
                raise MailApiError("mail 的响应缺少信封 data", status=status)
            if body.get("code", 0) != 0:
                raise MailApiError(f"mail 信封 code={body.get('code')}：{body.get('message')}", status=status)
            return body["data"]
        detail = _detail(response)
        if listing and status in (404, 405):
            raise UpstreamListingUnavailable("mail 尚无列出邮件的 integration 接口（任务 G0）", status=status)
        if status in (401, 403):
            raise MailAuthError(f"mail 拒绝了 API key：{detail}", status=status)
        if status == 404:
            raise MailNotFound(f"mail 里找不到：{detail}", status=status)
        if status in (409, 423):
            raise AttachmentNotReady(f"附件暂不可下载：{detail}", status=status)
        if status in (408, 429) or status >= 500:
            raise MailUnavailable(f"mail 暂时不可用（{status}）：{detail}", status=status)
        raise MailApiError(f"mail 返回 {status}：{detail}", status=status)

    def get_mailbox(self) -> MailboxInfo:
        data = self._get("/v1/integration/mailbox")
        try:
            return MailboxInfo(
                mailbox_id=str(data["mailbox_id"]),
                primary_address=str(data["primary_address"]),
                scopes=tuple(data.get("scopes") or ()),
                key_name=str(data.get("key_name") or ""),
            )
        except (KeyError, TypeError) as exc:
            raise MailApiError(f"mailbox 自检响应格式不对：{exc}") from exc

    def get_message(self, message_id: str) -> MessageDetail:
        return MessageDetail.from_data(self._get(f"/v1/integration/messages/{message_id}"))

    def get_download_link(self, message_id: str, attachment_id: str) -> DownloadLink:
        data = self._get(f"/v1/integration/messages/{message_id}/attachments/{attachment_id}/download")
        try:
            return DownloadLink(
                url=str(data["url"]),
                expires_in_seconds=int(data.get("expires_in_seconds") or 0),
                filename=str(data.get("filename") or ""),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise MailApiError(f"下载链接响应格式不对：{exc}") from exc

    def download(self, url: str) -> bytes:
        try:
            response = self._client.get(url)
        except httpx.HTTPError as exc:
            raise MailUnavailable(f"下载附件失败：{exc}") from exc
        if response.status_code == 200:
            return response.content
        if response.status_code in (400, 401, 403, 410):
            # 预签名链接过期时对象存储回 403（也见过 400 / 410）。
            raise DownloadLinkExpired(f"下载链接失效（{response.status_code}）", status=response.status_code)
        if response.status_code in (408, 429) or response.status_code >= 500:
            raise MailUnavailable(f"对象存储暂时不可用（{response.status_code}）", status=response.status_code)
        raise MailApiError(f"下载附件返回 {response.status_code}", status=response.status_code)

    def list_messages(self, *, since: datetime, cursor: str | None = None, limit: int = 200) -> UpstreamPage:
        params: dict[str, Any] = {"since": since.isoformat(), "limit": limit}
        if cursor:
            params["cursor"] = cursor
        data = self._get("/v1/integration/messages", params, listing=True)
        try:
            items = tuple(
                UpstreamMessage(message_id=str(i["message_id"] if "message_id" in i else i["id"]),
                                received_at=parse_time(str(i["received_at"])))
                for i in data["items"]
            )
            return UpstreamPage(items=items, next_cursor=data.get("next_cursor"))
        except (KeyError, TypeError, ValueError) as exc:
            raise MailApiError(f"列出邮件响应格式不对：{exc}") from exc
