"""邮件接入的配置。密钥（webhook 签名密钥、mail API key、服务令牌）不进仓库，由部署注入。"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field

from monitor_contracts import normalize_mailbox

#: 默认的主题解析规则（N 实测邮件格式前的占位）。命名分组 name / job 必须都有。
#: 例："候选人A 的简历（后端工程师）"。实测后通过配置替换，不改代码。
DEFAULT_SUBJECT_PATTERNS: tuple[str, ...] = (
    r"^\s*(?P<name>[^\s（(【\[]{1,64})\s*的简历\s*[（(](?P<job>[^）)]{1,128})[）)]",
    r"^\s*【(?P<job>[^】]{1,128})】\s*(?P<name>[^\s|｜]{1,64})\s*[|｜]",
)


class ConfigError(ValueError):
    """配置缺失或不合法。"""


@dataclass(frozen=True)
class MailSettings:
    """邮件接入的全部可调项。

    - ``boss_sender_allowlist``：BOSS 发件人白名单，元素是完整地址（``a@b``）或域名（``@b``）。
      **默认空**：此时无法判断是否 BOSS 邮件，一律进 needs_review（不猜），不会 ignored。
    - ``account_aliases``：邮件主题 / 正文里出现的招聘账户标识（例如账户名或账户邮箱）→ account_id。
      都没出现时不按账户过滤，仍然要求唯一命中。
    - ``expected_mailbox_id``：mail 里 zhaopin@ 的 mailbox_id；配置后其他邮箱的推送 2xx 忽略。
    """

    mailbox: str = "zhaopin@remotedesk.io"
    #: 同一个邮箱的别名（例如 bosszhipin@remotedesk.io）。webhook 按邮箱订阅，别名的信自动包含；
    #: 自检时 key 绑定邮箱的主地址落在 mailbox 或别名里都接受。记录里的 mailbox 一律用主地址。
    mailbox_aliases: tuple[str, ...] = ()
    webhook_secret: str = ""
    mail_api_base_url: str = ""
    mail_api_key: str = ""
    expected_mailbox_id: str | None = None
    timestamp_tolerance_seconds: int = 300
    lease_seconds: int = 300
    max_attempts: int = 3
    boss_sender_allowlist: tuple[str, ...] = ()
    account_aliases: Mapping[str, str] = field(default_factory=dict)
    subject_patterns: tuple[str, ...] = DEFAULT_SUBJECT_PATTERNS
    #: 关联时只看 [收信时间 - 窗口, 收信时间] 内成功的 request_resume。
    request_window_days: int = 30
    #: 核对：pending 超过多少分钟算积压（方案 8.2 第 6 条：30 分钟）。
    pending_backlog_minutes: int = 30
    #: 核对：overdue 提醒最多回看多少天。
    overdue_lookback_days: int = 30
    #: 核对：失败投递对账的回看小时数；发现落死投递时是否按窗口自动重放。
    delivery_lookback_hours: int = 48
    auto_replay_dead_deliveries: bool = False
    #: PDF 平均每页非空白字符少于该值时判为疑似扫描版。
    scanned_min_chars_per_page: int = 20
    #: 只处理这些附件类型（按扩展名）；其余附件记录但不写 resume_document。
    resume_extensions: tuple[str, ...] = (".pdf", ".doc", ".docx")

    def __post_init__(self) -> None:
        if self.max_attempts < 1:
            raise ConfigError("max_attempts 至少为 1")
        if self.lease_seconds < 1:
            raise ConfigError("lease_seconds 至少为 1")
        if self.timestamp_tolerance_seconds < 1:
            raise ConfigError("timestamp_tolerance_seconds 至少为 1")
        for pattern in self.subject_patterns:
            compiled = re.compile(pattern)
            if not {"name", "job"} <= set(compiled.groupindex):
                raise ConfigError(f"主题规则必须同时有 name 与 job 命名分组：{pattern}")
        for entry in self.boss_sender_allowlist:
            if "@" not in entry:
                raise ConfigError(f"白名单元素必须是地址或 @域名：{entry}")
        object.__setattr__(self, "mailbox", normalize_mailbox(self.mailbox))
        object.__setattr__(self, "mailbox_aliases", tuple(normalize_mailbox(a) for a in self.mailbox_aliases))
        object.__setattr__(
            self, "boss_sender_allowlist", tuple(normalize_mailbox(e) for e in self.boss_sender_allowlist)
        )

    @property
    def mailbox_addresses(self) -> frozenset[str]:
        """本邮箱的全部地址（主地址 + 别名）。"""
        return frozenset((self.mailbox, *self.mailbox_aliases))

    def require_secrets(self) -> None:
        """部署前自检：签名密钥、mail 地址与 key 都必须配置。缺失时抛 ConfigError。"""
        missing = [
            name
            for name in ("webhook_secret", "mail_api_base_url", "mail_api_key")
            if not getattr(self, name)
        ]
        if missing:
            raise ConfigError("缺少配置：" + "、".join(missing))

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> MailSettings:
        """从环境变量读取（部署用）。列表用逗号分隔，账户别名用 ``别名=account_id`` 逗号分隔。"""
        env = os.environ if env is None else env

        def _list(name: str) -> tuple[str, ...]:
            return tuple(x.strip() for x in env.get(name, "").split(",") if x.strip())

        aliases: dict[str, str] = {}
        for item in _list("MONITOR_MAIL_ACCOUNT_ALIASES"):
            alias, sep, account = item.partition("=")
            if not sep or not alias.strip() or not account.strip():
                raise ConfigError(f"MONITOR_MAIL_ACCOUNT_ALIASES 格式应为 别名=account_id：{item}")
            aliases[alias.strip()] = account.strip()
        kwargs: dict[str, object] = {
            "mailbox": env.get("MONITOR_MAIL_MAILBOX", "zhaopin@remotedesk.io"),
            "mailbox_aliases": _list("MONITOR_MAIL_MAILBOX_ALIASES"),
            "webhook_secret": env.get("MONITOR_MAIL_WEBHOOK_SECRET", ""),
            "mail_api_base_url": env.get("MONITOR_MAIL_API_BASE_URL", ""),
            "mail_api_key": env.get("MONITOR_MAIL_API_KEY", ""),
            "expected_mailbox_id": env.get("MONITOR_MAIL_MAILBOX_ID") or None,
            "boss_sender_allowlist": _list("MONITOR_MAIL_BOSS_SENDERS"),
            "account_aliases": aliases,
        }
        if env.get("MONITOR_MAIL_SUBJECT_PATTERNS"):
            # 多条规则用换行分隔（正则里可能有逗号）。
            kwargs["subject_patterns"] = tuple(
                p for p in env["MONITOR_MAIL_SUBJECT_PATTERNS"].splitlines() if p.strip()
            )
        return cls(**kwargs)  # type: ignore[arg-type]
