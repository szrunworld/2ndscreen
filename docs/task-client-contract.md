# 任务客户端契约（C03 草案，版本 0）

产品界面（Agent Desktop 主窗口、独立业务 App、受管 CLI/MCP 客户端）通过一个薄的 TaskClient 读取任务视图并发出控制请求。本契约固定界面需要的字段与语义；Runtime 侧由 C03 实现真实查询与按任务控制。界面只读结构化字段，不解析供人阅读的文本，不在客户端另建状态机、调度器或预算器。

状态：草案，供 A02 建类型与样例数据。字段名在 C03 落地前可以改，语义不变。

## 1 身份与作用域

两套协议、一个宿主。原生控制协议（`host.info`，C02）回答"谁在这个 endpoint 上"；任务协议（本契约）回答"任务服务能做什么"。二者由同一个宿主进程提供，`host.pid` 与 `task` 的来源进程一致；客户端先核对 `host`，再核对 `task.protocolVersion`。

```ts
/** 回答这次请求的服务是谁。每个响应都带，客户端据此核对自己连的是哪一个实例。 */
interface ServiceIdentity {
  host: {
    product: string;                 // "Agent Desktop" | "2ndscreen" | 独立业务 App 名
    bundleId: string;                // 宿主进程的 bundle id
    pid: number;
    controlProtocolVersion: string;  // 原生控制协议版本（ControlProtocol.version，当前 "1"）
    engineRevision: string;          // 2ndscreen 提交
  };
  task: {
    protocolVersion: string;         // 本契约版本，当前 "0"
    runtimeVersion: string;          // task-runtime 版本
    capabilities: string[];          // "task.view" "task.control" "task.artifacts" "agent.host" …
  };
}

/** 请求方的作用域：只看见、只控制属于自己的任务。 */
interface ClientScope {
  clientId: string;         // 产品或 App 的稳定标识（C02 验证进程与签名身份后填入）
  agentIds?: string[];      // 为空表示该客户端接入的全部 agent
}
```

## 2 任务视图

两类任务（skill 任务与 agent 任务）统一成一个视图。原始状态保留在 `raw` 里，界面只用统一字段。

```ts
type TaskKind = 'skill' | 'agent';

/** 统一状态。界面按它选文案与按钮，不看 raw。 */
type TaskUiState =
  | 'queued'        // 已提交，等待执行者
  | 'running'       // 执行者正在动作
  | 'waiting'       // 等人：审批、回答、登录、人工核对（见 waiting）
  | 'pausing'       // 暂停请求已受理，执行者尚未停下
  | 'paused'        // 执行者已停，可恢复
  | 'stopping'      // 取消请求已受理，执行者尚未停下
  | 'cancelled'     // 执行者已停，不再恢复
  | 'succeeded'
  | 'partial'       // 部分完成，有可解释的说明
  | 'failed'
  | 'interrupted'   // 执行者非正常消失，恢复前需核对
  | 'unknown';      // 服务无法判断执行者是否仍在动作（见 executor）

type Operation = 'pause' | 'resume' | 'cancel' | 'approve' | 'deny' | 'answer' | 'bind_account' | 'open_output' | 'resubmit';

interface TaskView {
  id: string;
  kind: TaskKind;
  agentId: string;            // skill 任务为 builtin:<skill id>
  taskType: string;           // skill id 或 agent 的 task type
  scope: { clientId?: string; agentId: string };
  state: TaskUiState;
  raw: { status: string; phase?: string; lifecycle?: string };  // 账本里的原始值，供诊断
  waiting?: {
    reason: string;           // 稳定码：login_required | approval | question | captcha | account_changed | model_unavailable | budget_exhausted | skill_missing | ...
    since: string;            // ISO 时间
    resolvedBy: 'user' | 'approval' | 'external' | 'operator';
    inboxId?: string;         // 对应待处理项
  };
  updatedAt: string;          // 账本最后一次变化
  heartbeat?: { at: string; stale: boolean };   // 执行者最近心跳；stale 为真时界面不得显示"正在执行"
  progress?: { current?: string; counts?: Record<string, number> };  // 当前对象与计数，不编造百分比
  allowed: Operation[];       // 此刻服务允许的操作；界面只渲染这里有的按钮
  executor?: { ownerPid?: number; epoch?: string; stopped: boolean };  // stopped 为真才算执行者已停
  error?: { code: string; message: string };
  result?: {
    summary?: string;
    outputPath?: string;
    verification: { platform: 'passed' | 'failed' | 'none'; business: 'passed' | 'failed' | 'none'; notes?: string[] };
  };
  artifacts: Array<{ id: string; path: string; kind: string; sha256?: string; verified: boolean }>;
  usage?: { modelCalls: number | 'unknown'; inputTokens: number | 'unknown'; outputTokens: number | 'unknown'; cost?: number | 'unknown' };  // cost 为小数（货币单位见 prices.json）
  submittedAt?: string;
  startedAt?: string;
  endedAt?: string;
}
```

### 2.1 从现有账本到统一状态

| 现有 | 统一 `state` |
| --- | --- |
| skill 任务 `queued`，已发布 | `queued` |
| skill 任务 `queued`，未发布（publication_missing） | `waiting`，reason `publication_missing` |
| skill 任务 `queued`/`running`，本 runtime 无该包（skill_missing） | `waiting`，reason `skill_missing` |
| `running`，心跳新鲜 | `running` |
| `running`，pause_requested 未 pause_applied | `pausing` |
| `running`，worker 生命周期 exited、未处理 | `interrupted` |
| `waiting_user` | `waiting`，reason 取 waitReason |
| `paused` | `paused` |
| `cancelling`，执行者未证实停止 | `stopping` |
| `cancelled` | `cancelled` |
| `succeeded` / `partial` / `failed` | 同名 |
| agent 任务 `queued`/`running`/`succeeded`/`partial`/`failed` | 同名；`failure: 'interrupted'` → `interrupted` |
| 执行者退出未证实（unprovenNoted） | `unknown` |

## 3 控制回执

```ts
interface ControlRequest {
  taskId: string;
  operation: Operation;
  payload?: OperationPayload[Operation];   // 任意 JSON，按操作固定（见下）
  requestId: string;                       // 客户端生成，幂等
}

/** 每个操作的输入。没有列出的操作不带 payload。 */
interface OperationPayload {
  pause: undefined;
  resume: undefined;
  cancel: undefined;
  approve: { inboxId: string; decision: 'grant' };
  deny: { inboxId: string; reason?: string };
  answer: { inboxId: string; answer: string };
  bind_account: { platform: string; accountKey: string };
  open_output: undefined;                        // 客户端本地动作，不发给服务
  resubmit: { input: Record<string, unknown> };  // 与原任务同类型的新输入
}

/** 待处理项，供 approve/deny/answer 渲染并核对；由 `task inbox` 给出，字段与 agent-inbox.ts 对齐。 */
interface PendingItem {
  id: string;                  // inboxId
  kind: 'approval' | 'question' | 'login' | 'review';
  taskId: string;
  agentId: string;
  createdAt: string;
  expiresAt?: string;
  action?: { effect: string; app: string; target?: string; label: string };  // 审批绑定的具体动作
  question?: string;
}

interface ControlReceipt {
  requestId: string;
  taskId: string;
  operation: Operation;
  accepted: boolean;                   // 服务是否受理
  acceptedAt?: string;
  reason?: { code: string; message: string };   // 未受理的原因
  executorStopped: boolean;            // 受理时执行者是否已经停下；多数情况下为 false
  settlesTo: TaskUiState[];            // 受理后任务会落到的状态，界面据此等待
}
```

语义：

- `accepted` 只表示请求已记录到账本并将由执行者或守护进程处理。它不等于执行者已停。
- 用户点取消后：收到 `accepted: true, executorStopped: false` → 显示"停止中"；之后轮询或订阅 `TaskView`，`state` 变为 `cancelled` 且 `executor.stopped === true` 才显示"已停止"。暂停同理（`pausing` → `paused`）。`executor` 缺失时没有停止证据，界面继续显示"停止中/暂停中"并说明缺少执行端证据。
- 回执文案按操作区分：`pause`/`cancel` 等待执行端停止；`resume`/`answer`/`approve`/`deny`/`bind_account` 按各自的 `settlesTo` 显示进度（例如 resume → `queued`/`running`，answer → 离开 `waiting`），不套用"停止中"。
- 服务绝不会用"停止整个 host"来兑现"取消一个任务"。按任务取消要有自己的回执与停止证据。
- 同一 `requestId` 重复提交返回同一回执。
- 对 `unknown` 状态的任务，`resume` 与 `resubmit` 不在 `allowed` 里，直到人工核对（`answer` 或 `approve` 一个核对项）之后。

## 4 错误码

沿用 RuntimeError 的 `code`，新增两个服务级错误：

| code | 含义 | 界面处理 |
| --- | --- | --- |
| `capability_missing` | 服务没有这项能力（如未装 runtime、未注册 workflow） | 显示缺失能力与获取方式 |
| `not_found` | 任务不存在或不在作用域内 | 从列表移除 |
| `conflict` | 状态不允许该操作 | 刷新视图 |
| `invalid_input` | 请求内容不合法 | 显示字段错误 |
| `lease_held` | 另一执行者占用 | 显示占用方 |
| `offline` | 服务未运行或 endpoint 无人监听 | 显示离线，提供启动入口 |
| `version_mismatch` | `protocolVersion` 不兼容 | 显示升级/等待 |

## 5 传输

第一版通过 CLI JSON 行，和现有 `task` 子命令同一进程、同一检查链：

```
2ndscreen task view TASK_ID            → { ok, service: ServiceIdentity, task: TaskView }
2ndscreen task views [--agent ID] [--state S,...] [--limit N]
                                       → { ok, service, tasks: TaskView[] }
2ndscreen task control TASK_ID OPERATION [--request-id ID] [--payload JSON]
                                       → { ok, service, receipt: ControlReceipt }
2ndscreen task service                 → { ok, service }
```

现有 `status`/`outcome`/`pause`/`resume`/`cancel`/`artifacts` 保留，语义不变；新命令是它们之上的统一读写层。后续换成 socket 或事件订阅时保留本契约的字段。

## 6 共享样本

`docs/task-client-contract.sample.json` 是一份按本契约构造的响应样本（`views` 的输出），Runtime 侧的序列化测试与产品侧的 Swift 解码测试都以它为准；改契约先改样本。

## 7 验收（C03 实现时）

- `view` 对 skill 任务与 agent 任务返回同一结构；每一行映射表有一个用例。
- 取消一个排队、运行、等待审批中的任务：回执 `accepted` 后，任务最终 `cancelled` 且 `executor.stopped`；另一个任务不受影响；host 仍在运行。
- 心跳过期的任务 `heartbeat.stale === true`，`state` 不是 `running`。
- 作用域外的任务 `not_found`。
- 产品界面（A02）用样例数据渲染全部 `TaskUiState` 与 `allowed` 组合，再接真实 `view`。
