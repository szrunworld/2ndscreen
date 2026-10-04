# 招聘 Monitor 端到端执行计划

本计划执行 [Monitor 第一版方案](monitor-spec.md) 与线框图。监督者（Claude，本会话）负责派发、答疑、审查、合并、真机验证和向用户升级决策；实现、单元测试、修复和提交由 Claude Code 的 claude-opus-5-5 worker 执行。本文件取代此前的任务表；方案说明不变。

代码根目录：仓库内新建 `monitor/`，与 `packages/task-runtime`、`agents/boss` 并列，互不引用对方源码。技术栈：Monitor 客户端 Python 3.12（sqlite3、httpx、pydantic）；服务端 Python FastAPI + SQLite（接口预留 PostgreSQL）；控制台 React + Vite；邮件接入 Python。包管理统一 uv，前端 pnpm。

## 一、监督者工作方式

### 1.1 角色

- 用户：决定产品取舍、提供测试账号、逐项授权对外动作、决定分支与上线。
- 监督者：维护本计划与接口冻结清单；派发任务；接收 worker 问询并在 30 分钟内回答或升级；逐项审查交付；按依赖顺序合并；占用真实 BOSS 做 B 阶段屏幕供给与 N 阶段真机验收；记录状态表。
- Worker（Opus 5.5）：在独立子工作区和分支内只修改自己拥有的路径；按验收标准交付；报告而不是猜测。

### 1.2 派发包

每个任务派发时 worker 收到：本文件对应小节、`monitor-spec.md`、`docs/monitor/contracts.md` 与 `api.md`（A 交付后）、所需夹具路径、分支名、下面的固定规则。不需要阅读 `packages/task-runtime` 或 `agents/boss` 的实现；需要参考时由监督者摘录。

### 1.3 固定规则（写进每个派发包）

1. 只修改所有权表中属于本任务的路径。需要别人改接口时在报告里写"接口请求"，不自行改，不复制一份同名类型。
2. 通过依赖注入接收其他模块，测试里只用符合契约的 fake 与 `monitor/fixtures/**` 的脱敏夹具。
3. 不启动 BOSS、不操作真实账号、不发送任何对外消息、不访问真实邮箱。对外动作代码默认白名单关闭。
4. 新增公开函数必须有测试：至少一个正常路径、一个边界或失败路径。
5. 中文注释与文档，英文标识符。不写"已验证"除非附证据；夹具通过不等于真机通过。
6. 提问走报告中的"问询"段，分三类标注：契约缺口 / 产品取舍 / 环境阻塞。契约缺口由监督者裁决并改 A 的产物（版本号 +1，通知受影响任务）；产品取舍升级用户；环境阻塞由监督者处理。等待期间继续做不受影响的部分。
7. 交付报告格式：commit 列表；运行过的测试命令与结果（含失败）；未覆盖项；接口请求；已知限制；对后续任务的接入说明。

### 1.4 审查清单（监督者对每次交付）

- 文件只落在所有权范围内；没有改契约、依赖清单或他人文件。
- 本地重跑测试命令，结果与报告一致。
- grep 禁止项：真实姓名/手机号、`screenshot` 用于非登录二维码场景、对外动作绕过白名单、固定 sleep 代替状态等待（允许的例外要有注释）。
- 失败路径有测试；错误分类符合契约。
- 报告中的接口请求已登记并分派。
- 合并后跑受影响任务的回归；派回修复时写明具体失败项，不重述需求。

### 1.5 并发与升级

- 默认同时最多 3 个 worker（用户可提高到 4）。优先保证关键路径（A → D1/D2 → H1 → M）。
- 以下决策只能由用户做：测试账号与候选人；每一次真机对外动作的授权；文档与代码落在哪个分支；独立设备是否接受"自动登录 + 不启用 FileVault"；简历与联系方式的保留期限；是否上线。
- 状态表（监督者维护在 `docs/monitor/status.md`）：任务、worker/工作区、分支、状态（未派/进行/待审/派回/已合）、最近 commit、未决问询。

## 二、接口冻结清单（A 交付后生效）

其他任务只依赖以下产物，不依赖彼此的实现：

| 产物 | 内容 | 所有者 |
| --- | --- | --- |
| `monitor/contracts/schemas/*.json` | command、command_result、event、search_snapshot、policy、device_registration、device_heartbeat、login_qr | A |
| `monitor_contracts` 包 | pydantic 模型；`validate_*`；三层状态机迁移表；`event_id` 计算；`Driver` Protocol 与 `Snapshot`/`Element` 模型；`ActionHandler`/`ActionResult`；`Observer` Protocol；`Ledger` Protocol | A |
| `monitor/fixtures/schema/ax-fixture.schema.json` | 脱敏元素树夹具的文件格式（场景名、步骤序列、每步元素列表、标注） | A |
| `docs/monitor/api.md` + `monitor/contracts/openapi.yaml` | 服务端 HTTP 接口：设备注册/心跳、指令领取/回报/确认、事件上报、简历文档写入、搜索任务、人工处理、登录接力、策略读写 | A |
| `monitor/fixtures/ax/**` | 真实客户端的脱敏元素树夹具与标注 | B |
| `docs/monitor/capabilities.md` | 能力矩阵：观察到 / 未观察到 / 不支持，附夹具引用 | B（只读部分）、N（写操作部分） |

契约变更流程：worker 提接口请求 → 监督者裁决 → 由 A 的 worker（或监督者直接）修改并把 `monitor_contracts.__version__` +1 → 通知受影响任务 rebase。

## 三、任务总表

| 代号 | 任务 | 唯一负责路径 | 依赖 | 估算 |
| --- | --- | --- | --- | --- |
| A | 契约、协议与 API 规范 | `monitor/contracts/**`、`monitor/pyproject.toml`（工作区根）、`monitor/fixtures/schema/**`、`docs/monitor/contracts.md`、`docs/monitor/api.md` | 无 | 3–4 人日 |
| B | 只读可行性验证与夹具 | `monitor/fixtures/ax/**`、`docs/monitor/capabilities.md` 只读部分 | 监督者提供 2ndscreen 屏幕与 BOSS 实例 | 2–3 人日 |
| C | Driver 适配器（CLI 与 Fake） | `monitor/client/monitor/driver/**`、`monitor/client/tests/test_driver*.py` | A | 3 人日 |
| D1 | 本地账本 | `monitor/client/monitor/ledger/**`、`monitor/client/tests/test_ledger*.py` | A | 2 人日 |
| D2 | 指令客户端与执行管线 | `monitor/client/monitor/core/**`、`monitor/client/monitor/__main__.py`、`monitor/client/tests/test_core*.py` | A | 3 人日 |
| E | 观察模块 | `monitor/client/monitor/observe/**`、`monitor/client/tests/test_observe*.py` | A、B | 4 人日 |
| F1 | 服务端基础：设备、指令队列、事件接收 | `monitor/server/app/{main,db,devices,commands,events}.py`、`monitor/server/tests/test_{devices,commands,events}.py`、`monitor/server/pyproject.toml` | A | 3 人日 |
| F2 | 服务端业务：流程状态机与策略引擎 | `monitor/server/app/{cases,policy,orchestrator,manual}.py`、对应测试 | A、F1 | 4 人日 |
| F3 | 服务端扩展：搜索、登录接力、通知 | `monitor/server/app/{search,login_relay,notify}.py`、对应测试 | A、F1 | 2 人日 |
| G0 | 邮件服务补 integration 列表接口 | 仓库 remotedesk-resend 内 | 用户同意跨仓修改 | 1 人日 |
| G | 邮件接入（mail 服务订阅方） | `monitor/mail/**` | A3、F1 | 4 人日 |
| H1 | 动作公共层 + 问候 + 求简历 | `monitor/client/monitor/actions/{common,greeting,request_resume}.py`、对应测试 | A、B | 3 人日 |
| H2 | 搜索动作 | `monitor/client/monitor/actions/search.py`、对应测试 | A、B | 2 人日 |
| H3 | 换微信（人工触发） | `monitor/client/monitor/actions/contact_exchange.py`、对应测试 | A、B、H1 合并、N 的写操作结论 | 1.5 人日 |
| I1 | 控制台骨架、mock、总览、连接与策略 | `monitor/console/**`（除 I2 页面目录） | A（openapi.yaml） | 3 人日 |
| I2 | 控制台候选人流程、执行记录、搜索页 | `monitor/console/src/pages/{cases,log,search}/**` | A、I1 合并 | 3 人日 |
| J | 安装、模式、launchd、bootstrap、状态窗口 | `monitor/client/monitor/{install,bootstrap,statusbar}/**`、`monitor/launchd/**`、对应测试 | A、C、D2 合并 | 3–4 人日 |
| K | 登录接力 | `monitor/client/monitor/login/**`、对应测试 | A、B、C、D2 合并 | 2–3 人日 |
| M | 集成、混沌测试、运维手册 | `monitor/integration/**`、`monitor/scripts/**`、`docs/monitor/runbook.md` | C、D1、D2、E、F1–F3、G、H1–H3、J、K | 4 人日 |
| A3 | 契约 0.3.0：邮箱路线与搜索收敛 | `monitor/contracts/**`、`monitor/fixtures/schema/**`、`docs/monitor/{contracts,api}.md` | A2 合并 | 1 人日 |
| R | 品牌化简历渲染 | `monitor/branding/**`（服务端工作区成员 monitor-branding） | A3、G；用户提供模板与 logo；N 实测邮件格式 | 3–4 人日 |
| N | 写操作验证与真机验收（监督者 + 用户授权） | `docs/monitor/capabilities.md` 写操作部分、`docs/monitor/acceptance.md` | B；用户授权 | 3–5 人日 |

合计约 52–58 人日。3 个 worker 并行、含审查与派回，日历时间约 5 周；4 个 worker 约 4 周。关键路径：A → D2 → H1 → M → N。

## 四、依赖图与波次

    波次 0   A 契约 ║ B 只读验证（监督者供屏）
                ↓ A 评审合并、B 夹具就位
    波次 1   C Driver ║ D1 账本 ║ D2 管线 ║ F1 服务端基础 ║ G 邮件
                ↓（最多 3–4 个并行，按关键路径排队）
    波次 2   E 观察 ║ H1 动作公共+问候+求简历 ║ H2 搜索 ║ F2 业务 ║ F3 扩展 ║ I1 控制台骨架
                ↓                                   N 写操作验证（用户授权后随时插入）
    波次 3   H3 换联系方式+转发 ║ I2 控制台页面 ║ J 安装与模式 ║ K 登录接力
                ↓
    波次 4   M 集成与混沌
                ↓
    波次 5   N 真机验收：单会话闭环 → 三项功能试运行 → 恢复与运维

调度原则：同一波内优先派关键路径任务；一个 worker 交付进入待审时立即派下一个可开工任务；评审派回优先于新派发。

## 五、各任务说明

每个任务按"目标 / 范围 / 不做 / 验收 / 测试命令"写。所有路径相对仓库根。

### A 契约、协议与 API 规范

目标：固定所有模块间的数据形状和 Python 协议，让其余任务只依赖本任务产物。

范围：

- JSON Schema（draft 2020-12）：`command`（含 `action` 枚举 send_greeting / request_resume / request_contact_exchange / search_candidates / forward_resume / provide_input，各自 target 与 payload 形状）、`command_result`（status 枚举 succeeded / failed / cancelled / expired / skipped_precondition / unknown，observed、evidence）、`event`（kind 枚举 application_observed / attachment_available / contact_exchange_updated / login_required / login_qr / login_ok / human_input_required / blocked_by_dialog / device_paused）、`search_snapshot`（coverage 枚举 partial / complete / unreadable / empty_confirmed；`unreadable` 时 items 必须为空且不得被当作空结果）、`policy`、`device_registration`（mode: local / remote）、`device_heartbeat`。
- `monitor_contracts` 包：上述 pydantic 模型；`validate_*`；状态机迁移表 `can_transition_case / can_transition_command / can_transition_delivery`；`compute_event_id(account_id, kind, conversation, bucket)`；`Driver` Protocol（`state`、`click`、`type_text`、`key`、`scroll`、`bind_window`、`screen_ok`、`screenshot_region` 仅供登录接力）与 `Snapshot`/`Element`（role、text、frame、index、enabled）；`ActionHandler` Protocol（`run(command, driver, ctx) -> ActionResult`、`verify_only(...)`）；`Observer` Protocol（`observe(driver, baseline) -> list[Event]`）；`Ledger` Protocol（指令与事件的读写、状态迁移、补传游标）。
- 夹具格式 `ax-fixture.schema.json`：`scene`、`steps[]`（每步 `label`、`elements[]`、`window`、`annotations`：如 `is_new_application`、`qr_region`）。
- `docs/monitor/api.md` 与 `monitor/contracts/openapi.yaml`：设备注册 `POST /devices`、心跳、`POST /devices/{id}/commands:claim`（长轮询）、`POST /commands/{id}/result`、`POST /commands/{id}/ack`、`POST /events`（批量，幂等）、`POST /resume-documents`、`POST /search-runs`、`GET /cases`…、人工处理、登录接力 `POST /login-qr`、策略读写。所有写接口带 `Idempotency-Key`。
- 测试向量：合法与非法样本各 ≥10，`monitor/contracts/tests/vectors/`。

不做：业务逻辑、网络、GUI、任何实现。

验收：全新目录 `cd monitor && uv sync && uv run pytest contracts` 通过；非法样本给出字段级错误；状态机表覆盖方案第六、七节全部状态；openapi.yaml 能被 `openapi-spec-validator` 校验；`contracts.md` 对每个 kind/action 有一段说明。

### B 只读可行性验证与夹具

目标：用真实客户端回答方案第十二节的只读部分，产出脱敏夹具。监督者在 2ndscreen 测试屏幕上提供 BOSS 实例与 CLI；worker 使用 2ndscreen skill 的只读命令和导航类点击。

范围：会话列表结构；新投递/新招呼的呈现（标记、分组、未读、单独页签）；候选人名与岗位的元素位置；附件简历入口；简历弹层旁"转发"的选项（只看不选）；搜索页结果是元素还是图片；联系方式交换按钮与状态文案；登录页与扫码页签、二维码区域的元素几何。每个场景录制为 `monitor/fixtures/ax/<scene>/fixture.json`，姓名替换为"候选人A/B"，手机号与微信号删除，附 `README.md`。

不做：任何白名单动作、发送、点"确认"；猜测未观察到的行为。

验收：`capabilities.md` 只读部分每行有"观察到 / 未观察到 / 不支持"结论与夹具引用；夹具通过 A 的 schema 校验；监督者抽查无真实个人信息。

### C Driver 适配器

目标：Monitor 唯一接触 GUI 的层，实现 A 的 `Driver` Protocol。

范围：`CliDriver`（子进程调用 2ndscreen CLI，解析 JSON，超时与错误分类：窗口丢失 / 屏幕丢失 / 超时 / 快照过期 / CLI 非零退出）；定位器（文本精确或包含、角色、几何区域、同行右侧；唯一命中或歧义错误）；`FakeDriver`（按夹具步骤回放，可脚本化"某动作后进入下一步"，记录所有写方法调用供断言）；录制模式（把 `state` 输出脱敏写成夹具）。监督者提供 CLI 输出样例到 `monitor/fixtures/cli-samples/`。

不做：业务语义；重试策略。

验收：对 CLI 样例解析正确；FakeDriver 能回放 B 的全部夹具；每类失败路径有测试；写方法在 FakeDriver 上可计数。

### D1 本地账本

目标：实现 A 的 `Ledger` Protocol，SQLite 三表。

范围：`command_ledger`、`event_outbox`、`monitor_state` 的建表与迁移（版本化）、WAL；指令按 `command_id` 幂等写入；状态迁移只允许契约表中的迁移；补传游标；`needs_baseline`、`paused`、`mode`、`account_binding` 的读写；崩溃一致性（事务）。

不做：网络、GUI、业务判断。

验收：迁移从空库与上一版本都能升级；非法迁移抛错并有测试；进程中断模拟（事务中途异常）后数据一致。

### D2 指令客户端与执行管线

目标：方案第七节的全部行为，使用注入的 `Ledger`、`Driver`、`ActionHandler`、`Observer`。

范围：`CommandClient`（长轮询领取、30 秒心跳、回报、确认、设备令牌、指数退避、离线检测）；`Pipeline`（领取 → 账本 → 去重 → 有效期/账户 → GUI 锁 → 动作处理器 → 持久化 → 回传 → delivered）；`GuiLock` 与观察调度器（动作优先，默认 45 秒周期，可配）；暂停；崩溃恢复（`running` 的指令转 `verify_only`，仍不明则 `unknown`，依赖它的后续指令不领取）；离线超过 24 小时置 `needs_baseline`；每日上限与最小间隔的本地强制（下限写死在代码）。`__main__.py` 只做装配与参数解析。

不做：具体动作与识别规则；服务端。

验收：方案第七节异常表每行一个测试（用 fake server 与 fake handler）；`kill -9` 模拟后同一 `command_id` 的 GUI 写操作只发生一次；回传 500 后补传成功；上限触发后动作返回 failed(reason=rate_limited) 且不调用 driver。

### E 观察模块

目标：从元素树得到业务事件，不猜。实现 A 的 `Observer` Protocol。

范围：页面分类（会话列表 / 会话详情 / 搜索页 / 登录页 / 验证码 / 未知弹窗 / 简历弹层）；首次基线与 `needs_baseline` 处理；新投递识别（规则来自 B 夹具标注）；附件可用、联系方式状态识别；`event_id` 幂等；同岗位同名会话标记歧义；不支持的呈现返回 `unsupported` 并只上报一次。

不做：执行任何动作；服务端去重。

验收：对 B 全部夹具识别结果与标注一致；"未读但非投递"不产生新投递事件；基线场景不产生事件；歧义场景产生歧义事件而非新投递。

### F1 服务端基础

目标：设备、指令队列、事件接收的 HTTP 实现，严格按 `openapi.yaml`。

范围：FastAPI 骨架、SQLite 模型与迁移（devices 含 mode、commands、events、manual_actions 表）；设备注册与令牌（哈希存储、吊销）、心跳；指令创建（depends_on、expires_at）、领取（按设备与账户、依赖满足、未过期、原子）、回报幂等、确认、取消；事件批量接收按 `event_id` 去重落库并发出内部信号供 F2 消费；`Idempotency-Key` 处理；从代码导出 openapi.json 并与 A 的 yaml 做一致性测试。

不做：业务状态机、策略、搜索、登录接力。

验收：TestClient 覆盖每个端点的成功与失败；重复回报返回首次结果；过期指令不被领取；openapi 一致性测试通过。

### F2 服务端业务

目标：recruitment_cases 状态机、策略引擎、指令生成、人工处理。

范围：事件 → case（账户 + 候选人 + 岗位）建立与去重；状态机按契约迁移表；策略（岗位范围、问候开关与模板、自动求简历、收到简历后的动作、工作时段、每日上限不低于客户端下限、暂停）；指令生成（问候成功才生成求简历；问候 unknown 不推进；收到并关联简历后按策略生成交换请求）；人工确认已发送、人工关联邮件、停止流程（记录 actor/at/note，不覆盖原始结果）；总览统计（分别计数）。

不做：HTTP 骨架改动（有需要提接口请求）；邮件解析。

验收：方案 8.1、8.2 后半、8.3 各一条端到端测试；重复事件不建重复 case；unknown 不推进；工作时段外不生成对外指令。

### F3 服务端扩展

目标：搜索任务、登录接力存储、通知。

范围：搜索任务创建（有效期默认 10 分钟）、快照存储与查询；`login_qr` 保存到 `expires_at`、过期后接口不返回内容、查看记录；`login_ok` 撤下；`human_input_required` 与 `provide_input` 指令的桥接；通知适配器接口（第一版实现：控制台待办 + Webhook，其他渠道留接口）。

验收：过期二维码接口返回 410；查看记录可查询；搜索快照 `unreadable` 与 `empty_confirmed` 分别可查。

### G0 邮件服务接口补充（已取消：用户 2026-10-04 决定不做，上游收信完整性由邮件服务侧的监控负责）

为 Monitor 的对账补一个 integration 接口：`GET /v1/integration/messages?since=&cursor=&limit=`（`mail.read`，只列 key 绑定的邮箱，返回 message_id、received_at、from、has_attachments、scan 状态、purged），按该仓既有的 ACL、审计、迁移与测试规范实现。可选：`POST /v1/integration/messages/{id}/archive`（新 scope `mail.organize`，只移动文件夹到 archive，便于人工在门户看出哪些已处理）。不提供删除接口：销毁只走留存任务。

### G 邮件接入（mail 服务订阅方：webhook + 任务表 + 核对）

目标：方案 8.2（mail 服务版）。范围：`POST /webhooks/mail`（HMAC 验签、原始字节、按投递 id 与 message_id 幂等写 pending、快速 2xx）；数据库任务表与消费者（租约领取、integration API 取信与附件、写副本与 sha256、BOSS 发件人白名单、去重、关联、写服务端、失败 3 次转 failed）；我方副本 30 天清理；核对任务（方案 8.2 第 6 条；G0 合入后启用"mail 有、我方没有"的对账，之前用投递台账兜底）。mail 访问封装成接口，测试用 fake mail（签名错误、重复投递、附件未扫完、链接过期、key 配错）。不做：OCR、MQ、删除 mail 里的邮件。依赖：A3、F1。需要的配置（不进仓库）：mail 的 API key 与 webhook 密钥。

### H1 动作公共层 + 问候 + 求简历

目标：动作执行的公共流程与前两个动作。

范围：`common.py`：定位会话（姓名 + 岗位 + 提示词全匹配；多命中 = 歧义不执行）、打开、读状态、等待可识别结果（上限 10 秒，按 B/N 标志）、白名单检查（`allowed_actions`，默认空）、结果与 evidence 组装、`verify_only`；`greeting.py`：输入模板、点发送、验证消息出现在聊天区；`request_resume.py`：检查"已请求"→ skipped_precondition；点求简历；只点 N 记录的那一个确认按钮；验证。

验收：每个动作对成功 / 已发生 / 歧义 / 未知弹窗 / 超时五种夹具场景有测试；白名单关闭时 FakeDriver 写方法调用计数为 0。

### H2 搜索动作

目标：`search_candidates`。

范围：进入搜索入口、输入关键词、等待可识别结果状态、读取当前页、生成 `search_snapshot`；界面显示无结果 → `empty_confirmed`；结果为图片或状态未知 → `unreadable`；不翻页。使用 `common.py` 中的等待与 evidence 工具（若 H1 未合并则先用本地副本并在合并时替换，由监督者协调）。

验收：三种 coverage 各有夹具测试；`unreadable` 时 items 为空且 status 不是 succeeded-with-empty。

### H3 换联系方式

目标：`request_contact_exchange(exchange_type=wechat)`，只由人工在控制台触发（用户 2026-10-04 决定，不换电话）。范围：读取当前交换状态并按方案 8.3 分支；点击『换微信』、验证『请求交换微信已发送』出现。转发简历不在 v1（用户 2026-10-04 决定简历由 BOSS 自动发到公司邮箱）。验收：三种初始状态各有测试。

### I1 控制台骨架、mock、总览、连接与策略

目标：React + Vite 工程、从 `openapi.yaml` 生成客户端、mock server、两页。

范围：路由与页面框架（顶栏、五页签）；mock server 覆盖所有状态；总览页（分别计数、需要处理、最近活动、暂停按钮语义提示）；连接与策略页（设备卡片按模式显示；远端设备"需要登录"卡片渲染二维码并倒计时；邮箱卡片；策略表单含问候开关、每日上限、不可关闭的异常暂停）。

验收：mock 下两页可用；phone 宽度不横向滚动（表格除外）；二维码卡片在过期后显示"等待刷新"而不是旧码。

### I2 控制台候选人流程、执行记录、搜索页

目标：其余三组页面。

范围：候选人流程列表与详情（时间线、简历文件、最近操作、人工处理记录）；执行记录列表与详情（已完成 / 未确认清单；"结果待确认"只给重新检查 / 人工确认 / 停止，无重试）；搜索页（三种结果状态分开展示；第一版没有"发起问候"按钮，只展示快照）。

验收：mock 下五个页面可用；用例断言"结果待确认"详情不存在"重试"文案。

### J 安装、模式、launchd、bootstrap、状态窗口

目标：方案第三节与 8.5 的非二维码部分。

范围：`monitor install` 交互选择 local / remote，前提检查（权限；remote 另查自动登录、FileVault、电源），不满足列出并退出非零；写 `mode`；注册设备带 mode；`monitor mode` 切换；launchd（remote 开机 LaunchAgent；local 可选随会话启动）与安装卸载脚本；bootstrap（remote：建屏、启动 BOSS、绑定、防休眠；local：策略时段内 takeOver 到专用屏幕，暂停时归还）；状态窗口（rumps 或 Tk：模式、账户、客户端状态、当前动作、待执行/待回传、最近异常、"暂停并归还窗口"/"暂停自动操作"按钮）。

验收：缺前提时准确列出缺项；mode 出现在本地与服务端；bootstrap 失败有上限重试并上报；监督者在测试机验证 launchd 重启拉起。

### K 登录接力

目标：方案 8.5 的二维码部分与人工输入代填。

范围：登录页与扫码页签识别（B 夹具）；二维码区域定位、`screenshot_region` 单次截图、Vision 条码解码（pyobjc 或等效本地库）；`login_qr` 事件（含 expires_at）、10 秒周期重读、变化重传、"已失效"刷新点击；登录完成识别 → `login_ok`；`human_input_required` → `provide_input` 代填（定位输入框、输入、提交）；滑块等只上报；local 模式下只做检测 + 暂停 + 通知，不上报二维码。

验收：对登录页夹具能定位并解码合成二维码图；变化在一个周期内重传；登录完成后 10 秒内 `login_ok`；local 模式夹具不触发 `login_qr`。

### M 集成、混沌测试、运维手册

目标：把 C、D、E、F、G、H、J、K 接起来并证明恢复行为。

范围：集成测试（FakeDriver 回放夹具 + 真实 F 服务进程 + G 对本地测试邮箱）覆盖 8.1–8.4 与 8.5 夹具版；混沌：回传 500、执行中 kill、重复送达、取消、过期、离线 24 小时、服务端重启；一键脚本；`runbook.md`（安装、选模式、绑定、暂停、恢复、吊销令牌、常见异常与处置）。

验收：集成与混沌一键通过；混沌场景下 FakeDriver 写操作计数与预期完全一致；手册按步骤能在干净账户完成绑定（监督者执行）。

### A3 契约 0.3.0：邮箱路线与搜索收敛

用户 2026-10-04 二次决定：简历走"求简历 → 候选人同意 → BOSS 自动发到公司邮箱"，Monitor 不转发；搜索页不能发起问候。变更：
1. `forward_resume` 从 v1 的 action 枚举中移除（及其 payload、output、硬上限、策略项），在 contracts.md 记为"v1 不支持，保留名字以后再用"。
2. policy 增加 `company_mailbox`（只读展示用，邮箱地址）与 `resume_mail_timeout_days`（默认 3，求简历成功后超过该天数未收到邮件进入提醒）。不加 resume_route。
3. case 状态机：`resume_requested → resume_linked`（邮件到达并唯一关联）为主路径；保留 `resume_received`（界面看到附件）为可选观察；`resume_requested → needs_human`（超时或关联歧义）。不加 resume_forwarded。
4. `resume_document` 增加 `variant: original | branded`、`derived_from`、`mail_message_id`；新增 `mail_messages` 的 API 形状（状态 pending / processed / needs_review / failed / ignored，供核对与控制台展示）与 `POST /mail-verifications`（核对结果）。
5. 确认 send_greeting 的目标只能是会话（v1 无搜索结果目标），在文档写明。
6. openapi 补 F1 报告列出的缺失 401/422。

### R 品牌化简历渲染（已移出：属于 ATS，用户 2026-10-04）

目标：把邮件里的原始简历转换成公司样式的 PDF。范围：输入原始文件（PDF 文字层或邮件正文 HTML，按 N 的实测）→ 结构化字段（基本信息、求职意向、工作经历、项目经历、教育经历、技能）→ 套用公司模板（HTML/CSS 模板 + logo，渲染为 PDF）→ 作为 `variant=branded` 写回 `resume_document`，`derived_from` 指向原件。字段取舍可配置（是否包含联系方式、是否剔除平台水印与"BOSS直聘"字样）。解析失败或字段缺失时不输出残缺版本，标记 `branding_failed` 并保留原件。不做：OCR（扫描版不处理）。验收：对 N 实测得到的脱敏邮件样本与合成样本，输出 PDF 字段完整、样式符合模板；原件不被修改。启动条件：用户提供模板与 logo，N 实测邮件格式。

### N 写操作验证与真机验收（监督者）

目标：回答方案第十二节的写操作部分，并对集成产物做真机验收。全部对外动作需用户逐项授权测试账号与目标候选人。

范围：各执行一次问候、求简历、换电话、转发到邮箱；记录前后元素树、弹窗、聊天区变化、邮件到达时间与内容格式、配额提示；扫码登录后的人工步骤；结论写入 `capabilities.md` 写操作部分并转成 H1/H3/K 的结果验证规则。随后按交付点验收：单会话闭环 → 三项功能试运行 → 恢复与运维，记录到 `acceptance.md`，不以夹具结果替代。

## 六、交付点

| 交付点 | 包含任务 | 能看到什么 |
| --- | --- | --- |
| 1 契约与可行性 | A、B | 契约包、API 规范、脱敏夹具、只读能力矩阵 |
| 2 客户端骨架与服务端基础 | C、D1、D2、F1、G | 指令可领取、执行（fake 动作）、回传、补传；邮件能入库 |
| 3 业务能力 | E、H1、H2、H3、F2、F3、I1、I2 | 夹具驱动的新投递 → 求简历链路；控制台全部页面（mock） |
| 4 安装与登录 | J、K | 两种模式安装；远端登录接力 |
| 5 集成与恢复 | M | 一键集成与混沌测试；运维手册 |
| 6 真机验收 | N | 单会话闭环、三项功能、恢复与运维的真实证据 |

## 七、启动前需要用户确认

1. 代码与文档落在哪个分支（建议新建 `monitor-v1` 自 `szrunworld/ss-runtime-integration`）。
2. 并发 worker 数（默认 3）。
3. B 阶段何时可以占用一台机器的 BOSS 实例与 2ndscreen 屏幕（监督者需要约 1 天）。
4. N 阶段的测试账号、可用于写操作验证的候选人，以及授权方式（逐项口头确认）。
5. 独立设备模式是否接受"自动登录 + 不启用 FileVault"。
