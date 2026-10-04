"""邮件接入测试的公共夹具：可控时钟 + fake mail 服务 + 契约形状的 fake 服务端。

测试模块用 ``from mail_testkit import ...`` 引用这里的辅助（与 server 的 server_testkit 做法一致，
不依赖 rootdir 与 import 模式）。
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, replace
from datetime import timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest

from monitor_mail.clock import FakeClock
from monitor_mail.config import MailSettings
from monitor_mail.mail_api import HttpMailApi
from monitor_mail.server_api import HttpServerApi
from monitor_mail.service import MailIngest
from monitor_mail.storage import LocalDirStorage
from monitor_mail.store import MailStore
from monitor_mail.testing import (
    FAKE_MAIL_BASE,
    FAKE_MAIL_KEY,
    FAKE_SERVER_BASE,
    FAKE_SERVICE_TOKEN,
    FAKE_WEBHOOK_SECRET,
    FakeAttachment,
    FakeMailService,
    FakeMonitorServer,
    sample_resume_pdf,
)
from monitor_mail.webhook import handle_delivery

BOSS_SENDER = "noreply@zhipin.example"
SUBJECT_A = "候选人A 的简历（后端工程师）"


@dataclass
class Env:
    clock: FakeClock
    mail: FakeMailService
    server: FakeMonitorServer
    settings: MailSettings
    store: MailStore
    storage: LocalDirStorage
    ingest: MailIngest
    tmp: Path

    def rebuild(self, **settings_changes: Any) -> Env:
        """换配置（或模拟进程重启）：沿用同一个任务表、存储与 fake。"""
        settings = replace(self.settings, **settings_changes) if settings_changes else self.settings
        ingest = make_ingest(self.clock, self.mail, self.server, settings, self.store, self.storage,
                             mail_key=settings.mail_api_key)
        return replace(self, settings=settings, ingest=ingest)

    def with_server_handler(self, handler) -> MailIngest:
        """用自定义的服务端处理函数（例如处理完后模拟崩溃）装配一个新进程。"""
        return MailIngest(
            settings=self.settings,
            store=self.store,
            mail=HttpMailApi(base_url=FAKE_MAIL_BASE, api_key=self.settings.mail_api_key, client=self.mail.client()),
            server=HttpServerApi(base_url=FAKE_SERVER_BASE, service_token=FAKE_SERVICE_TOKEN,
                                 client=httpx.Client(transport=httpx.MockTransport(handler))),
            storage=self.storage,
            clock=self.clock,
        )

    def deliver(self, message_id: str, **kwargs: Any) -> tuple[int, dict[str, Any]]:
        body, headers = self.mail.webhook(message_id, **kwargs)
        return handle_delivery(body=body, headers=headers, store=self.store, settings=self.settings, clock=self.clock)

    def boss_mail(self, *, subject: str = SUBJECT_A, attachments: list[FakeAttachment] | None = None,
                  from_address: str = BOSS_SENDER, text: str | None = None) -> str:
        if attachments is None:
            attachments = [FakeAttachment("att1", "简历.pdf", sample_resume_pdf())]
        return self.mail.add_message(subject=subject, from_address=from_address, attachments=attachments, text=text)

    def request_resume(self, *, case_id: str = "case_1", account_id: str = "acct_1", name: str = "候选人A",
                       job: str = "后端工程师", days_ago: float = 1) -> str:
        return self.server.add_request_resume(case_id=case_id, account_id=account_id, candidate_name=name,
                                              job_title=job, executed_at=self.clock.now() - timedelta(days=days_ago))


def make_ingest(clock, mail, server, settings, store, storage, *, mail_key: str = FAKE_MAIL_KEY) -> MailIngest:
    return MailIngest(
        settings=settings,
        store=store,
        mail=HttpMailApi(base_url=FAKE_MAIL_BASE, api_key=mail_key, client=mail.client()),
        server=HttpServerApi(base_url=FAKE_SERVER_BASE, service_token=FAKE_SERVICE_TOKEN, client=server.client()),
        storage=storage,
        clock=clock,
    )


def default_settings(**changes: Any) -> MailSettings:
    base = dict(
        webhook_secret=FAKE_WEBHOOK_SECRET,
        mail_api_base_url=FAKE_MAIL_BASE,
        mail_api_key=FAKE_MAIL_KEY,
        boss_sender_allowlist=("@zhipin.example",),
    )
    base.update(changes)
    return MailSettings(**base)


@pytest.fixture
def env(tmp_path: Path) -> Env:
    clock = FakeClock()
    mail = FakeMailService(clock)
    server = FakeMonitorServer(clock)
    settings = default_settings()
    store = MailStore(str(tmp_path / "mail.db"))
    storage = LocalDirStorage(tmp_path / "blobs")
    ingest = make_ingest(clock, mail, server, settings, store, storage)
    return Env(clock, mail, server, settings, store, storage, ingest, tmp_path)


sys.modules.setdefault("mail_testkit", sys.modules[__name__])
