# Second Screen 并行开发任务

本拆解执行 macOS 首版 P0–P5。P0、接口评审、逐项代码审查和合并验收由主协调者负责；实现、单元测试、修复和提交由 Claude Code 的 claude-opus-5-5 执行。P6 远端回传和 P7 Windows 是后续扩展，不进入本轮首版合并。

功能目标及边界见 [实施规划](skill-runtime-boss-plan.md)。真实桌面验收与模拟测试分别报告，不把夹具通过当成 BOSS 实测成功。

## 正交性规则

1. 每个 agent 使用独立 Orca 子工作区和分支，禁止修改主工作区。最多同时运行三个开发 agent。
2. A0 固定公共契约后再启动消费者。后续任务禁止改 contracts.ts、依赖清单或其他任务拥有的文件；变更通过协调者提交给原负责人。
3. 每个模块通过依赖注入接收其他模块，仅在自己的测试中使用符合契约的 fake；不另写一套同名公共类型或复制其他模块的实现。
4. 真实 BOSS 桌面只由协调者占用。开发 agent 不启动、控制 BOSS，不操作招聘账号；测试采用临时目录和合成夹具。
5. 每个 agent 提交自己的文件，报告 commit、执行过的测试、失败项、限制和接入说明。不能自行合并其他 agent 的分支或主分支。
6. 协调者逐项审查后按依赖顺序合并；发现问题派回原负责人修复。最终集成 agent 执行合并后的回归，协调者验收实际行为。
7. 原有六个 Swift 文件的未提交修改不属于本轮任务。保留原工作区和补丁快照，涉及相同文件时必须显式整合，不能覆盖或丢弃。

## 任务与文件所有权

| 任务 | 唯一负责范围 | 交付与独立验收 | 依赖 |
| --- | --- | --- | --- |
| P0 主协调者 | docs/boss-macos-baseline.md、docs/boss-macos-capabilities.md，本地实测证据 | 现有测试、窗口/页面/滚动/产物能力矩阵；阻断项明确 | 无 |
| A0 公共契约 | packages/task-runtime/package.json、package-lock.json、tsconfig.json、src/contracts.ts、tests/contracts.test.ts、docs/task-runtime-contracts.md | 类型、边界验证、模块 API、JSONL Bridge 协议、测试脚手架；全新安装可类型检查 | 无，与 P0 并行 |
| A1 桌面会话 | packages/task-runtime/src/session.ts、src/adapters/second-screen.ts、tests/session.test.ts、tests/second-screen.test.ts | CLI 注入、环境准备、会话租约、窗口重绑、快照过期、取消和明确错误；不加载模型 | A0 |
| A2 账本与产物 | packages/task-runtime/src/store.ts、src/artifacts.ts、tests/store.test.ts、tests/artifacts.test.ts | SQLite 事务、迁移、幂等、原子归档、恢复对账、身份/路径验证、不完整产物不计完成 | A0 |
| A3 流程学习 | packages/task-runtime/src/procedures.ts、src/learning.ts、src/recovery.ts、tests/procedures.test.ts、tests/learning.test.ts、tests/recovery.test.ts | 同批次 trial 回放、三次独立成功晋级、参数化、预算、局部修复、版本回滚；模型离线稳定回放 | A0 |
| A4 BOSS 采集 | agents/boss/src/resumes/**、packages/task-runtime/tests/boss-resumes.test.ts | 页面分类、候选人身份、列表进度、在线/附件分支、文件证据；不发送消息，能力缺失明确返回 | A0、P0 可用证据 |
| A5 Swift 探索桥接 | Sources/ScreenCLI/AgentBridge.swift、Sources/TarsAgent/Bridge.swift、Tests/TarsAgentTests/BridgeTests.swift、packages/task-runtime/src/adapters/agent-bridge.ts、tests/agent-bridge.test.ts | 复用现有 TarsAgent，结构化事件、已执行轨迹、预算/取消/进程退出；无双重执行 | A0 |
| A8 本地视觉 | Sources/ScreenCLI/LocalVision.swift、Sources/SecondScreenCore/LocalVision.swift、Tests/SecondScreenCoreTests/LocalVisionTests.swift、packages/task-runtime/src/adapters/local-vision.ts、tests/vision.test.ts | 本机 Vision OCR、图片比较、裁剪拼接；坐标与内存限制、完整性证据，不调用模型、不发送桌面输入 | A0 |
| A6 调度与恢复 | packages/task-runtime/src/runner.ts、src/daemon.ts、src/telemetry.ts、tests/runner.test.ts、tests/daemon.test.ts | 批次循环、状态机、暂停取消、等待用户、重启续跑、调用计量；20 位稳定夹具零模型调用 | A1–A5 |
| A7 产品入口与集成 | Sources/ScreenCLI/TaskCommand.swift、Sources/ScreenCLI/main.swift、MCP 接入文件、packages/task-runtime/src/cli.ts、src/index.ts、skills/boss-resumes/**、安装脚本和集成测试 | 一次命令创建任务，status/resume/cancel/artifacts 可用；Skill/MCP 接通，干净环境安装、旧功能回归 | A6 |

A7 的最终装配在 A6 验收后进行，可在协调者批准后修改依赖清单和公共装配文件。2026-10-04 起，A7 的入口准备（CLI 参数解析、Swift/MCP 注册、Skill 文件）提前作为独立准备任务，与 A6 并行；仍由同一个 A7 工作区独占相应文件。准备任务不实现假的运行器，不宣称端到端完成；A6 验收后同一负责人再接最终装配任务。A5/A8 不自行修改 main.swift；交付可调用入口，由 A7 统一注册。A4 复用旧 BOSS 解析器但不改旧聊天助手；共享会话租约的旧入口接入由 A7 统一完成。A7 启动前另由协调者检查 A8 已完成；运行记录中 A7 的原有依赖是 A6，这一新增条件由协调者执行。

A8 来自 P0 的实测发现：在线简历正文只暴露 AXImage，需要本地 OCR。A8 唯一获准在 contracts.ts 的 LocalVision 部分追加可选拼接接口并补对应测试，变更经协调者审核后通知 A4；不得修改其他契约。这一局部增量不阻塞 A1–A3。

2026-10-04 第二批协调补充：A5 可在 ExplorationRequest 与对应校验器中追加可选 usageContext（purpose/reason），并更新 Bridge 协议文档；测试放在 A5 的 agent-bridge.test.ts，不与 A8 的 contracts.test.ts 修改重叠。A6 接手后可在 recovery.ts 与 recovery.test.ts 中补充此字段的传递及首次学习/修复计量回归，除此之外不修改 A3 实现。两个契约增量均保持旧调用兼容。

执行持续至首版范围完成：每批交付后由协调者自动评审、派回修复、验证和合并，依赖满足即启动下一批，不在批次边界等待用户再次指示。第二批为 A4/A5/A8，之后 A6、A7，再做完整回归与真实场景验收。额度或环境阻塞必须明确记录，不能把等待当完成；恢复后接续剩余 DAG。

2026-10-04 12:10 调整：A7 准备任务已评审合并；最终任务先并行完成打包、旧入口租约接入与装配。A6 首次交付在审查中发现租约过期不能证明旧执行者退出等问题，已派回修复。A7 可在自己的分支合入 A6 临时提交以编译，但最终生命周期接线及集成验收仍以协调者接受的修订版本为准。A4 同时修复真实页面的栅格姓名识别，三个工作区继续互不编辑对方文件。

P0 又验证了岗位下拉箭头的显式 AXPress 路由。A4 当前姓名修复完成后，由单独后续任务负责该路由接入，可追加可选的点击方式契约，并独占相应 contracts 校验、SecondScreenAdapter、ControlProtocol/InputEngine/DriverCommands 和对应测试。A7 不编辑这些文件；主入口帮助文字仍由 A7 负责。默认点击行为保持兼容，显式辅助功能按压不允许静默回退为事件点击。该增量仅在后续任务正式派发后开始。

开发期间原主工作区被其他操作切换到 iphone-commands，并新增 4108e74 提交。集成工作区改为 /Users/kevinshi/orca/workspaces/2ndscreen/ss-runtime-integration，分支 szrunworld/ss-runtime-integration，以 4108e74 为基线合并已评审契约。后续成果在这里统一合并，原主工作区保持由用户使用。

## 执行波次

    P0 主协调者 ─────────────────────── 实际桌面验收
    A0 公共契约
         ↓
    A1 桌面会话 ║ A2 账本产物 ║ A3 流程学习
         ↓ 可用并发槽位继续启动
    A4 BOSS 采集 ║ A5 Swift 桥接 ║ A8 本地视觉
         ↓ 各模块均审查通过
    A6 调度恢复
         ↓
    A7 产品入口与集成
         ↓
    主协调者完整回归与真实验收

A1–A5、A8 在实现文件上正交；A4 的图片能力通过 LocalVision 注入。限制并发数量只控制资源，不增加代码依赖。P0 若发现登录、权限或必要后台操作缺口，纯逻辑模块仍可开发，真实 BOSS 交付保持未验收状态。

## 每个任务的完成报告

报告放在各工作区 docs/agent-reports/A编号.md，包含目标、实际修改文件、commit SHA、实际测试命令与结果、未验证项、依赖和已知限制。报告文件为该任务独占，不修改其他人的报告。

协调者审查顺序：检查文件归属和 diff → 核实测试覆盖失败路径 → 复跑相关测试 → 接口兼容检查 → 接受或派回修复 → 合并 → 记录合并后结果。worker_done 只表示该 agent 交付，不自动等于总体验收通过。
