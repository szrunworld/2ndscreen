# 招聘 Monitor 服务端 HTTP 接口

版本 0.1.1，与 `monitor_contracts` 0.1.1 对应。机器可读的定义在 [`monitor/contracts/openapi.yaml`](../../monitor/contracts/openapi.yaml)（OpenAPI 3.1，已通过 `openapi-spec-validator` 校验）。本文写给实现者（F1–F3、G、I1/I2、D2）看，冲突时以 openapi.yaml 为准。消息体的字段含义见 [contracts.md](contracts.md)。

## 一、通用规则

**传输**：只暴露 HTTPS，基础路径 `/api/v1`。第一版用轮询，领取指令为长轮询（最长 30 秒），不用 WebSocket。

**认证**（三种 bearer 令牌）：

| 名称 | 谁用 | 说明 |
| --- | --- | --- |
| `deviceToken` | Monitor | `POST /devices` 返回，只出现一次；服务端只存哈希；可吊销，吊销后返回 401。路径里的 `device_id` 必须与令牌所属设备一致，否则 403 |
| `consoleSession` | 控制台 | 服务端从中取得 actor，写入人工处理记录和二维码查看记录 |
| `serviceToken` | 邮件接入（G） | 写简历文档、查询转发记录 |

**幂等**：所有写接口（POST / PUT）必须带 `Idempotency-Key` 头，格式为 `^[A-Za-z0-9._:-]{8,128}$`。

- 服务端按（principal, 方法, 路径, 键）保存首次响应 24 小时，同一个键重放时原样返回。
- 同一个键配不同请求体，返回 422 `idempotency_key_reused`。
- Monitor 的键由业务标识确定性地生成（见 contracts.md 第九节），断网重试复用同一个键。控制台每次用户点击生成一个 UUID。
- 业务层另有一层幂等，即使换了键也成立：结果按 `command_id`，事件按 `event_id`，简历按（message_id, sha256），指令领取按租约。

**错误**：响应类型为 `application/problem+json`，结构为 `{code, message, errors?[], existing?}`。`errors[]` 是字段级错误 `{path, message, code}`，路径格式与 `monitor_contracts.FieldError` 一致，服务端可以直接用 `check(name, body)` 的结果填充。常用错误码：`validation_failed`、`idempotency_key_reused`、`result_conflict`、`not_found`、`qr_expired`、`contracts_version_unsupported`。

**分页**：列表接口统一用 `cursor` + `limit`（1–200，默认 50）作参数，返回 `{items, next_cursor}`，`next_cursor` 为 null 表示没有下一页。

## 二、接口一览

| 方法与路径 | 调用方 | 用途 |
| --- | --- | --- |
| `POST /device-enrollments` | 控制台 | 生成一次性注册码（含 mode） |
| `POST /devices` | Monitor（无令牌） | 用注册码注册，换取 `device_id` 和 `device_token` |
| `GET /devices`、`GET /devices/{id}` | 控制台 | 设备卡片：模式、在线状态、最近心跳、绑定、二维码是否有效 |
| `POST /devices/{id}:revoke` | 控制台 | 吊销令牌 |
| `PUT /devices/{id}/account-binding` | 控制台 | 确认设备与账户的绑定 |
| `POST /devices/{id}:pause`、`:resume` | 控制台 | 暂停或恢复设备 |
| `POST /devices/{id}/heartbeat` | Monitor | 心跳 |
| `POST /devices/{id}/commands:claim` | Monitor | 长轮询领取指令 |
| `POST /commands/{id}/ack` | Monitor | 确认已写入本地账本 |
| `POST /commands/{id}/result` | Monitor | 回报最终结果 |
| `GET /commands`、`GET /commands/{id}` | 控制台、G | 执行记录；G 用 `action=forward_resume&status=succeeded&executed_after=` 查询转发记录 |
| `POST /commands/{id}:cancel` | 控制台 | 取消指令 |
| `POST /commands/{id}:confirm-sent` | 控制台 | 人工确认已发送（只用于 unknown） |
| `POST /commands/{id}:recheck` | 控制台 | 重新检查界面状态（生成 verify_only 指令） |
| `POST /events`、`GET /events` | Monitor / 控制台 | 批量上报事件 / 查看最近活动 |
| `POST /resume-documents`、`GET /resume-documents`、`GET /resume-documents/{id}` | G / 控制台 | 写入简历附件；列表与待人工关联队列 |
| `POST /resume-documents/{id}/parse-result` | G | 回报解析结果 |
| `POST /resume-documents/{id}:link` | 控制台 | 人工关联到流程 |
| `POST /search-runs`、`GET /search-runs`、`GET /search-runs/{id}` | 控制台 | 提交搜索，查看快照 |
| `GET /cases`、`GET /cases/{id}` | 控制台 | 流程列表与详情 |
| `POST /cases/{id}:stop` | 控制台 | 停止流程 |
| `POST /login-qr` | Monitor（仅 remote） | 上传登录二维码内容 |
| `GET /devices/{id}/login-qr` | 控制台 | 读取二维码（记录查看者；过期返回 410） |
| `POST /devices/{id}/login-qr:withdraw` | Monitor / 控制台 | 撤下二维码 |
| `GET /devices/{id}/login-qr/views` | 控制台 | 查看记录 |
| `POST /input-requests/{id}/response` | 控制台 | 提交人工输入，生成 provide_input 指令 |
| `GET /accounts/{account_id}/policy`、`PUT` | 控制台（读写）、Monitor（读） | 策略 |
| `GET /overview` | 控制台 | 总览，各项分别计数 |

路径里的冒号动词（`:claim`、`:cancel` 等）表示对资源执行的动作，不是子资源。

## 三、Monitor 侧流程

### 3.1 注册与绑定

1. 用户在控制台选择模式，生成注册码（`POST /device-enrollments`）。
2. 执行 `monitor install` 时，Monitor 以 `device_registration` 为请求体调用 `POST /devices`，拿到 `device_token` 后存入 keychain 或 0600 文件。注册码只能用一次。若 `contracts_version` 不兼容，返回 409。
3. Monitor 心跳上报 `account_id`，用户在控制台确认绑定（`PUT /devices/{id}/account-binding`）。绑定确认之前，或心跳中的账户与绑定不一致时，领取接口返回空列表，心跳响应中 `account_confirmed=false`。

### 3.2 心跳

`POST /devices/{id}/heartbeat`，请求体为 `device_heartbeat`，默认 30 秒一次。响应 `HeartbeatAck`：

- `paused`：服务端要求的暂停状态（控制台点了暂停）。Monitor 按它停止领取和新的对外动作，已经发生的动作仍然完成记录与回传。
- `policy_version`：与本地不同时，Monitor 重新 `GET /accounts/{account_id}/policy`。
- `cancellations[]`：已领取但被取消的 `command_id`，规则见 3.4。

服务端超过 90 秒没有收到心跳时，把设备显示为 offline。

### 3.3 领取、确认、执行、回报

```
claim(长轮询) → 写本地账本 queued → ack → … 执行 … → result → 收到 200 → delivered
```

- **领取** `POST /devices/{id}/commands:claim`，请求体 `{account_id, max_commands, wait_seconds ≤ 30}`。服务端原子地选出该设备已绑定账户下满足以下条件的指令：`depends_on` 已 succeeded、未过期、未取消、处于 pending 或租约已过期。没有可领取的指令时，最多等待 `wait_seconds` 秒后返回空列表。设备暂停、需要重建基线（`needs_baseline`）或账户未确认时，返回空列表。
- **租约**：响应中的 `lease_seconds` 内必须 ack，否则这条指令可以被重新领取。重新领取得到的是同一个 `command_id`，Monitor 账本按 `command_id` 去重，重复送达时返回已有结果。
- **确认** `POST /commands/{id}/ack`，请求体 `{device_id, ledger_state, received_at}`。ack 之后服务端不再把这条指令交给别人。重复 ack 返回 200。
- **回报** `POST /commands/{id}/result`，请求体 `command_result`，路径中的 id 必须与请求体一致。每条指令只接受一个结果：重复且相同返回 200 并带 `duplicate=true`；与首次不同返回 409 `result_conflict`，同时在 `existing` 中附上首次结果。Monitor 只有收到 200 才把本地结果标记为 delivered；回报失败时保存结果、稍后补传，不重做 GUI 动作。
- **离线超过 24 小时**：Monitor 上线后先置 `needs_baseline=true` 并重建基线，再开始领取。

### 3.4 取消

控制台调用 `POST /commands/{id}:cancel`：

- 指令还没被领取：服务端直接把它置为 cancelled。
- 已被领取：服务端通过心跳和下一次领取响应中的 `cancellations` 通知设备。Monitor 若还没开始执行，回报 `cancelled`；若动作已经发生，回报实际结果。最终状态以设备回报为准。

### 3.5 事件

`POST /events`，请求体 `{device_id, events[1..100]}`。服务端逐条处理：

- 用 `validate_event` 校验，不合法的条目返回 `rejected` 和字段错误。
- `event_id` 已存在的条目返回 `duplicate`，其余返回 `accepted`。
- 单条失败不影响整批。

Monitor 把 `accepted` 和 `duplicate` 的事件都标记为 delivered。`rejected` 的事件留在 outbox，并通过 `heartbeat.last_error` 上报，不自动重发（契约不一致需要人来处理）。

### 3.6 登录接力（仅 remote）

1. Monitor 解码二维码后调用 `POST /login-qr`（请求体 `login_qr`），同时发一个 `login_qr` 事件（不含二维码内容）。local 模式调用该接口返回 403。
2. 控制台调用 `GET /devices/{id}/login-qr` 取得 `qr_payload` 重新渲染二维码，每次读取都会记录查看者，响应带 `Cache-Control: no-store`。过期或已撤下时返回 410，不返回内容。控制台此时显示"等待刷新"，不显示旧码。
3. 二维码内容变化时 `qr_seq` +1 并重新上传，新码覆盖旧码。
4. Monitor 发出 `login_ok` 事件，或调用 `POST /devices/{id}/login-qr:withdraw`，服务端都会撤下二维码。
5. 需要人工输入时，Monitor 发 `human_input_required` 事件。只有 `can_fill=true` 的请求，控制台才能调用 `POST /input-requests/{id}/response`；服务端据此生成 `provide_input` 指令。输入的值不写入日志和事件。

## 四、控制台与服务端内部

- **流程**：`GET /cases` 每行是一个 recruitment_case，可以按 stage、needs_human、job_title、关键字过滤。`GET /cases/{id}` 返回时间线、简历文件、相关指令和人工处理记录。
- **人工处理**：`confirm-sent`、`resume-documents/{id}:link`、`cases/{id}:stop` 都要求填写说明（`note`），服务端记录 actor、时间和说明，返回 `ManualAction`，不覆盖原始执行结果与证据。结果待确认（unknown）的指令只提供重新检查、人工确认、停止三种处理，没有"重试"接口。
- **重新检查**：`POST /commands/{id}:recheck` 为同一动作和目标创建一条 `execution_mode=verify_only` 的新指令，只读，不受白名单和限额约束。对 search_candidates 和 provide_input 调用返回 409。
- **搜索**：`POST /search-runs` 的请求体为 `{account_id, query, max_results, ttl_seconds=600}`。服务端检查策略白名单、暂停状态和上限后，创建 `search_candidates` 指令。`SearchRun.outcome` 由快照的 coverage 得出（results / no_results / unreadable），控制台对三者分别展示。
- **简历文档**（G 调用）：`POST /resume-documents` 按（message_id, sha256）去重，重复时返回 200 并带 `duplicate=true`。`link.method` 按优先级依次为 reliable_id → forward_record（带 `command_id`）→ name_match → none；为 none 时进入人工关联队列，并列出 `candidate_case_ids`。同一流程下的多份简历按 `version` 保留，不覆盖。解析结果可以随创建请求一起提交，也可以之后用 `POST /resume-documents/{id}/parse-result` 提交。
- **策略**：`PUT` 必须带 `If-Match: <policy_version>`，版本不一致返回 412。`policy_version`、`updated_at`、`updated_by` 以服务端为准，保存后版本 +1。`pause_on_anomaly` 只能为 true。
- **总览**：`GET /overview` 分别返回今日新投递、已请求简历、收到简历、解析完成、待人工处理和 unknown 结果的计数，不合并成"成功数"。

## 五、服务端视角的指令状态

`CommandServerStatus` 在 Monitor 指令状态的基础上增加了服务端独有的三个前置状态：

```
pending（待领取）→ claimed（已领取，租约中）→ acked（已写入设备账本）→ 与 command_result.status 相同的终态
```

- 租约过期且没有 ack：`claimed` 回到 `pending`。
- 在 `pending` 时被取消：直接进入 `cancelled`。
- 业务流程状态以 contracts.md 第八节为准。
