# 任务 A 交付报告：契约、协议与 API 规范

Worker：claude-opus-5-5，分支 `szrunworld/monitor-A`（工作区 monitor-A），契约版本 0.1.0。

## Commit 列表

| commit | 内容 |
| --- | --- |
| `4f033c7` | uv 工作区根、contracts 成员、8 个 JSON Schema + common.json、`monitor_contracts` 包（模型、validate_*、状态机、event_id、幂等键、Driver/Action/Observer/Ledger Protocol）、夹具格式 schema、测试向量、uv.lock。按协调者要求优先提交，供任务 C 使用 Driver 协议 |
| `a76c0a1` | openapi.yaml、`FixtureElement`、全部 pytest 测试 |
| `d4ed4b6` | `docs/monitor/contracts.md`、`docs/monitor/api.md` |
| （本报告所在 commit） | `docs/monitor/agent-reports/A.md` |

## 运行过的测试命令与结果

| 命令 | 结果 |
| --- | --- |
| 全新 clone（`git clone --branch szrunworld/monitor-A`）后 `cd monitor && uv sync && uv run pytest contracts` | 168 passed |
| `cd monitor && uv run pytest contracts`（工作区） | 168 passed |
| `cd monitor && uv sync --locked` | 通过（lock 与 pyproject 一致） |
| `uv run openapi-spec-validator contracts/openapi.yaml` | `contracts/openapi.yaml: OK` |
| 把 openapi 中一个外部 `$ref` 改成不存在的文件后再校验（临时副本） | 报 `Unresolvable: ./schemas/nope.json`，说明校验器确实解析了外部引用 |

开发中出现过、已修复的失败：
1. 夹具元素往返序列化时多出 `snapshot_id`，导致 schema 拒绝。修复方法是新增不带 snapshot_id 的 `FixtureElement`。
2. `oneOf: [对象, null]` 内部的错误只报成"不符合任一形状"。修复后改为报告唯一可能分支内的字段级错误，例如 `last_error.scene`。

测试覆盖：
- 向量：合法 37 个、非法 41 个。每个契约至少各有 1 个合法和 1 个非法样本。每个非法样本都声明了期望的字段路径并逐一断言；语义层样本断言 `layer=model`。合法样本还做了"校验 → to_wire → 再校验"的往返检查。
- schema 与模型的一致性：action、status、reason、kind、coverage、mode、exchange 的枚举逐一比对；每个 action 和每个 kind 都有 payload 规则；三处版本号一致。
- 状态机：方案第六、七节列出的全部状态都在；case、command、delivery 三层分别与测试中独立写出的期望迁移集做全矩阵比对；第七节异常表逐行检查；终态、自迁移、未知状态名都有测试。
- event_id：金标准值（附展开后的字节串）、hints 顺序与空白及 NFC 规范化不影响结果、每个输入变化都会改变 id、非法输入报错、`observation_bucket` 的取整。
- 其他：幂等键、Driver 模型与错误分类、Protocol 可以被结构化实现满足、LedgerCommand 与 MonitorState 的规则、openapi（必需端点齐全、所有写操作都带 Idempotency-Key、二维码读取有 410、消息体引用了对应的 schema 文件）。

## 契约缺口裁决（已按协调者答复实现）

1. 新增事件 kind `conversation_ambiguous`；"不支持的呈现"走 `heartbeat.last_error`（`code=unsupported_presentation` + `scene`）。
2. 指令新增 `execution_mode: execute|verify_only`。verify_only 不受限额、间隔和白名单约束，只适用于会话类动作。
3. 联系方式事件不带号码；`exchange_state` 增加 `unknown`；契约中没有预留号码字段。
4. 会话类动作的 `workflow_id` 必填；search_candidates 和 provide_input 的 `workflow_id` 为 null。
5. reason 与 status 的约束见 contracts.md 第四节；reason 枚举包含协调者列出的 10 个，另加 captcha、account_mismatch、paused、dependency_not_satisfied、verification_failed、driver_error、crash_recovery。
6. 已提交 `monitor/uv.lock`。

## 未覆盖项

- **openapi 的 API 专用响应体**：Device、CaseDetail 等写在 openapi.yaml 的 components 里，没有对应的 pydantic 模型，也没有测试向量。F1 要做"代码导出的 openapi 与 yaml 一致性测试"，届时这些响应体会被覆盖。
- **夹具 schema 的脱敏检查**只拦截中国大陆手机号样式的 11 位数字，查不出微信号和真实姓名，仍需人工抽查。
- **语义规则只在 Python 层**：`result_ref` 前缀、`event_id` 重算、`expires_at` 晚于 `issued_at` 这类跨字段规则只在 pydantic 层检查；只用 JSON Schema 的消费方（例如控制台 TS 代码）不会执行这些规则。
- **wheel 打包未实际构建**：hatch 的 force-include 会把 schemas 打进 wheel，但我没有构建 wheel 验证这一点，工作区里用的是可编辑安装。ax-fixture schema 在 wheel 中会找不到，只有源码布局下可用。

## 对其他任务的接口说明

- **全体**：只用 `from monitor_contracts import ...` 导出的名字。校验用 `validate_<name>` / `check(name, data)`；序列化用 `model.to_wire()`；字段错误路径形如 `items[0].result_ref`。
- **C（Driver）**：协议在 `driver.py`，与协调者建议的差异已在 4f033c7 的通知里说明。`Element` 带 `snapshot_id`，Driver 填写后用来检测快照过期并抛 `StaleSnapshotError`。`Locator` 多了 `right_of`。写方法失败必须抛 `DriverError` 子类。`FakeDriver` 回放夹具时用 `FixtureElement.to_element(snapshot_id)` 生成元素。
- **D1（账本）**：实现 `Ledger` Protocol；迁移一律调用 `require_transition`；`LedgerCommand` 的规则（终态必须有 result 和 delivery）可以直接复用。
- **D2（管线）**：每日上限和最小间隔的硬常量由 D2 定义，不在契约里。用 `ActionResult.to_command_result(command, reported_at=...)` 组装结果；用 `idempotency.*_key` 生成请求头。
- **E（观察）**：`Observer.observe(driver, baseline)` 可以就地更新 baseline；event_id 必须用 `compute_event_id`；bucket 的选择规则见 contracts.md 9.1。
- **F1/F2/F3（服务端）**：严格按 openapi.yaml 实现。事件与结果用 `check()` 校验后，把错误填进 Problem.errors。CommandServerStatus 比 Monitor 的状态多了 pending、claimed、acked 三个服务端前置状态。
- **G（邮件）**：用 `POST /resume-documents`，其中 `link.method` 记录关联依据；用 `GET /commands?action=forward_resume&status=succeeded&executed_after=` 查询转发记录。
- **H1–H3（动作）**：白名单关闭时返回 `failed/action_not_allowed`，且不调用任何写方法。search 读不出时返回 `failed/unreadable`，并在 output 中带上 coverage=unreadable 的快照。contact 的 skipped_precondition 也必须带 output。
- **I1/I2（控制台）**：可以从 openapi.yaml 生成客户端（外部 `$ref` 指向 `./schemas/*.json`）。搜索按 `SearchRun.outcome` 分三种状态展示。"结果待确认"只有 recheck、confirm-sent、stop 三个操作，契约中没有重试接口。
- **K（登录接力）**：二维码内容只走 `POST /login-qr`；`login_qr` 事件不带内容；local 模式不得调用该接口。

## 已知限制

- 状态机中有几条迁移是我按方案推断的，方案没有明说，见 contracts.md 8.1：`new_application/greeted → resume_received`（候选人主动发简历）、`resume_requested → resume_linked`（邮件先于界面观察到达）、`running → cancelled`（仅限尚未发生写操作）。若产品不认可，需要修改迁移表并把版本 +1。
- `ActionReceipt.method` 是自由字符串（如 ax_press、event、paste），没有做成枚举。
- openapi 中对设备离线（90 秒）、租约时长、Idempotency-Key 保存 24 小时等数值只做了文字约定，具体值由 F1 实现并写入配置。
- 本任务只产出契约，夹具通过不代表真机行为。BOSS 客户端相关的结论都要等 B、N 的证据。
