"""装配：把任务表、mail 访问、服务端访问、存储、消费者、核对组装成一个对象。

用法（协调者装配，见 G.md）::

    ingest = MailIngest.from_settings(settings, db_path=..., storage_root=...,
                                      server=HttpServerApi(base_url=..., service_token=...))
    ingest.startup_check()                      # key 配错立即失败，而不是等第一封信
    app.include_router(ingest.webhook_router()) # POST /webhooks/mail
    # 后台线程：ingest.run_forever(stop_event)；每小时：ingest.verify()
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter

from .clock import Clock, SystemClock
from .config import MailSettings
from .consumer import Consumer, ProcessOutcome
from .mail_api import DeliveryLedger, HttpMailApi, MailApi
from .retention import DEFAULT_RETENTION_DAYS
from .server_api import ServerApi
from .storage import BlobStorage, LocalDirStorage
from .store import MailStore
from .verify import Verifier, self_check
from .webhook import create_webhook_router

logger = logging.getLogger(__name__)


@dataclass
class CycleReport:
    flushed: int
    registered: int
    outcomes: list[ProcessOutcome]


class MailIngest:
    def __init__(
        self,
        *,
        settings: MailSettings,
        store: MailStore,
        mail: MailApi,
        server: ServerApi,
        storage: BlobStorage,
        clock: Clock | None = None,
        ledger: DeliveryLedger | None = None,
        retention_days: int | Callable[[], int] = DEFAULT_RETENTION_DAYS,
        resume_mail_timeout_days: int | Callable[[], int] = 3,
    ) -> None:
        self.settings = settings
        self.store = store
        self.mail = mail
        self.server = server
        self.storage = storage
        self.clock = clock or SystemClock()
        self.consumer = Consumer(store=store, mail=mail, server=server, storage=storage, settings=settings,
                                 clock=self.clock)
        self.verifier = Verifier(store=store, mail=mail, server=server, storage=storage, settings=settings,
                                 clock=self.clock, ledger=ledger, retention_days=retention_days,
                                 resume_mail_timeout_days=resume_mail_timeout_days)

    @classmethod
    def from_settings(cls, settings: MailSettings, *, db_path: str | Path, storage_root: str | Path,
                      server: ServerApi, **kwargs: Any) -> MailIngest:
        settings.require_secrets()
        return cls(
            settings=settings,
            store=MailStore(str(db_path)),
            mail=HttpMailApi(base_url=settings.mail_api_base_url, api_key=settings.mail_api_key),
            server=server,
            storage=LocalDirStorage(storage_root),
            **kwargs,
        )

    def startup_check(self) -> str:
        """接线自检：key 绑定 zhaopin@ 且有 mail.read。失败抛 SelfCheckError。"""
        return self_check(self.mail, self.settings)

    def webhook_router(self, path: str = "/webhooks/mail") -> APIRouter:
        return create_webhook_router(store=self.store, settings=self.settings, clock=self.clock, path=path)

    def run_cycle(self, max_messages: int = 100) -> CycleReport:
        """一轮：补发 outbox → 登记新推送 → 处理到没有可处理的任务。"""
        flushed, _ = self.consumer.writer.flush()
        registered = self.consumer.register_pending()
        outcomes = self.consumer.run_until_idle(limit=max_messages)
        return CycleReport(flushed, registered, outcomes)

    def verify(self) -> dict[str, Any]:
        return self.verifier.run()

    def requeue(self, mail_message_id: str) -> bool:
        return self.consumer.requeue(mail_message_id)

    def run_forever(self, stop: threading.Event, *, idle_seconds: float = 15.0,
                    verify_every_seconds: float = 3600.0) -> None:
        """后台循环（部署用）。空闲时用 ``stop.wait`` 等待——这是轮询间隔，不是用来等某个状态的固定 sleep。"""
        last_verify: datetime | None = None
        while not stop.is_set():
            try:
                report = self.run_cycle()
                now = self.clock.now()
                if last_verify is None or (now - last_verify).total_seconds() >= verify_every_seconds:
                    self.verify()
                    last_verify = now
            except Exception:  # noqa: BLE001 - 后台循环不能因单次异常退出
                logger.exception("邮件接入循环出错")
                report = None
            if report is None or not report.outcomes:
                stop.wait(idle_seconds)
