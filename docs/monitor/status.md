# Monitor 执行状态表

监督者维护。状态：未派 / 进行 / 待审 / 派回 / 已合 / 阻塞。任务定义见 [执行计划](monitor-agent-tasks.md)。

| 代号 | 任务 | Worker / 工作区 | 分支 | 状态 | 最近 commit | 未决问询 |
| --- | --- | --- | --- | --- | --- | --- |
| A | 契约、协议与 API 规范 | ctx_0786c7296951→ctx_edd92e2bd40f（已释放） | monitor-A | 已合（928dc10，契约 0.1.1，170 tests） | ffd598b | — |
| A2 | 契约 0.2.0 审查修正（写操作标志拆分、账户不可读、定位器语义） | ctx_6b7c4980f328（已释放） | monitor-A2 | 已合（contracts 191 tests）；合并后 client/core 41 个测试待 D2b 适配 | dadf00b | — |
| D2b | 管线适配契约 0.2.0 + 硬上限 | 已释放 | monitor-D2b | 已合（9d74827）；全量 703 tests | 0c4f3be | 执行中取消需另一线程调 pipeline.cancel（→ J）；崩溃恢复 unknown 时 outbound 保守取 true |
| A3 | 契约 0.3.0：邮箱路线与搜索收敛 | 已释放 | monitor-A3 | 已合（fbf6f3a，contracts 266 tests）；A3b 补充中；client/server 适配由 X 处理 | 76e93e8 | — |
| A3b | 契约 0.3.1（换微信阶段、mail 服务字段） | 已释放 | monitor-A3 | 已合（e57b411，contracts 281）；协调者补测试夹具 mail_retention_days，全量 1152 | b90ccf4 | — |
| X | client/server 适配 0.3.0 | 已释放 | monitor-X | 已合（813e25a；全量 1137 tests） | 2a9653d | server 一致性测试 NOT_YET_IMPLEMENTED 白名单 26 项，F2/F3/G 实现时逐项移出 |
| C2 | Driver 修复（CliFailure 冻结、window release 分类、PDF 子树过滤） | 已释放 | monitor-C2 | 已合（f9dbc1e；全量 1181） | b99a2db | 窗口归还文案按源码构造未实测；开着 PDF 预览时快照 index 与 CLI index 不同（driver 内部映射） |
| D2c | 管线三处小改（入口分发、status()、suspend_gui） | ctx_f53c25d0358d / monitor-D2c | monitor-D2c | 进行（21:21 撞会话额度，凌晨 12:30 自动继续；改动在工作区未提交） | — | — |
| A4 | 契约 0.3.2 汇总补丁 | 已释放 | monitor-A4 | 已合（5dc14d1，contracts 299）；server 一致性测试 21 个失败待 F4 | 2810273 | 多账户策略取值未裁决（A4.md） |
| R | 品牌化简历渲染 | — | — | 移出本项目（用户 2026-10-04：属于 ATS 功能，见 ~/orca/ats） | — | — |
| B | 只读可行性验证与夹具 | ctx_1b25ee64eab9（已释放） | monitor-B | 已合（898edbd） | 201001d | 登录/二维码、新招呼首次打开、电话待同意/已交换/已拒绝、邮件转发内容、搜索输入后结果 → 留给 N/K |
| C | Driver 适配器 | ctx_3dfbecec466d（已释放） | monitor-C | 已合（ecfe9da；client 入工作区 + relock，contracts+client 351 tests） | ec6aed9 | 定位器 text 同时匹配 label/value（比契约宽），0.2.0 契约里追认；CliDriver 未在 BOSS 上真机跑过 → N |
| D1 | 本地账本 | 已释放 | monitor-D1 | 已合（079107c + 0.2.0 适配 69a9855） | 3a3a5b4 | 已回传数据保留期限待产品决定 |
| D2 | 指令客户端与执行管线 | ctx_be925b1cfd1f（已释放） | monitor-D2 | 已合（810c993；relock httpx；contracts+client 464 tests） | dc26e24 | 工厂入口：D1 open_ledger(path)、E create_observer()、H create_handlers()；0.2.0 合并后跟进 core/write_flags.py 与 guard.py |
| E | 观察模块 | 已释放 | monitor-E | 已合（a139f20；协调者同时改 core：观察用 verify 守卫、attach 注入、首个基线带账户；全量 884 tests） | e002670 | 待 N：点页签后列表刷新、处理过的会话是否移出新招呼、更多时间文案形态 |
| F1 | 服务端基础 | 已释放 | monitor-F1 | 已合（2b1dff2 + 0.2.0 适配 8abbf54） | c7bbc4b | openapi 缺 401/422/403 → A3 |
| F2 | 服务端业务 | 已释放 | monitor-F2 | 已合（含 F2b 原子性 60163fd；全量 1442）；业务部分冻结（归 ATS） | 94a473c | 契约请求 ManualCommandCreated.scheduled_for；issued_at 未到不下发写入 contracts.md |
| F3 | 服务端扩展（搜索、登录接力、通知 + 邮件相关端点） | 已释放 | monitor-F3 | 已合（6ec91ae；全量 1602） | — | 通知只保留设备运维类（login_required、blocked_by_dialog、login_qr、邮件 failed），case_needs_human 与 mail_verification 通知冻结；搜索受工作时段约束（搜索算对外动作）；scrub/purge 定时调用归 M 与部署；契约缺口见 F3.md |
| G | 邮件接入（mail 服务订阅方） | 已释放 | monitor-G | 已合（mail 入工作区；全量 1313） | f29f5a9 | 交接给服务器端（docs/monitor/handover-mail-ingestion.md），Monitor 内冻结 |
| H1 | 动作公共层 + 问候 + 求简历 | 已释放 | monitor-H1 | 已合（合并时全量 963 tests） | — | 9 条界面假设待 N（H1.md 第五节）；接口请求：Driver 层过滤 PDF 子树、hints 稳定 |
| H2 | 搜索动作 | 已释放 | monitor-H2 | 已合（a6cd2e4；全量 1639 + 1 xfail（search 计为对外动作，待 D2d）） | — | 11 条真机假设待 N（H2.md 第五节） |
| H3 | 换微信（人工触发） | 已释放 | monitor-H3 | 已合（de10737；全量 1477） | — | 8 条真机假设待 N（H3.md 第五节）；『已交换』界面未观察到，遇到时返回 unknown 不点击 |
| I1 | 控制台骨架、总览、连接与策略 | — | — | 撤销（2026-10-04：管理页放服务器端 / ATS 门户，见 handover-device-console.md） | — | — |
| I2 | 控制台候选人流程、执行记录、搜索 | — | — | 撤销（同上） | — | — |
| J | 安装、模式、launchd、状态窗口 | 已释放 | monitor-J | 已合（2420f09；其分支上 982 tests；合并后受 0.3.0 limits 影响由 X 修） | 3a33e4d | 真机验证步骤见 J.md 第七节；接口请求：CliFailure 冻结 bug、window release 分类（→ C2）、python -m monitor install 分发（→ X 之后） |
| K | 登录接力 | — | — | 未派 | — | — |
| M | 集成、混沌测试、运维手册 | — | — | 未派 | — | — |
| N | 写操作验证与真机验收 | 监督者 | — | 未开始（待用户授权） | — | — |

## 契约版本

| 版本 | 日期 | 变更 | 受影响任务 |
| --- | --- | --- | --- |
| 0.3.2 | 2026-10-04 | 搜索=对外动作（三标志 true、受工作时段约束）；ManualCommandCreated.scheduled_for 与 issued_at 未到不下发；openapi 补 401/403/404/422；serviceToken 只读 listResumeDocuments/getPolicy；ResumeDocument.candidate_case_ids；human_input_required.expires_at（默认 10 分钟）；mail_message_key revision=purged | server（F4）、core（D2d） |
| 0.3.1 | 2026-10-04 | 人工换微信可从除 closed 外各阶段进入 contact_requested（之后邮件到达不回退阶段）；mail_message 改为 mail 服务订阅方（provider=remotedesk-mail、mail_message_id='mail:'+id）；upstream_missing；policy.mail_retention_days（必填，默认 30）；收件邮箱 zhaopin@remotedesk.io | F2、G、I1 |
| 0.3.0 | 2026-10-04 | 移除 forward_resume；mail_message / mail_verification；resume_document variant；搜索卡片 fields/masked_name/prop_card_texts；只换微信 + POST /cases/{id}:request-wechat；补齐 401/403/422 | client、server（X 适配） |
| 0.2.0 | 2026-10-04 | command_result 的 gui_write_performed 拆为 navigation_performed / outbound_action_performed / externally_visible_side_effect（线上必填；verify_only 与取消只约束 outbound；outbound⇒externally_visible）；account_id 来自绑定、account_mismatch 只在有证据时使用；Locator.text/text_contains 匹配 text/label/value | D1、D2、H1–H3、F1、I1 |
| 0.1.1 | 2026-10-04 | Element.enabled 改 bool\|None=None（CLI 不提供）；Element.text 改为 label 优先否则 value | C、E、H、K |
| 0.1.0 | 2026-10-04 | A 问询裁决：新增 event kind `conversation_ambiguous`；command 加 `execution_mode: execute\|verify_only`（verify_only 不受上限、不看白名单）；contact_exchange_updated 只报 state（含 unknown），不带号码；workflow_id 对四个流程动作必填；command_result reason 枚举与组合约束；unsupported_presentation 走 heartbeat.last_error；monitor/uv.lock 归 A，后续任务不提交 lock 改动，监督者合并时重新 lock | 全部 |

## 已知风险（待 N 验证）

- 2ndscreen CLI 的 `--index` 指向菜单栏应用缓存的最近一次 state，任何进程调用 state 都会替换它。CliDriver 写前会重读核对，但同机其他 agent 并发使用 CLI 仍有竞争窗口；Monitor 运行时同机不应有其他 agent 操作 2ndscreen。
- `--text` 点击不报歧义，CliDriver 一律先定位再按 index 点击。
- 全局坐标随显示器增删平移；CliDriver 只用窗口相对几何。

## 用户待决事项

Run：run_7d52e82ce7ed。分支 monitor-v1（a12a931，自 szrunworld/ss-runtime-integration）；并发 3（用户 2026-10-04 确认）。

1. ~~新招呼 = 新投递~~ 已确认（2026-10-04）；会话列表只读最新约 10 行、逐批处理的设计也已接受。
2. N 阶段：账号已确定为用户本人账号，就在本机已登录的 BOSS 客户端（2026-10-04）。待定：用于写操作验证的候选人与逐项授权。
3. 独立设备模式是否接受"自动登录 + 不启用 FileVault"。
4. ~~已读回执~~ 已决定（2026-10-04）：接受；如实记录 externally_visible_side_effect。
5. 候选人同意交换后，是否把**微信号**回传到服务端存储（v1 契约暂不带号码，只报状态）。交换方式已决定（2026-10-04）：只换微信、仅人工触发（A3 0.3.0 实现）。
6. ~~硬上限~~ 已决定（2026-10-04）：每种对外动作每日 ≤40；间隔问候/求简历/转发 45 秒、换联系方式 60 秒、搜索 30 秒（D2b 实现）。
7. ~~简历路线~~ 已决定（2026-10-04，二次）：求简历 → 候选人同意 → BOSS 自动发到公司预留邮箱；Monitor 不转发；邮箱按『邮箱即队列 + 消费 + 归档 + 核对』读取（任务 G）；对外版本套用公司模板与 logo（任务 R）。
10. ~~邮箱~~ 已决定（2026-10-04）：zhaopin@remotedesk.io（别名 bosszhipin@），公司邮件服务 mail（remotedesk-resend）的公共邮箱；Monitor 订阅 mail.ready + integration key 取信；保留 30 天由 mail 留存任务执行，Monitor 不逐封删除。进展（2026-10-04）：公共邮箱 CV 已建（zhaopin@ + 别名 bosszhipin@）。部署时待办：retention_days 改为 30（默认 365）；Monitor 服务端部署后把其主机加入 mail 的 MAIL_WEBHOOK_ALLOWED_HOSTS 并为 CV 建 mail.ready 订阅；签发 mail.read API key 存服务端环境变量；BOSS 后台收简历邮箱改为上述地址之一；G0 不做（用户 2026-10-04：邮件服务侧已有专门服务监控收信，Monitor 不负责上游完整性）；BOSS 后台收件邮箱已设置（用户 2026-10-04 确认）。
9. ~~任务 R~~ 移出本项目（属于 ATS）。原需要：公司简历模板（Word/PDF/HTML 样例均可）、logo 文件、字段取舍（是否含联系方式、是否去掉平台字样）。
8. ~~搜索页问候按钮~~ 已决定（2026-10-04）：v1 去掉，搜索只返回快照。

## H1 接口请求裁决

- 问候前若聊天区已有完全相同的我方消息 → skipped_precondition/precondition_already_done（避免重复发送）：同意。
- Driver 层过滤附件 PDF 预览子树：同意，作为 C 的后续小任务排队（目前由 actions/common.py 在动作层过滤）。
- hints 不随时间变化：E/F2 生成 hints 时只用稳定字段（岗位、会话入口），不用时间或未读数。

## core 小改（已派 D2c）

- `python -m monitor install|mode` 分发到 `monitor.install.cli:main`（J 请求 1）。
- `MonitorRuntime.status()` 增加 outbox 计数、last_error.message、当前指令 id 与开始时间（J 请求 2）。
- 运行时"窗口不归 Monitor"状态：`suspend_gui(reason)` / `resume_gui()`，避免 local 模式时段外的 window_lost 覆盖其他错误（J 请求 3）。

## 与 ATS 的分工（2026-10-04）

- 已确认：Monitor = 本机执行器 + 薄桥接服务（设备、指令队列、事件接收）。业务（候选人、流程、简历存储解析、通知、流程页与总览、品牌化简历）归 ATS。F2 的 cases/policy/overview 冻结；I1/I2 只做设备、登录、执行记录。
- 已决定：时间路线 A（Monitor 先独立运行，ATS 到 P2 再切换指令来源）；设备、登录、执行记录管理页放服务器端（ATS 门户），I1/I2 撤销（交接 handover-device-console.md）。
- 契约变更请求已写好：docs/monitor/ats-contract-change-request.md（用户转交 ATS）。
- 原待决： 给 ATS 的契约变更（channel_task 与执行器接口、任务类型含求简历/换微信/搜索、无联系方式的 BOSS 候选人入库、品牌化简历）由谁提出。

- 邮件收简历（G）：用户决定交给服务器端（定时任务，与设备无关）。交接文档 docs/monitor/handover-mail-ingestion.md；接收方确认后从 Monitor 移除 monitor/mail 与相关端点。

## 搜索算对外动作（用户 2026-10-04）

- 更正此前"搜索属于导航"的裁决：搜索输入与提交在 ctx.outbound() 内，三标志 navigation/outbound/visible 均为 true。
- 待跟进（D2d，D2c 恢复后派）：core 中 search 的限额改按对外动作计数、崩溃恢复对 search 的 outbound 不再强制 false、服务端搜索受工作时段约束；契约 contracts.md 第四节释义同步（0.3.2，文档修订）。
