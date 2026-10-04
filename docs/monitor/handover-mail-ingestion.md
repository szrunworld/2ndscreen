# 交接：BOSS 简历邮件接入（交给服务器端）

日期：2026-10-04。交出方：招聘 Monitor（本仓库 `monitor-v1` 分支）。接收方：服务器端（建议并入 ATS，即 `amplifistudio/remotedesk-recruiting` 的后端，由其负责人决定）。

## 一、为什么交出去

用户决定（2026-10-04）：邮件收简历是服务器端可以定向执行的定时任务，与设备无关，不应由 Monitor 负责。招聘业务（候选人、流程、简历存储与解析）的权威是 ATS，简历最终也要进 ATS。

说明：这段代码本来就是服务端组件（webhook + 后台消费者），从未在客户端运行。交接后 Monitor 只保留本机执行器与薄桥接服务。

## 二、它做什么

```
BOSS（候选人同意发送简历）──自动发信──> zhaopin@remotedesk.io（别名 bosszhipin@）
公司邮件服务 mail（remotedesk-resend）── mail.ready webhook ──> 本组件
本组件：验签 → 按投递 id 与 message_id 幂等落 pending → 2xx
        消费者（任务表 + 租约，无 MQ）：integration API 取信与附件 → 副本 + sha256
        → BOSS 发件人白名单 → 附件去重 → 关联候选人 → 写入简历 → processed / needs_review / failed
        副本保留 30 天清理；每小时核对 8 项
```

关键规则（来自用户决定与真机发现）：

- 只订 `mail.ready`（附件扫描完成后才推）；推送体只有标识，内容用 integration API key 回取。
- 不删除 mail 服务里的邮件：mail 只由留存任务销毁（受 legal hold 约束），邮箱 `retention_days=30` 由管理员在 mail 侧设置。
- BOSS 发件人白名单默认空 → 所有邮件进人工处理，不猜；第一封真实 BOSS 简历邮件到达后再配置。
- 关联只在唯一命中时自动完成（账户 + 岗位 + 姓名，结合求简历的执行时间窗）；同名、多岗位或找不到 → 人工队列，不按姓名硬匹配。
- 不读、不 OCR 扫描版 PDF，只标记。
- 上游完整性（mail 有、我方没收到）由邮件服务侧的监控负责（用户 2026-10-04），本组件不做"列出邮件"对账（原 G0 取消）。

## 三、代码与测试

| 位置 | 内容 |
| --- | --- |
| `monitor/mail/monitor_mail/webhook.py`、`signature.py` | webhook 路由与 HMAC-SHA256 验签（原始字节，时间戳容差 5 分钟） |
| `store.py`、`consumer.py`、`service.py` | 任务表、租约领取、消费流程、失败计数 |
| `mail_api.py` | mail 服务 integration API 客户端（`X-Mail-Api-Key`，平台信封） |
| `matching.py` | 关联规则 |
| `pdf_text.py` | pypdf 文本提取与扫描版判定 |
| `storage.py`、`retention.py` | 副本存储（本地目录，接口可换对象存储）与 30 天清理 |
| `verify.py` | 核对任务（8 项，其中 upstream_missing 与 webhook_delivery_failed 报 null 并写原因） |
| `server_api.py`、`writer.py` | 写入服务端的客户端（当前对接 Monitor 服务端的 `/mail-messages`、`/mail-verifications`、`/resume-documents`） |
| `config.py` | 全部配置项（含收件地址别名列表） |
| `testing.py`、`tests/` | fake mail 服务与 132 个测试 |

运行：`cd monitor && uv sync && uv run pytest mail`。依赖本仓库的 `monitor-contracts`（`mail_message`、`mail_verification`、`resume_document` 的形状与 `MAIL_TRANSITIONS`），详见 `docs/monitor/contracts.md` 0.3.1。设计正文见 `docs/monitor/monitor-spec.md` 8.2，交付报告见 `docs/monitor/agent-reports/G.md`。

## 四、接收方需要改的地方

1. **写入目标改为 ATS**：`server_api.py` / `writer.py` 现在写 Monitor 服务端的 `/resume-documents` 等端点。并入 ATS 后应改为 ATS 自己的简历入库路径（ATS 现有 `/admin/imports` 批量导入，或其内部服务调用），简历存储与解析（nebula `resume-extraction`）复用 ATS 已有能力。
2. **候选人身份**：ATS 按手机号或邮箱去重候选人；BOSS 简历 PDF 里通常有联系方式，可直接按 ATS 规则入库。关联到哪个 `application`，需要 ATS 侧有"BOSS 求简历"的记录（来自执行器回传的 `request_resume` 结果：账户、岗位、候选人姓名、执行时间）。这部分接口要等 ATS 定义执行器契约（channel_task）。
3. **契约归属**：`mail_message` / `mail_verification` 的形状目前定义在 Monitor 的契约包里；并入 ATS 后由 ATS 的契约管理，Monitor 侧随后删除这些定义。
4. **部署配置**（不进仓库）：见第五节。

## 五、部署时管理员要在 mail 服务配置的项目

1. 公共邮箱 CV 已建：`zhaopin@remotedesk.io`，别名 `bosszhipin@remotedesk.io`。记下 `mailbox_id`。
2. 该邮箱 `retention_days = 30`（当前默认 365）。
3. 把接收方服务主机加入 mail 的 `MAIL_WEBHOOK_ALLOWED_HOSTS`。
4. 建订阅：`events=["mail.ready"]`，`include_spam=false`，`include_catch_all=false`，`max_attempts=9`；返回的 secret 只出现一次，直接放进部署环境变量。
5. 签发 integration API key：`scopes=["mail.read"]`，只返回一次，放进部署环境变量。
6. 运维：订阅连续失败 20 次会被自动停用；停机超过约 46 小时的推送会落死，需按窗口重放。

## 六、遗留问题

- 副本清理后再写同一封邮件记录的幂等键：临时在键里加"已清理"段，需在契约里正式定义。
- 服务端令牌读取策略（保留天数、超时天数）的权限：Monitor 服务端在 F3 中登记；并入 ATS 后改用 ATS 的配置。
- BOSS 发件人地址、邮件主题与正文格式尚未实测（等第一封真实简历邮件）。

## 七、Monitor 侧的后续动作

- 接收方确认接手后，Monitor 从工作区移除 `mail` 成员与 `monitor/mail/` 目录，并删除契约里仅为它服务的定义；在此之前代码保留在 `monitor-v1`，不再扩展。
- Monitor 服务端为 G 提供的 `/mail-messages`、`/mail-verifications`、`/resume-documents` 端点（任务 F3 中）同样冻结，随交接一起移除。
