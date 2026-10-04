# 交接：BOSS 招聘 Agent 的服务端并入 recruiting

日期：2026-10-05。交出方：2ndscreen 仓库 `monitor-v1` 分支中的 `monitor/server`、`monitor/mail`、`monitor/contracts`。接收方：`amplifistudio/remotedesk-recruiting` 的 backend。本文给执行合并的主线程使用，自成一体；其他交接文档是它的附件。

## 〇、决定与边界（用户 2026-10-04 / 05）

1. 招聘业务以 ATS（recruiting）为准；两边冲突时以 recruiting 的设计、契约为准。
2. **服务端全部进 recruiting，客户端单独建仓库**（`amplifistudio/remotedesk-boss-agent`，另行处理）。客户端是装在招聘运营 Mac 上的 BOSS 执行器（Python，经 2ndscreen CLI 在私有虚拟屏上操作 BOSS 客户端）。
3. 时间路线 A：客户端先跑起来，所以**执行器对接层要先上线**；recruiting 的 P1 原本不做执行器，需要 recruiting 接受"执行器对接层提前作为独立模块上线"。
4. 邮件收简历（BOSS 把简历自动发到 `zhaopin@remotedesk.io`）是服务器端定时任务，归 recruiting。
5. 设备、登录、执行记录管理页放在 recruiting 门户，客户端只保留本机状态窗口。
6. 品牌化简历、人工换微信流程、BOSS 站内搜索的业务含义由 recruiting 定义。

## 一、源材料位置

本机路径（另一个主线程可直接读；如需远程访问，由用户决定是否推送 `monitor-v1` 分支）：

```
/Users/kevinshi/orca/workspaces/2ndscreen/ss-runtime-integration   （分支 monitor-v1）
├── monitor/server/        FastAPI + SQLite 服务端，app/ 约 8200 行，tests/ 309 个测试
├── monitor/mail/          邮件接入（webhook + 任务表 + 核对），约 3100 行，132 个测试
├── monitor/contracts/     客户端与服务端协议：JSON Schema、pydantic 模型、状态机、openapi.yaml（版本 0.3.3）
├── monitor/integration/   跨客户端与服务端的端到端与混沌测试（37 个场景）
└── docs/monitor/
    ├── monitor-spec.md                方案（§一·五 与 ATS 的分工、§六 契约、§七 执行管线、§八 数据流）
    ├── contracts.md、api.md           契约与 HTTP 接口说明
    ├── capabilities.md                BOSS 客户端真机能力（只读部分）
    ├── ats-contract-change-request.md 给 recruiting 的契约变更请求 CR-1～CR-8（本文的前置）
    ├── handover-mail-ingestion.md     邮件接入交接（本文第五节的细节）
    ├── handover-device-console.md     门户管理页需求（本文第六节的细节）
    ├── runbook.md                     运维手册
    └── agent-reports/                 各任务交付报告（F1–F5、G、M 等最相关）
```

运行全部测试：`cd monitor && uv sync && uv run pytest contracts client server mail integration`（当前 1774 passed + 1 xfailed）。

## 二、服务端现状：四块代码与去向

| 块 | 模块（`monitor/server/app/`） | 作用 | 去向 |
| --- | --- | --- | --- |
| ① 执行器对接 | `devices.py`、`commands.py`、`events.py`、`login_relay.py`、`search.py` | 设备注册与令牌、心跳（带暂停、取消、账户绑定）、指令队列（长轮询领取、租约、ack、结果幂等）、观察事件、登录二维码接力与人工输入代填、搜索任务与快照 | **先上线**：recruiting 新模块 `modules/executors`（名称由 recruiting 定），对应 CR-1～CR-4 |
| ② 招聘流程（已冻结） | `cases.py`、`orchestrator.py`、`policy.py`、`manual.py`、`overview.py` | 新投递 → 问候 → 求简历的自动编排、策略（工作时段、上限）、人工处理、总览计数 | **不照搬**：按 recruiting 的 `application` + `application_event` 重新落地；本代码作参考实现（尤其是事务与崩溃恢复） |
| ③ 简历与邮件 | `mail_endpoints.py`、`resume_documents.py` + `monitor/mail/` | 邮件状态与核对、简历入库去重与关联 | 并入 recruiting 的简历入库（`imports` / `attachments` / `ai` resume_parse），邮件接入作为定时任务 |
| ④ 基础设施 | `db.py`、`main.py`、`serve.py`、`notify.py` | 存储与迁移、装配与鉴权、幂等、通知 | 丢弃，改用 recruiting `core/`（db、envelope、errors、auth、audit、scheduler、observability）与 `modules/notify` |

## 三、执行器对接层（块 ①）的迁移要求

### 3.1 数据模型（recruiting 表前缀 `recruiting_`，Alembic 迁移）

| 表 | 来源 | 说明 |
| --- | --- | --- |
| `recruiting_executor` | `devices` | 绑定 `channel_account_id`（已有 `recruiting_channel_account`）；mode(local/remote)、status、last_heartbeat_at、monitor_version、contracts_version、key_hash、revoked_at、paused、pause_reason |
| `recruiting_executor_enrollment` | `device_enrollments` | 一次性注册码（哈希存储、24 小时有效、带 mode） |
| `recruiting_channel_task` | `commands` | 设计已有字段 + `application_id?`、`depends_on?`、`not_before`、`expires_at`、`execution_mode(execute/verify_only)`、`lease_until`、`acked_at`、`result(JSON)`、`idempotency_key`；状态见 3.3 |
| `recruiting_executor_event` | `events` | 按 `event_id` 唯一 |
| `recruiting_login_qr` / `..._view` / `recruiting_input_request` | `login_relay` | 二维码内容只存到过期；查看记录；人工输入请求（有效期 10 分钟） |
| `recruiting_search_run` | `search_runs` | 搜索参数与快照（卡片字段、masked_name、prop_card_texts、coverage） |
| 幂等记录 | `idempotency` | 若 recruiting 已有幂等机制就复用；没有则按 api.md 第一节实现（principal + 方法 + 路径 + 键，保存 24 小时，同键不同体 422） |

### 3.2 接口（`/internal/executors*`，每个执行器一把 key）

按 Monitor 的 `monitor/contracts/openapi.yaml` 与 `docs/monitor/api.md` 第三节实现，路径改为 recruiting 风格：注册（注册码换 key）、心跳（回执含 paused、policy_version、cancellations、account_binding）、领取（长轮询 ≤30 秒、原子、按依赖/有效期/not_before/暂停/账户确认过滤）、ack、result（重复相同结果 200+duplicate，不同结果 409 并附首次结果）、事件批量上报（逐条 accepted/duplicate/rejected）、登录二维码上传与撤下。门户侧（userauth）：生成注册码、设备列表与详情、暂停/恢复/吊销、确认账户绑定、读二维码（410 过期，记录查看者，no-store）、提交人工输入、执行记录查询、取消、重新检查（生成 verify_only）、人工确认已发送、提交搜索。

**鉴权差异**：recruiting 现有 `core/auth.py` 是单一共享的 `apiKey` 头；执行器需要**每台一把、只存哈希、可吊销**的 key（设计 §7.2 已写"每个执行器单独发 key"），需要新增一种依赖。所有写接口带 `Idempotency-Key`。返回体改用 recruiting 的 `{code, message, data}` 信封；**客户端随之适配**（客户端仓库任务，见第八节）。

### 3.3 必须保留的行为（客户端安全依赖它们）

1. 同一任务只会被一台执行器领取；ack 后不再交给别人；租约过期未 ack 回到待领取。
2. 结果幂等：同一任务只接受一个最终结果。
3. `unknown` 是终态，**不自动重试**，只允许"重新检查（verify_only）/ 人工确认已发送 / 停止"——这是"绝不重复对外发送"的底线。
4. 创建任务与更新业务状态（application / 流程）**在同一数据库事务**里完成（Monitor 在 F2b 修过这个缺陷：两步之间崩溃会重复发送；见 `agent-reports/F2.md` 的 F2b 节与 `tests/test_atomicity.py`）。
5. 依赖未成功（含 unknown）、已过期、`not_before` 未到（工作时段外顺延）、执行器暂停、账户未确认时都不下发。
6. 心跳回执里如实给出账户绑定（契约 0.3.3 `account_binding`）；客户端以此为准写本机绑定（缺陷 M-1 的教训：没有这一项，真实部署永远不领取任务）。
7. 搜索算对外动作：受工作时段约束（时段外 409）、计入每日上限。
8. 每日上限服务端只能比客户端硬上限更严（客户端硬上限：每种对外动作每日 40 次；最小间隔问候、求简历 45 秒，换微信 60 秒，搜索 30 秒）。

### 3.4 测试迁移

`monitor/server/tests/` 中 `test_devices.py`、`test_commands.py`、`test_events.py`、`test_login_relay.py`、`test_search.py`、`test_atomicity.py`、`test_openapi_consistency.py` 的用例意图逐条迁移（改用 recruiting 的测试夹具与 SQLite/MySQL 双跑）；`monitor/integration/` 中跨两端的端到端与混沌场景（重复送达、执行中被杀、服务端重启、租约过期、取消、过期、离线 24 小时）在 recruiting 侧以契约测试 + 模拟执行器重建，断言对外动作次数与预期完全一致。

## 四、招聘流程（块 ②）在 recruiting 的落地

Monitor 的 `recruitment_cases` 不迁表，映射到 recruiting：

| Monitor | recruiting | 说明 |
| --- | --- | --- |
| case（账户 + 候选人 + 岗位） | `application`（`requisition_id`, `candidate_id`） | 需 CR-5：允许无手机号/邮箱的 BOSS 候选人入库（以 `channel_account_id + external_profile_id` 或账户+岗位+姓名+会话线索作临时身份），简历到达后按 c1:147 规则合并 |
| 新投递 / 已问候 / 已求简历 | `sourced` → `contacted` 段内的 `application_event` | 自动流程只到"简历请求已发送"；问候或求简历结果 unknown/failed/expired 转人工、不重发 |
| 收到简历 | 简历入库 + `application_event` | 先换微信后收到简历时阶段不回退 |
| 换微信（只换微信，仅人工，除关闭外各阶段可发起，工作时段外顺延） | `channel_task(kind=request_wechat)` + `application_event` | 自动流程不得生成；联系方式不进群（recruiting 规则） |
| 同岗位同名会话（歧义） | 转人工队列，不建新投递 | |
| 策略：岗位范围、问候开关与模板、自动求简历、工作时段、每日上限 | recruiting 的配置（clientconfig 或渠道账号配置） | 上限不得高于客户端硬上限 |
| 总览计数 | recruiting 报表 | 新投递、已求简历、收到简历、待人工分别计数 |

参考代码：`cases.py`（状态机与迁移表 `monitor_contracts.states`）、`orchestrator.py`（编排、挂起补发、崩溃恢复 `recover()`）、`manual.py`、`policy.py`。

## 五、简历与邮件（块 ③）

细节见 `handover-mail-ingestion.md`。要点：

1. 订阅公司邮件服务 mail（`amplifistudio/remotedesk-resend`）的 `mail.ready` webhook，公共邮箱 CV：`zhaopin@remotedesk.io`（别名 `bosszhipin@remotedesk.io`，已建好）；用 integration API key（`mail.read`）回取邮件与附件。
2. webhook 只做验签（HMAC-SHA256，覆盖 `{id}.{timestamp}.{原始字节}`，头 `X-RemoteDesk-Webhook-*`）、落 pending、快速 2xx；消费用 recruiting 的 scheduler 作业或任务表（无 MQ）。
3. 简历进入 recruiting 现有入库链路（`imports` → candidate 合并 → `ai_job(resume_parse)` → nebula），不再写 Monitor 的 `resume_documents` 表。
4. 关联到 application：账户 + 岗位 + 候选人姓名 + `request_resume` 任务的执行时间窗，唯一命中才自动关联，否则人工。BOSS 发件人白名单默认空（全部人工），第一封真实邮件到达后配置。
5. 不删除 mail 里的邮件（mail 只由留存任务销毁，受 legal hold 约束）；CV 邮箱 `retention_days` 由管理员设为 30；recruiting 侧副本按 30 天清理。上游完整性由邮件服务侧监控负责，不做"列出邮件"对账（原 G0 取消）。
6. 部署配置（不进仓库）：CV 的 `mailbox_id`、webhook secret、integration key、把 recruiting 主机加入 mail 的 `MAIL_WEBHOOK_ALLOWED_HOSTS`、建 `mail.ready` 订阅（`include_spam=false`、`include_catch_all=false`、`max_attempts=9`）。

可复用代码：`monitor/mail/monitor_mail/{signature,webhook,consumer,matching,pdf_text,retention,verify}.py` 与其 132 个测试。

## 六、门户管理页

细节见 `handover-device-console.md`：设备列表、新增设备（注册码与安装命令）、设备详情（暂停/恢复/吊销/确认绑定）、登录二维码卡片与人工输入、执行记录（"结果待确认"只给重新检查 / 人工确认 / 停止，**无重试**）、可选搜索页（三种结局分开展示，不能从结果发起问候）。不放候选人业务（候选人与流程用 recruiting 已有页面）。

## 七、契约归属

1. 客户端与服务端之间的执行器协议改由 recruiting 契约包管理：按 `ats-contract-change-request.md` 的 CR-1～CR-4 写进 c1（表）、c2（channel_task 状态与 kind）、c3（`/internal/executors*` 接口）、c5（执行器事件）。
2. 可直接借用的形状：`monitor/contracts/schemas/{command,command_result,event,heartbeat_ack,device_registration,device_heartbeat,search_snapshot,login_qr}.json` 与 `monitor/contracts/openapi.yaml`（0.3.3）。其中 `command_result` 的三个写操作标志（`navigation_performed`、`outbound_action_performed`、`externally_visible_side_effect`）必须保留：服务端据此判断"取消前是否已对候选人可见"。
3. recruiting 发布执行器契约后，客户端仓库引用其固定版本；Monitor 契约包中仅为服务端业务服务的定义（cases、policy、overview、resume_document、mail_*）不再维护。

## 八、建议的执行顺序与验收

| 步骤 | 内容 | 验收 |
| --- | --- | --- |
| S0 | recruiting 协调者审议 `ats-contract-change-request.md`，定执行器契约（CR-1～CR-4、CR-5） | 契约包更新、版本号 +1 |
| S1 | 执行器对接层：表、`/internal/executors*`、门户侧设备与任务接口、每执行器 key 鉴权、幂等 | 第三节 3.3 八条行为各有测试；从 `monitor/server/tests` 迁来的用例意图全部覆盖 |
| S2 | 门户管理页（第六节） | 能完成：新增设备 → 安装 → 在线 → 确认绑定 → 看到执行记录 |
| S3 | 流程映射（第四节）：新投递建 application、自动问候与求简历、人工换微信、歧义转人工 | 端到端：模拟执行器上报新投递 → 生成任务 → 回报结果 → application_event 正确；崩溃两步之间不重复 |
| S4 | 邮件接入（第五节） | 模拟 mail 服务：重复投递、签名错误、附件未扫完、歧义关联；真实邮件到达后配置发件人白名单 |
| S5 | 客户端切换：客户端仓库把服务端地址与协议切到 recruiting（信封、路径、鉴权头） | 客户端集成测试对 recruiting 跑通；对外动作次数断言不变 |
| S6 | 2ndscreen 侧清理：`monitor-v1` 分支归档，不合入 2ndscreen 主线 | — |

上线前置：部署 recruiting 时把 mail webhook 与 key 配好；BOSS 后台收简历邮箱已改为 `zhaopin@remotedesk.io`（用户已设置）。

## 九、已知遗留与风险

- **真机未验证**：所有动作只在脱敏夹具与集成测试中验证；求简历确认流程、各提示文案、"已交换"界面、搜索输入后的结果、BOSS 简历邮件格式都待真机验证（客户端仓库的 N 阶段）。服务端关联规则需在拿到第一封真实邮件后校准。
- **时间冲突**：recruiting P1 不含执行器、P3 才做自动问候（CR-8）；按路线 A 需要提前 S1–S3。
- **鉴权**：每执行器 key 是 recruiting 的新能力。
- **身份合并**（CR-5）：BOSS 候选人先无联系方式、后有，合并规则需 recruiting 定义。
- **品牌化简历**（CR-7）：用户要求，recruiting 文档中尚无。
- 契约与实现里的少量待办：`ManualCommandCreated.scheduled_for` 已在 0.3.2 定义；人工输入过期返回 409（未来可改 410）；搜索最小间隔按 search_runs 计算，被取消的搜索也占间隔（F4 报告）。
