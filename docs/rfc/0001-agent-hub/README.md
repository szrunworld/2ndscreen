---
authors:
  - "@szrunworld"
state: draft
---

# RFC 0001 - Agent Hub

## 修订记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-07 | 初稿，题为 Agent Skills Hub |
| 2026-10-07 | 吸收 OpenShell 的模式：provider profile、租约式授权与三种审批模式、审批前校验摘要、结构化拒绝、动作前检查链；改为 RFC 格式（第十五节） |
| 2026-10-07 | 管理面补齐：安装时内容校验、内容寻址存储与版本回滚、发布前两层扫描与安全等级、多设备同步边界、agent 入口；参考 skills-hub、agent-skills-hub、PromptHub（第十五节） |
| 2026-10-07 | **改题为 Agent Hub**：托管的单元是 agent，不是 skill；skill 一词只留给 `SKILL.md`。产品定位为 Agent Desktop，新增常驻模式、多应用、身份、组织档案（第九节）；`remotedesk-agent` 从独立客户端改为 RemoteDesk 的组织档案与 agent 索引 |
| 2026-10-07 | 吸收 herdr、nasiko、google/ax：运行状态与卡住原因（第六节「状态面板」）、缺信息与要授权两种暂停及问答往返、按 agent 归集 provider 用量与成本（第十五节）；限额计数落盘 |

本文描述 **Agent Desktop** 的 agent 运行时与注册表（Agent Hub）：任何语言实现的 agent 通过协议接入 2ndscreen 的 Runtime，由 Runtime 代为操作桌面，并由我们统一分发、授权和管理。依据 2026 年 10 月 7 日读取的 `vdisplay-prototype`（a879db0）、`remotedesk-boss-agent`（`greet-skill`）、`wechat-agent` 和 `amplifistudio/remotedesk-agent`（f551e87）编写。它是待实施方案，不代表功能已经交付。

**一 产品定位与为什么要做**

Agent Desktop 是 agentdesktop.com 产品线的本地层：一台用户自己的电脑上，agent 在私有虚拟屏里操作真实的桌面应用，用户照常用自己的屏幕。它由三层组成：

| 层 | 名字 | 内容 |
| --- | --- | --- |
| 引擎 | 2ndscreen | 虚拟屏、后台输入、辅助功能读取、截图、UI-TARS 探索、`SecondScreenRuntime` 库。仓库名保留，关系如 Chromium 之于 Chrome |
| 产品 | Agent Desktop | 引擎 + task runtime + Agent Hub（注册表、授权、审批、provider）+ 审批 UI。个人用户直接安装 |
| 组织档案 | 如 RemoteDesk | 不是另一个 app，而是 Agent Desktop 里的一份组织配置：身份、provider 出口、授权上限、agent 索引源、预装 agent。见第九节 |
| Agent | boss-agent、wechat-agent 等 | 各自成仓，打包签名后发布到索引 |

今天有三个 BOSS 直聘 agent 的形态并存过：2ndscreen 仓库里的 TypeScript 原型 `agents/boss`（PR #35 删除中）、独立仓库的 Python 执行器 `remotedesk-boss-agent`（约 2.8 万行），以及 Runtime 内置的只读采集工作流 `boss.collect-resumes`。另有 TypeScript 的 `wechat-agent`。它们各自直接调用 `2ndscreen` 命令行点击、输入，Runtime 对它们在做什么一无所知；互斥、限额、审批、模型出口、崩溃恢复每个项目各写一遍。

已经定下的边界（2026-10-06 / 10-07）：

- 场景 agent 不放进 2ndscreen 仓库；2ndscreen 保持中性构建。
- Runtime 负责本地只读采集；外发动作（打招呼、求简历、换微信）由 agent 负责。
- 托管 agent 的客户端与 RemoteDesk Work 分开，以 2ndscreen 为运行底座。
- 托管的单元叫 agent。它有自己的循环、自己的判断、自己的状态，要对外发动作、要被授权和审批，这就是 agent 的定义；市场上 skill 一词已专指给 LLM 看的 `SKILL.md`。

Hub 是这些边界的实现方式：**agent 通过协议嵌入 Runtime，而不是通过源码树嵌入 2ndscreen。**

**二 现状与缺口**

`packages/task-runtime` 已有：任务包目录 `skills/<name>/`（`task.json`、窗口 profile、流程种子）、effect 分级（read / navigation / artifact / external-submit）、租约 `leaseScopeKey`、SQLite 账本、检查点与崩溃恢复、流程学习与无模型回放、预算与 token 统计、`2ndscreen task` 命令行与 MCP `task_*` 工具、以及一个子进程 JSONL 协议（`agent-bridge`，见 `docs/task-runtime-contracts.md`「Bridge JSONL 协议」）。`SecondScreenRuntime` 库（PR #37）让宿主 app 能在进程内嵌入引擎。

缺口有六个：

| 缺口 | 现状 | Hub 需要 |
| --- | --- | --- |
| 执行体形态 | 只能是编译进 worker 的 TypeScript（`bootstrap.ts` 的 `WORKFLOWS` 表写死 `boss-resumes-v1`） | 任意语言的子进程或 MCP server |
| 生命周期 | 一个任务一个进程，任务结束进程退出 | 常驻 agent：整天盯着应用、自己产生任务，由 Runtime 启停和排程 |
| 发现与分发 | 启动时读本地目录，不认识的 `workflow` 直接拒绝 | 注册表、安装、版本、启用与禁用、索引 |
| 外发动作 | 契约每一层写死 `submitAllowed: false` | 默认禁止，按 agent、按账号显式授权，Runtime 持有硬上限 |
| 共享服务 | 模型调用在 Bridge 内部；限额、审批、审计、身份不存在 | 作为 Runtime 服务提供给所有 agent |
| 组织 | 无 | 组织档案：身份、provider、上限、索引源、预装 |

**三 术语**

| 词 | 含义 |
| --- | --- |
| **Agent** | 可部署、可授权的单元：清单、目标应用的窗口 profile、可选流程种子、可选 `SKILL.md`、一个执行体。Runtime 加载它、给它任务或让它常驻、替它操作桌面、记录它的一切。本文的「agent 包」即此 |
| **Task** | 交给 agent 的一件工作，有输入、账本、状态、产物。`2ndscreen task run` 创建；常驻 agent 也可以自己创建 |
| **Skill** | 只指 `SKILL.md` 这类给人和 LLM 看的操作说明。`skills/2ndscreen/SKILL.md` 是引擎自己的；一个 agent 可以带几份给自己或给调用它的 LLM 读 |
| **Effect** | 一个动作对外界的影响等级：read / navigation / artifact / external-submit |
| **Grant** | 用户或组织对 `(agent, 应用, 账号, effect)` 的授权，默认有时限 |
| **Provider** | agent 需要的外部服务（模型、邮件、对象存储），由 Runtime 持有凭据代为调用 |
| **组织档案** | 一份配置：身份、provider 出口、授权上限、索引源、预装 agent。登录某个组织后生效 |

执行体三种：

| 执行体 | 形态 | 用途 |
| --- | --- | --- |
| `builtin` | Runtime 自带的 TypeScript 工作流 | 参考实现；`boss-resumes-v1` 保留 |
| `process` | Runtime 拉起的子进程，stdin/stdout 走 JSON lines | 任何语言；boss-agent（Python）、wechat-agent（TypeScript） |
| `mcp` | 一个 MCP server，Runtime 作为其 client | 接入第三方或用通用 agent 框架写的 agent |

**四 Agent 包格式**

目录布局：

```
<agent>/
  agent.json                 清单（替代 task.json，schemaVersion 2）
  SKILL.md                   给人和 LLM 看的说明，可有多份
  profiles/macos/<id>.json   每个目标应用一份窗口 profile，格式不变
  procedures/*.seed.json     可选，流程种子
  inputs/<schema>.json       任务输入的 JSON Schema
  bin/ 或 dist/              process 执行体的可执行文件或入口
  SIGNATURE                  包签名（见第八节）
```

清单在 `TaskSpec` 上扩展：

```json
{
  "schemaVersion": 2,
  "id": "remotedesk.boss-recruiter",
  "version": "0.1.0",
  "runtimeContract": ">=2 <3",
  "platforms": ["macos"],
  "applications": [
    { "bundleId": "com.zhipin.www", "versions": ">=1.7.4 <2", "windowProfile": "boss-macos-1440x900" }
  ],
  "mode": "resident",
  "executor": {
    "kind": "process",
    "command": ["bin/boss-agent", "serve"],
    "protocol": "agent-jsonl/1",
    "runtime": { "kind": "python", "version": "3.12", "bundled": true }
  },
  "tasks": {
    "request-resumes": { "inputSchema": "request-resumes-input-v1" },
    "collect-resumes": { "inputSchema": "collect-resumes-input-v1" }
  },
  "effects": ["read", "navigation", "artifact", "external-submit"],
  "capabilities": ["ui.read", "ui.navigate", "artifact.write"],
  "providers": [{ "id": "ark-text", "purposes": ["draft"] }],
  "identity": { "required": true, "audience": "recruiting.remotedesk.io" },
  "limits": {
    "external-submit": { "perDay": 20, "minIntervalMs": 45000 }
  },
  "approval": { "external-submit": "human_in_the_loop" },
  "schedule": { "workHours": "org", "idlePollSeconds": 60 },
  "foregroundAllowed": false,
  "learning": { "promoteAfterSuccesses": 3 },
  "skills": ["SKILL.md"]
}
```

规则：

- `runtimeContract` 与 Runtime 的 `CONTRACT_VERSION` 不匹配、任一 `applications[].versions` 与实际应用版本不匹配、平台不符，加载即拒绝，错误码 `capability_missing`，不带病运行。
- `applications` 是 agent 会操作的全部应用，每个带版本范围与 profile。租约按应用分别取得；一个 agent 同时操作 BOSS 和邮件客户端时持两把租约。
- `mode` 为 `task` 时一个任务一个进程，任务结束进程退出；为 `resident` 时 Runtime 按 `schedule` 启停它，它在工作时段内常驻、自己产生任务（第五节）。
- `tasks` 列出 agent 接受的任务类型及输入 schema。`2ndscreen task run <agent>.<task>` 以此校验输入。
- `effects` 是 agent **声明**会用到的 effect 类别。未声明的类别出现在动作请求里，Runtime 拒绝该动作，`action_result` 带 `reason: effect_undeclared`；连续三次即终止任务。
- `limits` 是 agent 自己声明的上限。Runtime 持有每个 effect 类别的全局硬上限（第七节），agent 只能声明得更严，不能更松。
- `providers` 声明 agent 需要的外部服务及用途。包里不允许出现任何 key；Runtime 按第六节的 provider profile 代为调用。未声明的 provider 请求一律拒绝。
- `identity` 声明 agent 是否需要代表用户向业务系统表明身份，以及受众。身份令牌由 Runtime 从组织档案取得并只在 provider 调用时附加，agent 进程看不到令牌本身，只知道「我在替谁干活」。
- `approval` 说明每类 effect 的审批模式，取值见第七节：`human_in_the_loop`（每次外发都要人批）、`trusted_within_ceiling`（在授权租约与硬上限内由 Runtime 自动放行）、`locked_down`（可见但禁止执行）。agent 只能声明得比用户设置更严。
- `schedule.workHours` 为 `org` 时取组织档案的工作时段，为 `user` 时取用户设置，为 `always` 时不限；缺省 `org`，无组织档案时等同 `user`。时段外 Runtime 不启动常驻 agent，已在跑的在当前步结束后暂停。
- `executor.runtime.bundled: true` 表示包内自带语言运行时；否则声明对宿主机的要求，安装时检查。
- 清单一律经 `validateAgentSpec` 校验，一次列出全部错误，和现有校验器同一风格。
- `task.json`（schemaVersion 1）继续被接受，视为 `mode: task`、`executor.kind = builtin`、单应用、`effects` 不含 external-submit 的 agent。

**五 执行协议：agent 请求，Runtime 动手**

这是整个方案最重要的一条设计选择。现在的 agent 自己拿 `2ndscreen` 命令行操作应用，Hub 下反过来：**agent 进程不直接接触 2ndscreen。** Runtime 把观察推给 agent，agent 回一个带 effect 的动作请求，Runtime 校验、执行、把结果送回。由此得到的性质：

- 互斥、租约、崩溃恢复、限额、审批、审计、provider 在 Runtime 实现一次，所有 agent 自动获得。
- agent 进程不需要辅助功能和屏幕录制权限，只有 Agent Desktop 有。agent 天然被隔离在「只能提议」的位置。
- 动作结果为 `unknown` 时不重发的规则由 Runtime 保证，不再依赖每个 agent 自觉。

协议名 `agent-jsonl/1`，是现有 Bridge JSONL 的超集：Bridge 是「Runtime 给一个单元目标，子进程自己探索并执行」；Agent 协议是「子进程给出每一步，Runtime 执行」。两者共用 `Observation`、`Action`、`ActionRequest`、`ActionResult`、`Condition`、`Locator` 这些类型，一行一个 JSON 对象，每条带 `v`、`agentRunId`、`taskId`（任务级消息）、`seq`、`at`。

Runtime → agent：

| 消息 | 含义 |
| --- | --- |
| `agent_start` | 进程启动后的第一条：agent 配置、账号范围、授权快照、组织档案中与它有关的部分（工作时段、上限、身份受众）、恢复信息（上次未完成的任务与检查点）。不含 socket 路径与任何凭据 |
| `task_start` | 一个任务开始：任务类型、输入（已按 schema 校验）、预算、会话信息。`mode: task` 的 agent 一生只收一条 |
| `observation` | 一次读取：`snapshotId`、所属应用、窗口几何、元素树或子树、截图路径（Runtime 私有目录内）、文字、`pageClass` |
| `action_result` | 对应某个 `act` 的 `ActionResult`，含前后快照 ID。被 Runtime 拒绝时附结构化原因 `reason`（如 `effect_undeclared`、`not_granted`、`quota_exhausted`、`too_fast`、`snapshot_stale`、`target_unknown_result`、`outside_work_hours`）与 `next_steps`（可机器读取的建议：等待多久、改走只读路径、请求授权） |
| `provider_result` | 对应某个 `provider` 请求的回答与用量 |
| `grant` / `deny` | 对某个 `ask_approval` 的裁决。`deny` 可带 `guidance`：自由文本加结构化提示（`too_fast`、`wrong_target`、`outside_quota`、`needs_time_limit`、`not_now`），agent 据此修正后重提或降级 |
| `task_created` | 对常驻 agent `create_task` 的回应，带 `taskId`；或 Runtime 代用户创建的任务 |
| `user_answer` | 对带 `questionId` 的 `ask_user` 的回答，任务原地继续 |
| `pause` / `resume` / `cancel` / `stop` | 控制。`cancel` 针对任务；`stop` 针对常驻 agent，收到后应在当前步结束时发 `agent_stopped` 并退出 |

agent → Runtime：

| 消息 | 含义 |
| --- | --- |
| `observe` | 请求一次观察，指明应用，可指定要不要元素树、截图、感兴趣的区域 |
| `act` | 一个 `ActionRequest`，指明应用，必须声明 `effect`；使用元素 index 时必须带 `snapshotId` |
| `wait` | 一个 `WaitSpec`，Runtime 轮询条件后以 `observation` 回复 |
| `provider` | 请求外部服务：`providerId`、`purpose`（ui / repair / analysis / draft / submit）、输入、可选截图引用、输出约束。模型调用是其一种 |
| `ask_approval` | 请求对某个 effect 或某个具体动作的人工批准，附给人看的摘要 |
| `ask_user` | 缺信息，需要用户介入（登录、验证码、歧义选择）。带 `questionId`（可带 `choices`）时 Runtime 回 `user_answer`；不带时只是提示。与 `ask_approval`（要授权）分开 |
| `create_task` | 常驻 agent 发现了要做的事（如新来一个候选人），请求 Runtime 建一个任务。Runtime 校验类型与输入、写账本、回 `task_created` |
| `item` | 工作项状态变化（discovered → … → committed），Runtime 写账本 |
| `artifact` | 声明一个产物文件及其完整性 |
| `unit_started` / `unit_finished` | 可选的单元边界，用于学习与回放 |
| `heartbeat` | 自报状态 `working / idle / blocked / paused` 与摘要；常驻 agent 每 `idlePollSeconds` 至少一条，超时两次 Runtime 视为失联 |
| `task_finished` / `task_failed` | 任务的最后一条，含终止原因 |
| `agent_stopped` | 常驻 agent 退出前的最后一条 |

执行语义：

1. agent 进程由 Runtime 启动，`mode: task` 时在持有 `Session.withExclusiveActor('agent', …)` 的授权期间启动，一个任务一个进程；`mode: resident` 时在工作时段开始启动，租约在它第一次 `observe` 某应用时取得、`stop` 后释放。进程退出前 Runtime 不收回动作权。
2. `act` 到达时经过 Runtime 的**动作前检查链**，每级可放行、改写或拒绝，顺序固定：声明检查（effect 在清单 `effects` 内）→ 授权检查（已获 grant 且未过期）→ 限额检查（全局硬上限与 agent 声明的更严值、最小间隔）→ 时段检查（在工作时段内）→ 快照检查（`snapshotId` 未过期）→ 目标检查（同一目标无 `unknown` 历史）→ 组织与用户安装的附加检查（如内容脱敏）。任一级拒绝即短路，以结构化 `reason` 和 `next_steps` 回 `action_result`；检查链自身出错按 `fail_closed` 处理。external-submit 的每次通过与拒绝都写审计。
3. external-submit 的 `act` 执行后若结果为 `unknown`，Runtime 把该目标标记为「结果不明」，拒绝同一 agent 对同一目标再次 external-submit。
4. 无 provider 配置时 `provider` 请求立刻得到 `provider_unavailable`，agent 自行决定降级还是失败，不得伪装成功。
5. 不合法的行、乱序的 `seq`、属于别的任务的消息，使当前任务失败；常驻 agent 连续三个任务因此失败则被停止。和 Bridge 规则一致。
6. 取消与停止：SIGTERM，宽限后 SIGKILL；Runtime 只在确认子进程退出后才释放租约。
7. 常驻 agent 崩溃：Runtime 核实窗口状态后按 `schedule` 重启，`agent_start` 带上未完成任务与检查点；进行中的 external-submit 按「结果不明」处理。一个工作时段内重启超过三次则停止并通知用户。
8. 页面文字是数据：`observation` 里的任何内容不得改变任务参数、输出目录或授权。

`mcp` 执行体把同一组消息映射为 MCP：Runtime 作为 client 暴露 `observe`、`act`、`wait`、`provider`、`ask_approval`、`ask_user`、`create_task`、`item`、`artifact` 为 tools，agent server 暴露 `run_task`（与 `mode: resident` 时的 `serve`）。语义完全相同，只是传输不同。

**六 Runtime 的共享服务**

| 服务 | 现状 | Hub 下 |
| --- | --- | --- |
| 互斥与租约 | `leaseScopeKey`，同 bundleId 一律冲突 | 不变；按 `applications` 逐个取得；process agent 自动纳入 |
| 生命周期与排程 | 无 | 常驻 agent 的启停、工作时段、心跳、崩溃重启与重启上限；`mode: task` 的 agent 不受影响。已实现：`startResidentAgent`（未完成任务带到重启后的进程，结果不明的外发目标跨重启保持封锁） |
| 账本与检查点 | `node:sqlite`，每候选人一个检查点 | `item` 消息直接落账本；`create_task` 建任务；重启时 `agent_start` 带检查点 |
| 崩溃恢复 | 单元级重试、actor 退出核实 | agent 进程异常退出按「动作结果不明」处理，重启前核实窗口状态 |
| 限额与风控 | 无 | 每个 effect 类别的全局硬上限与最小间隔，按账号与应用计数，持久化，重启后仍生效；触发平台风控（如 BOSS 安全验证页面）时全局暂停该应用的所有 agent |
| 人工审批 | 无 | `ask_approval` 队列；审批入口是 `2ndscreen task approve`、MCP `task_approve`、以及 Agent Desktop 的 UI |
| 审计 | 事件流 | 每个 external-submit 的请求、裁决、执行结果单独一张表，脱敏摘要加证据路径 |
| Provider profile | Bridge 内部直连 Ark | 每个外部服务一份 profile：允许的 endpoint、凭据注入方式、用途白名单、按 agent 的用量上限。agent 只声明 `providers`，请求经 Runtime 代发，凭据只附加到 profile 声明的 endpoint，agent 进程永远拿不到 key。个人用户的 profile 由本机 key 配置；组织用户的 profile 来自组织档案，指向组织的服务端代理（`archive/llm-worker` 为先例） |
| 身份 | 无 | 组织档案登录后 Runtime 持有用户身份令牌；`identity.required` 的 agent 的 provider 调用自动附带，受众按清单限定。agent 进程只收到不可用于鉴权的身份摘要（显示名、组织、角色） |
| 动作前检查链 | 无 | 第五节第 2 条的有序检查链。内置级：声明、授权、限额、时段、快照、目标；可插拔级：组织或用户安装的检查器，接口与内置级相同（输入动作与上下文，输出放行、改写或拒绝加结构化原因），默认 `fail_closed`。检查器产出的记录只含类别、计数、置信度，不含候选人原文 |
| 学习与回放 | builtin 工作流专用 | process agent 发 `unit_*` 边界即可参与；不发则只执行不学习 |
| 状态上报 | `task status` | 不变；增加 per-agent 聚合（成功率、provider 调用、暂停原因） |
| 状态面板 | 无 | 每次 agent 运行一条：`starting / working / idle / blocked / paused / done / failed`。agent 用心跳自报 `working / idle / blocked / paused`，按协议 `seq` 丢弃过期上报；Runtime 根据未决的审批与提问自己判定「卡在审批」「卡在输入」，agent 无法用心跳盖掉。卡住的排在最前并写明在等什么。可订阅，可等到某状态（固定在一次运行上）。快照原子写入 `<tasksDir>/agents/status.json`，`2ndscreen task agents` 与 MCP `task_agents` 读取。已实现：`agent-status.ts` |
| 提问 | 无 | `ask_user` 带 `questionId`（可带 `choices`）时，Runtime 交给注入的 `Asker`，回 `user_answer`，任务原地继续；不在选项内的回答重问，最多三次。不带 `questionId` 的只是提示，阻塞到 agent 的下一条消息。与 `ask_approval` 分开：前者缺信息，后者要授权。已实现 |
| Provider 用量 | 无 | 每次真正发出的 provider 调用记一条：agent、运行、任务、provider、模型、用途、成败、token、耗时，写 `<tasksDir>/agents/provider-usage.jsonl`。`2ndscreen task usage --by agent|provider|model|task` 与 MCP `task_usage` 汇总；价目表 `prices.json` 按 `provider/model` 或 `provider` 计价；未知 token 不当 0，算不出成本的调用单独计数。已实现：`agent-ledgers.ts` |

**七 外发动作授权模型**

现有契约的 `submitAllowed: false` 校验代码全部保留，只是授权多了一个来源：

- 默认：任何 agent、任何账号的 external-submit 都是禁止的。
- 授权单位：`(agentId, application, accountKey, effect)`，由用户通过 `2ndscreen agent grant` 或 Agent Desktop 的 UI 授予，写入账本，可撤销。组织档案可以预先授予其预装 agent，但仍受下面的租约与上限约束。
- **授权默认是有时限的租约。** `grant` 不带 `--expires` 时默认 7 天，到期自动失效；长期授权要显式 `--durable`，并在 `agent inspect` 里单独标出。自动放行只在租约有效期内发生。
- 四层结构：**硬上限**（Runtime 内置，不可配置放宽）→ **组织上限**（组织档案，只能在硬上限内收窄）→ **用户上限**（只能再收窄）→ **agent 声明**（只能再收窄）。任何一级都不能放宽上一级。
- 三种审批模式，按 effect 设置，各级取最严者：
  - `human_in_the_loop`：每个 external-submit 先 `ask_approval`，批准后才执行。默认值。
  - `trusted_within_ceiling`：租约有效、限额未超、检查链全部通过时由 Runtime 自动放行，不再逐个询问；任一条件不满足回落到人工审批。适合已经跑稳的 agent。
  - `locked_down`：agent 可以提出，Runtime 一律拒绝并记录，用于观察一个新 agent 想做什么而不让它做。
- **审批展示的是后果，不是请求。** `ask_approval` 到达用户前，Runtime 补上校验结果：今日该 effect 已用与剩余额度、距上次外发的间隔、目标账号与候选人键、该目标是否有过 `unknown` 结果、是否在工作时段内。用户看到的是一段摘要加一个按钮，不是 agent 写的原始理由。
- 拒绝有三种：`reject`（本次不做）、`reject_with_guidance`（附结构化提示，agent 可修正后重提）、`revoke`（顺带撤销该授权）。
- `agent_start` 带授权快照；agent 请求未授权的 effect 时得到带 `reason: not_granted` 与 `next_steps` 的拒绝，任务不终止，agent 可降级为只读路径。
- Runtime 的全局硬上限优先级最高。以 BOSS 为例，依据 2026-10-06 的实测，20 分钟内约 45 个对象、间隔 10 到 20 秒触发了安全验证；硬上限因此定为每类外发动作每日 20 次、最小间隔 45 秒加 0 到 15 秒随机，组织、用户和 agent 只能更严。
- 结果 `unknown` 的 external-submit 永不重发，这条由 Runtime 而不是 agent 保证。

**八 管理面**

本地注册表：`~/Library/Application Support/Agent Desktop/agents/` 为安装目录（引擎单独运行时为 `~/Library/Application Support/2ndscreen/agents/`），仓库里的 `skills/` 目录改名 `agents/`，只放内置 agent。包按内容寻址存放（`store/<sha256>/`），`installed/<id>` 指向当前版本，所以同一 agent 的多个版本可以并存，回滚只是改一个指针。注册表 SQLite 表记录每个 agent 的来源、当前版本与历史版本、签名校验结果、安全等级、启用状态、授权、所属组织档案。

安装时的内容校验，签名验证通过之后、解包登记之前执行，任一项不过即拒绝：路径（无绝对路径、无 `..`、无越出包根的符号链接）、压缩包（炸弹检测、条目数与解压后体积上限）、符号链接（包内一律不允许）、体积（单文件与整包上限）、必需文件（`agent.json`、至少一份 `SKILL.md`、声明的 profile 与入口）、指纹（每个文件的哈希与清单里的 `files` 表一致，索引里的包哈希与下载结果一致）。包根的 `.agentignore` 只在打包时生效，决定哪些文件不进包。安装默认非破坏性：目标已存在且版本相同则不动，版本不同则并存并切换指针，从不覆盖已有版本的文件。

命令行（MCP 提供同名 `agent_*` 工具）：

```
2ndscreen agent list                      已安装 agent、版本、模式、启用状态、兼容性、所属组织
2ndscreen agent install <path|url|id>     校验签名与清单，解包，登记
2ndscreen agent update [<id>]             按索引更新；旧版本保留
2ndscreen agent rollback <id> [<version>]  切回上一个或指定的已安装版本
2ndscreen agent pin <id> <version>        固定版本，update 跳过
2ndscreen agent enable|disable <id>
2ndscreen agent start|stop <id>           常驻 agent 的手动启停（排程之外）
2ndscreen agent status [<id>]             常驻 agent 在岗状态、今日用量、暂停原因
2ndscreen agent grant <id> --account K --effect external-submit [--expires 7d | --durable]
2ndscreen agent grant <id> … --mode trusted_within_ceiling
2ndscreen agent revoke …
2ndscreen agent providers                 已配置的 provider profile 与各 agent 用量
2ndscreen agent inspect <id>              清单、声明的 effect、限额、已授权项、安全等级与扫描结果、版本历史、最近运行
2ndscreen org login|logout|status         组织档案（第九节）
2ndscreen task run <agent>.<task> …       任务类型来自清单 tasks
2ndscreen task approve|reject <task> <approval-id> [--guidance HINT…]
```

远端索引：一个静态 JSON 索引加包文件，放在 Cloudflare（R2 加 Worker 即可），记录每个 agent 每个版本的 `runtimeContract`、`applications`、下载地址、哈希与签名，以及安全扫描结果 `securityGrade`（`safe` / `caution` / `unsafe` / `reject`）、`securityScore`、`securityFlags`、`securityScannedAt`。索引本身也签名。`reject` 的版本即使签名有效也拒绝安装；`unsafe` 需要 `--allow-unsafe` 并记录；`caution` 在 `agent install` 和 `inspect` 里显示命中的模式。Agent Desktop 自带公共索引；组织档案可以追加自己的索引。

发布流水线：agent 仓库打包 → 静态扫描 → 签名 → 写索引。静态扫描分两层：规则层对每个版本自动跑（危险命令、网络外联、读取包外路径、读取凭据、提示注入模式），输出等级；深扫层用 SkillSpector 一类的 AST 与 YARA 扫描器，只对规则层标为 `caution` 以上的版本跑，结果必须经人工复核才写入索引，因为这类扫描器的误报率很高。签名证明来源，扫描证明内容，两者缺一不发布。

签名：包用 Ed25519 签名，公共索引的发布者公钥内置在 Runtime 里，组织档案可以加入自己的发布者。未签名或签名不符的包默认拒绝安装；开发模式（`--allow-unsigned`）只对本地路径生效，并在 `agent list` 里标出。

兼容矩阵：Runtime 升级时按 `runtimeContract` 判断已安装 agent 是否还能加载，不能加载的标记为 `incompatible` 并在 `task run` 与排程启动时明确报错。

遥测：每个 agent 每次任务的结果、外发次数、provider 调用、暂停原因、Driver 错误分类，写本地账本；是否上报到远端由组织档案决定，Runtime 只提供导出。索引里的质量信号只来自这些遥测（成功率、人工接管率、`unknown` 比率），不用 star 数一类的仓库热度。

多设备：注册表里哪些内容可以跨设备同步，哪些不能，必须分清。可同步的是已安装 agent 的 id 与版本、启用状态、用户对 agent 的备注。**授权（grant）、provider 凭据、身份令牌、账号绑定、本机路径一律不同步**，换一台机器重新登录、重新授权。同步只允许一个活动来源，避免两个来源互相覆盖。

给 LLM agent 用的入口：`2ndscreen agent` 全部命令输出单行 JSON，并附一份 `manage-agents` 的 `SKILL.md`，让通用 agent（Claude Code 等）能替用户安装、更新、查看 agent，和 `skills/2ndscreen/SKILL.md` 同一形式。

**九 组织档案**

组织档案把「一家公司怎么用 Agent Desktop」从代码变成配置。它不是另一个 app。

一份组织档案包含：

| 项 | 内容 |
| --- | --- |
| 身份 | 登录方式（OIDC 或组织自己的登录端点）、令牌刷新、受众列表。登录后 Runtime 持有令牌，agent 看不到 |
| Provider 出口 | 组织的 provider profile：模型走组织的服务端代理，邮件走组织邮箱等。替换或叠加个人配置 |
| 上限与审批 | 第七节的组织上限、每类 effect 的审批模式下限、工作时段、时区 |
| 索引源与发布者 | 组织自己的 agent 索引地址与签名公钥 |
| 预装 agent | 登录后自动安装并（在租约内）预授权的 agent 列表 |
| 检查器 | 组织安装到动作前检查链的附加检查 |
| 遥测 | 是否上报、上报到哪、脱敏级别 |
| 审批入口 | 除本机 UI 外，审批请求还推到哪里（组织的门户、群机器人） |

规则：

- 一台机器同一时刻只有一个活动的组织档案；个人配置始终存在，组织档案只能收窄它，不能放宽。
- 组织档案由组织的服务端签名下发，Runtime 校验后缓存；登出即清除令牌、撤销组织预授权、卸载标记为「仅组织」的 agent，个人安装的 agent 不动。
- 组织档案不能改 Runtime 硬上限，不能关闭审计，不能让 agent 进程拿到凭据。这三条是 Agent Desktop 对用户的承诺，与组织无关。

**RemoteDesk 是第一个组织档案。** 它提供：RemoteDesk 账号登录；模型 provider 指向 RemoteDesk 的 Cloudflare Worker（remotedesk-it 已合并的 `screen_question` 可复用，但调用方身份要从 Work 的 daemon 换成 Agent Desktop 的用户令牌）；招聘业务的 identity 受众 `recruiting.remotedesk.io`；预装 `remotedesk.boss-recruiter`；工作时段与上限来自 recruiting 服务端策略；审批请求同时推到 ATS 门户。`amplifistudio/remotedesk-agent` 仓库据此重新定位为「RemoteDesk 组织档案 + RemoteDesk 的 agent 索引与发布流水线」，它现在的 Swift 宿主骨架并入 Agent Desktop（第十一节）。

**十 仓库划分**

| 仓库 | 内容 |
| --- | --- |
| `szrunworld/2ndscreen` | 引擎：虚拟屏、输入、`SecondScreenRuntime` 库、task runtime、Agent 协议、Hub 客户端（命令行、注册表、组织档案客户端）、内置参考 agent `boss.collect-resumes`。中性，不含任何外发 agent，不含任何组织的配置 |
| Agent Desktop 应用仓库 | 产品 app：品牌、托盘、审批 UI、组织登录界面、公共索引地址、打包与签名。以 SwiftPM tag 依赖 2ndscreen，不 fork。是否单独成仓还是作为 2ndscreen 的 `apps/agent-desktop` 目录，见第十三节未决项 |
| 各 agent 仓库 | 一个 agent 一个仓库，产出签名包。`remotedesk-boss-agent`、`wechat-agent` 是前两个 |
| 公共索引仓库 | 索引生成、发布流水线、发布者公钥管理 |
| `amplifistudio/remotedesk-agent` | RemoteDesk 组织档案的定义与下发服务、RemoteDesk 的 agent 索引、面向 RemoteDesk 的发布流水线。不再是独立客户端 |

**十一 迁移**

1. **`boss.collect-resumes`（builtin）**：把 `BossWorkflow` 的单元执行改为经同一套内部接口（`observe` / `act` / `wait`）调用，与 process agent 走同一条校验与账本路径。验收标准是现有测试全部通过，行为无差异。
2. **`wechat-agent`（TypeScript，约 1300 行）**：第一个外部 process agent，`mode: task`。它的 `screen.ts` 和 `front.ts` 直接 `execFile('2ndscreen', …)`，替换为一个 `RuntimeClient` 读写 stdin/stdout。它不需要 external-submit（接受好友前已有人工确认），正好验证协议、注册表和签名链路。
3. **`remotedesk-boss-agent`（Python）**：它的 `Driver` Protocol（`state`、`click`、`type_text`、`key`、`scroll`、`bind_window`、`screen_ok`、`screenshot_region`）就是接缝；现有 `CliDriver` 和 `FakeDriver` 可替换，新增 `RuntimeDriver`，方法一一映射为 `observe` / `act` / `wait`。它的 `autopilot` 循环就是 `mode: resident` 的形态：工作时段、STOP/PAUSE 文件、心跳改为协议消息，发现新候选人时 `create_task`。`core/` 里的限额、GUI 锁、崩溃恢复与 Runtime 重叠的部分改为信任 Runtime，账本改为只记业务层状态。`install/`、`launchd/`、`statusbar/` 删除，由 Agent Desktop 接管。这是三者里唯一需要 external-submit 授权的，排在最后。
4. **`remotedesk-agent` 宿主骨架**：`Sources/RemoteDeskAgent`（托盘、socket、嵌入的 `AgentRuntime`）是 Agent Desktop 应用的雏形，整体搬到 Agent Desktop 应用仓库并去掉 RemoteDesk 品牌；`agents/` 目录与 `docs/architecture.md` 改为描述组织档案与索引。bundle id 从 `com.remotedesk.agent-desktop` 改为 Agent Desktop 自己的前缀，权限授予要重新做一次。
5. **RemoteDesk 组织档案**：定义文件、签名下发端点、Worker 调用方身份改为用户令牌、ATS 审批推送。依赖以上四步与 P5。

映射表（Python Driver → Agent 协议）：

| Driver 方法 | 协议消息 |
| --- | --- |
| `bind_window` | `agent_start` / `task_start` 已带会话；不再由 agent 绑定 |
| `state(include_tree)` | `observe { app, elements: true }` |
| `click(target, mode)` | `act { app, kind: click, target, method, effect }` |
| `type_text(target, text)` | `act { kind: type, … }` |
| `key(keys)` | `act { kind: key, … }` |
| `scroll(target, direction, amount)` | `act { kind: scroll, … }` |
| `screen_ok` | `observe` 的窗口几何；屏幕丢失由 Runtime 以错误码告知 |
| `screenshot_region(rect, out)` | `observe { screenshot: { region } }`，文件在 Runtime 私有目录 |
| autopilot 的工作时段 / STOP / PAUSE / 心跳 | `agent_start` 的 schedule、`stop` / `pause` / `resume`、`heartbeat` |
| 异常类 `WindowLostError` 等 | `action_result.status` 与 `RuntimeErrorCode`（`window_lost`、`snapshot_stale`、`timeout`…） |

**十二 阶段与验收**

| 阶段 | 交付 | 验收 |
| --- | --- | --- |
| P1 协议与清单 | `agent.json` schemaVersion 2 校验器；`agent-jsonl/1` 消息类型与 `parseAgentMessage`，含常驻模式消息；Runtime 的 process 执行体宿主与排程器；`boss.collect-resumes` 走同一内部接口 | 现有 Runtime 测试全绿；用一个合成的 echo agent 分别以 `task` 与 `resident` 模式跑完 observe / act / wait / create_task / item / heartbeat / finished 全链路，含取消、停止、超时与崩溃重启 |
| P2 第一个外部 agent | `wechat-agent` 改为 process agent 并签名打包；`agent install/list/enable/disable`；本地注册表 | 从包安装到任务完成不改任何 Runtime 代码；未签名包被拒 |
| P3 外发授权 | 租约式 `grant/revoke`、三种审批模式、动作前检查链（含时段）、`ask_approval` 后果摘要、`reject_with_guidance`、审计表、`unknown` 不重发 | 用 FakeDriver 夹具跑限额与审批的混沌测试；真机上 BOSS 求简历 20 次全部有审计记录 |
| P4 boss-agent 接入 | `RuntimeDriver`；autopilot 改为 `mode: resident`；删除 boss-agent 内与 Runtime 重叠的基础设施 | boss-agent 的 1308 个测试在 `RuntimeDriver` 上通过；常驻值守一个完整工作日，时段外无任何动作 |
| P5 索引、应用与组织档案 | 公共索引与发布流水线（打包、两层扫描、签名、写索引）、`agent update/rollback/pin`、安全等级展示；Agent Desktop 应用（宿主骨架迁入、审批 UI、组织登录）；组织档案格式与 `org login`；RemoteDesk 档案与索引 | 新机装 Agent Desktop，从公共索引装 wechat-agent 并运行；登录 RemoteDesk 后自动装 boss-recruiter 并在租约内自动放行；登出后组织 agent 卸载、个人 agent 不动；一个被标为 `reject` 的测试包被拒绝；更新后 `rollback` 回到旧版并能跑任务 |

每个阶段结束都留下能运行的版本。

**十三 风险与未决问题**

- **Runtime 变成关键路径**：审批、风控、provider、排程都压到 Runtime 上，它必须先于 agent 稳定。P1 的合成 agent 测试和 P3 的混沌测试是对此的防线。
- **常驻 agent 的失控面**：一个整天在跑的进程比一个任务难约束。防线是：动作仍全部经检查链，时段外不启动，心跳超时即失联处理，重启上限，`agent status` 随时可见。
- **每步一次 JSONL 往返的开销**：一次 `observe` 含完整元素树可能有几百 KB。方案是 `observe` 支持子树与增量（只回 `snapshotId` 变化的部分），截图只传路径。需要在 P1 实测。
- **Python 运行时打包**：`bundled: true` 意味着包含 CPython，体积约 40 MB。可接受；替代方案是 Agent Desktop 统一提供 Python，由清单声明依赖。P2 用 TypeScript agent 先行，P4 前决定。
- **沙箱程度**：agent 进程没有 TCC 权限，但仍是宿主用户的普通进程，能读文件、访问网络。首版靠签名、安装时内容校验与发布前扫描约束，不做系统级沙箱；是否用 App Sandbox 或 `sandbox-exec` 包裹留作后续。
- **命名**：「Agent Desktop」在呼叫中心软件里是通用词（Cisco、Genesys、Amazon Connect 都有 agent desktop，指人工坐席工作台），搜索区分度差；域名 agentdesktop.com 已持有，接受这一点。`skills-hub`、`agent-skills-hub`、`PromptHub` 都已被占且都指 `SKILL.md` 管理器，不用。
- **仓库归属（未决）**：Agent Desktop 是 agentdesktop.com 的产品，应用仓库放 `szrunworld` 下与 2ndscreen 并列，还是作为 2ndscreen 的子目录；RemoteDesk 的组织档案与索引留在 `amplifistudio`。个人与公司资产的划分由 Kevin 决定。
- **Windows**：协议、清单与组织档案与平台无关；Runtime 的 Windows 侧依赖 `windows/` 下的 C# 核心进度，本文不展开。
- **Provider 与身份的令牌**：个人用户本地持有 key；组织用户走组织的服务端代理。两条路径都通过同一个 provider 服务，agent 无感。profile 的 endpoint 白名单和 identity 的受众限定是防止凭据被 agent 借道外传的唯一控制，必须和限额一样不可由 agent 放宽。
- **协议版本化**：`agent-jsonl/1` 冻结后只增消息类型，不改已有字段；破坏性变更升 `/2`，Runtime 同时支持相邻两个版本一个发布周期。
- **与 Bridge 的关系**：Bridge 继续作为 Runtime 内部的探索器存在；是否把它也改写为一个 `builtin` agent，等 P1 之后看是否有收益。
- **主窗口判定**：适配器把宽度不足窗口配置一半的窗口当作加载窗口，这条规则按 BOSS 直聘定。2026-10-07 计算器验收时，198 宽的固定窗口被误判，只能靠把窗口配置写到实际尺寸附近绕过。通用 agent 需要由窗口配置声明最小主窗口尺寸，或者改用别的信号判断加载完成。
- **与 remotedesk-it 已合并工作的关系**：Worker `screen_question`、Cloud 的 grant 与 operations 仍在 `develop`，但其调用方假设（Work daemon 身份）与本文不符；RemoteDesk 组织档案落地时要么改调用方身份，要么弃用。

**十四 与现有文档的关系**

- `docs/task-runtime-contracts.md`：P1 时新增「Agent 包 v2」与「Agent JSONL 协议」两节，「安全边界」一节的 `submitAllowed=false` 改写为第七节的授权模型。
- `docs/skill-runtime-boss-plan.md`：其「首版不包含主动打招呼、求简历、自动回复」的边界由本文的 P3 与 P4 接续。
- `README.md`：「Skill tasks」一节改名「Agents and tasks」，增加 `2ndscreen agent`、`2ndscreen org` 命令与注册表位置。
- `amplifistudio/remotedesk-agent` 的 `README.md`、`docs/architecture.md`、`agents/README.md`：改为组织档案与索引的定位，指向本文第九、十一节。
- 文档形态：本文及后续方案改用 RFC 格式管理，`docs/rfc/NNNN-<name>/README.md`，frontmatter 带作者与状态（draft / accepted / superseded），正文含修订记录、决定与明确推迟的事项。本文即 `docs/rfc/0001-agent-hub/README.md`，实施 PR 引用它的编号。

**十五 先例**

NVIDIA OpenShell（Rust，Apache 2.0，2026 年 10 月读取）自我定位为 autonomous agents 的运行时，与本文对应，但它解决的是另一层问题：agent 进程能碰哪些文件、网络与凭据，由 Landlock、seccomp 和 L4/L7 出口代理在内核层强制。它的沙箱层对 macOS GUI agent 不适用，但下列模式被本文采用：

| OpenShell | 本文对应 |
| --- | --- |
| Provider profiles：agent 看不到凭据，supervisor 只对 profile 声明的 endpoint 注入 | 第六节 provider profile 与身份服务 |
| 策略分层（org ceiling / effective / proposal），只能在上限内收窄；授权持久度 `ephemeral_lease` / `durable` / `promoted` | 第七节四层上限与租约式授权 |
| 审批模式 `human_in_the_loop` / `trusted_agent_within_ceiling` / `manual_only_locked_down`；`reject_with_guidance` 带结构化提示 | 第七节审批模式与拒绝方式 |
| Validation before approval：审批者看到的是验证后的后果摘要 | 第七节「审批展示的是后果」 |
| Structured deny feedback：拒绝带机器可读原因与 `next_steps` | 第五节 `action_result.reason` / `next_steps` |
| Supervisor middleware（RFC 0009）：热路径上的有序检查链，`fail_closed` 默认，findings 不含原始敏感值 | 第五节与第六节的动作前检查链 |
| Workspaces 与 org-scoped provider profiles（RFC 0011） | 第九节组织档案 |
| 驱动接口走 gRPC 而非进程内 trait（RFC 0001 否决的替代方案） | 第五节 agent 一律进程外的选择 |
| RFC 流程与目录格式 | 第十四节 |

不采用：内核级沙箱、L4/L7 出口代理、多副本 gateway 与 Kubernetes 驱动、多租户控制面、形式化 prover。它的「skills」只是给 coding agent 看的 `SKILL.md`，与本文的 agent 包无关，但与本文对 skill 一词的用法一致。

另外三个 `SKILL.md` 管理器（2026 年 10 月读取）只与第八节的管理面重叠，它们没有执行体、权限模型和运行时：

| 项目 | 形态 | 本文采用 |
| --- | --- | --- |
| qufei1993/skills-hub（Rust，Tauri，MIT） | 中央库投影到 48 个工具目录 | 安装默认非破坏性；多设备同步排除本机路径、工具目标与凭据；给 LLM agent 用的 CLI 与 `manage-agents` 技能 |
| zhuyansen/agent-skills-hub（Python，MIT） | 纯索引，综合评分 | 两层安全扫描（规则层全量、深扫按需加人工复核）；索引字段 `securityGrade / Score / Flags / ScannedAt` 与 `reject` 阻止安装 |
| legeling/PromptHub（TypeScript，Electron，**AGPL**） | Prompt、Skill、Agent 三类资产 | 安装时内容校验清单（路径、压缩包、符号链接、体积、必需文件、指纹）；版本历史与回滚；内容寻址存储；只允许一个活动同步源 |

不采用它们的评分体系（star、fork、活跃度）；质量信号只来自遥测。PromptHub 是 AGPL，只借思路，不引用代码。

另有三个 agent 运行时（2026 年 10 月读取），都不做桌面 GUI agent：

| 项目 | 形态 | 本文采用 |
| --- | --- | --- |
| herdrdev/herdr（Rust，Apache 2.0） | 终端里编码 agent 的运行时：后台保持会话、多机一个窗口、标出卡住的 pane | 运行状态词汇 working / idle / blocked / done；上报带单调递增序号、过期即丢；等待固定在一次运行上；卡住的排最前；宿主给 agent 注入固定环境变量（`AGENT_DESKTOP_*`） |
| Nasiko-Labs/nasiko（Rust，Apache 2.0） | A2A 协议的 agent 控制面：OCI 打包、模型路由、MCP 网关 | 缺信息（`INPUT_REQUIRED`）与要授权（`AUTH_REQUIRED`）两种暂停分开，回答由平台转交、任务原地继续；按 agent 与模型归集用量和成本 |
| google/ax（Go，Apache 2.0） | 仿 kubectl 的集群编排：Task / Workspace / Model 三种资源 | 只印证结构：任务、组织档案、provider 三分 |

不采用：nasiko 的 OCI 镜像打包与集群控制面，ax 的集群调度，agentscope-runtime 的 Linux 容器沙箱（目标应用不在 Linux 上）。
