"""招聘 Monitor 邮件接入（任务 G）：公司邮件服务 mail 的订阅方。

数据流（方案 8.2）：mail.ready webhook → 任务表（pending）→ 消费者按租约领取 →
integration API 回取邮件与附件 → 我方副本 + sha256 → BOSS 发件人白名单 → 去重 →
按求简历记录关联 → POST /resume-documents → PUT /mail-messages → processed。
另有我方副本保留期清理与每小时核对（POST /mail-verifications）。

装配入口见 :mod:`monitor_mail.service`（``MailIngest``）与 :mod:`monitor_mail.webhook`。
"""

from __future__ import annotations

__version__ = "0.1.0"
