---
authors:
  - "@szrunworld"
state: draft
---

# RFC 0002 - ACP 双向集成

## 修订记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-07 | 初稿。参考 TencentCloud/Octop 的 ACP 实现（`docs/acp.md`）与 ACP 协议文档 |

本文给 Agent Desktop 增加 [Agent Client Protocol](https://agentclientprotocol.com/)（ACP）的两个方向：**入站**，让 Zed、JetBrains、Neovim、Emacs 等编辑器把 Agent Desktop 当成一个 agent 来用；**出站**，让 Claude Code、Codex、Gemini CLI 这类 ACP 编程 agent 成为 Agent Desktop 的一种执行体，在 Runtime 的检查链下操作桌面。依据 2026 年 10 月 7 日读取的 `vdisplay-prototype`（b4703de）与 [RFC 0001](../0001-agent-hub/README.md) 编写。它是待实施方案，不代表功能已经交付。

**一 为什么做，以及和 MCP 的分工**

ACP 是 Zed 在 2025 年 8 月发布的开放协议：编辑器作为 client 拉起一个 agent 子进程，双方在 stdin/stdout 上走 JSON-RPC 2.0。编辑器负责界面（对话、计划、工具调用卡片、权限弹窗），agent 负责模型与执行。截至 2026 年，Zed 原生支持，JetBrains 通过合作在推进，Neovim、Emacs 有稳定插件，Zed 的 ACP Registry 已收录约 50 个 agent。

我们已经有 MCP（`2ndscreen mcp`）。两者解决的是不同问题：

| | MCP（已有） | ACP 入站（本文） | ACP 出站（本文） |
| --- | --- | --- | --- |
| 谁是大脑 | 编程工具（Claude Code 等）自己逐步决定 | Agent Desktop 里的 agent | 编程 agent，但只能经 Runtime 动手 |
| 谁是手 | Agent Desktop | Agent Desktop | Agent Desktop |
| 交互粒度 | 一次一个原子动作：`click`、`state`、`type` | 一句话交出一件事，流式看进度 | 一个任务交给编程 agent 去做 |
| 适合 | 即时、短小的操作；调试 | 长任务、要审批、要能取消和回看 | 不写代码，用一段说明快速做出一个桌面 agent |
| 检查链 | 原子工具直接调用引擎，**不经过**检查链；只有 `task_*` 工具经过 | 全部经过 | 全部经过 |

结论：「让编程工具直接驱动桌面」MCP 已经能做。ACP 入站补的是**托管 agent 在编辑器里的使用体验**：进度、审批弹窗、取消、会话历史，以及通过 ACP Registry 分发。ACP 出站补的是**用现成编程 agent 当执行体**，同时把它关在 Runtime 的检查链里。

**二 范围**

做：

- 入站：`2ndscreen acp` 作为 ACP agent server，把一个 ACP 会话映射为对 hub agent 的一串任务。
- 出站：新执行体 `acp`，Runtime 作为 ACP client 拉起编程 agent，并给它一个按任务限定的 MCP server。
- 两个方向共用的映射：Runtime 事件与 ACP `session/update`、审批与 `session/request_permission`、提问与 `elicitation/create`。

不做：

- HTTP 或 WebSocket 传输。两个方向都只走 stdio，和 Octop 一致。
- 入站鉴权。stdio 子进程与用户同权，不另设登录。
- 出站 agent 的文件系统与终端能力。首版在 `initialize` 里声明不支持 `fs` 与 `terminal`。
- 从编辑器里创建长期授权。编辑器只能让审批**更严**，不能放宽（第五节）。
- 让 Agent Desktop 委派编码任务给编程 agent（Octop 的 `acp_runner` 场景）。和我们的产品方向无关，不在本文范围。

**三 入站：`2ndscreen acp`**

3.1 启动与配置

```bash
2ndscreen acp                       # 会话里再选 agent
2ndscreen acp --agent wechat-agent  # 固定一个 agent
```

Zed 配置示例（`~/.config/zed/settings.json`）：

```json
{
  "agent_servers": {
    "Agent Desktop": {
      "command": "/Applications/2ndscreen.app/Contents/Resources/bin/2ndscreen",
      "args": ["acp"]
    }
  }
}
```

`2ndscreen acp` 和 `2ndscreen task` 一样由 Swift CLI 转给 `.app` 内自带的 Runtime。它本身不取应用租约，也不直接操作窗口：任务仍然写进 `tasks.db` 由唯一的后台 worker 执行。ACP 进程退出不影响已提交的任务。

3.2 能力协商（`initialize`）

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `agentCapabilities.loadSession` | `true` | 会话可从账本恢复 |
| `promptCapabilities.image` | `true` | 用户可贴截图指明目标，作为任务输入的附件 |
| `promptCapabilities.embeddedContext` | `true` | 编辑器里的文件可作为任务输入，如一份岗位说明 |
| `promptCapabilities.audio` | `false` | |
| `mcpCapabilities` | 全部 `false` | 编辑器在 `session/new` 传来的 MCP server 一律忽略，并在会话信息里注明 |
| 读取 `clientCapabilities.elicitation` | — | 决定提问走 `elicitation/create` 还是对话回落（3.6） |

3.3 会话

| ACP | Agent Desktop |
| --- | --- |
| `session/new` | 在 `tasks.db` 新建一条 ACP 会话记录：`sessionId`、`cwd`、所选 agent、模式。会话下挂零到多个 `taskId` |
| `session/load` | 从账本回放：用户输入、计划、工具调用摘要、结果。不回放截图。仍在运行的任务重新接上流式更新 |
| `session/list` | 列出 ACP 会话，带标题、agent、最近状态 |
| `session/prompt` | 一次输入。解析为命令或任务（3.4），执行到「任务结束」或「卡在人身上」为止 |
| `session/cancel` | 取消本轮触发的任务。等 Runtime 确认执行者已经停手，才以 `cancelled` 结束本轮；未决的权限请求按拒绝处理 |

会话配置项（session config options）：

| 配置项 | 取值 | 说明 |
| --- | --- | --- |
| `agent` | 已安装且启用的 agent，含 builtin | 固定 `--agent` 时只读 |
| `mode` | `ask`（默认）/ `auto` | `ask`：本会话内所有 external-submit 一律逐个审批，即使授权是 `trusted_within_ceiling`。`auto`：按已有授权执行。两者都不能超出授权；没有授权的 effect 照样被拒 |
| `screenshots` | `off`（默认）/ `submit` / `all` | 工具调用卡片里是否附截图。`submit` 只在外发动作的前后附 |
| `pageText` | `off`（默认）/ `on` | 是否在卡片里显示页面文字。关闭时只显示动作和目标的标签 |

3.4 输入如何变成任务

hub agent 的任务类型带输入 schema，自由文本不能直接当输入。首版两种方式：

1. **斜杠命令**。每个任务类型生成一条命令，经 `available_commands_update` 下发，如 `/collect-resumes 前端工程师 5`。参数按 schema 解析，失败时回一条说明，不建任务。
2. **声明了文本任务类型的 agent**。清单里有一个输入只含 `instruction: string` 的任务类型时，自由文本直接作为它的输入。

P2 再加：其余 agent 的自由文本经 provider（用途 `analysis`）填成 schema，以 `plan` 展示解析结果，用户确认后才建任务。

固定命令：

| 命令 | 作用 |
| --- | --- |
| `/agents` | 已安装 agent 与状态面板 |
| `/status [taskId]` | 当前任务状态，默认本会话最近一个 |
| `/pause` `/resume` `/cancel` | 控制本会话的任务 |
| `/inbox` | 所有待审批与待回答，含不是本会话发起的 |
| `/deny <说明>` | 拒绝最近一个审批并附说明，对应 `reject_with_guidance` |
| `/grants` | 查看授权，只读 |
| `/usage` | 本会话与本 agent 的 provider 用量 |

3.5 Runtime 事件到 `session/update`

| Runtime | ACP | 内容 |
| --- | --- | --- |
| `task_created` | `session_info_update` + `plan` | 标题取任务类型与关键参数；计划列出 agent 声明的单元 |
| `unit_started` / `unit_finished` | `plan` | 条目状态 pending、in_progress、completed |
| 一次 `act` | `tool_call` → `tool_call_update` | `kind`：read 效果为 `read`，navigation 为 `execute`，external-submit 为 `other` 并在标题前标「外发」。`title` 如「点击 在线简历」。`rawInput` 是 `Action`。状态随结果变化；被检查链拒绝时为 `failed`，正文是结构化 `reason` 与 `next_steps` |
| 一次 `observe` / `wait` | `tool_call`，`kind: read` | 默认只写读了哪个应用、等了什么条件 |
| `artifact` | `tool_call`，`kind: read`，`locations` 指向文件 | 编辑器里点开即看 |
| `item` | `agent_message_chunk` | 如「已完成 3 / 5」 |
| `heartbeat` 摘要 | `agent_thought_chunk` | |
| provider 调用 | `usage_update` | token 未知时不报 0 |
| 等待用户释放应用（#54） | `plan` 条目 + 消息 | 「等待你释放 BOSS 直聘」 |
| `task_finished` | 汇总消息，本轮 `end_turn` | 状态、数量、终止原因、产物位置 |
| `task_failed` | 原因消息，本轮 `end_turn`；`cancelled` 时为 `cancelled` | |

3.6 审批与提问

- **`ask_approval` → `session/request_permission`**。`toolCall` 带 Runtime 补齐的后果摘要：今日该 effect 已用与剩余、距上次外发的间隔、目标、是否有过 `unknown` 结果、是否在工作时段内。选项只有 `allow_once` 与 `reject_once`。首版**不提供** `allow_always`，因为它会变成从编辑器创建的长期授权。P2 可加「本会话内允许」，映射为随会话结束而失效的租约。
- 同一个审批也出现在 `2ndscreen task inbox` 与 MCP `task_approve`。任何一处先裁决即生效，其余入口收到撤回。
- **`ask_user`**。client 支持 `elicitation` 时发 `elicitation/create`，有 `choices` 时给单选。不支持时发一条消息并以 `end_turn` 结束本轮，用户的下一次输入作为回答；任务在 Runtime 里原地等待，不受本轮结束影响。

3.7 长任务

ACP 允许在一轮之外发送 `session/update`。任务开始后，本轮一直保持到任务结束或卡在人身上。超过 `turnHoldSeconds`（默认 600）时本轮以 `end_turn` 结束并说明「任务在后台继续」，之后的进度作为轮外更新继续发送。各编辑器对轮外更新的展示需要在 P1 实测（第八节）。

常驻 agent 不通过 prompt 驱动。`/agents` 可以挂到某个常驻 agent 上，把它的审批与提问接到本会话。

**四 出站：执行体 `acp`**

4.1 清单

```json
{
  "executor": {
    "kind": "acp",
    "command": ["/usr/local/bin/claude-agent-acp"],
    "protocol": "acp/1",
    "instructions": "INSTRUCTIONS.md",
    "externalModel": true
  }
}
```

- `command` 必须是已安装的可执行文件，不允许 `npx` 现拉，和 Runtime「不从 npx 或 PATH 取东西」的规则一致。安装时记录其路径与哈希。
- `instructions` 是给编程 agent 的任务说明模板，Runtime 用任务输入渲染后作为第一次 `session/prompt`。
- `externalModel: true` 必填。编程 agent 用自己的模型与账号，截图和页面文字会发给它的模型厂商。安装时向用户展示；组织档案可以禁止 `acp` 执行体。

已知可用的 ACP agent：

| agent | 适配器 |
| --- | --- |
| Claude Code | `@zed-industries/claude-agent-acp` |
| Codex | `@zed-industries/codex-acp` |
| Gemini CLI | 原生 `--experimental-acp` |
| OpenCode | `opencode acp` |

4.2 运行流程

1. Runtime 在持有该任务授权期间拉起进程，和 `process` 执行体相同。
2. `initialize`：`clientCapabilities.fs` 与 `terminal` 均为 `false`。
3. `session/new`：`cwd` 为该任务的私有目录；`mcpServers` 只有一项，即 `2ndscreen agent-mcp --task <taskId> --token <一次性令牌>`。这个 server 暴露 RFC 0001 第五节 `mcp` 执行体的那组工具：`observe`、`act`、`wait`、`ask_approval`、`ask_user`、`item`、`artifact`，外加 `finish`。每个 `act` 都经过完整的动作前检查链。**不提供** `click`、`state` 这些原子工具。
4. 第一次 `session/prompt` 发渲染后的说明。本轮 `end_turn` 而未调用 `finish` 时，Runtime 追问一次；仍未调用则任务失败，原因 `error`。
5. 编程 agent 发来的 `session/request_permission`：针对注入的 `agent-mcp` 工具自动 `allow_once`，因为检查链已经把关；其余工具一律 `reject_once`，包括 Bash、编辑文件、联网抓取。
6. 编程 agent 的 `session/update` 写进运行日志；`agent_message_chunk` 作为心跳摘要上报状态面板；`usage_update` 记入 provider 用量，标注为外部模型，拿不到时记 `unknown`。
7. 取消、超时、停止：先发 `session/cancel`，宽限后 SIGTERM，再 SIGKILL。和其他执行体一样，确认进程退出后才释放租约。

4.3 适合的场景

不写代码，只写一段说明，就把一个只读的桌面流程跑起来，例如「把企业微信里今天的未读整理成摘要」。跑稳后，单元可以经 `run_unit` 沉淀成流程，或者改写成 `process` agent，去掉对外部模型的依赖。外发动作照样受授权、限额与审批约束。

**五 安全**

| 风险 | 控制 |
| --- | --- |
| 编辑器放宽审批 | 会话模式只有 `ask` 与 `auto`，都在已有授权之内；ACP 里不能 grant、revoke 或改上限 |
| 候选人等页面数据流进编辑器 | 截图与页面文字默认不进卡片；会话记录只存摘要。ACP 会话的账本与任务账本一样仅用户可读 |
| 编辑器传入的 MCP server | 入站一律忽略 |
| 出站 agent 绕过检查链 | 只给按任务限定的 `agent-mcp`，令牌一次性且绑定 `taskId`；不给原子工具；不支持 `fs` 与 `terminal`；其余工具的权限请求一律拒绝 |
| 出站 agent 把数据发给外部模型 | `externalModel` 必须声明，安装时展示；组织可禁用；用量单独标注 |
| 出站 agent 失控 | 与 `process` 执行体相同：一个任务一个进程、超时、取消、退出核验后才释放租约 |
| 页面里的指令注入 | RFC 0001 第五节第 8 条：观察内容不改变任务参数、输出目录或授权。对出站 agent 额外在说明模板里声明，但不依赖它 |

**六 实现位置**

| 模块 | 位置 | 说明 |
| --- | --- | --- |
| JSON-RPC 与 ACP 类型 | `packages/task-runtime/src/acp-rpc.ts` | 自行实现最小 JSON-RPC，Runtime 保持零运行时依赖。测试用官方 `schema.json` 校验每条消息，作为开发依赖 |
| 入站 server | `packages/task-runtime/src/acp-server.ts` | 读状态面板订阅、`tasks.db`、审批箱；经账本控制请求与 worker 通信，和 `task` 命令相同 |
| 入站会话账本 | `tasks.db` 新表 `acp_sessions`、`acp_session_tasks`、`acp_session_events` | 迁移到 v4 |
| CLI 入口 | `Sources/ScreenCLI` 增加 `acp`，转给 Runtime | 与 `TaskCommand` 同一路径 |
| 出站 client | `packages/task-runtime/src/acp-client.ts` | |
| 执行体 | `agent-host` 增加 `acp`；`agent-contracts` 清单校验 | |
| 任务级 MCP server | `2ndscreen agent-mcp` | 与 RFC 0001 的 `mcp` 执行体共用工具定义 |

**七 阶段与验收**

| 阶段 | 交付 | 验收 |
| --- | --- | --- |
| P1 入站最小链 | `2ndscreen acp`；`initialize`、`session/new`、`session/prompt`、`session/cancel`；斜杠命令；事件到 `tool_call` 与 `plan` 的映射；会话账本 | 在 Zed 里对计算器 agent 发一条命令，用独立 socket 的侧实例跑完，卡片与计划正确；中途取消在执行者停手后才返回 `cancelled`；对比 MCP 路径确认没有绕过检查链 |
| P2 审批、提问、恢复 | `session/request_permission`、`elicitation` 与回落、`session/load`、`session/list`、`usage_update`、模式 `ask` 与 `auto`、`/deny` | wechat-agent 接受好友请求，在 Zed 里批准与拒绝各一次，审计表都有记录；挂起权限时取消，审批按拒绝处理；关掉 Zed 再打开能恢复会话并接上仍在运行的任务 |
| P3 出站执行体 | 清单 `acp`、`acp-client`、`agent-mcp`、权限策略、外部模型标注 | 用 `claude-agent-acp` 跑一个只读计算器任务，全部动作在审计里；它尝试调用 Bash 被拒；中途杀掉进程，确认退出后才释放租约 |
| P4 分发 | ACP Registry 上架；JetBrains、Neovim 实测；用户文档 | 新机装 Agent Desktop 后，在 Zed 的 Registry 里能找到并直接使用 |

**八 风险与未决问题**

- **长任务与轮次语义**：BOSS 采集一跑几分钟到几十分钟。轮外 `session/update` 在协议里允许，但各编辑器是否展示、是否超时，要在 P1 用 Zed 实测后定 `turnHoldSeconds`。
- **自由文本到 schema**：首版只靠斜杠命令与文本任务类型，体验受限。P2 的 provider 解析需要确认步骤，不能让模型直接建外发任务。
- **外部模型的数据外流**：出站执行体天然把屏幕内容交给第三方模型。对招聘这类含个人信息的场景，默认应由组织档案禁用，只在个人场景或只读脱敏场景开放。
- **MCP 原子工具绕过检查链**：这是现状，不是本文引入的。但 ACP 入站上线后，同一台机器上会同时存在受管和不受管两条路。是否把 MCP 的 `click` 等工具也改为经 Runtime 执行，另开议题。
- **协议演进**：会话配置项、`session/list` 已稳定，`elicitation` 较新。所有可选能力都按 `initialize` 的协商结果启用，不假设 client 支持。
- **Octop 的参照边界**：Octop 的入站是把一个聊天 agent 整个暴露给编辑器，出站是让 agent 委派编码任务。我们的入站映射到托管任务，出站是把编程 agent 当执行体关进检查链。两者只共用协议，不共用语义。
