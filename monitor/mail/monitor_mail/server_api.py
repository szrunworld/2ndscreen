"""招聘 Monitor 服务端的访问封装（``serviceToken``，基础路径 ``/api/v1``）。

只用 api.md / openapi.yaml 0.3.1 定义的接口：
``PUT /mail-messages/{id}``、``GET /mail-messages``、``POST /resume-documents``、``GET /resume-documents``、
``GET /commands``（求简历记录）、``POST /mail-verifications``。所有写接口都带 Idempotency-Key。
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from datetime import datetime
from typing import Any, Protocol

import httpx

from .clock import to_wire_time


class ServerApiError(Exception):
    """服务端返回非 2xx 或连不上。``transient`` 为 True 时稍后重试。"""

    def __init__(self, message: str, *, status: int | None = None, code: str | None = None,
                 existing: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.existing = existing

    @property
    def transient(self) -> bool:
        return self.status is None or self.status in (408, 429) or self.status >= 500


class ServerApi(Protocol):
    def put_mail_message(self, mail_message_id: str, body: dict[str, Any], idem_key: str) -> dict[str, Any]: ...

    def create_resume_document(self, body: dict[str, Any], idem_key: str) -> dict[str, Any]: ...

    def post_mail_verification(self, body: dict[str, Any], idem_key: str) -> dict[str, Any]: ...

    def list_commands(
        self,
        *,
        action: str,
        statuses: Sequence[str],
        executed_after: datetime | None = None,
        executed_before: datetime | None = None,
        account_id: str | None = None,
        case_id: str | None = None,
    ) -> Iterator[dict[str, Any]]: ...

    def list_mail_messages(
        self, *, statuses: Sequence[str], mailbox: str | None = None, received_after: datetime | None = None
    ) -> Iterator[dict[str, Any]]: ...

    def list_resume_documents(
        self, *, case_id: str | None = None, mail_message_id: str | None = None
    ) -> Iterator[dict[str, Any]]: ...


class HttpServerApi:
    def __init__(self, *, base_url: str, service_token: str, client: httpx.Client | None = None, timeout: float = 15.0) -> None:
        if not base_url or not service_token:
            raise ValueError("base_url 与 service_token 都必须配置")
        self._base = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {service_token}"}
        self._client = client or httpx.Client(timeout=timeout)

    def _request(self, method: str, path: str, *, json: Any = None, params: Any = None,
                 idem_key: str | None = None) -> dict[str, Any]:
        headers = dict(self._headers)
        if idem_key is not None:
            headers["Idempotency-Key"] = idem_key
        try:
            response = self._client.request(method, self._base + path, json=json, params=params, headers=headers)
        except httpx.HTTPError as exc:
            raise ServerApiError(f"连不上服务端：{exc}") from exc
        if 200 <= response.status_code < 300:
            return response.json()
        try:
            problem = response.json()
        except ValueError:
            problem = {}
        problem = problem if isinstance(problem, dict) else {}
        raise ServerApiError(
            f"服务端 {method} {path} 返回 {response.status_code}：{problem.get('message') or response.text[:200]}",
            status=response.status_code,
            code=problem.get("code"),
            existing=problem.get("existing"),
        )

    def _paged(self, path: str, params: list[tuple[str, str]]) -> Iterator[dict[str, Any]]:
        cursor: str | None = None
        while True:
            page_params = list(params) + [("limit", "200")] + ([("cursor", cursor)] if cursor else [])
            page = self._request("GET", path, params=page_params)
            yield from page.get("items", [])
            cursor = page.get("next_cursor")
            if not cursor:
                return

    def put_mail_message(self, mail_message_id: str, body: dict[str, Any], idem_key: str) -> dict[str, Any]:
        return self._request("PUT", f"/mail-messages/{mail_message_id}", json=body, idem_key=idem_key)

    def create_resume_document(self, body: dict[str, Any], idem_key: str) -> dict[str, Any]:
        return self._request("POST", "/resume-documents", json=body, idem_key=idem_key)

    def post_mail_verification(self, body: dict[str, Any], idem_key: str) -> dict[str, Any]:
        return self._request("POST", "/mail-verifications", json=body, idem_key=idem_key)

    def list_commands(self, *, action, statuses, executed_after=None, executed_before=None, account_id=None,
                      case_id=None) -> Iterator[dict[str, Any]]:
        params: list[tuple[str, str]] = [("action", action)] + [("status", s) for s in statuses]
        if executed_after is not None:
            params.append(("executed_after", to_wire_time(executed_after)))
        if executed_before is not None:
            params.append(("executed_before", to_wire_time(executed_before)))
        if account_id:
            params.append(("account_id", account_id))
        if case_id:
            params.append(("case_id", case_id))
        return self._paged("/commands", params)

    def list_mail_messages(self, *, statuses, mailbox=None, received_after=None) -> Iterator[dict[str, Any]]:
        params: list[tuple[str, str]] = [("status", s) for s in statuses]
        if mailbox:
            params.append(("mailbox", mailbox))
        if received_after is not None:
            params.append(("received_after", to_wire_time(received_after)))
        return self._paged("/mail-messages", params)

    def list_resume_documents(self, *, case_id=None, mail_message_id=None) -> Iterator[dict[str, Any]]:
        params: list[tuple[str, str]] = []
        if case_id:
            params.append(("case_id", case_id))
        if mail_message_id:
            params.append(("mail_message_id", mail_message_id))
        return self._paged("/resume-documents", params)
