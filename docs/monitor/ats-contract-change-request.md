# 契约变更请求：BOSS 渠道执行器（2ndscreen Monitor）接入 ATS

- 提出方：2ndscreen 招聘 Monitor（BOSS 直聘执行器）
- 接收方：ATS 协调者（仓库 `amplifistudio/remotedesk-recruiting`）
- 日期：2026-10-04
- 性质：请求在 ATS 契约包中补齐执行器相关定义。本文不修改 ATS 仓库，由用户转交。

## 一、背景

ATS 设计已把"2ndscreen 的 BOSS 直聘助手"定为 BOSS 渠道执行器（`recruiting-module-design.md` §7.2）：recruiting 下发 `channel_task`，执行器拉取、执行、回传结果，每个执行器单独发 key。该执行器（下称 Monitor）已在 2ndscreen 仓库实现到可集成状态：本机端（观察新招呼、问候、求简历、换微信、当前页搜索、本地账本与 outbox、硬上限、登录接力、状态窗口）与一层薄桥接服务（设备注册与令牌、指令队列、事件接收）。

用户决定（2026-10-04）：

1. 招聘业务（候选人、流程、简历存储与解析、通知、流程页与总览、品牌化简历）以 ATS 为准；Monitor 只做执行器与桥接。
2. 时间路线 A：Monitor 先独立运行，ATS 到 P2 后把指令来源切换为 ATS 的 `channel_task`。
3. 设备、登录、执行记录管理页放在服务器端（建议 ATS 门户"渠道 / 执行器"）。
4. 邮件收简历（BOSS 自动发到 `zhaopin@remotedesk.io`）交给服务器端定时任务，Monitor 不负责。

目前 ATS 契约包里执行器相关内容只出现在设计文档，未进入 c1–c8，Monitor 无法按契约对接。以下是具体请求。

## 二、变更请求

### CR-1　c1 数据模型：补 `channel_task` 与执行器表

现状：`channel_task` 只在设计文档 §5 渠道部分出现（`id, channel_account_id, kind, payload, status, attempts, result, executor_id`）；c1 渠道部分只有 `channel_account`、`job_posting`。

请求：

- `channel_task`：在上述字段基础上增加 `application_id`（可空）、`depends_on`（可空，前置任务）、`not_before` / `expires_at`（工作时段与有效期）、`execution_mode`（`execute | verify_only`，后者用于"重新检查界面状态"，只读）、`lease_until`、`acked_at`、`result`（JSON，见 CR-3）、`idempotency_key`。
- `executor`（或 `channel_executor`）：`id, channel_account_id, mode(local | remote), status, last_heartbeat_at, monitor_version, contracts_version, key_hash, revoked_at`。
- `executor_enrollment`：一次性注册码（门户生成、`monitor install --enrollment-code` 使用）。
- `executor_event`：执行器上报的观察事件（见 CR-4），按 `event_id` 唯一。

参考形状：Monitor 契约 `monitor/contracts/schemas/{command,command_result,event,device_registration,device_heartbeat}.json`，可直接借用。

### CR-2　c2 状态机：`channel_task` 状态与任务类型

- 状态：`pending → claimed（租约中）→ acked（已写入执行器账本）→ succeeded | failed | cancelled | expired | skipped_precondition | unknown`；租约过期未 ack 回到 pending；`unknown` 为终态，**不自动重试**（防止重复对外发送），只允许"重新检查（verify_only）/ 人工确认已发送 / 停止"。
- `kind` 增补：现有 `publish / pull_resumes / greet / reply / request_resume` 之外，增加 `request_wechat`（只换微信、仅人工触发，不得由自动流程生成）、`search`（当前页搜索快照）、`provide_input`（登录时人工输入的代填）。
- 阶段映射建议（执行器结果 → `application_event`）：问候成功、求简历成功 → `contacted` 内的事件；`request_wechat` 成功 → 事件记录（不改变雇主可见阶段）。

### CR-3　c3 REST：执行器接口（`/internal` 层，executor key 鉴权）

请求定义以下接口（形状可直接参考 Monitor 的 `monitor/contracts/openapi.yaml` 与 `docs/monitor/api.md` 第三节，已有实现与测试）：

| 方法与路径 | 用途 |
| --- | --- |
| `POST /internal/executors`（注册码换 key） | 注册；key 只返回一次、服务端只存哈希 |
| `POST /internal/executors/{id}/heartbeat` | 心跳；响应带暂停状态、策略版本、待取消任务 |
| `POST /internal/executors/{id}/tasks:claim` | 长轮询领取（≤30 秒），原子、按依赖与时段过滤 |
| `POST /internal/tasks/{id}/ack` | 已写入执行器本地账本 |
| `POST /internal/tasks/{id}/result` | 回报最终结果；重复相同结果幂等，不同结果 409 并返回首次结果 |
| `POST /internal/executor-events` | 批量上报观察事件（按 `event_id` 幂等） |
| `POST /internal/login-qr` 及门户读取接口 | 独立设备登录二维码接力（过期 410、记录查看者、no-store） |

所有写接口带 `Idempotency-Key`。任务结果必须包含三个写操作标志：`navigation_performed`、`outbound_action_performed`、`externally_visible_side_effect`（打开会话会产生已读回执，属于可接受的副作用，但须如实记录）。

### CR-4　c5 事件：执行器观察事件

- 事件种类：`application_observed`（『新招呼』页签中的新会话 = 新投递）、`conversation_ambiguous`（同岗位同名，转人工，不建新投递）、`contact_exchange_updated`（只报状态，不带微信号/手机号原文）、`login_required`、`login_ok`、`human_input_required`、`blocked_by_dialog`、`device_paused`。
- 修正一处不一致：设计 §5 写 outbox 包含"渠道指令"，c5 的 outbox 消费者里没有；请明确渠道指令是否走 outbox，还是由执行器直接领取 `channel_task`（Monitor 按后者实现）。

### CR-5　c1 候选人：允许没有联系方式的 BOSS 候选人入库

现状：c1:147 去重键为 `(owner_client_id, phone_normalized)` 或 `(owner_client_id, email_normalized)`。BOSS 新投递在拿到简历前既没有手机号也没有邮箱，按现规则无法建 candidate，也就无法建 `application(sourced)` 来承接执行器结果。

请求：允许 `phone` 与 `email` 皆空的候选人，以 `(channel_account_id, external_profile_id)` 作为临时身份；BOSS 侧拿不到稳定 id 时，以（账号、岗位、候选人姓名、会话线索）作临时键，并在简历到达后按手机号/邮箱合并。合并规则需要定义（谁合并谁、事件如何迁移）。c1:137 的 `external_profile_id` 已可容纳 BOSS id。

### CR-6　简历邮件接入的归属

BOSS 在候选人同意后自动把附件简历发到 `zhaopin@remotedesk.io`（公司邮件服务 mail 的公共邮箱，别名 `bosszhipin@`）。用户决定由服务器端定时任务处理。现有实现（webhook 验签、任务表消费、去重、关联、30 天副本清理、核对，132 个测试）在 2ndscreen 仓库 `monitor/mail`，交接文档 `docs/monitor/handover-mail-ingestion.md`。

请求：在 ATS 中确定接收方与入库路径（`/admin/imports` 的机器调用版本，或内部服务调用），以及与执行器 `request_resume` 结果的关联规则（账号 + 岗位 + 姓名 + 求简历时间窗，唯一命中才关联，否则人工）。

### CR-7　品牌化简历

用户要求对外使用的简历套用公司模板与 logo（Monitor 方案已标"由 ATS 实现"），ATS 文档中尚无此项。请求补入（建议作为推荐时简历快照的一种派生版本，原件保留）。

### CR-8　阶段计划

ATS 执行计划把执行器放在 P2、自动打招呼/求简历放在 P3（`recruiting-p1-execution-plan.md` 第 17、263、271 行附近），设计 §7.2 又把 greet / request_resume 列在 P2，两处不一致。按用户的时间路线 A，Monitor 先独立运行；请 ATS 确认 CR-1～CR-4 计划在哪个阶段落地，以便 Monitor 安排切换。

## 三、Monitor 侧承诺

- 契约定稿后，Monitor 桥接层改为对接 ATS 的 `/internal` 接口；Monitor 服务端里的业务部分（`/cases`、`/overview`、`/accounts/{id}/policy`、`/resume-documents`、`/mail-*`）随之移除。
- 本机端行为规则不变：每种对外动作每日 ≤40 次、最小间隔 45 秒（换微信 60 秒、搜索 30 秒），策略只能更严；遇到登录失效、验证码、未知弹窗立即暂停；不读取附件 PDF 预览文字层；不读取在线简历正文（无 OCR）。

## 四、参考

- Monitor 方案：`docs/monitor/monitor-spec.md`（§一·五 与 ATS 的分工）
- Monitor 契约：`docs/monitor/contracts.md`、`docs/monitor/api.md`、`monitor/contracts/`（版本 0.3.1）
- 真机能力：`docs/monitor/capabilities.md`
- 交接：`docs/monitor/handover-mail-ingestion.md`、`docs/monitor/handover-device-console.md`

以上文件位于 2ndscreen 仓库 `monitor-v1` 分支。
