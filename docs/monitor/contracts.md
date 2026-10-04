# 招聘 Monitor 契约说明

契约版本：`monitor_contracts.__version__ = "0.3.0"`（2026-10-04）。本文说明 `monitor/contracts/` 的产物，是[方案](monitor-spec.md)第六、七节的落地版本。HTTP 接口见 [api.md](api.md)。

本文中"已验证"只表示 `uv run pytest contracts` 通过的契约层行为，不代表 BOSS 客户端上的任何能力。

## 一、产物与用法

| 产物 | 位置 | 用途 |
| --- | --- | --- |
| JSON Schema（draft 2020-12） | `monitor/contracts/schemas/*.json` | 线上消息格式的权威定义；服务端、控制台、Monitor 共用 |
| `monitor_contracts` 包 | `monitor/contracts/monitor_contracts/` | pydantic v2 模型、`validate_*`、状态机、`compute_event_id`、Protocol |
| 夹具格式 | `monitor/fixtures/schema/ax-fixture.schema.json` | B 录制、C 回放、E/H 测试的脱敏元素树格式 |
| OpenAPI | `monitor/contracts/openapi.yaml` | 服务端 HTTP 接口；消息体直接 `$ref` 上面的 schema |
| 测试向量 | `monitor/contracts/tests/vectors/{valid,invalid}/` | 合法 42 个、非法 58 个，其他任务可直接拿来做 fake 数据 |

```sh
cd monitor && uv sync && uv run pytest contracts
```

其他成员在自己的 `pyproject.toml` 中依赖 `monitor-contracts`（`[tool.uv.sources] monitor-contracts = { workspace = true }`），然后 `from monitor_contracts import ...`。只依赖 `__init__.py` 导出的名字，不要 import 下划线开头的模块。

### 校验分两层

`validate_<name>(data)` 先跑 JSON Schema（结构、枚举、按 action/kind 的形状），有错就停；结构通过后再跑 pydantic（跨字段语义：时间先后、`result_ref` 前缀、`event_id` 是否等于计算值等）。两层的错误都转成 `FieldError(path, message, code, layer)`，路径形如 `payload.text`、`items[0].result_ref`，任何失败都抛 `ContractValidationError`（`.errors`、`.paths`）。只要错误列表、不想抛异常时用 `check(name, data)`。

可校验的契约名：`command`、`command_result`、`event`、`search_snapshot`、`policy`、`device_registration`、`device_heartbeat`、`login_qr`、`mail_message`、`mail_verification`、`ax_fixture`。

模型序列化成线上 JSON 用 `model.to_wire()`（即 `model_dump(mode="json")`）。可选字段在线上允许为 `null`。

## 二、公共约定

- 时间一律是 RFC 3339 且必须带时区（`format: date-time` + pydantic `AwareDatetime`）。
- 所有对象 `additionalProperties: false`：多余字段是错误，不会被静默忽略。
- `conversation` = `{candidate_name, job_title, hints[]}`。Monitor 只有在三者全部一致时才算命中；多处命中就是歧义，不执行。`hints` 里不放手机号、微信号。
- `evidence` 只放脱敏后的元素文本摘录（每条不超过 500 字，最多 50 条），不能放截图或二进制。`observed.before/after` 是 `{code, detail}` 形式的界面事实，`code` 用 snake_case。
- 敏感字段（`provide_input.payload.value`、`enrollment_code`、`qr_payload`）在 pydantic 模型中 `repr=False`，不会出现在日志或异常文本里，但 `to_wire()` 会保留原值。

## 三、指令 command（服务端 → Monitor）

公共字段：`command_id`（UUID）、`workflow_id`（case_id，会话类动作必填，其余必须为 null）、`account_id`、`action`、`execution_mode`（`execute` | `verify_only`，默认 execute）、`target`、`payload`、`issued_at`、`expires_at`（必须晚于 issued_at）、`depends_on`（前置指令，可空，不能指向自己）。

`execution_mode=verify_only`：对应控制台的"重新检查界面状态"。这类指令只调用 `ActionHandler.verify_only`，不受每日上限、最小间隔和白名单开关约束。它允许导航（打开会话、切页签、滚动），不允许任何对外动作，结果的 `outbound_action_performed` 必须为 false（见第四节）。它只用于会话类动作，`search_candidates` 和 `provide_input` 必须是 `execute`。

| action | target | payload | output（结果中） |
| --- | --- | --- | --- |
| `send_greeting` | 会话目标 | `{text}` 1–500 字 | 无 |
| `request_resume` | 会话目标 | `{}`（不接受参数） | 无 |
| `request_contact_exchange` | 会话目标 | `{exchange_type: "phone"}` | `{exchange_type, exchange_state}` |
| `search_candidates` | `{scope: "current_page"}` | `{search_id, query, max_results 1–100}` | `{snapshot}` |
| `provide_input` | `{input_request_id}` | `{value}` 1–64 字 | 无 |

会话目标 = `{conversation, candidate_ref?}`。`candidate_ref` 是服务端的候选人引用，Monitor 只回显、不用来定位。

**v1 只能以会话为目标**（用户 2026-10-04 决定）：`send_greeting` 等会话类动作的目标只能是会话列表里的会话，不能是搜索结果。0.3.0 删除了会话目标里的 `result_ref`，带上它会被校验器拒绝。以后若要从搜索结果发起问候，需要契约新增"搜索结果"目标，并在执行时重新定位、核对身份。

**`forward_resume` v1 不支持**（用户 2026-10-04 决定）：简历由 BOSS 在候选人同意后自动发到公司预留邮箱，Monitor 不转发。0.3.0 把它从 action 枚举、payload/output、结果规则、策略白名单与上限、设备能力中全部移除。名字保留，以后需要时再加回（契约版本 +1）。

各动作说明：

- **send_greeting**：问候。服务端已按策略模板渲染好 `text`，Monitor 不再拼接。执行前要核对目标会话，执行后要读到聊天区出现该文本才算 succeeded。结果为 `unknown` 时，服务端不自动推进求简历（方案 8.1 第 5 条）。
- **request_resume**：请求简历。界面已有"已请求"标记时返回 `skipped_precondition`（`reason=precondition_already_done`）。执行后要读到请求消息出现才算成功。只允许点击 N 阶段记录的那一个确认按钮。成功结果的 `executed_at` 是邮件关联的时间窗起点：候选人同意后，BOSS 会把附件简历自动发到公司邮箱（第七节"公司邮箱"）。
- **request_contact_exchange**：交换联系方式，第一版只支持电话（以后加微信时契约版本 +1）。界面已是 `available` 或 `pending_acceptance` 时返回 `skipped_precondition` 并在 output 中给出当前状态。点击并确认请求已发出时返回 succeeded，`exchange_state=requested`。succeeded 和 skipped_precondition 都必须带 output。"请求已发送"是指令结果，"联系方式可用"是业务事件 `contact_exchange_updated`，两者不要混用。v1 契约不传号码原文。
- **search_candidates**：在当前页搜索，不翻页，`workflow_id` 为 null。见第五节。
- **provide_input**：把控制台人工输入的值（如短信验证码）代填到 `human_input_required` 所指的输入框。值不得写入日志或 evidence。

## 四、结果 command_result（Monitor → 服务端）

字段：`command_id`、`action`、`execution_mode`、`status`、`reason`、`reason_detail?`、`observed`、`evidence`、`navigation_performed`、`outbound_action_performed`、`externally_visible_side_effect`、`executed_at`、`reported_at`、`output`。

跨字段规则（JSON Schema 与 pydantic 都会检查）：

| 条件 | 规则 |
| --- | --- |
| `status=succeeded` | `reason` 必须为 null，`executed_at` 必填 |
| `status ∈ {failed, unknown, skipped_precondition}` | `reason` 必填 |
| `status ∈ {cancelled, expired}` | `executed_at` 必须为 null |
| `status=cancelled` | `outbound_action_performed=false`（导航过可以取消，`navigation_performed` / `externally_visible_side_effect` 如实填写） |
| `status=expired` | 三个标志都为 false |
| `execution_mode=verify_only` | `outbound_action_performed=false`（允许导航） |
| `outbound_action_performed=true` | `externally_visible_side_effect=true` |
| `search_candidates` + succeeded | 必须带 `output.snapshot`，且 coverage 不能是 unreadable |
| `request_contact_exchange` + succeeded/skipped_precondition | 必须带 `output.exchange_state` |
| greeting / resume / provide_input | output 必须为 null |

`reason` 枚举：

| reason | 含义 |
| --- | --- |
| `action_not_allowed` | 白名单未开启该动作（不调用 driver） |
| `rate_limited` | 触发每日上限或最小间隔（不调用 driver） |
| `target_ambiguous` | 目标多处命中 |
| `target_not_found` | 找不到目标会话或按钮 |
| `unknown_dialog` | 出现未知弹窗，没有点击任何未知控件 |
| `login_required` | 登录失效 |
| `captcha` | 验证码或风控 |
| `account_mismatch` | 有证据表明客户端当前账户与指令账户不一致。v1 仅在有证据时使用（例如界面出现账户切换提示），目前没有检测手段，见第七节"账户来源" |
| `paused` | 设备已暂停，指令未开始 |
| `dependency_not_satisfied` | `depends_on` 的指令没有 succeeded（包括 unknown） |
| `timeout` | 在上限时间内等不到可识别的结果状态 |
| `unreadable` | 界面读不出（例如搜索结果是图片） |
| `unsupported` | 当前版本不支持（例如 Monitor 收到了自己没有处理器的动作） |
| `precondition_already_done` | 动作已经发生过（skipped_precondition 时使用） |
| `verification_failed` | verify_only 确认动作没有发生，或执行后验证不通过 |
| `driver_error` | Driver 抛出窗口丢失、屏幕丢失、CLI 失败等错误 |
| `crash_recovery` | 崩溃恢复后 verify_only 仍然无法确认（配合 unknown） |

### 执行标志（0.2.0 起替代 `gui_write_performed`）

三个布尔标志在线上必填（缺省会把"忘了填"误当成"什么都没做"）；`ActionResult` 里默认 false，处理器必须如实设置。

| 标志 | 含义 | 例子 |
| --- | --- | --- |
| `navigation_performed` | 发生过只改变本机界面的 GUI 操作 | 点击打开会话、切换页签或筛选、滚动、关闭弹层、在搜索框输入关键词 |
| `outbound_action_performed` | 发生过对候选人或第三方可见的动作 | 发送消息、点击确认、提交转发、点击求简历 / 换电话、代填并提交验证码 |
| `externally_visible_side_effect` | 本次执行可能产生了对方可见的副作用 | 对外动作一定算；只打开未读会话也可能产生已读回执，此时没有对外动作但为 true |

服务端用 `outbound_action_performed` 区分"取消前确实没有对外动作"和"做了但结果不明"，用 `externally_visible_side_effect` 判断候选人是否可能已经察觉（例如已读）。白名单关闭、限额、暂停、依赖未满足时 handler 不调用 driver，三个标志都为 false。

与状态机的关系：`running → cancelled` 仅限 `outbound_action_performed=false`。已经导航（甚至已产生已读回执）但还没点任何对外按钮时可以取消，如实填写另外两个标志；对外动作已经发生时不能回报 cancelled，必须回报实际结果。`expired` 只从 `queued` 进入，三个标志都为 false。

## 五、搜索快照 search_snapshot

`{search_id, query, scope: "current_page", coverage, unreadable_reason?, items[], captured_at}`。

搜索结果**不需要识别身份**（用户 2026-10-04 说明）：Monitor 只回答"有 / 没有"，并把每张结果卡片上界面已有的可读文本原样返回。身份确认、使用道具卡找人由公司自己的流程完成，Monitor 不做。0.3.0 起每张卡片是：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `result_ref` | 是 | `<search_id>:item_<position>`，本次快照里的位置 |
| `position` | 是 | 卡片在当前页的顺序，从 1 起，自上而下；必须等于 `result_ref` 末尾的序号 |
| `fields[]` | 是，≥1 条 | `{label?, text}`：卡片上界面已有的全部可读文本，按出现顺序原样给出（打码姓名、学历、院校、经验、年龄、标签、期望、活跃状态等）。`label` 只在界面上确有可见标签时填写，没有就是 null，不要自行命名或归类 |
| `masked_name` | 否 | 平台打码后的姓名原文（如「王**」），读不到为 null。不是身份 |
| `prop_card_texts[]` | 是，可为空 | 卡片上与道具卡相关的元素文案，原样给出。Monitor 不点击、不使用道具卡 |

0.2.0 的 `display_name`、`summary`、`stable_candidate_id` 已删除。所有卡片文本都不得含中国大陆手机号样式的 11 位数字（schema 与模型两层都检查）；这只是兜底，Monitor 本来就不读联系方式。

| coverage | items | 结局 `snapshot.outcome` | 指令 status |
| --- | --- | --- | --- |
| `complete` / `partial` | 至少 1 条 | `results` | succeeded |
| `empty_confirmed`（界面明确显示无结果） | 必须为空 | `no_results` | succeeded |
| `unreadable` | 必须为空，且必须填 `unreadable_reason` | `unreadable` | failed + `reason=unreadable` |

`unreadable` 和 `empty_confirmed` 的 items 都是空的，区分只靠 coverage。消费方必须按 `outcome` 分三支处理，不能用"items 是否为空"判断有没有结果。读取失败不得回报为空列表，校验器会拒绝 `unreadable` + succeeded 的组合。

`result_ref` 的格式是 `<search_id>:item_<n>`（n 从 1 开始，等于 `position`），前缀必须等于 `search_id`，同一快照内不能重复。它只是本次快照里的位置，不是候选人身份，**也不能作为任何指令的目标**（见第三节）。coverage 与三种结局的规则 0.3.0 未改。

## 六、事件 event（Monitor → 服务端，经 outbox 补传）

公共字段：`event_id`、`device_id`、`account_id`（会话类事件必填；登录类和暂停事件在未绑定账户时可以为 null）、`kind`、`conversation`、`bucket`、`observed_at`、`payload`。`event_id` 必须等于 `compute_event_id(account_id, kind, conversation, bucket)`，校验器会重新计算。

| kind | conversation | payload | 说明 |
| --- | --- | --- | --- |
| `application_observed` | 必填 | `{marker_text?, evidence}` | 只对能明确识别为"新投递"的会话产生，普通未读不算。首次启动和 needs_baseline 时只建基线，不产生事件。识别规则来自 B 的夹具标注 |
| `attachment_available` | 必填 | `{attachment_name?, evidence}` | 会话中出现可用的附件简历。只是可选观察：服务端可据此把流程记为 `resume_received`，但简历文件只从公司邮箱读取，不据此下发任何指令 |
| `contact_exchange_updated` | 必填 | `{exchange_type, exchange_state, evidence}` | observe 看到交换状态变化（例如候选人同意）。v1 不带号码原文 |
| `conversation_ambiguous` | 必填 | `{match_count ≥ 2, candidates[≥2]{position, hints, summary?}, evidence}` | 同一岗位下出现同名会话。服务端转人工处理，不建立新投递。candidates 只放脱敏摘要 |
| `login_required` | null | `{reason, mode}` | 登录失效或回到登录页。Monitor 暂停对外动作。local 模式只通知用户在本机登录 |
| `login_qr` | null | `{qr_seq, expires_at}` | 仅 remote 模式。只通知二维码已更新，二维码内容只经 `POST /login-qr` 上传，过期即删，不进事件表 |
| `login_ok` | null | `{mode, account_display?}` | 登录完成。服务端撤下二维码卡片 |
| `human_input_required` | 可空 | `{input_request_id, input_kind, prompt_text, can_fill}` | 需要人工输入（短信验证码等）。slider、confirm_on_phone、unknown 时 `can_fill` 必须为 false，只上报并等待人工 |
| `blocked_by_dialog` | 可空 | `{dialog_kind, dialog_text, buttons[], command_id?}` | 验证码、风控、配额或未知弹窗阻断。Monitor 暂停相应执行，不点任何未知控件 |
| `device_paused` | null | `{reason, by, detail?}` | 设备进入暂停（用户、登录、换账户、异常、服务端要求、重建基线） |

"不支持的呈现"（E 识别到的界面形态不在规则内）不单独占一个事件 kind，而是放在 `device_heartbeat.last_error`：`code=unsupported_presentation`，必须填 `scene`（页面类别），同一呈现只上报一次。

## 七、其他消息

- **policy**：账户级策略。字段包括 `policy_version`（PUT 用 If-Match 做乐观锁）、`allowed_actions`（对外动作白名单，默认空即全部关闭；provide_input 和 verify_only 不受它控制）、`job_scope`、`greeting{enabled, template}`、`auto_request_resume`、`after_resume_received{action, wait_for_parse}`、`resume_mail_timeout_days`、`company_mailbox`、`work_hours`（IANA 时区 + 窗口，空窗口表示任何时段都不生成对外指令）、`daily_limits` 与 `min_interval_seconds`（四个对外动作各一项：send_greeting、request_resume、request_contact_exchange、search_candidates）、`pause_on_anomaly`（只能为 true）、`paused`。Monitor 本地另有写死的硬上限和最小间隔下限，策略只能收紧、不能放宽。这些常量由 D2 定义，不在契约里。
  - `after_resume_received.action` 默认 `none`（0.3.0）：收到并关联简历后**不**自动交换联系方式；`wait_for_parse` 默认 true。线上仍必须写全，默认值只用于模型构造和控制台初始值。交换联系方式的类型（`exchange_type`）本版未改，等用户确认后在 0.3.1 处理。
  - `resume_mail_timeout_days`（默认 3，范围 1–30）：求简历成功后超过该天数仍未收到并关联简历邮件，服务端把流程转 `needs_human`（`needs_human_reason=resume_mail_timeout`），核对任务也会把它列为提醒。
  - `company_mailbox`：BOSS 账户设置里预留的公司邮箱，只读展示，以服务端配置为准；PUT 时服务端忽略请求里的值。未配置时为 null。不加 `resume_route`：v1 只有这一条简历路线。
- **device_registration**：`POST /devices` 的请求体。字段包括 `enrollment_code`、`device_name`、`mode`、`platform`、`monitor_version`、`contracts_version`、`capabilities`。local 模式不能声明 `login_relay`。
- **device_heartbeat**：默认 30 秒一次。字段包括 `mode`、`account_id`（绑定账户，见下文"账户来源"）、`client_state`、`paused` + `pause_reason`（paused 时必填）、`needs_baseline`、`current_action`、`queue{queued_commands, undelivered_results, outbox_events}`、`last_error`、`monitor_version`。
- **login_qr**：`POST /login-qr` 的请求体。字段包括 `device_id`、`account_id?`、`qr_payload`（本地解码出的文本，不是图片）、`qr_seq`（内容每变一次 +1）、`captured_at`、`expires_at`（必须晚于 captured_at）、`decoder`。

### 公司邮箱 mail_message / mail_verification（0.3.0）

简历路线（用户 2026-10-04 二次决定）：新投递 →（可选）问候 → 求简历 → 候选人同意 → BOSS 按账户设置把附件简历自动发到公司预留邮箱 → 邮件接入（G）读取、关联、解析。Monitor 不参与这一段。

**mail_message**：公司邮箱里的一封邮件，邮件接入先把原始 .eml 落盘，再以 `pending` 写入（`PUT /mail-messages/{mail_message_id}`），处理后更新状态。

| 字段 | 说明 |
| --- | --- |
| `mail_message_id` | 记录主键，`mail:` + 32 位十六进制，由 `compute_mail_message_id` 确定性生成（见下）。不是邮件头 Message-ID |
| `mailbox` | 收件邮箱 |
| `message_id` | 邮件头 Message-ID 原文，缺失时为 null |
| `uidvalidity`、`uid` | IMAP 游标；同时给出或同时为 null。`message_id` 为 null 时必须给出 |
| `received_at`、`sha256`（原始 .eml）、`raw_storage_uri?`、`from_address?`、`subject?` | 原件信息。sha256 只用于去重与核对，不是候选人身份 |
| `status` | `pending` 已落盘待消费；`processed` 已提交并移到 `Monitor/Processed`；`needs_review` 关联歧义或找不到流程，移到 `Monitor/NeedsReview`；`failed` 连续失败达到上限，移到 `Monitor/Failed`；`ignored` 非 BOSS 发件人，移到 `Monitor/Ignored` |
| `attempts` | 消费失败次数。未达上限的失败仍为 `pending`，attempts +1 |
| `error` | `failed` 必填；`needs_review` / `ignored` 可写原因；`pending` / `processed` 必须为 null |
| `updated_at` | 不早于 `received_at` |

`mail_message_id` 的两种来源（协调者 2026-10-04 裁决）：

```
有 Message-ID： "mail:" + sha256_hex(邮箱 + "\n" + 规范化 Message-ID)[:32]
没有 Message-ID："mail:" + sha256_hex(邮箱 + "\n\n" + UIDVALIDITY + ":" + UID)[:32]
邮箱 = 去首尾空白后转小写；规范化 Message-ID = NFC、去首尾空白、去外层尖括号（空串视为缺失）
```

有 Message-ID 时只用它，即使同时有 UID，这样换文件夹（UID 改变）后主键不变。校验器会重新计算并比对。

**mail_verification**：核对任务（方案 8.2 第 5 条）一次的结果，`POST /mail-verifications` 提交。

- `outcome`：`ok` 全部检查项 count=0；`issues_found` 至少一项 count>0；`failed` 核对本身没跑完，必须给出 `error`，`checks` 可以为空。只有 failed 能带 error。
- `checks[]`：`{code, count, refs[≤20]}`，outcome 为 ok / issues_found 时 7 个检查项必须各出现一次：`inbox_backlog`（INBOX 中超过 30 分钟未处理）、`processed_without_record`（Processed 中的邮件在数据库无记录）、`original_missing`（原件不存在）、`hash_mismatch`（原件哈希不一致）、`document_without_original`（resume_document 找不到原件）、`needs_review_mismatch`、`failed_mismatch`（文件夹数量与人工队列不一致）。`refs` 放抽样的 mail_message_id 或 doc_id。
- `overdue_resume_requests[]`：`{case_id, command_id, requested_at, days_waiting}`，求简历成功但超过 `resume_mail_timeout_days` 仍未收到邮件的流程。只是提醒，不影响 outcome；流程是否转 needs_human 由服务端判定。

**resume_document**（只在 openapi 中定义，0.3.0 新增字段）：`variant`（`original` 邮件原件 | `branded` 套用公司模板的派生版本）、`derived_from`（branded 时为原件 doc_id，original 时为 null）、`mail_message_id`（来源邮件记录，branded 继承原件）。原件始终保留，品牌化只新增派生版本。关联方式 `link_method` 的 `forward_record` 改为 `resume_request`：在该账户 request_resume 已成功的流程里，按执行时间窗结合账户 + 岗位 + 姓名唯一命中；不能唯一命中进入人工关联队列。

### 账户来源（0.2.0）

P0 与任务 B 都确认：BOSS 客户端窗口里读不到当前登录的是哪个招聘账户。因此 v1 的规则是：

- `account_id` 来自安装时的绑定：用户在控制台为这台设备确认绑定账户（`PUT /devices/{id}/account-binding`），Monitor 把绑定结果保存在本地。Monitor 不从界面读取账户，也不推断账户。
- `device_heartbeat.account_id` 表示"本机保存的绑定账户"，不是"观察到的账户"；未绑定时为 null。服务端发现它与服务端记录的绑定不一致时，说明是配置问题（例如重装后未重新绑定），不说明用户在 BOSS 里换了账户。
- 指令、事件里的 `account_id` 同样是绑定账户。
- reason `account_mismatch` 和暂停原因 `account_switched` 保留，但 v1 只在有证据时使用（例如界面出现账户切换或被挤下线的提示）。当前没有检测手段，用户在 BOSS 里直接切换账户时 Monitor 察觉不到。这一项列入 N 阶段待验证。

## 八、状态机

迁移表在 `monitor_contracts.states`，只能用 `can_transition_case / can_transition_command / can_transition_delivery / can_transition_mail`（或 `require_transition` 抛 `IllegalTransition`）判断，不要另写一份。所有层都不允许自迁移，未知状态名抛 `ValueError`。

### 8.1 业务流程（服务端 recruitment_case）

```mermaid
stateDiagram-v2
    [*] --> new_application
    new_application --> greeted
    new_application --> resume_requested: 问候关闭
    new_application --> resume_received: 候选人主动发简历
    greeted --> resume_requested
    greeted --> resume_received
    resume_requested --> resume_linked: 邮件到达并唯一关联（主路径）
    resume_requested --> resume_received: 看到附件（可选观察）
    resume_received --> resume_linked
    resume_linked --> contact_requested
    contact_requested --> contact_available
    contact_available --> closed
    new_application --> needs_human
    greeted --> needs_human
    resume_requested --> needs_human: 邮件超时 / 关联歧义
    resume_received --> needs_human
    resume_linked --> needs_human
    contact_requested --> needs_human
    needs_human --> greeted: 人工确认已发送
    needs_human --> resume_requested
    needs_human --> resume_received
    needs_human --> resume_linked: 人工关联
    needs_human --> contact_requested
    needs_human --> contact_available
    needs_human --> closed
    closed --> [*]
```

除 `contact_available` 外，每个非终态都可以直接进入 `closed`（停止流程、明确拒绝），图中省略这些边。

简历的**主路径**是 `resume_requested → resume_linked`：邮件到达公司邮箱并唯一关联到本流程（0.3.0）。`resume_received` 指界面上看到了附件简历，只是可选观察，不是必经阶段。求简历成功后超过 `policy.resume_mail_timeout_days` 未收到邮件，或邮件关联歧义时，`resume_requested → needs_human`；人工关联后 `needs_human → resume_linked`。`resume_linked` 之后是否请求联系方式由 `after_resume_received.action` 决定，默认不请求。迁移表本身 0.3.0 没有增删边。

### 8.2 指令执行（Monitor command_ledger）

```mermaid
stateDiagram-v2
    [*] --> queued
    queued --> running: 获得 GUI 执行权
    queued --> cancelled: 排队时被取消
    queued --> expired: 已过期
    queued --> failed: 账户不符/白名单关闭/限额/依赖未满足（不调用 driver）
    running --> succeeded
    running --> failed
    running --> skipped_precondition: 动作已发生
    running --> unknown: 崩溃后 verify_only 仍不明
    running --> cancelled: 仅限 outbound_action_performed=false
    succeeded --> [*]
    failed --> [*]
    cancelled --> [*]
    expired --> [*]
    skipped_precondition --> [*]
    unknown --> [*]
```

`running` 不能回到 `queued`，否则会重做 GUI 动作。`unknown` 在本机是终态，Monitor 停止自动重试，依赖它的后续指令不执行。人工确认记在服务端的 `manual_actions`，不改写本机结果。重复送达的指令按 `command_id` 返回已有记录，不产生新的迁移。

### 8.3 回传（指令结果与事件 outbox）

```mermaid
stateDiagram-v2
    [*] --> pending: 产生最终结果 / 写入 outbox
    pending --> delivered: 收到服务端 200
    delivered --> [*]
```

### 8.4 公司邮箱邮件记录（mail_message.status，0.3.0）

```mermaid
stateDiagram-v2
    [*] --> pending: 原件落盘后写入
    pending --> processed: 提交成功，移到 Processed
    pending --> needs_review: 关联歧义 / 找不到流程
    pending --> failed: 连续失败达到上限
    pending --> ignored: 非 BOSS 发件人
    needs_review --> processed: 人工关联后
    failed --> pending: 人工重试
    processed --> [*]
    ignored --> [*]
```

迁移表是 `monitor_contracts.states.MAIL_TRANSITIONS`，用 `can_transition_mail` 或 `require_transition("mail", …)` 判断。同状态写入（例如未达上限的失败仍为 pending、attempts +1）是更新，不是迁移，由调用方处理。

## 九、幂等键规则

### 9.1 event_id

```
event_id = sha256_hex( JSON( ["monitor-event-v1", account_id or "", kind, 会话身份 or null, bucket] ) )
会话身份  = [NFC(strip(candidate_name)), NFC(strip(job_title)), sorted(set(NFC(strip(h)) for h in hints))]
```

- JSON 序列化使用 `ensure_ascii=False` 和紧凑分隔符 `(",", ":")`，按 UTF-8 编码后计算哈希。hints 按 Unicode 码点排序。其他语言实现以测试中的金标准值为准（`tests/test_event_id.py::GOLDEN_MATERIAL`）。
- `bucket` 是"观察到的变化时间片"，由观察方决定：优先用界面上能读到的变化时间（例如列表里的消息时间），或者首次看到该变化时记入基线的时间片，保证同一变化在多次观察中算出同一个 id。两者都没有时，用 `observation_bucket(observed_at, width_seconds)` 兜底（UTC 向下取整，例如 `2026-10-04T01:00:00Z/3600`）。
- 服务端按 `event_id` 去重。同一个新投递因为 bucket 不同算出两个 id 时，服务端还会按账户 + 候选人 + 岗位合并到同一个 case，不会重复建 case。

### 9.2 Idempotency-Key（HTTP 写接口）

格式：`^[A-Za-z0-9._:-]{8,128}$`。重试必须复用同一个键，所以键由业务标识确定性地生成。`monitor_contracts` 提供了以下生成函数：

| 接口 | 函数 | 形如 |
| --- | --- | --- |
| `POST /commands/{id}/result` | `command_result_key(command_id)` | `result:<uuid>` |
| `POST /commands/{id}/ack` | `command_ack_key(command_id)` | `ack:<uuid>` |
| `POST /devices/{id}/commands:claim` | `claim_key(device_id, claim_attempt_id)` | 同一次领取尝试的重试复用 attempt id |
| `POST /devices/{id}/heartbeat` | `heartbeat_key(device_id, sent_at)` | |
| `POST /events` | `events_batch_key(event_ids)` | 与顺序无关，相同集合得到相同键 |
| `POST /login-qr` | `login_qr_key(device_id, qr_seq)` | |
| `POST /resume-documents` | `resume_document_key(source_id, sha256)` | 原件 source_id = mail_message_id；品牌化版本 = `"branded:" + derived_from` |
| `PUT /mail-messages/{id}` | `mail_message_key(mail_message_id, status, attempts)` | 同状态的多次失败靠 attempts 区分 |
| `POST /mail-verifications` | `mail_verification_key(verification_id)` | |
| 控制台写接口 | 每次用户点击生成一个 UUID | 双击、刷新重放不会重复执行 |

部分内容含不安全字符或超长时，自动退化为 `前缀:哈希`。服务端在 24 小时内对同一个键返回首次的响应；同一个键配不同请求体时返回 422 `idempotency_key_reused`。

## 十、Protocol（其他任务实现）

| Protocol | 实现任务 | 要点 |
| --- | --- | --- |
| `Driver` | C | `state(include_tree=False) -> Snapshot`；`click(target, mode)`、`type_text(target, text)`、`key(keys)`、`scroll(target, direction, amount)` 返回 `ActionReceipt`，失败抛 `DriverError` 子类；`bind_window(selector=None) -> WindowInfo`；`screen_ok() -> bool`；`screenshot_region(rect, out_path) -> Path`（只用于登录二维码）。`target` 为 `Element` 或 `Locator`（text / text_contains / role / region / index / right_of，取交集，必须唯一命中） |
| `ActionHandler` | H1–H3 | 属性 `action`；`run(command, driver, ctx) -> ActionResult`；`verify_only(command, driver, ctx) -> ActionResult`（绝不写）。白名单关闭时返回 `failed/action_not_allowed`，不调用写方法 |
| `Observer` | E | `observe(driver, baseline) -> list[Event]`。可以就地更新 `baseline`，由 core 持久化。`baseline.established=False` 时只建基线、返回空列表 |
| `Ledger` | D1 | 指令幂等写入、按迁移表迁移（非法迁移抛 `IllegalTransition`）、结果与事件的回传状态、补传游标 `outbox_cursor()`、`load_state / save_state(MonitorState)` |

Driver 错误码（`DriverError.code`，可以写入 `heartbeat.last_error.code`）：`window_lost`、`screen_lost`、`timeout`、`snapshot_stale`、`cli_failed`、`target_ambiguous`、`target_not_found`，以及基类 `driver_error`。

`Element` 的字段为 `index, role, label, value, frame, enabled`，另有可选的 `snapshot_id`（由 Driver 填写）和 `parent_index / depth`（仅 include_tree）。`enabled` 为 `bool | None`，默认 None，表示来源不提供（2ndscreen CLI 不输出该字段），不等于不可用。只读属性 `text`：label 去空白后非空就返回 label，否则返回 value，两者不拼接，所以输入框（label=搜索、value=关键词）仍能被 `Locator(text="搜索")` 命中。evidence 默认用这个属性。

Locator 的文本匹配（0.2.0 追认任务 C 的实现）：`text` 在规范化后与元素的 `text`、`label`、`value` 任一相等即命中，`text_contains` 在规范化后是其中任一的子串即命中。规范化是去掉方向控制符（例如 Calculator 值里的 U+200E）、NFKC、合并连续空白、去首尾空白，区分大小写。这样弹出菜单（label=typeface、value=Helvetica）两个词都能定位，静态文本只在 value 上时也能命中。匹配面变宽后命中可能变多，唯一命中的要求不变：作为写方法的 target 时，零个命中抛 `TargetNotFoundError`，多个命中抛 `TargetAmbiguousError`，Driver 不替调用方挑选。

## 十一、夹具格式

`monitor/fixtures/ax/<scene>/fixture.json`，格式见 `ax-fixture.schema.json`，用 `validate_ax_fixture` 校验：

- 顶层：`fixture_version: 1`、`scene`（与目录名一致）、`description`、`recorded_at`、`source{app, app_version?, driver, recorded_by?}`、`redaction{names_replaced, phones_removed, wechat_removed}`（三项都必须为 true）、`steps[≥1]`。
- 每一步：`label`、`window`、`elements[]`（`FixtureElement`：与 Element 相同，但没有 snapshot_id，`index` 必须等于位置，`to_element(snapshot_id)` 可转成 Element），以及 `annotations`。
- `enabled` 可以为 null 或省略。从 2ndscreen CLI 录制的夹具一律为 null，因为 CLI 实测不输出 enabled；不要为了凑值写 true。
- `annotations`：`page`（页面类别）、`conversations[]{element_index, conversation, is_new_application, unread?, ambiguous?}`、`is_new_application[]`（元素 index 简写）、`qr_region`、`expected_events[]`（观察本步后应产生的事件 kind，空列表表示不应产生事件）、`notes`，扩展键必须以 `x_` 开头。
- label、value、窗口标题若含中国大陆手机号样式的 11 位数字，schema 会直接拒绝。这只是兜底检查，不能替代人工脱敏抽查。

## 十二、变更流程

1. 需要改契约的任务在交付报告里写"接口请求"，不要自行修改，也不要复制一份同名类型。
2. 监督者裁决后，由 A 的 worker（或监督者）修改 schema、模型、openapi、本文和测试向量，四者必须同步。
3. 版本号：0.x 阶段每次契约变更时次版本号 +1（0.1.0 → 0.2.0），只改文档措辞时修订号 +1。需要同步修改的地方有 `monitor_contracts.__version__`、`contracts/pyproject.toml` 的 version、`openapi.yaml` 的 `info.version`，测试会检查三者是否一致。
4. 在 `docs/monitor/status.md` 的"契约版本"表登记变更和受影响的任务，并通知这些任务 rebase。
5. 服务端在 `POST /devices` 时比较 `contracts_version`，主版本或次版本不兼容时返回 409 `contracts_version_unsupported`。

## 十三、契约缺口裁决与变更记录

| 问题 | 裁决 |
| --- | --- |
| E 需要"歧义事件" | 新增 kind `conversation_ambiguous` |
| E 的"不支持的呈现只上报一次" | 用 `heartbeat.last_error`，`code=unsupported_presentation` + `scene` |
| 控制台"重新检查界面状态" | 指令增加 `execution_mode: verify_only`，不受限额、间隔和白名单约束 |
| 联系方式事件是否带号码 | v1 不带号码，状态加 `unknown`；是否回传号码由用户另行决定 |
| `workflow_id` | 会话类动作必填；search_candidates 和 provide_input 为 null |
| `reason` 与 status 的约束 | 见第四节 |
| `monitor/uv.lock` | 由 A 提交；后续任务不提交 lock 改动，由监督者合并时统一重新 lock |
| 写操作标志太粗（导航与对外动作混在一起，verify_only 无法导航） | 0.2.0 拆成三个标志，见第四节"执行标志" |
| 账户读不到 | 0.2.0：account_id 来自安装时绑定，不从界面读取；`account_mismatch` 只在有证据时使用，见第七节"账户来源" |
| Locator 文本匹配面 | 0.2.0 追认 C 的实现：text / text_contains 匹配 text、label、value 任一（规范化后），仍要求唯一命中 |
| 简历路线 | 0.3.0（用户 2026-10-04）：求简历 → 候选人同意 → BOSS 自动发到公司邮箱；Monitor 不转发，`forward_resume` 移除，名字保留 |
| mail_messages 由谁写 | 0.3.0（协调者裁决）：邮件接入用 `PUT /mail-messages/{mail_message_id}` 幂等 upsert；主键确定性生成，Message-ID 缺失时用 (邮箱, UIDVALIDITY, UID) 兜底；状态迁移表进 `states.py` |
| 搜索结果是否识别身份 | 0.3.0（用户 2026-10-04）：不识别。卡片只原样返回可读文本与道具卡文案；搜索结果不能作为指令目标（删除会话目标的 `result_ref`） |
| 邮件关联依据 | 0.3.0：`link_method` 的 `forward_record` 改为 `resume_request`（按 request_resume 执行时间窗），`command_id` 指向 request_resume 指令 |

### 变更记录

| 版本 | 日期 | 变更 | 受影响任务 |
| --- | --- | --- | --- |
| 0.1.0 | 2026-10-04 | 首版 | 全部 |
| 0.1.1 | 2026-10-04 | Driver 协议两处修正：`Element.enabled` 改为 `bool \| None = None`（None 表示来源不提供；FixtureElement 与 ax-fixture schema 同步允许 null 或省略）；`Element.text` 改为 label 非空取 label，否则取 value，不再拼接。8.1 中推断的三条迁移经审查全部接受，未改 | C、E、H1–H3、B（夹具） |
| 0.2.0 | 2026-10-04 | ① command_result / ActionResult 的 `gui_write_performed` 拆成 `navigation_performed`、`outbound_action_performed`、`externally_visible_side_effect`（线上必填）：verify_only 只禁对外动作、允许导航；cancelled 禁对外动作；expired 三个全 false；对外动作 ⇒ 对方可见；`running → cancelled` 仅限无对外动作；`ActionHandler.verify_only` 文档同步。② 账户来源：account_id 来自安装时绑定，heartbeat.account_id 是绑定账户而非观察到的账户；`account_mismatch` 保留但 v1 只在有证据时使用，列入 N 待验证。③ Locator 的 text / text_contains 匹配 Element.text、label、value 任一（规范化后），追认 C 的实现。forward_resume 与搜索字段未改 | D1、D2、E、H1–H3、F1（结果入库）、I1（展示）、C（文档追认，无代码变更） |
| 0.3.0 | 2026-10-04 | ① 移除 `forward_resume`：action 枚举、payload / output、结果规则、策略白名单与 daily_limits / min_interval_seconds、设备能力；`attachment_available` 只作可选观察。② policy 增加 `company_mailbox`（只读）与 `resume_mail_timeout_days`（默认 3）；`after_resume_received` 默认 `{action: none, wait_for_parse: true}`。③ case 主路径 `resume_requested → resume_linked`，`resume_received` 为可选观察，`resume_requested → needs_human` 用于超时或关联歧义（迁移表未增删边，只改说明）。④ 新增 `mail_message`、`mail_verification` 两个契约与 `MAIL_TRANSITIONS`、`compute_mail_message_id`、`mail_message_key`、`mail_verification_key`；`resume_document_key` 的第一个参数改为来源标识。⑤ 搜索快照卡片改为 `{result_ref, position, fields[], masked_name?, prop_card_texts[]}`，删除 `display_name / summary / stable_candidate_id`；会话目标删除 `result_ref`，v1 搜索结果不能作为指令目标。⑥ openapi：新增 `/mail-messages`、`/mail-verifications`；resume_document 增加 `variant / derived_from / mail_message_id`，`link_method` 的 `forward_record` 改为 `resume_request`；补齐 F1 报告列出的 401 / 403 / 422。交换联系方式（`exchange_type`）未改，留给 0.3.1 | D2（限额常量、testing 夹具）、D1（testing 夹具）、F1（一致性白名单清空）、F2（策略默认值、超时转人工、关联方式）、F3（搜索快照存储）、G（mail_messages、核对、关联方式）、H2（卡片形状）、I1/I2（策略页邮箱与超时、搜索页、邮件队列）、R（branded 版本写入） |
