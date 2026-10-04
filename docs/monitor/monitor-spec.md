# 招聘 Monitor 第一版方案说明

状态：评审稿（2026-10-04）。本稿由用户的方案整理而成，补入评审意见和实现约定；四项产品假设（见第十二节）验证通过前，所有涉及 BOSS 客户端控件的描述都只是设计意图，不是已验证能力。

配套文档：

- [任务拆解](monitor-agent-tasks.md)：给 Opus 5.5 agent 的正交任务、文件归属、依赖和验收
- 线框图：claude.ai 画布「招聘 Monitor 线框图」（控制台 5 页 + 2 张详情页 + 本机状态窗口）
- 既有能力证据：[BOSS macOS 能力矩阵](../boss-macos-capabilities.md)、[协调者验收记录](../agent-reports/Coordinator-review.md)

## 一、产品边界

产品不是"自动操作所有招聘功能"，而是让下面这条业务闭环可观察、可控制、可恢复：

    发现新投递 → （可选）问候 → 请求简历 → 等待候选人发送
      → 简历进入指定邮箱 → 服务端关联、解析
      → 按策略请求交换联系方式 → 记录结果

另加一条独立流程：

    服务端下发关键词 → Monitor 执行搜索 → 返回当前页候选人摘要 → 服务端展示

职责划分：

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| 服务端 | 策略、业务状态、指令生成、邮件接入、文件存储、解析、对账 | 操作界面 |
| Monitor（本机） | 检测新事件、定位目标、执行动作、验证结果、本地持久化、回传 | 候选人档案、是否合适的判断 |
| 桌面 Driver（既有 2ndscreen CLI） | 辅助功能树读取、后台点击与输入、窗口绑定、专用屏幕 | 业务语义 |
| BOSS 客户端 | 实际交互界面 | — |
| 邮箱 | 简历附件的接收通道 | — |
| 用户 | 配置策略、处理登录和歧义、暂停与恢复、授权对外动作 | — |

明确不做：截屏 + OCR 读取简历正文；自动翻页的全量搜索；撤回已发送的消息；跨账号批量操作。

## 二、与既有工作的关系

ss-runtime-integration 已经交付并验收了一套"截屏 + OCR 采集在线简历"的运行时（runner / session / store / 2ndscreen adapter）。Monitor 不再走这条数据路径，但沿用它的三项结论：

1. BOSS 客户端的会话列表、候选人姓名、岗位、按钮在辅助功能树里可读；在线简历正文只是一张 AXImage。Monitor 只读列表和按钮，不读正文，所以不需要 OCR。
2. 不抢焦点的后台点击、输入、窗口绑定、专用虚拟屏幕由 2ndscreen CLI 提供（`state` / `click` / `type` / `key` / `scroll`、窗口绑定与屏幕生命周期）。Monitor 通过 Driver 适配器调用这个 CLI，不重写这些能力。
3. 现有代码把「发送、求简历、换电话、换微信、确认、转发、举报」列为禁止点击（`agents/boss/src/resumes/pages.ts` 的 `FORBIDDEN_LABEL`）。Monitor 第一次放开其中一部分：改为**显式白名单**，只允许本方案列出的动作在本方案的校验流程内生效；其他按钮继续禁止。

Monitor 用 Python 实现（用户要求）。账本、指令管线等与 TS runtime 有概念重叠，但两者部署目标不同（Monitor 是独立常驻进程），接受这次重复；不要从 TS 代码复制实现细节，按本说明重新设计。

## 三、运行模式与前提

安装时（`monitor install`）用户为设备选择一种模式，写入本机 `monitor_state.mode`，注册设备时上报服务端；可用 `monitor mode <local|remote>` 切换，切换时重跑前提检查。两种模式共用同一套核心、观察、动作和契约代码，差异只在启动、登录与窗口归属。

| | 本机模式 `local` | 独立设备模式 `remote` |
| --- | --- | --- |
| 机器 | 招聘人员自己的 Mac | 专用 Mac，无人值守 |
| BOSS 实例 | 用户自己的实例；Monitor 在策略时段内把窗口接管到专用屏幕（takeOver），用户点"暂停并归还窗口"即可拿回 | Monitor 在专用屏幕上启动并独占 |
| 登录 | 用户自己在客户端登录；检测到登录失效时本机通知 + 控制台提示，暂停对外动作，不做二维码接力 | 二维码接力到控制台（8.5 节），账号本人手机扫码 |
| 启动 | 用户登录 macOS 后随会话启动（安装时可选），或手动启动 | macOS 自动登录用户 → launchd 拉起 2ndscreen、Monitor，Monitor 启动 BOSS |
| 系统前提 | 辅助功能、屏幕录制权限 | 同左 + macOS 自动登录 + 不启用 FileVault + 防休眠；安装时检查，不满足则列出并停止 |
| 通知去向 | 本机状态窗口（常驻可见）+ 控制台 | 控制台 + 推送 |

通用前提：

- Monitor 操作期间用户不能在同一 BOSS 实例里手动操作。本机模式下这是产品层面必须让用户理解的约束，状态窗口和"暂停并归还窗口"按钮要一键可达。能否不抢焦点以实测为准，不提前承诺。
- 第一版只绑定一个招聘账户。用户切换账户时 Monitor 停止执行并要求重新确认绑定。
- 对外动作（问候、求简历、换联系方式、转发）只在用户在策略页明确开启后执行；每种动作有每日上限和最小间隔，均在 Monitor 本地强制，服务端策略不能把它们调到下限以下。

## 四、端到端架构

    招聘人员 → 服务端控制台 → 业务编排服务 → 指令队列
                                          ↕ 领取指令 / 回报结果 / 心跳
                                      本机 Monitor ↔ 桌面 Driver ↔ BOSS 客户端
                                          ↓ 事件上报
                                      事件接收服务 → 业务编排服务
    BOSS 客户端 ┄(待验证的转发路径)┄→ 指定邮箱 → 邮件接入与附件去重
                                              → 文件存储与 PDF 解析
                                              → 候选人与会话关联 → 业务编排服务
    业务编排服务 → 业务数据库；Monitor → 本地 SQLite

传输：第一版用 HTTPS 轮询（领取指令时长轮询，最长 30 秒），不引入 WebSocket。每台设备一个设备令牌，所有请求带令牌；服务端只对外暴露 HTTPS。

## 五、Monitor 内部结构

    monitor/client/monitor/
    ├── core/        指令客户端（领取、心跳、回传、确认）、SQLite 账本、执行管线、GUI 调度锁、暂停
    ├── observe/     基线、新投递检测、附件与联系方式事件
    ├── actions/     问候、求简历、换联系方式、搜索、（按验证结果）转发
    ├── driver/      2ndscreen CLI 适配：读取元素树、定位、点击、输入；夹具回放
    └── statusbar/   本机状态窗口（账户、客户端状态、当前动作、暂停按钮）

GUI 调度锁：观察与动作共用一把锁，动作优先；观察按配置周期（默认 45 秒）运行，动作执行中不观察。锁由 core 持有，observe 和 actions 只能通过 core 申请执行权。

## 六、指令与事件契约（M0 固定）

指令（服务端 → Monitor）：

    command_id      本次指令唯一标识（UUID）
    workflow_id     所属招聘流程（recruitment_case）
    account_id      目标账户
    action          send_greeting | request_resume | request_contact_exchange | search_candidates | forward_resume
    target          { conversation: {candidate_name, job_title, hints[]}, candidate_ref? }
    payload         问候文本、关键词、交换类型等
    expires_at      有效期
    depends_on      前置指令 command_id（可空）

结果（Monitor → 服务端）：

    command_id
    status          succeeded | failed | cancelled | expired | skipped_precondition | unknown
    observed        执行前后读到的界面事实（已请求过、按钮缺失、弹窗文案等）
    evidence        脱敏后的元素文本摘录与时间戳；不含截图
    executed_at / reported_at

事件（Monitor → 服务端，经本地 outbox 补传）：

    event_id        本地生成的幂等键 = hash(account_id, kind, conversation 身份, 观察到的变化时间片)
    kind            application_observed | attachment_available | contact_exchange_updated | login_required | blocked_by_dialog | device_paused
    conversation    { candidate_name, job_title, hints[] }
    observed_at

搜索快照：

    { "search_id", "query", "scope": "current_page", "coverage": "partial|complete|unreadable|empty_confirmed",
      "items": [ { "result_ref": "search_123:item_1", "display_name", "summary", "stable_candidate_id": null } ] }

三类结果必须区分：确认无结果（`empty_confirmed`）、成功读取（`partial|complete`）、无法读取（`unreadable`）。读取失败不得回报为空列表。

状态分三层：

| 层次 | 状态 |
| --- | --- |
| 业务流程（服务端） | new_application → greeted? → resume_requested → resume_received → resume_linked → contact_requested → contact_available / closed / needs_human |
| 指令执行（Monitor） | queued → running → succeeded / failed / cancelled / expired / skipped_precondition / unknown |
| 结果回传（Monitor） | pending → delivered |

## 七、Monitor 执行管线

    领取指令 → 写入本地账本（queued）
      → 检查重复（command_id 已存在则直接返回已有结果）
      → 检查有效期与账户绑定
      → 获取 GUI 执行权
      → 读取当前界面，定位并核对目标（姓名 + 岗位 + 提示词全部一致才算命中；多个命中 = 歧义，不执行）
      → 检查动作是否已经发生（如"已请求简历"的界面标记）→ 已发生则 skipped_precondition
      → 执行动作
      → 验证结果（读取执行后的界面事实）
      → 本地持久化结果
      → 回传服务端；收到确认后标记 delivered

关键异常：

| 情况 | 处理 |
| --- | --- |
| 动作成功，回传失败 | 保存结果，稍后补传，不重做 GUI 动作 |
| 点击后进程崩溃，结果未知 | 重启后重新观察；仍无法确认则 `unknown`，停止自动重试，依赖该指令的后续指令不执行 |
| 指令重复送达 | 返回已有结果 |
| 登录失效、验证码、未知弹窗、目标歧义 | 暂停相应执行，上报原因；不点任何未知控件 |
| 排队时被取消 | 不执行，返回 cancelled |
| 取消到达时动作已发生 | 回报实际结果 |
| 指令过期 | 不执行，返回 expired |
| 用户切换账户 | 停止执行，等待重新绑定 |
| 离线超过 24 小时 | 上线后先重建观察基线，再领取指令 |

## 八、四条数据流

### 8.1 新投递 → 问候 → 请求简历

1. observe 低频读取会话列表，与基线比较，只把能明确识别为"新投递"的会话产生 `application_observed`；普通未读消息不算。首次启动只建立基线，不产生事件。
2. 服务端按 `event_id` 去重，建立 `recruitment_case`（账户 + 候选人 + 岗位），检查岗位是否在自动处理范围。
3. 若策略开启问候，下发 `send_greeting`；成功后下发 `request_resume`（`depends_on` 前者）。若问候关闭，直接下发 `request_resume`。
4. `request_resume` 执行前检查"是否已请求"；执行后读取聊天区确认请求消息已出现。
5. 问候结果 `unknown` 时不自动推进求简历。

### 8.2 简历 → 邮箱 → 关联 → 解析

1. observe 看到附件简历可用时产生 `attachment_available`。
2. 若可行性验证表明需要客户端转发：服务端下发 `forward_resume`，Monitor 执行并记录转发时间；若邮件由其他机制自动投递，Monitor 不承担转发。
3. 邮件接入服务增量收信（IMAP 或邮箱 API），按"邮箱内邮件标识 + 附件内容哈希"去重，保存原始邮件元信息与文件（本地文件系统起步，接口预留对象存储）。
4. 关联顺序：邮件中的可靠标识（若有）→ 转发记录（command_id、时间窗）→ 账户 + 岗位 + 姓名。只凭姓名不能唯一命中时进入人工关联队列。
5. 关联成功后建立 `resume_document` 版本（同一候选人多份简历保留版本，不覆盖），产生 `resume_received`，再解析 PDF 文本；扫描版是否走服务端 OCR 由策略决定，第一版不做。
6. 收到并正确关联即可触发联系方式请求；是否等解析完成由策略决定。

附件哈希只用于文件去重，不作为候选人身份。

### 8.3 交换联系方式

1. 服务端检查策略后下发 `request_contact_exchange`（第一版只支持电话；微信留作后续）。
2. Monitor 核对账户和会话，读取当前交换状态：已获得 → 回报可用；已请求待同意 → 回报等待；未请求 → 点击交换、验证请求已发出。
3. observe 后续看到候选人同意且字段可读时产生 `contact_exchange_updated`。

服务端状态：未请求 / 请求已发送 / 等待同意 / 联系方式可用 / 已明确拒绝（仅界面可识别时）/ 结果待确认。"请求已发送"是指令成功，"联系方式可用"是业务事件，两者不混用。

### 8.4 搜索

1. 控制台提交关键词和结果上限；服务端创建带有效期（默认 10 分钟）的 `search_candidates`。
2. Monitor 进入指定搜索入口、输入关键词、等待可识别的结果状态、读取当前页可访问的信息、整理摘要与覆盖标记后返回快照。
3. 第一版不自动翻页、不承诺完整简历和总数。`result_ref` 只是本次快照的位置；对某条结果发起动作时必须重新定位并核对身份。

### 8.5 开机自启与登录接力（独立设备模式）

目标：设备开机后无人干预即进入待命状态；需要登录时把二维码接力到控制台，由账号本人用手机扫码，登录态始终留在设备上。不复制、不导出 BOSS 的 cookie 或 token。本机模式只用其中的登录状态检测：失效时暂停、通知用户在本机登录、恢复后继续。

1. 开机：macOS 配置为自动登录该用户（因此不能启用 FileVault）；launchd 用户级任务启动 2ndscreen 与 Monitor。Monitor 创建专用屏幕，在其上启动 BOSS 客户端，并启动防休眠。
2. Monitor 读元素树判断登录状态。已登录 → 正常工作；未登录 → 切到扫码登录页签（如有），定位二维码区域。
3. 对二维码区域截一张图（仅此处使用截图，非持续），用系统 Vision 条码识别本地解码；把解码内容、设备 ID、过期时间经 HTTPS 上报为 `login_qr` 事件。服务端只保留到过期，记录查看者。
4. 控制台显示"设备需要登录"卡片并重新渲染二维码，同时推送通知。未登录期间 Monitor 每 10 秒重读一次；二维码变化即重传；出现"已失效，点击刷新"则点击刷新。
5. 用户用绑定账号的手机 BOSS App 扫码并确认。扫码后若客户端要求短信验证码或其他人工输入，走通用的 `human_input_required` 事件 → 控制台输入 → `provide_input` 指令 → Monitor 代填；滑块等无法代填的情形上报并等待人工。是否出现这些步骤由 M1b 实测。
6. Monitor 轮询到登录完成 → 上报 `login_ok`，服务端撤下二维码卡片，Monitor 进入正常观察。
7. 运行中检测到回到登录页 → 暂停对外动作、上报 `login_required`、重新进入第 2 步。

## 九、服务端数据模型

| 实体 | 用途 | 关键字段 |
| --- | --- | --- |
| devices | Monitor 连接、能力、健康 | device_id, mode (local/remote), token_hash, last_heartbeat, capabilities |
| account_bindings | 设备与招聘账户的绑定 | device_id, account_id, bound_at, confirmed_by |
| recruitment_cases | 某候选人与某岗位的一次流程 | case_id, account_id, candidate_name, job_title, conversation_hints, stage, paused |
| commands | 指令及依赖、有效期、结果 | command_id, case_id, action, payload, expires_at, depends_on, status, result |
| events | 客户端与邮箱产生的业务事件 | event_id, kind, case_id?, payload, observed_at, received_at |
| resume_documents | 简历文件、版本、关联、解析状态 | doc_id, case_id?, mail_id, sha256, version, link_status, parse_status, text_path |
| contact_exchanges | 联系方式请求与结果 | case_id, type, status, requested_at, available_at |
| search_runs / search_results | 搜索参数与结果快照 | search_id, query, coverage, items |
| manual_actions | 人工确认、人工关联 | actor, at, note, target |

同一候选人申请两个岗位有两条 `recruitment_cases`。姓名相同的不同候选人在同一岗位下视为歧义，进入人工处理。

本机 SQLite 三张表：`command_ledger`（指令、阶段、结果、回传状态）、`event_outbox`（未确认事件）、`monitor_state`（账户绑定、观察基线、读取进度、暂停状态）。

## 十、控制台页面

五个服务端页面加一个本机状态窗口，结构见线框图。关键规则：

1. 总览分别统计今日新投递、已请求简历、收到简历、解析完成、待人工处理，不合并成"成功数"。
2. 暂停 = 停止领取和启动新的对外动作；已发生的动作仍完成记录与回传；不声称撤回。
3. 候选人流程以 `recruitment_case` 为行，不是全局候选人表。
4. 结果待确认的动作只给"重新检查界面状态 / 人工确认已发送 / 停止此流程"，不给"重试"。人工确认记录操作者、时间和说明，不覆盖原始执行证据。
5. 搜索页说明覆盖范围；三种结果状态分开展示。
6. 策略页：岗位范围、新投递自动问候（可关）、问候模板、自动请求简历、收到简历后的动作、工作时段、每种动作的每日上限、异常时暂停并通知（不可关闭）、初次启用基线说明。
7. 本机窗口只显示账户、客户端状态、当前动作、待执行/待回传、最近异常和一个暂停按钮；不出现实现术语。本机模式下按钮文案为"暂停并归还窗口"，窗口常驻可见；登录失效时显示"请在 BOSS 客户端完成登录"。
8. 连接与策略页的设备卡片显示模式；远端设备未登录时显示"设备需要登录"卡片与二维码，本机设备只显示"等待用户在本机登录"。

## 十一、安全与合规

- 设备令牌在首次绑定时由控制台生成，Monitor 存本机 keychain 或 0600 文件；令牌可吊销。
- Monitor 回传的 evidence 只含元素文本摘录，不含截图；候选人姓名在日志中默认脱敏。
- 简历文件和联系方式属于个人信息：存储位置、访问权限、保留期限在服务端配置并记录；上线前确认告知与用途合规（《个人信息保护法》）。
- 对外动作的白名单、每日上限、最小间隔在 Monitor 本地强制，策略只能收紧。
- 发现验证码、风控提示、登录失效时立即暂停并通知，不尝试绕过。

## 十二、必须先验证的产品假设

| 假设 | 验证方法 | 不成立时的影响 |
| --- | --- | --- |
| 新投递能否从会话列表可靠识别（标记、分组或未读语义） | 只读观察真实客户端，记录元素结构 | 新投递检测改为用户手动触发或按时间窗口推断，准确性下降 |
| 问候、求简历、换电话的执行结果能否从界面读取 | 用户授权后在测试账号各执行一次，记录前后元素树 | 结果多数落入 unknown，需要人工核实，自动推进价值下降 |
| 简历如何进入邮箱；邮件携带哪些关联信息 | 实测附件简历的转发/下载入口与邮件内容 | 若无自动路径，需要客户端转发指令；若邮件无标识，关联只能靠转发记录和姓名 |
| 搜索结果能否从辅助功能树读取 | 只读观察搜索页 | 若为图片，搜索功能延后或接受 OCR 例外 |

另需记录：扫码登录后是否出现手机端确认、短信验证码或滑块（决定登录接力需要哪些人工输入通道）；二维码刷新周期与"已失效"状态的呈现；求简历、换联系方式的平台每日配额；在线简历弹层旁"转发"按钮的目标与格式；新招呼/新投递在客户端里的具体呈现位置。

## 十三、交付点与验收

| 交付点 | 能看到什么 | 验收重点 |
| --- | --- | --- |
| 可行性验证 | 能力矩阵文档、脱敏元素树夹具 | 不依赖 OCR；目标与结果可确认；每项结论附证据 |
| 单会话闭环 | 请求简历 → 邮件收到 → 正确关联 | 全链路可追踪；重复指令不重复操作 |
| 三项功能试运行 | 新投递自动处理、联系方式、当前页搜索 | 状态准确；不支持与无结果区分 |
| 恢复与运维 | 断网补传、崩溃恢复、暂停、人工处理 | 不因重试重复发送；unknown 可处理 |

工作量（1 位熟悉现有代码的工程师或等效 agent 产能）：Monitor 客户端 16–25 人日；邮件接入 3–5 人日；服务端编排 + 控制台若从零建设另计 15–25 人日。最大不确定项是第十二节的四项假设，验证结果可能改变 M4/M5/M7 的范围。
