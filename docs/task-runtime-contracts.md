# Task Runtime 公共契约

本文是 [实施规划](skill-runtime-boss-plan.md) 与 [并行任务拆解](parallel-agent-tasks.md) 的接口部分。所有类型、校验器与纯规则都在 `packages/task-runtime/src/contracts.ts`；本文规定每个模块文件**必须导出**的工厂签名、模块之间的约束，以及 Bridge 的 JSONL 协议。各模块只依赖 contracts.ts 和通过工厂参数注入的其他模块接口，不 import 其他负责人的实现文件。

契约版本 `CONTRACT_VERSION = 1`，Bridge 协议版本 `BRIDGE_PROTOCOL_VERSION = 1`。修改 contracts.ts 只能由 A0 负责人经协调者批准后进行。

## 包与工具链

| 项 | 规定 |
| --- | --- |
| 位置 | `packages/task-runtime/`，独立 npm 包 `@2ndscreen/task-runtime`，ESM |
| Node | `>=22.13.0`（`node:sqlite` 在此版本起无需 flag）；开发机实测 22.23.2 |
| 依赖 | 仅 devDependencies，精确版本：typescript 5.9.3、tsx 4.23.15、@types/node 22.20.5；package-lock.json 提交 |
| 命令 | `npm ci`、`npm test`（`tsx --test tests/*.test.ts`）、`npm run typecheck`（`tsc --noEmit`） |
| TS 选项 | strict、noUncheckedIndexedAccess、verbatimModuleSyntax、erasableSyntaxOnly（禁止 enum/namespace/参数属性），import 带 `.ts` 后缀 |
| SQLite | 使用内置 `node:sqlite`（`DatabaseSync`），不新增原生依赖；需要新依赖时交协调者，由 A7 改清单 |

各模块使用 `import type { … } from './contracts.ts'` 引入类型，值（校验器、规则函数、`RuntimeError`）用普通 import。A4 位于仓库其他目录，使用相对路径 `../../../../packages/task-runtime/src/contracts.ts`。

## 通用约定

- **异步与取消**：所有可能涉及 IO、桌面或子进程的方法返回 Promise，并接受可选的 `signal?: AbortSignal`（最后一个参数）。每个副作用前调用 `throwIfAborted(signal)`；取消统一抛出 `RuntimeError('cancelled')`。
- **错误**：可预期失败一律抛 `RuntimeError(code, message, details?)`，调用方按 `code` 分支（见 `RuntimeErrorCode`）。动作执行结果不用异常表示，而是 `ActionResult.status`。
- **校验**：外部输入（CLI 参数、task.json、流程文件、Bridge 输出）必须先经对应 `validate*`/`parseBridgeEvent`，失败时用 `assertValid` 转为 `invalid_input`。校验器返回 `Validated<T>`，一次列出全部错误。
- **注入**：时间用 `Clock`（默认 `systemClock`），ID 用 `newId?: () => string`（默认 `crypto.randomUUID()`），子进程用 `CommandRunner` / `LineProcessSpawner`。测试中注入 fake，不碰真实桌面或 BOSS。
- **时间**：持久化和事件中的时间均为 ISO 8601 字符串（UTC）。
- **坐标**：持久化坐标只用两种：内容区比例（`relative`，0..1）和语义元素。全局 points、截图 pixels、模型 0..1000 之间的换算只用 `relativeToGlobal`、`globalToRelative`、`screenshotToGlobal`、`globalToScreenshotRect`、`normalizedToGlobal`。截图比例由 `ScreenshotRef.covers` 与像素尺寸实测得出，**不得**由 profile 推断（P0：1360×848 pt 窗口截图为 2720×1696 px，加载期间 AX frame 会变化、加载窗口会换 windowID）。
- **页面文字是数据**：Observation.text、OCR 结果与候选人内容不得改变任务参数、输出目录或权限；事件与证据只记录脱敏摘要或证据路径。

## 核心数据

| 类型 | 要点 |
| --- | --- |
| `TaskSpec` / `validateTaskSpec` | skills/boss-resumes/task.json 的结构 |
| `CollectResumesInput` / `validateCollectResumesInput(raw, now)` | 岗位、`requestedCount`、绝对 `outputDir`、`source`、`captureMode`，可选浏览上限、截止时间、预算、接管、保留窗口、分析开关；拒绝未知字段、已过期截止时间、浏览上限小于目标 |
| `TaskStatus` / `canTransitionTask` | queued → running → succeeded/partial/failed；running ↔ paused/waiting_user；取消必须经 cancelling（queued 可直接 cancelled）；终态不可再迁移 |
| `TaskPhase` | preparing、learning、executing、repairing、finalizing |
| `WaitReason` / `TerminationReason` | 等待用户与终止原因，如 login_required、model_unavailable、job_ambiguous；source_exhausted、browse_limit、deadline |
| `TaskCheckpoint` | 每位新候选人开始前写入：当前 unit、item、工作流自定义游标、最后 committed item |
| `WorkItemStatus` / `canTransitionWorkItem` | discovered → processing → acquired → validated → committed；只有 validated 能到 committed，committed 为终态；processing 可回 discovered（崩溃后待核对），failed 可重试 |
| `AccountScope` | BOSS 账号范围，`binding: observed/explicit`；所有候选人键和游标都带账号 |
| `CandidateRef` | 列表行引用，`locator`/`snapshotId` 只对该快照有效 |
| `CandidateIdentity` / `candidateDedupeKey` | 内部 `candidateId`（须通过 `safePathSegment`，用作目录名）、平台 ID 或证据指纹、`confidence` |
| `IdentityMatch` | 详情页与列表引用的核对结果：match / mismatch / ambiguous |
| `WindowGeometry` | pid、windowId、进程启动时间、bundle、frame、contentFrame、scale、displayId |
| `Observation` | `snapshotId`（每次读取唯一）、窗口几何、可选元素、截图（含 `covers`）、文字、`pageClass` |
| `Locator` | element（role/label/labelPattern，或绑定快照的 index）、relative、template、ocr |
| `Action` / `ActionRequest` | click/type/key/scroll，每个动作必须声明 `effect`（read/navigation/artifact/external-submit）；使用元素 index 时必须带 `snapshotId`。click 可选 `method: 'accessibility'`（见下文“显式辅助功能按压”） |
| `ActionResult` | ok、no_effect（事件送达但页面未变，视为失败）、failed、stale_snapshot、unknown（结果不可知，external-submit 不得重发）；记录路由（`InputRoute`：element/coordinate/keyboard/accessibility）、坐标、前后快照、焦点是否变化 |
| `Condition` / `WaitSpec` / `CheckResult` | element/text/page/window/file/all/any，嵌套 ≤4 层；等待 1 ms – 120 s，轮询 50 ms – 5 s（`WAIT_LIMITS`） |
| `Budget` / `DEFAULT_BUDGET` / `checkBudget` | 每步本地恢复 2 次、每次修复 6 轮、每候选人 2 次模型修复、整任务调用数/token/墙钟上限 |
| `Usage` / `TokenCount` / `addTokens` | ui/repair/analysis 调用分开计；服务不报 token 时为 `'unknown'`，不得记 0，任一项 unknown 则合计为 unknown |
| `checkBudget` 与 unknown | 配置了 `taskTokens` 时，输入或输出 token 任一为 unknown 即返回 `exhausted: 'tokens'`（无法证明未超限，保守停止）；已知数值正常比较；未配置 token 上限时 unknown 允许继续，仍受调用数与墙钟上限约束。检查顺序：调用数 → token → 墙钟 |
| `ArtifactKind` / `ArtifactCompleteness` | original、captured_page、captured_image、resume_text、metadata、diagnostic；complete/partial_capture/unverified/invalid |
| `CaptureEvidence` / `captureCompleteness` | 只有 `topConfirmed`、`stop = bottom_confirmed` 且至少两种不同的底部信号时才是 complete；屏数上限、滚动无效、拼接缺口一律 partial_capture；连续相同截图本身不是底部信号 |
| `isCountable(artifacts, mode)` | available：complete 的 original 或 captured_image；original-only：只有 complete 的 original |
| `ProcedureV2` / `validateProcedure` | 见下文流程规则 |
| `leaseScopeKey` / `leaseScopesOverlap` | 租约 scope 为 `<bundleId>:<accountKey>`，账号未知时为 `<bundleId>:*`；同一 bundleId 的任意两个 scope 都视为重叠（`app:*` 与 `app:acct1`、`app:acct1` 与 `app:acct2` 均冲突），因为单实例应用同一时刻只能由一个会话操作 |
| `nextProcedureState` | 晋级与降级的唯一规则 |
| `ExplorationRequest` / `BridgeEvent` / `parseBridgeEvent` | 见 Bridge 协议 |

### 显式辅助功能按压（click `method: 'accessibility'`）

默认点击不变：不带 `method` 时由适配器选路（Web 内容走事件，原生可按压控件可能走 AXPress，路由报 element/coordinate）。只有逐个动作显式选择 `method: 'accessibility'` 时，才对**一个元素**执行 AXPress，并且只做这一件事：不移动指针、不改焦点、不发按键或事件，失败即失败，**不回退**。

- 校验（`validateAction`）：`method` 只能是 `'accessibility'`；目标必须是 `kind: 'element'`（index 绑定快照，或由 Session 在新读取上解析为唯一 index 的 role/label）；不得有 `button: 'right'`、`count: 2`、`modifiers`；relative/template/ocr 目标一律拒绝。
- Session 原样传递 `method`（语义定位器解析后仍保留）。
- SecondScreenAdapter：发送 `2ndscreen ax-press --screen … --pid … --window-id … --index N`（独立动词，不是 `click` 的选项：不认识它的旧 CLI 以 unknown command 退出，不会发出任何输入）。CLI 回报路由必须是 `ax.press.explicit`，结果 `route: 'accessibility'`；回报其他路由时结果为 `unknown` + `capability_missing`。旧 CLI（unknown command）、旧 side instance（bad request，无法解码）、元素不声明 AXPress 都归为 `capability_missing`。
- 原生：`InputAction.Kind.accessibilityPress` 是独立的线上枚举值，旧 app 解码即失败，在任何输入之前拒绝。InputEngine 只接受上一次 `window.state` 缓存快照中的 index（不重新读取、不按文字解析），元素必须声明 AXPress 且 AXPress 成功，路由 `ax.press.explicit`。
- 当前唯一使用者：BOSS 职位筛选箭头（P0 证实事件点击无效、AXPress 有效）。

## 模块文件与工厂签名

以下签名为约定的公共 API，实现者可以添加私有辅助函数，但不得改变这些名称、参数和返回类型。所有 `Deps` 中带 `?` 的项有默认值。

### A1 桌面会话

`packages/task-runtime/src/adapters/second-screen.ts`

```ts
export interface SecondScreenAdapterOptions {
  cli: string;                 // 2ndscreen 可执行文件
  socket: string;              // side instance 的控制 socket（SECONDSCREEN_SOCKET）
  app?: string;                // 用于启动 side instance 的 2ndscreen.app
  run: CommandRunner;
  screenshotDir: string;       // 截图存放目录，由调用方清理
  clock?: Clock;
  commandTimeoutMs?: number;   // 单条 CLI 命令上限，默认 15000
}
export function createSecondScreenAdapter(options: SecondScreenAdapterOptions): DesktopAdapter;
export function createCommandRunner(): CommandRunner;   // 基于 node:child_process.execFile，支持 signal 与超时
```

`packages/task-runtime/src/session.ts`

```ts
export interface SessionManagerDeps {
  adapter: DesktopAdapter;
  leases: LeaseStore;
  policy: { submitAllowed: boolean; foregroundAllowed: boolean };
  vision?: LocalVision;        // 解析 template/ocr 定位器；缺失时这类定位器返回 capability_missing
  clock?: Clock;
  newId?: () => string;
  ownerPid?: number;           // 默认 process.pid，应为长期 worker
  pollMs?: number;             // waitFor 默认轮询间隔
}
export function createSessionManager(deps: SessionManagerDeps): SessionManager;
```

要求：Session 用 `leaseScopeKey(profile.bundleId, account?.accountKey)` 申请租约，账号确认后可续期但不得另开第二个租约；Session 是唯一解析 Locator 并调用 `adapter.act` 的地方；`act` 对过期快照返回 `stale_snapshot`，对不允许的 external-submit 抛 `forbidden_effect`，在 `withExclusiveActor` 期间抛 `actor_busy`；`waitFor` 必须遵守 `WaitSpec` 上限；`rebind` 核对 bundle、进程启动时间和窗口归属，不凭历史 PID；模块不加载任何模型。

### A2 账本与产物

`packages/task-runtime/src/store.ts`

```ts
export const TASK_STORE_SCHEMA_VERSION: number;
export function defaultTaskDbPath(home?: string): string;
// ~/Library/Application Support/2ndscreen/tasks/tasks.db
export function openTaskStore(options: {
  path: string;                // ':memory:' 用于测试
  clock?: Clock;
  newId?: () => string;
}): Promise<TaskStore>;
```

要求：用 `node:sqlite`；迁移前备份、拒绝读取更高版本 schema；`transitionTask`/`transitionWorkItem` 用契约中的迁移表校验，非法迁移抛 `conflict`；`upsertWorkItem` 按 `candidateDedupeKey` 在任务内幂等；`commitItem` 在一个事务内写 artifact 并按 `isCountable` 决定 committed 或 failed（不计数的产物保留为诊断）；`counts` 由 work item 实时计算；`acquireLease` 对任何与请求 scope 按 `leaseScopesOverlap` 重叠的未过期租约抛 `lease_held`（不只是 scope 字符串相等），检查与插入在同一事务内；同时实现 `ProcedureRepository`，同一 (key, version) 重复插入抛 `conflict`。

`packages/task-runtime/src/artifacts.ts`

```ts
export function createArtifactStore(options: {
  outputDir: string;           // CollectResumesInput.outputDir
  taskId: string;              // 根目录为 <outputDir>/<taskId>
  clock?: Clock;
  newId?: () => string;
}): ArtifactStore;
```

要求：staging 在输出文件系统上且每次尝试唯一；`validate` 检查存在、大小稳定、无临时下载后缀、文件头类型、PDF 页数、哈希；`archive` 用同文件系统 rename 写入 `candidates/<candidateId>/{original,captured/pages,captured/resume.png,resume.txt,metadata.json}`，拒绝不通过 `safePathSegment` 的 ID 与解析后越出根目录的路径；`reconcile` 处理“已归档未入库”“已入库文件缺失”“残留 staging”三种情况；`writeIndex` 输出 manifest.json、index.csv、failures.json，可完全由账本重建。

### A3 流程、学习与恢复

`packages/task-runtime/src/procedures.ts`

```ts
export function createProcedureEngine(deps: {
  repository: ProcedureRepository;
  rule?: PromotionRule;        // 默认 DEFAULT_PROMOTION，Skill 的 learning.promoteAfterSuccesses 覆盖
  telemetry?: TelemetryRecorder;
  clock?: Clock;
  newId?: () => string;
}): ProcedureEngine;
export function importV1Procedure(v1: unknown, key: ProcedureKey, now: Date): ProcedureV2 | undefined;
// 只导入已命名控件步骤，结果为 seeded，缺前后条件时不得标 stable；不写回 ~/.config/2ndscreen/procedures
```

`packages/task-runtime/src/learning.ts`

```ts
export function createLearner(deps: {
  repository: ProcedureRepository;
  clock?: Clock;
  newId?: () => string;
}): Learner;
```

`packages/task-runtime/src/recovery.ts`

```ts
export function createRecovery(deps: {
  engine: ProcedureEngine;
  learner: Learner;
  explorer: ExplorerProvider;  // 惰性；只在本地恢复耗尽后调用
  telemetry: TelemetryRecorder;
  clock?: Clock;
  newId?: () => string;
}): Recovery;
```

要求：`createProcedureEngine` 的依赖里没有模型或探索器，稳定回放不可能初始化模型；`select` 顺序 stable > trial > seeded，跳过 degraded/retired；回放每步按 `bindSlots` 绑定参数，存储的流程不得含元素 index；恢复顺序为等待稳定 → 重新观察/定位 → 已验证的本地流程 → `explorer()` 修复，并遵守 `Budget`；`explorer()` 抛 `model_unavailable` 时返回 `{ status: 'model_unavailable' }`；回滚通过插入新版本实现，旧版本定义永不改写。

### A4 BOSS 采集

`agents/boss/src/resumes/workflow.ts`（同目录可另建 pages.ts、candidates.ts、capture.ts、validators.ts）

```ts
export function createBossResumesWorkflow(deps: {
  vision?: LocalVision;        // 在线简历正文是单个 AXImage，文字与滚动进度需要本地 OCR/比较
  telemetry?: TelemetryRecorder;
  clock?: Clock;
}): BossWorkflow;
```

要求：`units` 覆盖 `BOSS_UNITS` 全部八个单元，persist_candidate 的 `allowedEffects` 为 `['artifact']`，任何单元不得包含 external-submit；`acquireResume` 只写入 `context.staging`，遇索取简历确认框返回 `unavailable / request_dialog` 且不点击确认；在线采集的完整性必须用 `captureCompleteness` 判定；未注入 vision 时需要 OCR 的分支返回失败原因而不是猜测；`verifyUnit` 是唯一的成功证据来源，模型的 finished 不算；测试位于 `packages/task-runtime/tests/boss-resumes.test.ts`，只用合成夹具。

### A5 探索桥接

`packages/task-runtime/src/adapters/agent-bridge.ts`

```ts
export function createAgentBridge(options: {
  cli: string;                 // 2ndscreen 可执行文件，子命令见下文
  spawn: LineProcessSpawner;
  env?: Record<string, string>;
  killGraceMs?: number;        // SIGTERM 后等待退出的时长，默认 3000，之后 SIGKILL
  clock?: Clock;
}): ExplorerBridge;
export function createLineProcessSpawner(): LineProcessSpawner;   // 基于 node:child_process.spawn
```

Swift 侧：`Sources/TarsAgent/Bridge.swift` 与 `Sources/ScreenCLI/AgentBridge.swift` 提供可调用入口，子命令名暂定 `2ndscreen agent-bridge`，由 A7 在 main.swift 注册。

### A6 调度与恢复

`packages/task-runtime/src/telemetry.ts`

```ts
export function createTelemetry(clock?: Clock): TelemetryRecorder;
```

`packages/task-runtime/src/runner.ts`

```ts
export interface TaskRunnerDeps {
  store: TaskStore;
  sessions: SessionManager;
  artifacts: (task: TaskRecord) => ArtifactStore;
  engine: ProcedureEngine;
  learner: Learner;
  recovery: Recovery;
  workflow: BossWorkflow;
  spec: TaskSpec;
  profile: WindowProfile;
  telemetry: (taskId: string) => TelemetryRecorder;
  clock?: Clock;
  newId?: () => string;
}
export function createTaskRunner(deps: TaskRunnerDeps): TaskRunner;
```

`packages/task-runtime/src/daemon.ts`

```ts
export function createTaskDaemon(deps: {
  store: TaskStore;
  runner: TaskRunner;
  specs: (skillId: string) => TaskSpec | undefined;
  clock?: Clock;
}): TaskControl & { shutdown(): Promise<void> };
```

要求：TaskControl 每个方法只做短事务，不等待 GUI；cancel 先置 cancelling，确认动作执行者退出后置 cancelled；启动时把租约过期的 running 任务转为可恢复状态，不报告成功。

### A7 产品入口

`packages/task-runtime/src/cli.ts`

```ts
export function runCli(argv: readonly string[], io: CliIO, control: TaskControl): Promise<number>;
// 子命令为 CliCommand：run status pause resume cancel artifacts inspect-procedure；输出单行 JSON；返回进程退出码
```

`packages/task-runtime/src/index.ts`：重新导出 contracts.ts 并提供装配函数（签名由 A7 定，需经协调者审核）。

### A8 本地视觉（协调者新增）

`packages/task-runtime/src/adapters/local-vision.ts`

```ts
export function createLocalVision(options: {
  helper: string;              // 原生 macOS Vision 辅助程序路径
  spawn: LineProcessSpawner;
}): LocalVision;
```

要求：只读取已有图片，不截图、不发送输入、不调用模型；`roi` 与返回框均为图片像素；`compare` 给出相似度与竖直位移，供滚动进度和底部检查使用；未实现 `findTemplate` 时 template 定位器报 `capability_missing`。

可选 `compose`（A8 追加，经协调者批准）：`compose(framePaths, outputPath, { roi?, minOverlapPx? }, signal)` 把同一滚动区域的多屏截图自上而下拼成一张 PNG，返回 `ComposedImage`（尺寸、sha256、每帧 `first/placed/duplicate/gap` 及其输出行、`hasGap`）。每帧只在与上一帧有已验证的重叠（默认 ≥48 行、有纹理、无歧义，且重叠区逐行一致）时追加新行；只有在有纹理内容上证明未移动且未变化的帧才是 duplicate；其余帧（包括完全相同的空白帧或重复内容帧、重叠区有局部变化的帧）一律整帧追加并标 gap，`hasGap = true`，调用方应记 `CaptureEvidence.stop = 'stitch_gap'`。像素相同本身不证明连续。`outputPath` 必须是绝对 `.png` 路径、父目录存在、文件不存在；输出整张写入或完全不写。单帧加 roi 即裁剪。拼接干净不等于采集完整，完整性仍只由 `captureCompleteness` 判定；连续相同截图只是“无进展”。

Swift 侧：`Sources/SecondScreenCore/LocalVision.swift`（实现与协议）、`Sources/ScreenCLI/LocalVision.swift` 提供 `runLocalVision(args)`，由 A7 在 main.swift 的帮助检查之前注册为 `2ndscreen vision`。协议为 stdin 一行请求、stdout 一行回复，退出码 0 成功、1 失败、2 请求无效。上限：每个输入文件 ≤64 MB、单边 ≤16384 px、≤64M 像素，拼接 ≤64 帧、输出 ≤60M 像素。

## 单元执行顺序（A6 实现，A3/A4/A5 遵守）

对每个工作单元：

1. 记录检查点；`engine.select(key)` 找到可运行流程则 `engine.replay`（无模型），成功后 `workflow.verifyUnit` 复核，通过则 `engine.recordOutcome(ok)` 并计 `replayedUnits`。
2. 无流程而工作流有确定路径时，执行 `workflow.runScripted`，同样复核。
3. 回放失败、无流程或复核失败时调用 `recovery.recover`。只有本地恢复耗尽才会调用 `ExplorerProvider`；返回 `model_unavailable` 时任务进入 `waiting_user / model_unavailable`（或按策略将该项标 unavailable 继续），已稳定的单元继续回放。
4. Bridge 探索成功后，Runtime 用 `verifyUnit` 独立验证，再 `learner.propose` + `learner.accept` 保存 trial 版本；**不得再次执行** `ExplorationOutcome.executed` 中的任何动作。
5. 身份关键点每次检查：`open_candidate` 后 `workflow.identify` 必须为 match 才能继续；mismatch/ambiguous 将 item 置 ambiguous。
6. 归档顺序：`artifacts.stage` → `workflow.acquireResume` → `artifacts.validate` → `artifacts.archive` → `store.commitItem` → `artifacts.writeIndex`。只有 `commitItem` 返回 `counted: true` 才计成功。提交后返回列表失败不撤销 committed，阶段转 repairing。
7. 每次模型调用都要产生 `TelemetryEvent.model_call` 并带原因；稳定批次无异常时 `uiModelCalls` 必须为 0。

终止判定：committed 达到 requestedCount → succeeded / target_reached；来源耗尽、浏览上限、截止时间、预算耗尽而数量不足 → partial 并写明原因；取消 → cancelled。

## 流程 V2 规则

- 一个 `ProcedureKey`（skill、skillVersion、unit、platform、appVersion、profile、branch）下多个版本，`version` 递增，`parentVersion` 记修复来源。不同 key 不共享计数。
- 状态：seeded →（首次验证成功）trial →（`promoteAfterSuccesses` 个**不同** work item **连续**成功，其间无失败）stable。`counters.successItemIds` 是当前连胜内的不同 item；同一 item 重复成功只增加 successes，不推进晋级。
- 任何一次失败（即使低于降级阈值）都会清空 `successItemIds`，晋级须重新累积；`successes`/`failures` 为累计值，仅用于审计。
- 连续失败达到 `degradeAfterFailures`（默认 1）进入 degraded，不再被 select；修复产生新的 trial 版本，旧 stable 保留，可经 `rollback` 重新作为新版本启用。retired 不变。
- 存储的步骤不得使用元素 index（只能 role/label/labelPattern、relative、template、ocr）；步骤中的 `{{slot}}` 必须在 `parameters` 中声明；不允许 external-submit 时含该效果的流程不合法；非种子的 stable 必须有验证成功记录（`successes > 0`；stable 版本在低于阈值的失败后连胜可为空）。
- 版本定义写入后不可修改，`updateProcedureState` 只改 status、counters、updatedAt。V2 只由 Runtime 写入；Bridge 只输出提案。

## Bridge JSONL 协议

进程：`<cli> agent-bridge`，环境变量 `SECONDSCREEN_SOCKET` 指向会话 socket。Runtime 在持有 `Session.withExclusiveActor('bridge', …)` 的授权期间启动它。

1. Runtime 向 stdin 写入**一行** `ExplorationRequest`（`encodeJsonLine`），随后关闭 stdin。Bridge 先校验请求，不合法则输出 `unit_failed / error` 并以退出码 2 结束。
2. Bridge 向 stdout 每行输出一个 `BridgeEvent`，stderr 仅用于日志。每个事件带 `v`、`taskId`、`unitAttemptId`、`at`，与步骤相关的带 `stepId`。
   - `observed`：快照 ID、窗口几何、可选页面类别。
   - `action_started` / `action_finished`：同一 `stepId` 成对出现；动作必须在单元 `allowedEffects` 内，external-submit 一律拒绝。
   - `model_usage`：每次模型调用一条，含 purpose、reason、token（不可知为 `"unknown"`）。purpose/reason 取自请求的可选字段 `usageContext`（Runtime 发起修复时应填 `repair` 与对应原因）；请求未带时兼容默认为 `ui` / `missing_procedure`。
   - 最后一行必须是 `unit_finished`（含步骤数、可选流程提案）或 `unit_failed`（budget_exhausted、model_unavailable、cancelled、timeout、forbidden_effect、error）。
3. 退出码：0 finished，1 failed，2 请求无效。
4. Runtime 用 `parseBridgeEvent(line, { taskId, unitAttemptId })` 解析每行；不合法的行使本次探索失败（`error`），并终止子进程。
5. `ExplorationOutcome.executed` 只由 `action_finished` 组成，`executedBy: 'bridge'`；只有 `action_started` 没有 `action_finished` 的步骤记为结果 `unknown`，同样计入已执行，不得重发。token 用 `addTokens` 累计。
6. 取消与超时：abort 或超过 `budget.timeoutMs` 时发送 SIGTERM，Bridge 在当前动作结束后输出 `unit_failed / cancelled` 并退出；`killGraceMs` 后仍未退出则 SIGKILL。`explore` 只在确认子进程退出之后才 resolve，此后会话才收回动作权。进程无终止事件即退出时结果为 failed / error。
7. 无模型配置时，Bridge 立即输出 `unit_failed / model_unavailable` 并以 1 退出；Runtime 的 `ExplorerProvider` 也可在启动进程前直接抛 `model_unavailable`。

示例：

```json
{"v":1,"taskId":"t1","unitAttemptId":"u1","session":{"socket":"/Users/x/Library/Caches/2ndscreen/boss.sock","screenId":"boss","pid":4242,"windowId":77},"unit":{"name":"open_resume","goal":"打开 {{candidate.name}} 的在线简历","allowedEffects":["read","navigation"],"expectedPostconditions":[{"kind":"page","pageClass":"online_resume"}]},"parameters":{"candidate.name":"张三"},"budget":{"maxRounds":6,"timeoutMs":120000},"submitAllowed":false}
{"v":1,"taskId":"t1","unitAttemptId":"u1","at":"2026-10-04T08:00:01Z","type":"model_usage","purpose":"ui","reason":"missing_procedure","inputTokens":1200,"outputTokens":"unknown"}
{"v":1,"taskId":"t1","unitAttemptId":"u1","at":"2026-10-04T08:00:02Z","type":"action_finished","stepId":"st1","action":{"kind":"click","target":{"kind":"element","role":"AXButton","label":"在线简历"},"effect":"navigation"},"result":{"actionId":"st1","status":"ok","route":"element","startedAt":"2026-10-04T08:00:01Z","finishedAt":"2026-10-04T08:00:02Z"}}
{"v":1,"taskId":"t1","unitAttemptId":"u1","at":"2026-10-04T08:00:03Z","type":"unit_finished","steps":1}
```

## 安全边界

- 首版 `submitAllowed=false`、`foregroundAllowed=false`：契约层校验器拒绝 external-submit 动作、流程和探索请求；不发送任何消息、不点击索取简历确认。
- 开发 agent 的测试只用临时目录与合成夹具，不启动或控制 BOSS，不访问生产账号。
- 无模型时，稳定流程照常运行；需要探索的单元给出 `model_unavailable`，不伪装成功。
- 不完整的采集保存为诊断产物，从不计入成功数量；数量不足以 partial 结束并写明终止原因。
