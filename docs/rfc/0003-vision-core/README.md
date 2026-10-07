# RFC 0003 - 视觉与 Agent 核心重写进 Runtime（草案）

状态：草案，供讨论。依据：Kevin 的指令「把 UI-TARS 重写，把核心能力直接集成到 runtime 里面，不要整个包拿过来」，以及产品基线（agentdesktop/docs/product-baseline.md）的三层职责。

## 目标

Runtime 内提供一条最小而完整的链路：观察 → 视觉请求 → 动作解析 → 统一执行，模型按需调用。它服务两类调用方：业务 Agent 按需委托视觉与探索；外部 Agent 不经过它也能直接操作 desktop。它不是完整的学习平台，不带模型管理界面，不替代输入隔离验证。

## 现有 TarsAgent 的盘点（Sources/TarsAgent，3,230 行）

| 文件 | 行数 | 内容 | 处置 |
| --- | --- | --- | --- |
| Model.swift | 130 | ModelConfig、Message、VisionModel 协议、ChatCompletionsModel | 保留思路，重写为 Runtime 的可替换模型接口 |
| ActionParser.swift | 162 | UI-TARS 文本动作解析（click/type/scroll/finished 等）与坐标归一化 | 复用解析规则，输出改为 Desktop 动作建议 |
| Describe.swift | 43 | 元素描述拼接 | 复用 |
| Planner.swift | 246 | Step/Outcome/PlanContext，一步规划 | 重写为"单步建议"与"受托探索"两个模式 |
| Agent.swift | 556 | AgentScreen 协议（frame/screenshot/perform/elements）与循环 | AgentScreen 的职责移交 Desktop 执行核心；循环重写 |
| Bridge.swift | 751 | 旧探索桥 JSONL（ExplorationRequest、action_started/finished 事件） | 不迁移协议；保留已识别的约束：执行事件不能当指令再投递 |
| Screens.swift / IPhoneScreen.swift / AndroidPlan.swift | 542 | 控制屏、iPhone、Android 适配 | 不进首发；手机适配按产品基线为后续可选 |
| Procedure.swift / Learning.swift | 800 | 学习到的流程与槽位 | 不进本 RFC；留给业务 Agent 或后续 |

## 最小链路的七步

1. 取指定 desktop 的观察：截图（尺寸、`frameId`）、窗口几何、可选元素列表；坐标映射规则固定并写入观察。
2. 组织视觉请求：系统提示、历史、当前观察，通过可替换的模型接口发送；接口只约束"图像 + 文本进，文本出"，记录 token 用量或 unknown。
3. 解析模型输出为三类之一：动作建议（带模型坐标或元素序号）、完成声明、错误/需要人。
4. 把模型坐标或元素序号转换成 Desktop 支持的动作（click/type/key/scroll/drag），带目标窗口与 `frameId`。
5. 单步模式：返回建议，由调用方决定是否执行。
6. 受托探索模式：在明确的步数、时间与取消条件内循环执行，每步都经同一执行入口。
7. 记录三件事并关联：模型建议、实际发出的动作请求、真实执行回执（含执行时窗口几何）。

所有实际输入都经过 Desktop 的同一执行入口；重写的循环、旧脚本、外部 Agent 都不保留绕过控制权的原生输入路径。

## 与现有 task-runtime 的关系

- `agent-bridge.ts` 现在以子进程方式调用 `2ndscreen agent-bridge`（Bridge.swift）。重写后 Runtime 内的视觉核心取代这条桥，`run_unit` 的探索改走新链路；旧桥在兼容期内保留。
- 模型调用的预算、用量与审批仍由 Runtime 的现有账本承担，本 RFC 不新增一套。
- 业务判断（候选人、账号、页面策略）留在业务 Agent。

## 不做

- 不恢复完整任务平台的首发范围。
- 不要求创建 desktop、截图或输入经过模型。
- 不在本阶段做学习流程、手机适配、模型管理界面。

## 验收（实现时）

- 单步模式：对一张固定截图与固定模型回复（录制的样本），输出确定的动作建议；坐标映射有单元测试。
- 受托探索：在计算器上完成"算出 7×8"的探索，步数上限内结束；每步的建议、请求、回执三者关联可查。
- 旧桥的执行事件不会被当成指令再投递（保留已识别约束的回归）。
