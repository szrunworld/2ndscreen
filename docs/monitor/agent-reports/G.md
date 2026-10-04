# 任务 G 交付报告：邮件接入（公司邮件服务 mail 的订阅方）

分支 `szrunworld/monitor-G`，代码全部在 `monitor/mail/**`（新包 `monitor-mail`，模块 `monitor_mail`）。依据：方案 8.2（mail 服务版）、任务说明第五节 G、contracts.md 0.3.1、api.md、F1/A3 报告，以及 remotedesk-resend 的 `docs/outbound-webhooks.md`、`docs/api-keys.md` 和对应源码（`security/signature.py`、`api/integration.py`、`api/schemas.py`、`services/webhooks.py`，只读）。

## Commit 列表

见 `git log szrunworld/monitor-G`。G 的 commit 是 "monitor/mail: 邮件接入（mail.ready webhook、任务表消费者、副本清理、核对）（任务 G）"，同时提交本报告。

## 运行过的测试命令与结果

| 命令 | 结果 |
| --- | --- |
| `cd monitor/mail && uv run pytest` | **132 passed**（consumer 34、units 53、verify 14、signature 15、webhook 10、retention 6） |
| `cd monitor && uv run pytest contracts client server` | **1181 passed**，不受影响（本任务没有改这三个成员的任何文件） |
| `uvx ruff check --select F,E9,B monitor_mail tests` | 通过 |

过程中出现过的失败：`test_overdue_resume_requests` 一次（测试数据里两个流程用了同一个候选人，邮件按设计判为歧义，改的是测试数据）；`test_store_attachment_upsert_keeps_doc` 两次（失败路径的写法与函数签名冲突，改的是测试）。都没有改实现。写报告时自查发现一处实现缺陷并已修复：回取后曾用邮件详情的 received_at 覆盖登记时的 occurred_at，真 server 会因不可变字段回 409；fake 原先把两者设成同一时刻没测出来，现已让 fake 的 occurred_at 晚 2 分钟（与 mail 实际行为一致），旧实现在该 fake 下测试失败，修复后全部通过。

时间全部用 `FakeClock.advance` 推进，没有固定 sleep。部署用的后台循环 `run_forever` 空闲时用 `stop.wait(idle_seconds)` 作轮询间隔（有注释），测试里传 0。

## 实现概要

| 模块 | 内容 |
| --- | --- |
| `signature.py` | 验签：`X-RemoteDesk-Webhook-Id/-Timestamp/-Signature`，`v1,<base64>`（多个候选、任一匹配），HMAC-SHA256 覆盖 `{id}.{timestamp}.{原始字节}`，常量时间比较，容差默认 300 秒；密钥未配置一律拒绝。算法与 mail 的 `security/signature.py::digest` 逐字节一致（有测试） |
| `webhook.py` | `create_webhook_router(...)` → `POST /webhooks/mail`。签名错误 / 缺头 / 时间戳过期 401；非 `mail.ready`、非 inbound、其他邮箱（配置了 mailbox_id 时）回 200 并忽略；签名正确但体不合法 400；按投递 id 与 mail_message_id 两层幂等写任务表（pending），**不做任何网络调用**，立即 200 |
| `store.py` | SQLite 任务表（代替 MQ）：`mail_tasks`、`webhook_deliveries`、`mail_attachments`、`outbox`、`purge_log`。租约领取在 `BEGIN IMMEDIATE` 下原子完成（8 线程并发只成功一次有测试），过期租约可重领，失败退避用 `next_attempt_at`。迁移按 `user_version`，库版本高于代码拒绝降级 |
| `writer.py` | 对服务端的所有写都先把请求体落进 `outbox` 再发：重试和崩溃重领复用同一个 Idempotency-Key **和同一个请求体**，不会触发 422 `idempotency_key_reused`，也不会重复入库；没发出去的由 `flush()` 按创建顺序补发 |
| `consumer.py` | 领取 → 向服务端登记 pending → 回取邮件并写副本与 sha256（之后重试复用副本）→ BOSS 白名单 → 取下载链接并立即下载（过期重取一次）→ 按（mail_message_id, 附件 sha256）去重 → 关联（结论落库，重试沿用）→ PDF 文本 → `POST /resume-documents` → `PUT /mail-messages`（processed / needs_review / ignored）。mail 或存储出错 attempts +1、按 60 秒起翻倍退避，达到 3 次转 failed；**服务端暂时不可用不计失败**，只推迟。`requeue()` 做人工重试（failed → pending，再给 3 次） |
| `matching.py` | 关联规则：主题规则（可配置正则，命名分组 name / job）取姓名与岗位，账户别名表取账户；在 [收信 − 30 天, 收信] 内成功的 request_resume 里，账户 + 岗位 + 姓名一致且只落在一个流程上才 `method=resume_request`（带 command_id，取最近一次）；同名多流程、岗位不符、找不到、主题取不到、账户冲突一律 `method=none` 并给出候选流程 |
| `pdf_text.py` | pypdf 提取文字层；平均每页非空白字符 < 20 判 `suspected_scanned`，不 OCR；损坏、加密、不是 PDF 返回 `failed` 不抛异常。doc/docx 不解析（parse 为 null，服务端记 pending） |
| `retention.py` | 我方副本保留期清理（默认 30 天，可传 policy 回调）：删原始邮件副本、附件副本、解析文本，保留任务与附件元数据（sha256、doc_id、状态），写 `purge_log`，再 PUT 一次 mail_message（`copy_purged_at`、`raw_storage_uri=null`）。pending 不清理。**不调用 mail 的任何接口** |
| `verify.py` | 核对：8 个检查项各一次 + `overdue_resume_requests` + `purged_copies`，用 `validate_mail_verification` 自检后 `POST /mail-verifications`。先做 key 自检，失败则 `outcome=failed`。下面单列 |
| `mail_api.py` | `MailApi` Protocol + `HttpMailApi`：解信封 `{code,message,data}`，错误映射 401/403 → `MailAuthError`、404 → `MailNotFound`、409/423 → `AttachmentNotReady`、408/429/5xx/网络 → `MailUnavailable`；下载预签名链接**不带** API key，403/400/410 → `DownloadLinkExpired`。`list_messages`（G0）遇 404/405 → `UpstreamListingUnavailable`。另有 `DeliveryLedger` Protocol（投递台账，admin 接口，可选） |
| `server_api.py` | `ServerApi` Protocol + `HttpServerApi`（serviceToken，自动翻页） |
| `storage.py` | `BlobStorage` Protocol + `LocalDirStorage`（`file://` URI，临时文件 + 原子改名，拒绝越界 key 与外部 URI），以后可换对象存储 |
| `service.py` | `MailIngest` 装配：`startup_check()`、`webhook_router()`、`run_cycle()`、`verify()`、`requeue()`、`run_forever()` |
| `testing.py` | 测试替身（M 可复用）：`FakeMailService`（integration API + 预签名下载，按 openapi 的故障注入）、`FakeMonitorServer`（契约形状的服务端）、合成 PDF（有文字层 / 扫描版） |

### 核对检查项的实现

| code | 实现 | 现在能否执行 |
| --- | --- | --- |
| pending_backlog | 本地 pending 且登记超过 30 分钟 | 能 |
| copy_missing | 未清理的邮件副本或附件副本不存在 | 能 |
| hash_mismatch | 副本存在但 sha256 不一致 | 能 |
| document_without_copy | 已写成 resume_document 的附件副本不存在（未清理），refs 为 doc_id | 能 |
| needs_review_mismatch | 本地 needs_review 与 `GET /mail-messages?status=needs_review` 的对称差；服务端已人工关联为 processed 的同步到本地，不算不一致 | 能（依赖 server 实现该接口） |
| failed_mismatch | 本地 failed 与服务端 failed 队列的对称差 | 能（同上） |
| webhook_delivery_failed | `DeliveryLedger` 读 mail 投递台账里 failed / dead 的 mail.ready；`auto_replay_dead_deliveries=true` 时按窗口重放 | **count=null**：台账是 admin 接口（`platform.mail.mailbox.provision`），integration key 读不到。注入 ledger 后启用 |
| upstream_missing | `list_messages(since=30 天前)` 与本地任务比对 | **count=null**，原因"mail 尚无 integration 列出邮件接口（任务 G0）"。G0 合入后自动启用（接口返回 200 即用） |

## 验收对照

| 场景 | 测试 |
| --- | --- |
| 签名错误 | `test_signature.py::test_bad_headers_rejected`、`test_wrong_secret_rejected`；`test_webhook.py::test_wrong_signature_is_401_and_not_recorded` |
| 时间戳过期 | `test_timestamp_outside_tolerance_rejected[±301]`、`test_expired_timestamp_is_401` |
| 必须用原始字节 | `test_reserialised_body_fails` |
| 重复投递 | `test_duplicate_delivery_is_idempotent`（同 id）、`test_redelivery_with_new_id_maps_to_same_task`（新 id 同邮件）、`test_replayed_webhook_after_processing_does_not_duplicate` |
| 只接 mail.ready | `test_other_events_are_acknowledged_and_ignored` |
| 附件未扫完（409/423） | `test_attachment_not_scanned_retries_then_succeeds[409/423]` |
| 下载链接过期 | `test_expired_download_link_is_refetched`、`test_link_expired_twice_counts_as_failure` |
| key 配错（自检失败） | `test_verify.py::test_wrong_key_fails_verification`、`test_self_check`；`test_wrong_api_key_counts_as_failure` |
| 非 BOSS 邮件 | `test_non_boss_sender_is_ignored_without_downloading`、`test_exact_address_allowlist`；白名单为空 → `test_empty_allowlist_goes_to_review_without_guessing` |
| 同名多候选人 | `test_same_name_multiple_candidates_needs_review`；账户别名消歧 `test_account_alias_disambiguates` |
| 两份附件 | `test_two_attachments_two_documents`；内容相同去重 `test_identical_attachments_deduplicated_by_sha256` |
| 扫描版 PDF | `test_scanned_pdf_is_flagged_not_ocred`、`test_pdf_scanned_flagged` |
| 失败 3 次 → failed | `test_three_failures_mark_failed`；人工重试 `test_failed_can_be_requeued_manually` |
| 崩溃重领不重复入库 | `test_crash_and_reclaim_does_not_duplicate[POST /resume-documents, PUT /mail-messages]`（服务端已处理、调用方在拿到响应前"崩溃"，租约过期后新进程重领）、`test_lost_lease_abandons_processing` |
| 歧义不硬匹配 | `test_no_unique_match_needs_review[*]`、`test_unparseable_subject_needs_review`、`test_request_after_mail_arrival_is_not_used` |
| 副本清理 | `test_retention.py` 6 个 |
| 核对全部检查项 | `test_verify.py` 14 个 |

## 装配说明（给协调者）

```python
from monitor_mail.config import MailSettings
from monitor_mail.server_api import HttpServerApi
from monitor_mail.service import MailIngest

settings = MailSettings.from_env()   # 见下方环境变量
ingest = MailIngest.from_settings(
    settings,
    db_path="/var/monitor/mail/mail.db",
    storage_root="/var/monitor/mail/blobs",
    server=HttpServerApi(base_url="https://<server>/api/v1", service_token=<serviceToken>),
    retention_days=lambda: <policy.mail_retention_days>,          # 默认 30
    resume_mail_timeout_days=lambda: <policy.resume_mail_timeout_days>,  # 默认 3
    # ledger=<DeliveryLedger 实现>  # 有 mail 管理凭据时再接
)
ingest.startup_check()                       # key 配错在启动时就失败
app.include_router(ingest.webhook_router())  # POST /webhooks/mail，挂在根路径（不在 /api/v1 下）
threading.Thread(target=ingest.run_forever, args=(stop_event,), daemon=True).start()  # 每轮处理 + 每小时核对
```

- webhook 路由可以挂在 server 的 FastAPI 应用上，也可以单独起一个进程；它只写本地 SQLite，不依赖 server 在线。挂在同一应用时注意 webhook URL 必须在 mail 的 `MAIL_WEBHOOK_ALLOWED_HOSTS` 内。
- 只能有**一个**进程持有同一个 `mail.db`（SQLite）；多个消费者线程/进程共享同一个库是安全的（租约）。
- 环境变量：`MONITOR_MAIL_WEBHOOK_SECRET`、`MONITOR_MAIL_API_BASE_URL`（含网关前缀，如 `https://<gw>/api/mail`）、`MONITOR_MAIL_API_KEY`、`MONITOR_MAIL_MAILBOX`（默认 zhaopin@remotedesk.io）、`MONITOR_MAIL_MAILBOX_ALIASES`（逗号分隔，现应填 `bosszhipin@remotedesk.io`）、`MONITOR_MAIL_MAILBOX_ID`（可选）、`MONITOR_MAIL_BOSS_SENDERS`（逗号分隔，地址或 `@域名`；**N 实测前留空**）、`MONITOR_MAIL_ACCOUNT_ALIASES`（`别名=account_id`，逗号分隔）、`MONITOR_MAIL_SUBJECT_PATTERNS`（换行分隔的正则，需有 `name`、`job` 命名分组）。

## 部署时需要管理员在 mail 服务配置的项目

1. **公共邮箱**：zhaopin@remotedesk.io（kind=shared，别名 bosszhipin@remotedesk.io）——协调者告知已建好。记下它的 `mailbox_id` 填到 `MONITOR_MAIL_MAILBOX_ID`。
2. **留存**：zhaopin@ 的 `retention_days = 30`（mail 的 purge 任务统一清理；Monitor 不删 mail 里的信）。
3. **webhook 白名单**：把 Monitor 接收地址的主机名加入 `MAIL_WEBHOOK_ALLOWED_HOSTS`（留空表示一条都不推）。
4. **webhook 订阅**：`POST /v1/admin/mailboxes/{mailbox_id}/webhooks`，`url=https://<monitor 主机>/webhooks/mail`，`events=["mail.ready"]`（只订这一个），`include_spam=false`，`include_catch_all=false`，`max_attempts=9`（约 46 小时重试）。**返回的 secret 只出现一次**，直接放进部署的 `MONITOR_MAIL_WEBHOOK_SECRET`，不进仓库、不进聊天记录。
5. **integration API key**：`POST /v1/admin/mailboxes/{mailbox_id}/api-keys`，`scopes=["mail.read"]`（不要 mail.send），名字如 `monitor-zhaopin`。完整 key 只返回一次，放进 `MONITOR_MAIL_API_KEY`。
6. **网关地址**：告诉部署方 mail 的网关前缀（`/api/mail`）对 Monitor 主机可达，填 `MONITOR_MAIL_API_BASE_URL`。
7. **（可选）投递台账读权限**：要让核对项 `webhook_delivery_failed` 生效，需要一份能调 `GET /v1/admin/webhooks/{id}/deliveries` 与 `POST /v1/admin/webhooks/{id}/replay` 的管理凭据（`platform.mail.mailbox.provision`）。在此之前该项报 count=null。
8. **运维提醒**：订阅连续失败 20 次会被自动停用（`disabled_at` 有值），重新启用要人工操作；Monitor 停机超过约 46 小时期间的推送会落死，需要按窗口重放。

## 需要 server 实现的端点（server 尚未实现，G 的测试用契约形状的 fake）

| 端点 | G 怎么用 |
| --- | --- |
| `PUT /mail-messages/{mail_message_id}` | 登记 pending、终态、失败计数、清理结果。fake 实现了契约校验、路径与体一致、不可变字段 409 `mail_message_conflict`、迁移表外 409 `illegal_mail_transition`（带 `existing`）、首次 201 之后 200 |
| `GET /mail-messages?status=&mailbox=&received_after=` | 核对 needs_review / failed 队列 |
| `POST /resume-documents` | 原件，按（mail_message_id, sha256）去重，重复 200 + `duplicate=true`；需要先有 mail_message（否则 404） |
| `GET /resume-documents?case_id=` | 超时提醒判断流程是否已有简历 |
| `GET /commands?action=request_resume&status=succeeded&executed_after=&executed_before=&account_id=` | 关联与超时提醒。**注意**：`executed_after/before` 需按结果的 `executed_at` 过滤，且 `serviceToken` 要能调（F1 已实现该接口，需确认 serviceToken 认证已接上） |
| `POST /mail-verifications` | 核对结果，按 verification_id 幂等，不同内容 409 |

## 接口请求

1. **工作区成员**（协调者加）：根 `monitor/pyproject.toml` 的 members 加入 `"mail"`，同时把 `monitor/mail/pyproject.toml` 的 `monitor-contracts = { path = "../contracts", editable = true }` 改为 `{ workspace = true }`，再重新生成根 `uv.lock`。在此之前本包用路径依赖独立运行（成员目录的 uv.lock 已被 `monitor/.gitignore` 忽略，没有提交）。
2. **契约缺口：`mail_message_key` 不能区分"同状态同 attempts 的第二次写入"**（类别：契约缺口）。清理后要再 PUT 一次（`copy_purged_at`），这时 status 与 attempts 都没变，按 `mail_message_key(id, status, attempts)` 会和终态写入撞键，服务端回 422 `idempotency_key_reused`。目前的做法：清理更新用 `mail_message_key(id, f"{status}-purged", attempts)`（`retention.purge_key`）。建议 A 在契约里正式加一个变体（例如 `mail_message_key(id, status, attempts, revision="purged")`），并在 contracts.md 9.2 写明。
3. **策略读取**（类别：契约缺口）：`mail_retention_days` 与 `resume_mail_timeout_days` 在账户级 policy 里，但邮箱是公共的、跨账户的，而 api.md 没写 `serviceToken` 能否调 `GET /accounts/{id}/policy`。现在 G 接受回调（默认 30 / 3），由装配方决定取哪个账户的值。建议裁决：取所有账户中的最小值，或改成服务端配置项。
4. **G0**（需要用户同意跨仓修改）：`GET /v1/integration/messages?since=&cursor=&limit=`。G 已按 `{items:[{message_id|id, received_at,...}], next_cursor}`（包在信封里）实现，接口一上线 `upstream_missing` 即启用；若 G0 的最终形状不同，只需改 `HttpMailApi.list_messages`。

## 问询记录

无阻塞问询。协调者途中告知 zhaopin@ 有别名 bosszhipin@remotedesk.io：已做成配置列表 `mailbox_aliases`（`MONITOR_MAIL_MAILBOX_ALIASES`），自检时主地址落在 mailbox 或别名里都接受，没有写死任何地址；记录里的 `mailbox` 一律用主地址。

## 未覆盖项

- 没有连真实 mail 服务与真实 server 跑（按规则不访问真实邮箱）。fake 的形状取自 remotedesk-resend 源码（`IntegrationMessageDetailOut`、`AttachmentOut`、`DownloadOut`、`KeyScopeOut`、`payload_for`、`sign_outbound`），但没有与其 TestClient 做联测。
- BOSS 邮件的真实格式未知（待 N 实测）：发件人、主题与正文里有哪些字段、附件格式。默认主题规则只是占位（`候选人A 的简历（后端工程师）`、`【岗位】姓名 | …`），白名单默认为空（全部进 needs_review）。实测后只改配置。
- `DeliveryLedger` 只有 Protocol 与 fake，没有 HTTP 实现（admin 认证方式未定）。
- 多进程共享同一个 SQLite 文件的并发领取只在单进程多线程下测过。

## 已知限制

- **我方"原始邮件副本"是 integration 详情 JSON 的规范化字节**，不是 .eml：integration API 不提供原始 .eml 下载。`mail_message.sha256` 是这份副本的哈希；mail 自己的 `raw_sha256`（.eml 的哈希）保存在副本里，可用于存证对照。副本在第一次回取后冻结，重试不重取（详情里有已读、标签等会变的字段）。
- 白名单为空时（N 实测前的默认）所有邮件都进 needs_review，但仍会下载附件、写 resume_document（`link.method=none`，并把唯一命中的流程作为候选），方便人工关联；不会 ignored。
- 被 mail 判为 blocked / unscannable 的附件下载永远 409，3 次后转 failed（按"失败并告警"处理，不单独分类）。
- `is_auto_reply` 不用于过滤：BOSS 的系统邮件很可能带 `Auto-Submitted`，用它过滤会误伤。
- 关联窗口固定 30 天（`request_window_days`），岗位名按 NFC + 空白归一后精确比较；BOSS 邮件里的岗位写法若与指令里的不同（例如带城市），会进 needs_review，需要实测后调整规则。
- 人工在控制台把 failed 改回 pending 时，G 不会自动得知；核对的 `failed_mismatch` 会报出来，用 `MailIngest.requeue()` 处理。

## 对后续任务的接入说明

- **F2/F3（server）**：按上表实现端点。`mail_message.received_at` 取推送体的 `occurred_at`（登记时就要写，且写入后不可变）。注意 mail 的 `occurred_at` 是**投递记录的创建时间**（扫描完成后），比邮件真正的收信时间晚几分钟；邮件详情里的 `received_at` 只用于关联时间窗，不回写 mail_message（否则真 server 会回 409 `mail_message_conflict`，fake 已按此模拟并有测试锁定）。若希望 `received_at` 是真正的收信时间，需要契约允许回取后修正一次（契约缺口，暂不提）。
- **I1/I2（控制台）**：needs_review 的 `error` 是机器可读原因：`sender_unverified`、`ambiguous_cases`、`job_mismatch`、`no_resume_request`、`hints_missing`、`account_ambiguous`、`no_resume_attachment`；ignored 为 `non_boss_sender`；pending / failed 为 `<错误码>: <说明>`。
- **R（品牌化）**：原件的 `attachment.storage_uri` 与解析文本 `text_storage_uri` 都在我方存储，保留期到了会被删除（resume_document 上的 URI 随之失效）。
- **M（集成）**：`monitor_mail.testing` 的 `FakeMailService.webhook()` 能生成真实签名的推送，`FakeMonitorServer` 可替换为真 server 的 TestClient transport。
