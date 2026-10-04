# 任务 X 交付报告：client 与 server 适配契约 0.3.0

分支 `szrunworld/monitor-X`，基于 `85274d1`（契约 0.3.0，`KNOWN_YAML_GAPS` 已清空）。

## 测试命令与结果

| 命令 | 结果 |
| --- | --- |
| `cd monitor && uv sync && uv run pytest contracts client server` | **1039 passed** |
| `uv run pytest contracts` | 266 passed |
| `uv run pytest client` | 666 passed（修改前：10 个模块收集失败） |
| `uv run pytest server` | 107 passed（修改前：4 个一致性用例失败；新增 1 个用例） |

## 变更清单

### client

1. `client/monitor/core/limits.py`：`HARD_DAILY_CAPS`、`MIN_INTERVAL_FLOORS` 删除 `forward_resume`。其余数值不变：每种对外动作每日 40；间隔 send_greeting 45、request_resume 45、request_contact_exchange 60、search_candidates 30。模块末尾的"键集合等于 `OUTWARD_ACTIONS`"断言保留，现在成立。
2. `client/monitor/core/testing.py`（测试夹具）：
   - `make_policy` 改为 0.3.0 形状：新增 `resume_mail_timeout_days: 3`、`company_mailbox: "hr@example.com"`；`after_resume_received` 改为 `{action: none, wait_for_parse: true}`（与契约默认值一致；原来 `false` 也合法，改成默认值只是为了少一处差异）；`daily_limits` / `min_interval_seconds` 去掉 `forward_resume`。
   - `make_command`：`request_contact_exchange` 的 `exchange_type` 改为 `wechat`；删除 `forward_resume` 样例。
3. `client/monitor/ledger/testing.py`（测试夹具）：同上，`exchange_type` 改为 `wechat`，删除 `forward_resume` 样例（A3 报告指出的同类问题，此前没有用例因它失败）。
4. `client/tests/test_core_units.py::test_hard_limits_values_confirmed_by_user`：期望改为 4 种对外动作，并把上限写成显式字典（原来是"全为 40 且共 5 项"）。测试意图（锁定用户确认的数值）不变。

搜索快照：client 里目前没有任何搜索快照夹具或用例（H2 尚未实现），`fields / masked_name / prop_card_texts` 无需修改。

动作、观察、账本的业务逻辑均未改动；没有契约字段变更强制要求改业务代码的情况。

### server

1. `server/app/commands.py`：
   - `ManualAction.type` 的枚举加上 `request_wechat`。这是 ackCommand、cancelCommand、getCommand、listCommands 四个一致性失败的唯一原因（它们的响应里都内嵌 `manual_actions`）。
   - `listCommands` 的 `action` 查询参数去掉 `forward_resume`（一致性测试只比较参数名，不会发现这一处，但代码应与 `common.json#/$defs/action` 一致）。
   - `listCommands` 的 summary 同步 yaml（"查询求简历记录，用于按执行时间窗关联邮件"）。
2. `server/tests/test_openapi_consistency.py`：
   - `KNOWN_YAML_GAPS` 保持为空，所有已实现操作与 yaml 一致。
   - 新增显式白名单 `NOT_YET_IMPLEMENTED` 与用例 `test_unimplemented_operations_are_listed`：yaml 中未实现的操作必须与白名单完全一致。原测试只比较已实现操作，新端点不会让它失败；加这个白名单是为了让"尚未实现"成为显式清单，契约再新增端点时会被测试发现。

### 尚未实现端点白名单（26 个，均不在本任务范围）

confirmCommandSent、recheckCommand；createResumeDocument、listResumeDocuments、getResumeDocument、postParseResult、linkResumeDocument；listMailMessages、putMailMessage、postMailVerification、listMailVerifications；createSearchRun、listSearchRuns、getSearchRun；listCases、getCase、stopCase、requestWechatExchange；postLoginQr、getLoginQr、withdrawLoginQr、listLoginQrViews；respondInputRequest；getPolicy、putPolicy；getOverview。

F2 / F3 / G 等实现时，把对应 operationId 从 `NOT_YET_IMPLEMENTED` 移到 `IMPLEMENTED` 即可复用一致性比较。

## 问询记录

无。

## 已知限制

- 一致性测试对参数只比较 name / in / required，不比较参数 schema（如 `action` 枚举）。本次手工核对并修正了 `listCommands.action`；如需自动覆盖，可在后续任务扩展 `params()`。
- 契约 0.3.1（cases 迁移边、mail provider 字段）合入后，`NOT_YET_IMPLEMENTED` 若有新增 operationId 需要同步登记。
- 按规则未提交 `monitor/uv.lock`。
