# Monitor 执行状态表

监督者维护。状态：未派 / 进行 / 待审 / 派回 / 已合 / 阻塞。任务定义见 [执行计划](monitor-agent-tasks.md)。

| 代号 | 任务 | Worker / 工作区 | 分支 | 状态 | 最近 commit | 未决问询 |
| --- | --- | --- | --- | --- | --- | --- |
| A | 契约、协议与 API 规范 | ctx_0786c7296951→ctx_edd92e2bd40f（已释放） | monitor-A | 已合（928dc10，契约 0.1.1，170 tests） | ffd598b | — |
| A2 | 契约 0.2.0 审查修正（写操作标志拆分、账户不可读、定位器语义） | ctx_6b7c4980f328（已释放） | monitor-A2 | 已合（contracts 191 tests）；合并后 client/core 41 个测试待 D2b 适配 | dadf00b | — |
| D2b | 管线适配契约 0.2.0 | ctx_b7ad3e02477a / monitor-D2b | monitor-D2b | 进行 | — | — |
| A3 | 契约 0.3.0：简历路线 | — | — | 未派（排队，等有名额） | — | — |
| R | 品牌化简历渲染 | — | — | 未派（待用户模板与 logo、N 邮件格式） | — | — |
| B | 只读可行性验证与夹具 | ctx_1b25ee64eab9（已释放） | monitor-B | 已合（898edbd） | 201001d | 登录/二维码、新招呼首次打开、电话待同意/已交换/已拒绝、邮件转发内容、搜索输入后结果 → 留给 N/K |
| C | Driver 适配器 | ctx_3dfbecec466d（已释放） | monitor-C | 已合（ecfe9da；client 入工作区 + relock，contracts+client 351 tests） | ec6aed9 | 定位器 text 同时匹配 label/value（比契约宽），0.2.0 契约里追认；CliDriver 未在 BOSS 上真机跑过 → N |
| D1 | 本地账本 | ctx_18b2867a5255→ctx_872a5dbe5563（同一终端）/ monitor-D1 | monitor-D1 | 已合（079107c）；D1b 适配 0.2.0 进行中 | 62b0721 | 已回传数据保留期限待产品决定 |
| D2 | 指令客户端与执行管线 | ctx_be925b1cfd1f（已释放） | monitor-D2 | 已合（810c993；relock httpx；contracts+client 464 tests） | dc26e24 | 工厂入口：D1 open_ledger(path)、E create_observer()、H create_handlers()；0.2.0 合并后跟进 core/write_flags.py 与 guard.py |
| E | 观察模块 | — | — | 未派 | — | — |
| F1 | 服务端基础 | ctx_5b46093fd09a→ctx_cc1c5c58beb5（同一终端）/ monitor-F1 | monitor-F1 | 已合（2b1dff2，server 入工作区 0970865）；F1b 适配 0.2.0 进行中 | 823b3ad | openapi 缺 401/422 → A3 |
| F2 | 服务端业务 | — | — | 未派 | — | — |
| F3 | 服务端扩展 | — | — | 未派 | — | — |
| G | 邮件接入 | — | — | 未派 | — | — |
| H1 | 动作公共层 + 问候 + 求简历 | — | — | 未派 | — | — |
| H2 | 搜索动作 | — | — | 未派 | — | — |
| H3 | 换联系方式 + 转发简历 | — | — | 未派 | — | — |
| I1 | 控制台骨架、总览、连接与策略 | — | — | 未派 | — | — |
| I2 | 控制台候选人流程、执行记录、搜索 | — | — | 未派 | — | — |
| J | 安装、模式、launchd、状态窗口 | — | — | 未派 | — | — |
| K | 登录接力 | — | — | 未派 | — | — |
| M | 集成、混沌测试、运维手册 | — | — | 未派 | — | — |
| N | 写操作验证与真机验收 | 监督者 | — | 未开始（待用户授权） | — | — |

## 契约版本

| 版本 | 日期 | 变更 | 受影响任务 |
| --- | --- | --- | --- |
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
2. N 阶段测试账号、候选人与逐项授权方式。
3. 独立设备模式是否接受"自动登录 + 不启用 FileVault"。
4. Monitor 打开未读会话会产生已读回执（对外可见），新投递检测是否接受这一点（B 已避免打开未读会话）。
5. 候选人同意交换后，是否把手机号回传到服务端存储（v1 契约暂不带号码，只报状态）。
6. ~~硬上限~~ 已决定（2026-10-04）：每种对外动作每日 ≤40；间隔问候/求简历/转发 45 秒、换联系方式 60 秒、搜索 30 秒（D2b 实现）。
7. ~~简历路线~~ 已决定（2026-10-04）：默认直接转发在线简历到邮箱，求简历路线保留为可选；对外版本套用公司模板与 logo（任务 R）。
9. 任务 R 需要：公司简历模板（Word/PDF/HTML 样例均可）、logo 文件、字段取舍（是否含联系方式、是否去掉平台字样）。
8. ~~搜索页问候按钮~~ 已决定（2026-10-04）：v1 去掉，搜索只返回快照。
