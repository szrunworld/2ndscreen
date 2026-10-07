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

**通用启动（C01a）。** 业务包（skills 目录下带 task.json 的包）是显式的业务注册，不是 runtime 启动的前提：

- 默认 skills 目录不存在或没有任何包，runtime 以零业务启动：控制客户端、worker、agent 宿主都正常工作，只是没有可提交的 skill。
- `SECONDSCREEN_SKILLS_DIR` 显式指定的目录不存在、不可读，或某个包的 task.json 损坏、profile 不符，都是 `invalid_input` 错误；包里的 workflow 没有在本构建注册则是 `capability_missing`，错误信息列出已注册的 workflow。
- workflow 由 `workflows.ts` 的注册表提供，只为已安装并声明它的包构造；通用启动流程不会主动创建任何业务 workflow、runner 或业务会话。本包仍携带的 BOSS workflow 通过 `legacyWorkflows()` 显式选入（C01b 把它移出通用构建）。
- 账本里属于本 runtime 未安装的包的任务保持原状：不认领、不失败，控制事件 `skill_missing` 记录一次原因；装有该包的 worker 可以继续运行它。
- CLI 只在用户显式设置了 `SECONDSCREEN_SKILLS_DIR` 时才把它传给 worker；否则 worker 按自己的入口位置解析同一个默认目录。

**通用构建（C01b，第一步）。** `scripts/build.mjs --generic`（`install-task-runtime.sh … --generic`）产出不含任何 `src/boss` 模块（BOSS 页面 workflow 与解析器）、不带 skills 目录的 runtime；构建固定 `absWorkingDir` 后用 esbuild metafile 核对依赖图，仍触及业务模块即失败，静态导入业务模块的符号也会失败；`build.json` 记录 `variant`、全部输入模块和被替换的业务 import。`--legacy`（默认）保持 2ndscreen.app 现在的打包方式；两个变体参数互斥，安装脚本在下载和构建前就拒绝。`tests/generic-build.test.ts` 覆盖多个工作目录、嵌套业务模块、绕过插件的模块、参数冲突，并用真实构建产物启动 worker、宿主空的 agent 配置、查询并停止。

**尚未完成的 C01 部分。** 通用产物仍编入旧 skill runner（`runner.ts` 的候选人遍历与 `platform === 'boss'` 账号校验）和简历清单导出（`artifacts.ts`）：它们经公共 bootstrap 对 runner 与 artifact store 的引用进入 bundle。「通用发行物不含 BOSS 生产实现」要等这部分外置后才成立。

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

## Agent 包与 Agent JSONL 协议（RFC 0001，P1 进行中）

`packages/task-runtime/src/agent-contracts.ts`，只含类型、校验器与纯规则，依赖本文件之外的只有 `contracts.ts`。设计依据 `docs/rfc/0001-agent-hub/README.md` 第四、五、七节；Runtime 侧的执行体宿主、排程器与检查链在后续 P1 变更中落地，只接受这些校验器放行的内容。

| 项 | 规定 |
| --- | --- |
| `AgentSpec` / `validateAgentSpec` | `agent.json`，`schemaVersion: 2`。未知字段、重复的 bundleId、未声明 effect 上的 `limits` 或 `approval`、声明了 external-submit 却没有 `approval.external-submit`、`resident` 没有 `schedule` 或用 `builtin` 执行体、执行体命令指向包外，一律报错，一次列全 |
| `agentSpecFromTaskSpec` | `task.json`（schemaVersion 1）读成 agent：单应用、`mode: task`、`builtin` 执行体、effects 不含 external-submit。现有技能包继续经它加载 |
| `parseVersionRange` / `satisfiesRange` | 范围是空格分隔、全部成立的比较子（`>=2 <3`、`=1.7.4`，裸版本即 `=`），最多三段数字，缺段为 0，预发布标签忽略。`runtimeContract` 对 `AGENT_RUNTIME_CONTRACT_VERSION`（`2.0.0`）判断，`applications[].versions` 对实际应用版本判断，不满足即 `capability_missing` |
| `ApprovalMode` / `stricterApproval` | `trusted_within_ceiling` < `human_in_the_loop` < `locked_down`，各级设置取更严者 |
| `Grant` | `(agentId, application, accountKey, effect)` 加 `mode`；`durable: false` 时必须有 `expiresAt` |
| `ActionRefusalReason` / `NextStep` / `ApprovalHint` | 检查链拒绝的结构化原因与机器可读的下一步；`deny` 的 `guidance.hints` |
| `AgentMessage` / `parseAgentMessage` | agent → Runtime 的 15 种消息。每条带 `v: 1`、`agentRunId`、严格递增的 `seq`、`at`；`observe` / `act` / `wait` / `ask_approval` / `ask_user` / `item` / `artifact` / `unit_*` / `task_finished` / `task_failed` 必须带 `taskId`，`create_task` / `heartbeat` / `agent_stopped` 属于整次运行。`act` 只查形状（含 `effect` 必填），effect 是否声明、是否授权、是否超限由 Runtime 的检查链判断，不在解析器 |
| `RuntimeMessage` / `parseRuntimeMessage` | Runtime → agent 的 12 种消息，同样的基础规则；`action_result` 恰带 `result` 或 `refusal` 之一；其他语言写的 agent 用同一套规则校验输入 |

与 Bridge JSONL 的关系：共用 `Observation`、`Action`、`ActionResult`、`WaitSpec`、`Locator` 等类型与 `validateAction`、`validateWaitSpec`；Bridge 是 Runtime 给单元目标、子进程自己执行，Agent 协议是子进程给每一步、Runtime 执行。两者并存，Bridge 不改。

### Agent 宿主（`agent-host.ts`）

`runAgentTask(options)` 跑一个 `mode: task` 的 process agent 的一个任务，返回 `AgentTaskOutcome`；只在无法启动时抛 `invalid_input` / `capability_missing`，agent 做的任何事都写进结果。它在 agent 进程确认退出之后才返回。

| 规则 | 说明 |
| --- | --- |
| 启动 | 命令按 `agentCommand` 在包内解析，越出包根即拒绝；`executor.runtime.bundled: false` 时用 `interpreters[kind]` 启动。子进程用 `createLineProcessSpawner({ inheritEnv: false })`，环境只有 `PATH`、`HOME`、`LANG`、`LC_ALL`、`TMPDIR`、`USER`、`TZ` 与 `AGENT_DESKTOP`、`AGENT_DESKTOP_RUN_ID`、`AGENT_DESKTOP_AGENT_ID`、`AGENT_DESKTOP_PROTOCOL`；不传 2ndscreen socket、不传任何 key |
| 会话 | 调用方为清单里每个应用开好一个 `Session`；`observe` / `act` / `wait` 都经这些会话执行，agent 进程不碰桌面 |
| 检查链 | `checkAction` 纯函数，固定顺序：应用与 effect 已声明 → 授权（external-submit；`findGrant` 按 agent、应用、账号、effect 匹配，过期即 `grant_expired`）→ 限额（`effectiveLimit` 取硬上限、组织、用户、清单中最紧的；「每天」是滚动 24 小时；按应用与账号跨 agent 计数）→ 工作时段 → 快照 → 结果不明的目标 → 审批（清单、授权、组织/用户下限三者取最严；`human_in_the_loop` 要求 act 带一个已批准、未用过、effect 与目标相符的 `approvalId`，用一次即作废） |
| 硬上限 | `HARD_LIMITS`：external-submit 每 24 小时 20 次、间隔至少 45 秒 |
| 确认动作 | act 可带 `confirms: <requestId>`，表示它是前一次外发打开的确认框里的“确定”。被确认的那次须在同一任务、同一应用、同一 target、已放行且结果 ok、60 秒内、尚未被确认过；满足时这次算同一次使用：不再要审批，不再计入上限与间隔，不再记入限额账本，审计里带 `confirms`。不满足时按普通外发检查 |
| 结果不明 | external-submit 返回 `unknown`，或投递中被取消、超时，记该 `target`（没给 target 记整个任务）；之后同一目标的 external-submit 一律 `target_unknown_result` |
| 审批 | `ask_approval` 交给注入的 `Approver`，附 Runtime 算出的 `consequences`（24 小时内已用、剩余、距上次、目标是否有过不明结果、是否在时段内）；没有 `Approver` 时一律拒绝 |
| Provider | 只放行清单声明的 provider 与用途；没有注入 `ProviderService` 时回 `provider_unavailable` |
| 审计 | 每个 external-submit 的放行与拒绝都以 `audit` 事件发出 |
| 结束 | `task_finished` 后关 stdin，agent 应自行退出，5 秒不退则停掉；取消与超时先发 `cancel`，`killGraceMs` 后 SIGTERM，再一个 `killGraceMs` 后 SIGKILL。不合法的行、别的任务的消息、未声明应用上的 observe/wait、task 模式下的 `create_task` / `agent_stopped`，都以 `protocol` 失败结束 |

尚未覆盖：常驻模式与排程、输入按 `inputSchema` 校验、组织档案。

### 运行状态、提问与用量（`agent-status.ts`、`agent-ledgers.ts`）

| 项 | 规定 |
| --- | --- |
| `StatusBoard` / `createStatusBoard` | 每次运行一条 `AgentRunEntry`。`reportAgent(runId, seq, state)` 只接受比上次更大的 `seq`；`activity` 让有动作的运行显示为 working；`block` / `unblock` 记未决的审批与提问，最早的一个显示在 `blockedOn`，agent 的心跳盖不掉它；`finish` 之后不再变化。`waitFor` 只认指定运行，已在目标状态立即返回，取消或运行以别的状态结束时拒绝 |
| 状态文件 | `createFileStatusPersister(path)` 每次变化原子写入快照（0600）；`readStatusFile` 读取，文件不存在时为空列表。持久化失败不影响 agent |
| `formatAgentList` | 卡住的在最前，一行一条：标记、状态、agent、任务、在等什么或最近摘要、多久了 |
| 宿主接入 | `runAgentTask` 的 `status` 选项：启动登记、有动作即 working、审批与带 `questionId` 的提问期间 blocked、结束 done 或 failed |
| 提问 | `ask_user` 带 `questionId` 时交给 `asker`，回 `user_answer`；回答不在 `choices` 内重问，最多三次；同一 `questionId` 问两次是协议错误；没有 `asker` 时保持 blocked 到取消或超时。不带 `questionId` 只是提示，阻塞到下一条消息 |
| `createFileEffectLedger` | 限额计数落盘（JSONL，0600）。读到无法解析的记录即报 `io`，不计数就不放行。崩溃留下的未写完尾行在下次追加前截掉；被截掉的那次与「发出后未及记账就崩溃」一样不计 |
| Provider 用量 | `ProviderUsageRecord`：每次真正发出的调用一条，未声明的 provider 与用途不调用也不记。`createFileUsageLedger` 读到坏行跳过并计数。`summarizeUsage(records, by, prices)` 按 agent / provider / model / task 汇总，token 用 `addTokens`（未知不当 0），成本按币种分别相加，算不出的单独计 `uncosted` |
| 路径 | `agentDataPaths(tasksDir)`：`<tasksDir>/agents/` 下 `status.json`、`effects.jsonl`、`provider-usage.jsonl`、`prices.json`；`prepareAgentDataDir` 建目录并收紧为 0700 |
| 命令行 | `2ndscreen task agents [--all]`、`2ndscreen task usage [--by …] [--since …]`，MCP `task_agents`、`task_usage`。只读文件，不需要 worker |

### 常驻 agent（`startResidentAgent`）

`startResidentAgent(options)` 立即返回句柄 `{ submit, stop, currentRunId, done }`，在后台按工作时段维持一个 `mode: resident` 的 process agent。只在无法启动时同步抛 `invalid_input` / `capability_missing`。

| 规则 | 说明 |
| --- | --- |
| 工作时段 | `workHours` 为假时不启动进程，每 `workHoursPollMs`（默认 60 秒）看一次；进程运行中时段结束，先发 `stop`，`killGraceMs` 后 SIGTERM，再一个 `killGraceMs` 后 SIGKILL，本次运行记为 `work_hours`，不算故障 |
| 心跳 | 超过 `heartbeatTimeoutMs`（默认清单 `idlePollSeconds` 的两倍）没有任何一行，判为失联，不再礼貌询问，直接 SIGTERM 与 SIGKILL |
| 重启 | 崩溃、失联、协议违规、自行退出都算一次故障；按 `restartDelaysMs`（默认 2、10、30 秒，末项重复）等待后重启；同一段工作时段内故障超过 `maxRestarts`（默认 3）即放弃，`done` 以 `gave_up` 结束 |
| 任务 | agent 用 `create_task` 自己建任务（`createTask` 回调决定编号，默认新编号）；Runtime 用 `submit` 派任务，进程在时立即发 `task_start`，不在时排队到下次启动。每个任务恰好一次 `onTaskEnded`：agent 报告的结果，或 agent 被停止、被放弃时以 `cancelled` / `exited` 失败 |
| 续做 | 进程结束时未完成的任务带到下一个进程：`agent_start.resume.tasks` 列出它们，并重新发送带原输入的 `task_start`；已有的动作、条目、产物记录保留 |
| 结果不明 | 结果不明的外发目标在整个常驻生命周期内共享，重启后的进程同样不能再次外发 |
| 状态面板 | 每个进程一次运行一条；正常停止（时段结束、被要求停止）记为 done，其余记为 failed 并写明原因 |
| 停止 | `stop()` 或 `signal` 停止后不再接受 `submit`；放弃之后同样不再接受 |

### 单元服务 `run_unit`（`agent-units.ts`）

把 runner 给内置技能做的事，作为协议服务提供给任何 agent：agent 用后置条件描述一个单元要达到的界面状态，runtime 负责达到并验证。

| 项 | 规定 |
| --- | --- |
| 消息 | agent 发 `run_unit { taskId, requestId, app, unit: { name, goal, allowedEffects, postconditions, preconditions?, learnable?, timeoutMs? }, bindings?, itemId? }`；runtime 回 `unit_result`：成功带 `route`（verified / replay / recovered / repaired）、新观察、检查结果和流程（id、版本、状态）；失败带原因（not_offered、invalid_unit、forbidden_effect、unrecovered、model_unavailable、budget_exhausted、not_learnable、cancelled、error）与说明 |
| 校验 | `unitProblems`：名字小写加下划线；效果只能是 read / navigation / artifact，且必须是清单声明过的；含 external-submit 一律 `forbidden_effect`（外发只走 act 与检查链）；后置条件 1 到 16 条，不得检查文件，不得用页面分类（那是内置技能的分类器）。后置条件里可以写 `{{slot}}`，用 bindings 的值检查，存下的流程保留槽位 |
| 顺序 | 先看单元是否已经完成（不发任何动作）；再回放本 agent 学到的流程；失败后走恢复：本地路线（等待、重新定位、另一个本地流程），再走探索桥（模型），受任务预算与每项修复次数约束。每一步都由 runtime 在新观察上检查后置条件，模型说完成不算 |
| 学习 | 流程键 `agent:<agentId>` + agent 版本 + 单元名 + 应用版本 + 窗口配置；不与其他 agent、版本、窗口配置共享。探索走通的路径存为 trial，在不同 `itemId` 上验证成功累计到阈值（默认 3）后为 stable；回放失败即降级。整段等于某个绑定值的短文本（如按键“7”对应 digit=7）也变成槽位 |
| 记账 | 单元里的模型调用按 agent、任务记入 provider 用量，providerId `runtime.exploration`，用途 repair；状态看板有 unit started / finished 事件 |
| 托管 | worker 托管 agent 时提供该服务（流程、学习、恢复与技能任务共用 tasks.db）；探索桥进程经 worker 的 actor 记录启动。未提供时答 `not_offered` |



托管 agent 的进程没有界面，审批与提问经文件跨进程交给人。

| 项 | 规定 |
| --- | --- |
| 位置 | `<tasksDir>/agents/inbox/pending/<id>.json`（宿主写）与 `answers/<id>.json`（人写），目录 0700，文件 0600，原子写入 |
| `createInboxApprover` / `createInboxAsker` | 实现宿主的 `Approver` / `Asker`：写入待办，按 `pollMs`（默认 500 ms）等答复，拿到后删除两份文件；放弃等待（取消、超时）也删除 |
| `decide(paths, id, answer)` | 种类必须相符；回答必须是所给选项之一；拒绝提示必须是已知提示；每项只能决定一次，已决定的再决定为 `conflict`，不存在的为 `not_found` |
| `listInbox` / `formatInbox` | 最早的在前；审批一行同时列出 Runtime 算出的后果（今日已用与剩余、距上次、该目标是否有过不明结果、是否在时段内），不只是 agent 的说法 |
| 命令行与 MCP | `2ndscreen task inbox`、`approve INBOX_ID`、`deny INBOX_ID [--hint …]… [--text …]`、`answer INBOX_ID TEXT`；MCP `task_inbox`、`task_approve`、`task_deny`、`task_answer` |

### Agent 宿主（`agent-daemon.ts`、`agent-hosting.ts`、`agent-config.ts`、`agent-providers.ts`）

后台只有一个进程：持有任务账本守护租约的 worker（`worker.mjs`）同时托管 agent，维持 `<tasksDir>/agents/config.json` 里启用的常驻 agent，并运行提交给任务型 agent 的任务。`2ndscreen task host start|stop|status` 启停，MCP `task_host`。不再有单独的 `agents.mjs`。

| 项 | 规定 |
| --- | --- |
| 单实例 | `claimHost` 以 `agents/host.pid` 独占（O_EXCL）；死进程留下的文件被接管。只有持有守护租约的 worker 去托管；旧版独立宿主还活着时，worker 不托管，在 `agents/hosting.json` 写明在等什么 |
| 合并进 worker | agent 进程经 worker 的 actor 记录启动（`registry.wrap`），会话用 worker 的适配器与租约。开始托管前：每个没关闭记录就死掉的 worker 都要经 `verifyWorkerStopped` 证实已停（遗留进程组被结束）；证实不了就等待并写明原因。证实后：结束死宿主启动后遗留的应用（`agents/launched.json`，核对 bundle 与启动时间），交回死 worker 名下的 agent 会话租约，账本 `recover()`。worker 只在没有任务、没有常驻 agent、没有排队或运行中的 agent 任务时闲置退出 |
| 配置 | `validateHostConfig` 一次列出全部问题。每个条目：绝对路径的包、启用、账号（平台与账号键）、可选 `takeOver`、授权、上限、工作时段。授权必须写 `expiresAt` 或 `durable: true`，不允许含糊。provider 只支持 `openai-chat`，`baseUrl` 必须是不带凭据的 https（仅 localhost 可用 http），key 只给环境变量名 |
| 包 | `loadAgentPackage`：`agent.json` 校验通过且 `runtimeContract` 满足；每个应用一份 `profiles/macos/<id>.json`，id、bundle 与尺寸相符且实际路径在包内；执行体程序在包内 |
| 会话 | 每次常驻运行开始时打开、结束时关闭（`keepWindow: true`，应用留在私有屏上保持登录，租约交回）；会话打不开计为一次 `no_session` 故障 |
| 收尾 | runtime 自己启动的应用在宿主最终停止时由 `quitApp` 结束（核对 bundle 与启动时间）；不结束的话，私有屏回收时窗口会被挪到用户屏。适配器 `bindApp` 在启动应用后失败，同样立即结束该应用 |
| 服务 | 收件箱审批与提问、限额账本、provider（key 来自宿主环境，只发往配置的地址，拒绝重定向）、用量账本、状态看板、审计日志 `agents/audit.jsonl`（每个外发的放行与拒绝） |
| 日志 | worker 的日志 `worker.log`；每次运行结束写明原因（`detail`）：协议违规时解析器的报错，观察失败时窗口的错误。观察失败记为 `error`，不再记为协议违规 |
| 主窗口 | 适配器把比 `mainWindowMinWidth` 窄的窗口视为加载窗口；不写时为窗口配置宽度的一半（按 BOSS 直聘的启动画面定）。固定尺寸的小窗口应用（如计算器 198×350）在窗口配置里写 `mainWindowMinWidth`。窗口配置的尺寸必须在私有屏的范围内（`SCREEN_LIMITS`：320×240 到 6016×3384），加载包时即校验 |
| 热加载 | 每 `configPollMs`（默认 5 秒）按修改时间与大小检查配置。授权、上限、工作时段、provider 原地替换，运行中的 agent 下一次检查即生效，不重启；包、账号、`takeOver` 改变的 agent 重启，停用或删除的停止，新增的启动；不通过校验的配置不生效，记日志 |
| 授权命令 | `2ndscreen task grants [AGENT_ID]`、`grant AGENT_ID APPLICATION [--effect] [--mode] [--for 30m/12h/7d | --until ISO | --durable]`、`revoke AGENT_ID APPLICATION [--effect]`；MCP `task_grants`、`task_grant`、`task_revoke`。默认效果 external-submit、模式 human_in_the_loop、期限 7 天（RFC 0001 §7）。同一应用与效果的旧授权被替换；写入前整份配置重新校验，原子替换，0600 |
| 宿主生命周期 | 有常驻 agent 时 worker 一直运行到被要求停止；`task host stop` 停的是 worker，技能任务随之暂停。没有配置时 worker 不托管，配置出现后下一次检查（5 秒）开始托管 |
| 按请求运行 | `2ndscreen task submit AGENT_ID TASK_TYPE [--input JSON] [--timeout 30m]` 把任务写进 tasks.db 的 `agent_tasks` 表（schema v3，与技能任务同一账本、同一编号空间），确保 worker 在跑，立即返回任务编号。宿主每 `requestPollMs`（默认 1 秒）领取（`AgentTaskLedger.take`，标记已领取）：常驻 agent 交给它的 `submit`；任务型 agent 为每个任务打开会话、跑 `runAgentTask`、关闭会话，同一 agent 一次一个；不认识的 agent、清单没有的任务类型立即失败并写明原因。旧版命令行写在 `agents/requests/` 的请求文件照样被领取并转入账本 |
| 停止与崩溃 | 宿主停止时正在跑的被取消；排队的留在账本里给下一个宿主。宿主死掉后，下一个宿主的 `recover()` 把它在跑的任务记为 `failed / interrupted`（外发是否发生看限额账本，不重跑），已领取未开始的放回队列 |
| 任务结果 | 账本里每个任务：状态（queued / running / succeeded / partial / failed）、来源（runtime / agent）、提交、开始、结束时间、失败原因与说明、条目、产物、动作数与其中被拒和结果不明的数。agent 自建的任务也记。`2ndscreen task outcome TASK_ID` 与 `task status TASK_ID` 都能查（status 先查技能任务，再查 agent 任务）；旧宿主写在 `agents/outcomes/` 的结果仍可读。MCP `task_submit`、`task_outcome` |
| 结束应用 | 结束 runtime 启动的应用时先 `2ndscreen app quit --pid --bundle`（等同 ⌘Q，最多等 10 秒），仍在运行才 SIGTERM、再 SIGKILL；每一步前核对 bundle 与启动时间。BOSS直聘把 SIGTERM 当崩溃并自动重启到用户屏，2026-10-07 实测 |
| 启动收尾 | `app launch` 返回失败或超时（启动单独放宽到 45 秒）时，若应用在启动前没运行、启动后在运行，且启动时间不早于这次启动前 2 秒，视为这次启动的，核对身份后结束；早已在运行的不碰 |

