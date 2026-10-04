# Monitor 执行状态表

监督者维护。状态：未派 / 进行 / 待审 / 派回 / 已合 / 阻塞。任务定义见 [执行计划](monitor-agent-tasks.md)。

| 代号 | 任务 | Worker / 工作区 | 分支 | 状态 | 最近 commit | 未决问询 |
| --- | --- | --- | --- | --- | --- | --- |
| A | 契约、协议与 API 规范 | ctx_0786c7296951→ctx_edd92e2bd40f（已释放） | monitor-A | 已合（928dc10，契约 0.1.1，170 tests） | ffd598b | — |
| A2 | 契约 0.2.0 审查修正（写操作标志拆分、账户不可读、定位器语义） | ctx_6b7c4980f328 / monitor-A2 | monitor-A2 | 进行 | — | forward_resume 来源与搜索页问候待用户决定，下一版处理 |
| B | 只读可行性验证与夹具 | ctx_1b25ee64eab9（已释放） | monitor-B | 已合（898edbd） | 201001d | 登录/二维码、新招呼首次打开、电话待同意/已交换/已拒绝、邮件转发内容、搜索输入后结果 → 留给 N/K |
| C | Driver 适配器 | ctx_3dfbecec466d（已释放） | monitor-C | 已合（ecfe9da；client 入工作区 + relock，contracts+client 351 tests） | ec6aed9 | 定位器 text 同时匹配 label/value（比契约宽），0.2.0 契约里追认；CliDriver 未在 BOSS 上真机跑过 → N |
| D1 | 本地账本 | — | — | 未派 | — | — |
| D2 | 指令客户端与执行管线 | ctx_be925b1cfd1f / monitor-D2 | monitor-D2 | 进行 | — | — |
| E | 观察模块 | — | — | 未派 | — | — |
| F1 | 服务端基础 | ctx_5b46093fd09a / monitor-F1 | monitor-F1 | 进行 | — | — |
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
| 0.1.1 | 2026-10-04 | Element.enabled 改 bool\|None=None（CLI 不提供）；Element.text 改为 label 优先否则 value | C、E、H、K |
| 0.1.0 | 2026-10-04 | A 问询裁决：新增 event kind `conversation_ambiguous`；command 加 `execution_mode: execute\|verify_only`（verify_only 不受上限、不看白名单）；contact_exchange_updated 只报 state（含 unknown），不带号码；workflow_id 对四个流程动作必填；command_result reason 枚举与组合约束；unsupported_presentation 走 heartbeat.last_error；monitor/uv.lock 归 A，后续任务不提交 lock 改动，监督者合并时重新 lock | 全部 |

## 已知风险（待 N 验证）

- 2ndscreen CLI 的 `--index` 指向菜单栏应用缓存的最近一次 state，任何进程调用 state 都会替换它。CliDriver 写前会重读核对，但同机其他 agent 并发使用 CLI 仍有竞争窗口；Monitor 运行时同机不应有其他 agent 操作 2ndscreen。
- `--text` 点击不报歧义，CliDriver 一律先定位再按 index 点击。
- 全局坐标随显示器增删平移；CliDriver 只用窗口相对几何。

## 用户待决事项

Run：run_7d52e82ce7ed。分支 monitor-v1（a12a931，自 szrunworld/ss-runtime-integration）；并发 3（用户 2026-10-04 确认）。

1. 确认『新招呼』= 新投递（B 推断，客户端无『投递』字样）。
2. N 阶段测试账号、候选人与逐项授权方式。
3. 独立设备模式是否接受"自动登录 + 不启用 FileVault"。
4. Monitor 打开未读会话会产生已读回执（对外可见），新投递检测是否接受这一点（B 已避免打开未读会话）。
5. 候选人同意交换后，是否把手机号回传到服务端存储（v1 契约暂不带号码，只报状态）。
