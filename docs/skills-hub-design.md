# Agent Skills Hub 设计方案

本文描述把 2ndscreen 的 Task Runtime 扩展为一个可挂载、可管理的技能宿主（Skills Hub）的方案：任何语言实现的技能通过协议接入 Runtime，由 Runtime 代为操作桌面，并由我们统一分发、授权和管理。依据 2026 年 10 月 7 日读取的 `vdisplay-prototype`（a879db0）、`remotedesk-boss-agent`（`greet-skill`）和 `wechat-agent` 编写。它是待实施方案，不代表功能已经交付。

**一 为什么要做**

今天有三个"BOSS 直聘 agent"的形态并存过：2ndscreen 仓库里的 TypeScript 原型 `agents/boss`（PR #35 删除中）、独立仓库的 Python 执行器 `remotedesk-boss-agent`（约 2.8 万行），以及 Runtime 内置的只读采集技能 `boss.collect-resumes`。另有 TypeScript 的 `wechat-agent`。它们各自直接调用 `2ndscreen` 命令行点击、输入，Runtime 对它们在做什么一无所知；互斥、限额、审批、模型出口、崩溃恢复每个项目各写一遍。

已经定下的边界（2026-10-06 / 10-07）：

- 场景 agent 不放进 2ndscreen 仓库；2ndscreen 保持面向 agentdesktop.com 的中性构建。
- Runtime 负责本地只读采集；外发动作（打招呼、求简历、换微信）由 agent 负责。
- 新客户端 `remotedesk-agent`（暂名）与 RemoteDesk Work 分开，以 2ndscreen 为运行底座托管 BOSS 与后续 agent。

Hub 是这三条的实现方式：**技能通过协议嵌入 Runtime，而不是通过源码树嵌入 2ndscreen。**

**二 现状与缺口**

`packages/task-runtime` 已有：技能包目录 `skills/<name>/`（`task.json`、窗口 profile、流程种子）、effect 分级（read / navigation / artifact / external-submit）、租约 `leaseScopeKey`、SQLite 账本、检查点与崩溃恢复、流程学习与无模型回放、预算与 token 统计、`2ndscreen task` 命令行与 MCP `task_*` 工具、以及一个子进程 JSONL 协议（`agent-bridge`，见 `docs/task-runtime-contracts.md`"Bridge JSONL 协议"）。

缺口有四个：

| 缺口 | 现状 | Hub 需要 |
| --- | --- | --- |
| 工作流形态 | 只能是编译进 worker 的 TypeScript（`bootstrap.ts` 的 `WORKFLOWS` 表写死 `boss-resumes-v1`） | 工作流可以是任意语言的子进程或 MCP server |
| 技能发现 | 启动时读本地 `skills/` 目录，不认识的 `workflow` 直接拒绝 | 注册表、安装、版本、启用与禁用 |
| 外发动作 | 契约每一层写死 `submitAllowed: false` | 默认禁止，按技能、按账号显式授权，Runtime 持有硬上限 |
| 共享服务 | 模型调用在 Bridge 内部；限额、审批、审计不存在 | 作为 Runtime 服务提供给所有技能 |

**三 术语**

本文之后只用一个"技能"的定义：

> **技能包（skill package）**：一个目录，含机器可校验的清单、目标应用的窗口 profile、可选的流程种子，以及一个执行体。Runtime 加载它、给它任务、替它操作桌面、记录它的一切。

执行体三种：

| 执行体 | 形态 | 用途 |
| --- | --- | --- |
| `builtin` | Runtime 自带的 TypeScript 工作流 | 参考实现；`boss-resumes-v1` 保留 |
| `process` | Runtime 拉起的子进程，stdin/stdout 走 JSON lines | 任何语言；boss-agent（Python）、wechat-agent（TypeScript） |
| `mcp` | 一个 MCP server，Runtime 作为其 client | 接入第三方或用通用 agent 框架写的技能 |

`skills/2ndscreen/SKILL.md` 这类给 LLM 看的操作指南不是技能包，名字也不再混用；它仍是"直接驱动 2ndscreen 的通用 agent"的说明书。

**四 技能包格式**

目录布局：

```
<skill>/
  skill.json                 清单（替代 task.json，schemaVersion 2）
  SKILL.md                   给人和 LLM 看的说明
  profiles/macos/<id>.json   窗口 profile，格式不变
  procedures/*.seed.json     可选，流程种子
  inputs/<schema>.json       输入的 JSON Schema
  bin/ 或 dist/              process 执行体的可执行文件或入口
  SIGNATURE                  包签名（见第八节）
```

清单在 `TaskSpec` 上扩展，新增字段加粗：

```json
{
  "schemaVersion": 2,
  "id": "boss.request-resumes",
  "version": "0.1.0",
  "runtimeContract": ">=2 <3",
  "platforms": ["macos"],
  "application": "com.zhipin.www",
  "applicationVersions": ">=1.7.4 <2",
  "windowProfile": "boss-macos-1440x900",
  "executor": {
    "kind": "process",
    "command": ["bin/boss-agent", "skill"],
    "protocol": "skill-jsonl/1",
    "runtime": { "kind": "python", "version": "3.12", "bundled": true }
  },
  "inputSchema": "request-resumes-input-v1",
  "effects": ["read", "navigation", "external-submit"],
  "capabilities": ["ui.read", "ui.navigate", "model.text", "artifact.write"],
  "limits": {
    "external-submit": { "perDay": 20, "minIntervalMs": 45000 }
  },
  "approval": { "external-submit": "per-task" },
  "foregroundAllowed": false,
  "learning": { "promoteAfterSuccesses": 3 },
  "defaults": {}
}
```

规则：

- `runtimeContract` 与 Runtime 的 `CONTRACT_VERSION` 不匹配、`applicationVersions` 与实际应用版本不匹配、平台不符，加载即拒绝，错误码 `capability_missing`，不带病运行。
- `effects` 是技能**声明**会用到的 effect 类别。未声明的类别出现在动作请求里，Runtime 拒绝并以 `forbidden_effect` 终止该单元。
- `limits` 是技能自己声明的上限。Runtime 持有每个 effect 类别的全局硬上限（第七节），技能只能声明得更严，不能更松。
- `approval` 说明哪些 effect 需要人工审批，粒度 `never`（Runtime 仍可按用户设置要求）、`per-task`、`per-action`。
- `executor.runtime.bundled: true` 表示包内自带语言运行时；否则声明对宿主机的要求，安装时检查。
- 清单一律经 `validateSkillSpec` 校验，一次列出全部错误，和现有校验器同一风格。
- `task.json`（schemaVersion 1）继续被接受，视为 `executor.kind = builtin`、`effects` 不含 external-submit 的技能。

**五 执行协议：技能请求，Runtime 动手**

这是整个方案最重要的一条设计选择。现在的 agent 自己拿 `2ndscreen` 命令行操作应用，Hub 下反过来：**技能进程不直接接触 2ndscreen。** Runtime 把观察推给技能，技能回一个带 effect 的动作请求，Runtime 校验、执行、把结果送回。由此得到的性质：

- 互斥、租约、崩溃恢复、限额、审批、审计、模型出口在 Runtime 实现一次，所有技能自动获得。
- 技能进程不需要辅助功能和屏幕录制权限，只有 2ndscreen 有。技能天然被隔离在"只能提议"的位置。
- 动作结果为 `unknown` 时不重发的规则由 Runtime 保证，不再依赖每个技能自觉。

协议名 `skill-jsonl/1`，是现有 Bridge JSONL 的超集：Bridge 是"Runtime 给一个单元目标，子进程自己探索并执行"；Skill 协议是"子进程给出每一步，Runtime 执行"。两者共用 `Observation`、`Action`、`ActionRequest`、`ActionResult`、`Condition`、`Locator` 这些类型，一行一个 JSON 对象，每条带 `v`、`taskId`、`seq`、`at`。

Runtime → 技能：

| 消息 | 含义 |
| --- | --- |
| `task_start` | 任务输入（已按 `inputSchema` 校验）、账号范围、预算、授权快照（哪些 effect 已获批）、会话信息（不含 socket 路径） |
| `observation` | 一次读取：`snapshotId`、窗口几何、元素树或子树、截图路径（Runtime 私有目录内）、文字、`pageClass` |
| `action_result` | 对应某个 `act` 的 `ActionResult`，含前后快照 ID |
| `model_result` | 对应某个 `model` 请求的回答与 token 用量 |
| `grant` / `deny` | 对某个 `ask_approval` 的裁决 |
| `pause` / `resume` / `cancel` | 控制。`cancel` 后技能应在当前步结束时发 `task_finished` 并退出 |

技能 → Runtime：

| 消息 | 含义 |
| --- | --- |
| `observe` | 请求一次观察，可指定要不要元素树、截图、感兴趣的区域 |
| `act` | 一个 `ActionRequest`，必须声明 `effect`；使用元素 index 时必须带 `snapshotId` |
| `wait` | 一个 `WaitSpec`，Runtime 轮询条件后以 `observation` 回复 |
| `model` | 请求模型：`purpose`（ui / repair / analysis / draft）、输入文本、可选截图引用、输出约束 |
| `ask_approval` | 请求对某个 effect 或某个具体动作的人工批准，附给人看的摘要 |
| `ask_user` | 需要用户介入（登录、验证码、歧义选择），任务进入 `waiting_user` |
| `item` | 工作项状态变化（discovered → … → committed），Runtime 写账本 |
| `artifact` | 声明一个产物文件及其完整性 |
| `unit_started` / `unit_finished` | 可选的单元边界，用于学习与回放 |
| `task_finished` / `task_failed` | 最后一行，含终止原因 |

执行语义：

1. 技能进程由 Runtime 在持有 `Session.withExclusiveActor('skill', …)` 的授权期间启动，一个任务一个进程。进程退出前 Runtime 不收回动作权。
2. `act` 到达时 Runtime 依次检查：effect 在清单 `effects` 内；effect 已获授权；限额未超；`snapshotId` 未过期。任一不满足以对应错误码回 `action_result`，external-submit 的拒绝同时写审计。
3. external-submit 的 `act` 执行后若结果为 `unknown`，Runtime 把该候选项标记为"结果不明"，拒绝同一任务对同一目标再次 external-submit。
4. 无模型配置时 `model` 请求立刻得到 `model_unavailable`，技能自行决定降级还是失败，不得伪装成功。
5. 不合法的行、乱序的 `seq`、属于别的任务的消息，使任务失败并终止子进程，和 Bridge 规则一致。
6. 取消与超时：SIGTERM，宽限后 SIGKILL；`explore`/`run` 只在确认子进程退出后才 resolve。
7. 页面文字是数据：`observation` 里的任何内容不得改变任务参数、输出目录或授权。

`mcp` 执行体把同一组消息映射为 MCP：Runtime 作为 client 暴露 `observe`、`act`、`wait`、`model`、`ask_approval`、`ask_user`、`item`、`artifact` 为 tools，技能 server 暴露 `run_task` 一个 tool。语义完全相同，只是传输不同。

**六 Runtime 的共享服务**

| 服务 | 现状 | Hub 下 |
| --- | --- | --- |
| 互斥与租约 | `leaseScopeKey`，同 bundleId 一律冲突 | 不变；process 技能自动纳入 |
| 账本与检查点 | `node:sqlite`，每候选人一个检查点 | `item` 消息直接落账本；崩溃后技能重启时收到 `task_start` 带上次检查点 |
| 崩溃恢复 | 单元级重试、actor 退出核实 | 技能进程异常退出按"动作结果不明"处理，重启前核实窗口状态 |
| 限额与风控 | 无 | 每个 effect 类别的全局硬上限与最小间隔，按账号与应用计数，持久化，重启后仍生效；触发平台风控（如 BOSS 安全验证页面）时全局暂停该应用的所有技能 |
| 人工审批 | 无 | `ask_approval` 队列；审批入口是 `2ndscreen task approve`、MCP `task_approve`、以及宿主客户端的 UI |
| 审计 | 事件流 | 每个 external-submit 的请求、裁决、执行结果单独一张表，脱敏摘要加证据路径 |
| 模型出口 | Bridge 内部直连 Ark | `model` 服务统一出口；key 由 Runtime 持有或由托管服务代为调用（`archive/llm-worker` 为先例）；技能包里不允许出现 key |
| 学习与回放 | builtin 工作流专用 | process 技能发 `unit_*` 边界即可参与；不发则只执行不学习 |
| 状态上报 | `task status` | 不变；增加 per-skill 聚合（成功率、模型调用、暂停原因） |

**七 外发动作授权模型**

现有契约的 `submitAllowed: false` 校验代码全部保留，只是授权多了一个来源：

- 默认：任何技能、任何账号的 external-submit 都是禁止的。
- 授权单位：`(skillId, application, accountKey, effect)`，由用户通过 `2ndscreen skill grant` 或宿主 UI 授予，写入账本，可撤销。
- 任务启动时 Runtime 把授权快照放进 `task_start`；技能请求未授权的 effect 时得到 `forbidden_effect`，任务不终止，技能可降级为只读路径。
- `approval.per-action` 的技能，每个 external-submit 先 `ask_approval`，用户批准后才执行；`per-task` 在任务开始时一次批准。
- Runtime 的全局硬上限优先级最高。以 BOSS 为例，依据 2026-10-06 的实测，20 分钟内约 45 个对象、间隔 10 到 20 秒触发了安全验证；硬上限因此定为每类外发动作每日 20 次、最小间隔 45 秒加 0 到 15 秒随机，技能和服务端策略只能更严。
- 结果 `unknown` 的 external-submit 永不重发，这条由 Runtime 而不是技能保证。

**八 管理面**

本地注册表：`~/Library/Application Support/2ndscreen/skills/` 为安装目录，`skills/` 仓库目录只放内置技能。注册表 SQLite 表记录每个技能的来源、版本、签名校验结果、启用状态、授权。

命令行（MCP 提供同名 `skill_*` 工具）：

```
2ndscreen skill list                      已安装技能、版本、启用状态、兼容性
2ndscreen skill install <path|url|id>     校验签名与清单，解包，登记
2ndscreen skill update [<id>]             按远端索引更新
2ndscreen skill enable|disable <id>
2ndscreen skill grant <id> --account K --effect external-submit
2ndscreen skill revoke …
2ndscreen skill inspect <id>              清单、声明的 effect、限额、已授权项、最近运行
2ndscreen task run <id> …                 不变；SKILL_ID 来自注册表
```

远端索引：一个静态 JSON 索引加包文件，放在 Cloudflare（R2 加 Worker 即可），记录每个技能每个版本的 `runtimeContract`、`applicationVersions`、下载地址、哈希与签名。索引本身也签名。

签名：包用 Ed25519 签名，公钥内置在 Runtime 里，可以配置多个发布者。未签名或签名不符的包默认拒绝安装；开发模式（`--allow-unsigned`）只对本地路径生效，并在 `skill list` 里标出。

兼容矩阵：Runtime 升级时按 `runtimeContract` 判断已安装技能是否还能加载，不能加载的标记为 `incompatible` 并在 `task run` 时明确报错。

遥测：每个技能每次任务的结果、外发次数、模型调用、暂停原因、Driver 错误分类，写本地账本；是否上报到远端由宿主客户端决定，Runtime 只提供导出。

**九 仓库划分**

| 仓库 | 内容 |
| --- | --- |
| `szrunworld/2ndscreen` | Runtime、Skill 协议、hub 客户端（命令行与注册表）、内置参考技能 `boss.collect-resumes`。保持中性，不含任何外发技能 |
| 各技能仓库 | 一个技能一个仓库，产出签名包。`remotedesk-boss-agent`、`wechat-agent` 是前两个 |
| hub 索引仓库 | 索引生成、发布流水线、发布者公钥管理 |
| `remotedesk-agent`（暂名） | 发行版：2ndscreen 以 side instance 内嵌、RemoteDesk 预装技能、身份与模型托管、审批 UI。它不再需要自己的 runtime |

2ndscreen 以 SwiftPM tag 被 `remotedesk-agent` 依赖（需要把 `SecondScreenCore`、`TarsAgent` 增加 library product），不 fork。

**十 迁移**

1. **`boss.collect-resumes`（builtin）**：把 `BossWorkflow` 的单元执行改为经同一套内部接口（`observe` / `act` / `wait`）调用，与 process 技能走同一条校验与账本路径。验收标准是现有测试全部通过，行为无差异。
2. **`wechat-agent`（TypeScript，约 1300 行）**：第一个外部 process 技能。它的 `screen.ts` 和 `front.ts` 直接 `execFile('2ndscreen', …)`，替换为一个 `RuntimeClient` 读写 stdin/stdout。它不需要 external-submit（接受好友前已有人工确认），正好验证协议、注册表和签名链路。
3. **`remotedesk-boss-agent`（Python）**：它的 `Driver` Protocol（`state`、`click`、`type_text`、`key`、`scroll`、`bind_window`、`screen_ok`、`screenshot_region`）就是接缝；现有 `CliDriver` 和 `FakeDriver` 可替换，新增 `RuntimeDriver`，方法一一映射为 `observe` / `act` / `wait`。`core/` 里的限额、GUI 锁、崩溃恢复与 Runtime 重叠的部分改为信任 Runtime，账本改为只记业务层状态。`install/`、`launchd/`、`statusbar/` 由宿主客户端接管。这是三者里唯一需要 external-submit 授权的，排在最后。
4. **`remotedesk-agent`**：发行版工作，依赖以上三步完成。

映射表（Python Driver → Skill 协议）：

| Driver 方法 | 协议消息 |
| --- | --- |
| `bind_window` | `task_start` 已带会话；不再由技能绑定 |
| `state(include_tree)` | `observe { elements: true }` |
| `click(target, mode)` | `act { kind: click, target, method, effect }` |
| `type_text(target, text)` | `act { kind: type, … }` |
| `key(keys)` | `act { kind: key, … }` |
| `scroll(target, direction, amount)` | `act { kind: scroll, … }` |
| `screen_ok` | `observe` 的窗口几何；屏幕丢失由 Runtime 以错误码告知 |
| `screenshot_region(rect, out)` | `observe { screenshot: { region } }`，文件在 Runtime 私有目录 |
| 异常类 `WindowLostError` 等 | `action_result.status` 与 `RuntimeErrorCode`（`window_lost`、`snapshot_stale`、`timeout`…） |

**十一 阶段与验收**

| 阶段 | 交付 | 验收 |
| --- | --- | --- |
| P1 协议与清单 | `skill.json` schemaVersion 2 校验器；`skill-jsonl/1` 消息类型与 `parseSkillMessage`；Runtime 的 process 执行体宿主；`boss.collect-resumes` 走同一内部接口 | 现有 Runtime 测试全绿；用一个合成的 echo 技能跑完 observe / act / wait / item / finished 全链路，含取消与超时 |
| P2 第一个外部技能 | `wechat-agent` 改为 process 技能并签名打包；`skill install/list/enable/disable`；本地注册表 | 从包安装到任务完成不改任何 Runtime 代码；未签名包被拒 |
| P3 外发授权 | `grant/revoke`、`ask_approval`、全局硬上限、审计表、`unknown` 不重发 | 用 FakeDriver 夹具跑限额与审批的混沌测试；真机上 BOSS 求简历 20 次全部有审计记录 |
| P4 boss-agent 接入 | `RuntimeDriver`；删除 boss-agent 内与 Runtime 重叠的基础设施 | boss-agent 的 1308 个测试在 `RuntimeDriver` 上通过；真机值守一天 |
| P5 远端索引与发行 | 索引、发布流水线、`skill update`；`remotedesk-agent` 发行版 | 新机从索引安装两个技能并运行 |

每个阶段结束都留下能运行的版本。

**十二 风险与未决问题**

- **Runtime 变成关键路径**：审批、风控、模型出口都压到 Runtime 上，它必须先于技能稳定。P1 的合成技能测试和 P3 的混沌测试是对此的防线。
- **每步一次 JSONL 往返的开销**：一次 `observe` 含完整元素树可能有几百 KB。方案是 `observe` 支持子树与增量（只回 `snapshotId` 变化的部分），截图只传路径。需要在 P1 实测。
- **Python 运行时打包**：`bundled: true` 意味着技能包含 CPython，体积约 40 MB。可接受；替代方案是宿主客户端统一提供 Python，由清单声明依赖。P2 用 TypeScript 技能先行，P4 前决定。
- **沙箱程度**：技能进程没有 TCC 权限，但仍是宿主用户的普通进程，能读文件、访问网络。首版靠签名与审查约束，不做系统级沙箱；是否用 App Sandbox 或 `sandbox-exec` 包裹留作后续。
- **Windows**：协议与清单与平台无关；Runtime 的 Windows 侧依赖 `windows/` 下的 C# 核心进度，本文不展开。
- **模型出口的 key**：Runtime 本地持有 key 适合个人用户；托管用户走宿主客户端的服务端代理。两条路径都通过同一个 `model` 服务，技能无感。
- **协议版本化**：`skill-jsonl/1` 冻结后只增消息类型，不改已有字段；破坏性变更升 `/2`，Runtime 同时支持相邻两个版本一个发布周期。
- **与 Bridge 的关系**：Bridge 继续作为 Runtime 内部的探索器存在；是否把它也改写为一个 `builtin` 技能，等 P1 之后看是否有收益。

**十三 与现有文档的关系**

- `docs/task-runtime-contracts.md`：P1 时新增"技能包 v2"与"Skill JSONL 协议"两节，"安全边界"一节的 `submitAllowed=false` 改写为第七节的授权模型。
- `docs/skill-runtime-boss-plan.md`：其"首版不包含主动打招呼、求简历、自动回复"的边界由本文的 P3 与 P4 接续。
- `README.md`："Skill tasks"一节增加 `2ndscreen skill` 命令与注册表位置。
