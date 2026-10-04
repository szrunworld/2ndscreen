# A7 准备阶段报告（task_c637da93f5f9）

## 目标与范围

与 A6 并行，只做不依赖 A6 的入口准备：`runCli`、原生子命令注册、`task` 原生转发、MCP task 工具、boss-resumes Skill 包。最终集成（index.ts、Node 启动入口 main.mjs、打包与安装、后台 worker 启动、旧入口共享租约、依赖清单）留给 A6 完成后的新 Dispatch（task_89caf1a1937e）。

**本阶段没有交付端到端的 `task run`。** 仓库里没有生产用的 TaskControl，也没有 main.mjs；`2ndscreen task …` 在找不到 Runtime 时一律返回 `capability_missing`，不伪装成功。

未修改：index.ts、runner/daemon/telemetry、recovery.ts、contracts.ts、package.json/lock、Package.swift、其他负责人的文件。没有合并分支，没有推送，没有打开桌面，没有访问 BOSS。

## 修改文件

| 文件 | 内容 |
| --- | --- |
| packages/task-runtime/src/cli.ts | `runCli(argv, io, control)`（契约签名），另导出 `CLI_COMMANDS`、`CLI_USAGE`、`RUN_DEFAULTS`、`parseRun` |
| packages/task-runtime/tests/cli.test.ts | 12 个测试，注入合成 TaskControl |
| packages/task-runtime/tests/boss-skill.test.ts | 4 个测试：Skill 包的机器校验 |
| packages/task-runtime/tests/cli-native.test.ts | 6 个原生烟测，设置 `SECONDSCREEN_CLI` 后运行，否则跳过 |
| Sources/ScreenCLI/TaskCommand.swift | `TaskCommand.run(words)` 与 `TaskRuntime.locate` |
| Sources/ScreenCLI/main.swift | 注册 `vision`、`task`（帮助检查之前）和 `agent-bridge`；usage 增加三行说明 |
| Sources/ScreenCLI/MCPServer.swift | 7 个 task 工具，严格检查参数；instructions 增加一句 |
| skills/boss-resumes/SKILL.md、task.json、profiles/macos/boss-macos-1440x900.json、procedures/*.seed.json | Skill 包 |
| docs/agent-reports/A7-prep.md | 本报告 |

## 设计

### runCli（cli.ts）

- 只 import `./contracts.ts`。不读环境变量，不访问文件、账本或进程，不创建模型或探索器；测试读取源码核对这几条。
- 每次调用恰好输出一行 JSON：成功时 `{"ok":true,"command":…,"result":…}`，失败时 `{"ok":false,"command":…,"error":{code,message,details?}}`。stderr 不写任何内容。退出码：0 成功；2 为 `invalid_input`（参数或输入无效）；1 为其他运行时错误，包括 `not_found`、`conflict`、`lease_held`，以及非 RuntimeError 的 `internal`。结果无法序列化（循环引用、BigInt）时报 `internal`，仍只输出一行。
- 命令：
  - `run SKILL_ID --job --limit --output [--source] [--mode] [--browse-limit] [--deadline] [--budget FIELD=N]... [--take-over] [--keep-window] [--analysis]`；
  - `status|pause|resume|cancel|artifacts TASK_ID`；
  - `inspect-procedure PROCEDURE_ID`（返回 undefined 时为 `not_found`）。
  - 每个命令只调用一个 TaskControl 方法，测试用 Proxy 记录对 control 的全部属性访问。
- 严格解析：
  - 重复的选项、未知选项、`--x=v` 写法、缺少值（下一个词以 `--` 开头也算缺值）、多余的位置参数，全部拒绝。
  - 整数只接受纯数字且有界，拒绝 `1e3`、`0x10`、`05`、`+5`、`1.5`、首尾空格、超出安全整数的值。
  - ID 只允许 `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`。文本不能为空、不超过 200 字，不能含控制字符或 U+2028/2029。
  - `--deadline` 必须是带时区的 ISO 时间。
  - 最后由契约的 `validateCollectResumesInput` 判定：绝对路径、数量范围、浏览上限不小于目标、截止时间未过、未知字段。
  - 所有错误一次列出，放在 `details.errors`。
- `--source` 默认 conversations，`--mode` 默认 available。测试核对后者等于 task.json 的 `defaults.captureMode`。
- 帮助：`help`、`--help`、`-h` 出现在命令或选项的位置时输出帮助 JSON，退出码 0，不调用 control。作为选项值时（如 `--job -h`）只是普通文本。

### `2ndscreen task`（TaskCommand.swift）

- 在全局帮助检查之前注册，所以 `task --help` 和 `task run --help` 得到的是 task 自己的帮助。
- Runtime 目录取以下第一个存在的位置：
  1. `$SECONDSCREEN_TASK_RUNTIME`：必须是绝对路径、必须是目录。设置了但不可用时直接报错，不会悄悄跳到下一个位置。
  2. 本可执行文件所在 .app 的 `Contents/Resources/task-runtime`。先解析符号链接，所以链接到 /usr/local/bin 的 CLI 也能找到；向上最多查 4 层，以便将来 CLI 放在 Contents/MacOS 或 Contents/Resources/bin。
  3. 正在运行的 io.github.szrunworld.2ndscreen 的同一路径。
  - 候选位置固定且有限，不做递归搜索。
- Node：`$SECONDSCREEN_NODE`（绝对路径、可执行），否则 `<runtime>/bin/node`。入口为 `<runtime>/main.mjs`。从不查找 PATH 上的 node、npx 或当前目录。
- 执行：`execv(node, [node, main.mjs] + 原样的参数)`，没有 shell，退出码和信号都由 Node 进程自己产生。设置 `SECONDSCREEN_CLI` 为本 CLI 的真实路径，供 Runtime 驱动屏幕和 agent-bridge。
- 没有 Runtime 时输出一行 `{"ok":false,"command":…,"error":{"code":"capability_missing",…}}`，退出码 1，消息说明缺少的是哪一项。此时 `task --help` 仍打印用法和缺失原因，退出码 0。

### vision / agent-bridge

按 A8、A5 报告注册：`vision` 在帮助检查之前，调用 `runLocalVision(words.dropFirst())`；`agent-bridge` 在解析 Arguments 之后，调用 `AgentBridgeCommand.run(args)`。

### MCP

- 新增工具：`task_run`、`task_status`、`task_pause`、`task_resume`、`task_cancel`、`task_artifacts`、`task_inspect_procedure`。每个工具拼出与命令行完全相同的词，经原有的 `runSelf` 调用同一个 CLI。
- 这些工具在运行前只检查参数名和 JSON 类型：未知参数、字符串冒充数字、小数、用 1 冒充 true、budget 值不是整数，都直接返回 `invalid_input`，不启动任何进程。参数值的合法性仍由 Runtime 的解析器判定，与命令行结果一致。
- task 工具的子进程 stdin 为 /dev/null，避免读到 MCP 协议流。原有工具的行为未改。

### Skill 包

- task.json 通过 `validateTaskSpec`；不含 TaskSpec 以外的字段；`submitAllowed` 与 `foregroundAllowed` 均为 false。
- profile 只含 WindowProfile 的 id、version、1440×900、bundleId。appVersion、缩放和内容区在绑定窗口时实测，不写进 profile。
- 两个种子流程（open_resume：点击 AXLink「在线简历」；return_to_list：按 Escape）：
  - 状态 seeded、来源 seed，appVersion 1.7.4；
  - 通过 `validateProcedure({submitAllowed:false})`，只有 read/navigation 动作，不使用元素 index，不点击任何提交类标签；
  - 后置条件与 A4 单元定义完全一致，测试会核对。
  - **两者都未在真实 BOSS 上验证**，SKILL.md 中已写明。
- SKILL.md 如实说明：只支持 conversations；recommend 和 original-only 返回 `capability_missing`；不发送任何内容；账号必须由用户显式提供（配置命令尚未提供）；Runtime 缺失时停止，不得改用 npx。

## 测试

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 280 项：273 通过，7 跳过（6 个原生烟测、A8 的真实辅助程序测试），0 失败 |
| `SECONDSCREEN_CLI=<debug 2ndscreen> LOCAL_VISION_HELPER=<同一个> npm test` | 280 项全部通过 |
| 用 release 构建跑 `cli-native.test.ts` 与 `vision.test.ts` | 22 项全部通过 |
| `swift build`、`swift build -c release` | 通过 |
| `swift test` | 114 项全部通过 |
| 旧 CLI 手工检查 | 无参数时退出码 2；`--help` 退出码 0；未知命令、`android` 不带参数、`iphone --help`、`mcp` 遇到 EOF 的行为都与之前相同 |

原生烟测覆盖以下内容：

- `vision`：合成 PNG 的 metadata、compare、OCR；无效请求退出码 2；`--help`；多余参数。
- `agent-bridge`：无效请求输出一行 `unit_failed`，经 `parseBridgeEvent` 校验合法，退出码 2。不连接桌面，也不调用模型。
- `task` 缺少 Runtime 的各种情况：没有 bin/node、相对路径覆盖、没有 main.mjs、`--help`。
- 全局 usage 中列出了这三个新命令。
- 参数含 `$(touch …)`、反引号、引号、`*`、`~`、空格时原样传给 Node，标记文件没有被创建，Node 的退出码 7 原样返回。另测了 `bin/node` 的布局。
- MCP `tools/list`：原有 14 个工具加 7 个 task 工具，核对了 required 和属性。
- MCP `tools/call`：调用链为 MCP → 同一 CLI → execv node → 真实 `runCli` → 测试临时目录中的合成 control。验证了输入映射、`not_found`、未知参数、小数、字符串、1 冒充 true，以及相对路径由 Runtime 判为无效。

## 最终集成待做（A6 之后的新 Dispatch）

1. **main.mjs 与 index.ts**：按 A6 的 API 装配 TaskControl。不在每个 CLI 短进程中运行 `createTaskDaemon`，以免重复持有 worker 或租约。提交与恢复只写账本，并确保有一个长期运行的 detached worker（作为租约和屏幕的 owner-pid）。生命周期以 A6 的定义为准；装配签名先提交协调者审核。
2. **账号显式配置**：CollectResumesInput 中没有账号字段，A4 也无法从窗口读出账号。需要设计由用户提供的账号配置，在 runner 开始前绑定为 `binding: 'explicit'`，并同时覆盖 CLI 和 MCP（例如在 bootstrap 中处理，不放进 runCli 的输入）。目前 SKILL.md 只说明了这一要求。
3. **打包**：将 Node（≥22.13）放到 Contents/Resources/task-runtime/bin/node，并编译出 main.mjs（不依赖 tsx）；修改 bundle-app.sh 与依赖清单；确认 CLI 在安装后的位置（.app 内或通过符号链接）；在干净环境中验证安装。
4. 种子流程导入 ProcedureRepository、profile 加载，以及旧 BOSS 入口的共享租约。
5. MCP 返回任务资源链接（规划第十一节），尚未实现。

## 已知限制

- MCP task 工具的字符串值若以 `--` 开头，会被 Runtime 当作缺少值（与命令行的规则相同）。
- `TaskRuntime.locate` 没有 Swift 单元测试，因为 ScreenCLI 是可执行 target，测试无法导入；由原生烟测覆盖。
- 种子流程与 SKILL.md 中的界面文字依据 P0 和 A4 的结论，未在真实 BOSS 上验证。
