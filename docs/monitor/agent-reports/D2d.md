# D2d 交付报告：执行管线收尾（搜索计为对外动作、M-1 客户端、M-2、M-3、suspended）

分支：`szrunworld/monitor-D2d`。先按 0.3.3 的形状写好客户端并用测试驱动（`4b03b98`），收到协调者通知后合入 monitor-v1（契约 0.3.3，`e3d4644` 起；无冲突），再把 suspended 上报改成正式值、删除 M-1 的 xfail 与 `scripts/bind_account.py`。契约、server、mail 未改；没有提交 `uv.lock`。

## 一、验收

| 项 | 结果 |
| --- | --- |
| `cd monitor && uv sync && uv run pytest contracts client server mail integration` | **1774 passed，1 xfailed**（128.8 秒） |
| 剩余 xfail | 只有 1 条，等待 K：`integration/test_e2e_manual_search_login.py::test_real_observer_reports_login_required_on_login_page`（观察器把登录页归为 unknown，不产生 login_required） |
| `ruff check --select F,E9,B,UP`（core、改动的测试） | 只剩 1 条已有的 B007（`core/testing.py` 的 `route` 循环变量，不是本任务引入的） |

已解除的 xfail：H2 `test_core_treats_search_success_as_outbound`（client）、M-1 `test_monitor_learns_binding_from_server_without_manual_step`、M-2 `test_runtime_does_not_busy_spin_while_backing_off`、M-3 `test_heartbeat_4xx_does_not_crash_runtime`（integration）。都只删了标记（`test_known_defects.py` 因此不再用到 `pytest`，同时删掉了这个 import），测试本身没改。

## 二、变更

### 1. 搜索算对外动作（契约 0.3.2）

- `write_flags.success_is_outbound(action)` 对所有指令都返回 True（删除 `_NON_OUTBOUND_SUCCESS`）；函数保留为唯一判断点。
- `write_flags.counts_toward_limit` 只看 outbound：搜索与其他动作一样，只导航、未输入就失败的不计入，输入或提交过的计入。
- 崩溃恢复：复核确认搜索已发生时 outbound=true（原来是 false，而 0.3.2 契约要求成功的搜索三标志都为 true，旧行为会造出不合契约的结果、落成 unknown）。
- `limits.py` / `pipeline.py` 注释同步。

### 2. M-1 客户端部分：绑定以服务端为准

- `client.HeartbeatAck` 新增 `account_binding: AccountBinding | None` 与 `binding_reported: bool`（响应里有没有这个字段）。0.3.3 的服务端总会带上；没有这个字段（旧服务端）时不动本机绑定，不会误判成"撤销"。
- `MonitorRuntime._apply_server_binding`（每次心跳成功后调用）：
  - 回执有绑定，且与本机不同（从无到有、换账户，或同一账户被控制台重新确认、bound_at 变了）→ `bind_account(account_id, confirmed_by=, bound_at=服务端的确认时间)` 写入 `monitor_state.account_binding`。换了账户时清空策略、置 needs_baseline；因 `account_switched` 暂停的设备，控制台重新确认后恢复，并重建基线（沿用 bind_account 的原有语义）。
  - 回执绑定与本机相同 → 什么都不做（不会每次心跳都重建基线）。
  - 回执为 null 而本机有绑定 → 新增 `unbind_account()`：清除本机绑定与策略，记 `last_error=account_unbound`；之后心跳 account_id 为 null，不领取。
  - 回执刚写入新绑定时，`account_confirmed` 记为 None（本次心跳带的还是旧 account_id），由下一次心跳确认。
- **基线重建前不执行**：新增 `_execute_allowed()` = GUI 可用 且 not needs_baseline 且 契约兼容。原来 needs_baseline 只挡领取，本机队列里已有的指令仍会先于观察执行；现在执行与领取都要等基线重建（同一轮里会先观察，所以一般只差一轮）。这一条同样作用于"离线超过 24 小时"。崩溃恢复（只读复核）不受影响。
- 按协调者许可删除了 `monitor/scripts/bind_account.py`。**连带删除**了 `integration/test_e2e_device.py::test_bind_script_workaround_then_monitor_claims`：它测试的就是这个脚本，脚本删了它无法运行（这是许可之外唯一一处测试删除，请协调者知悉）。`integration_kit.bind_locally` 与 `test_real_server_process.py` 里直接调用 `rt.bind_account` 的替代步骤还在，现在已经多余但无害——按约束没有改 integration 的其他代码，可由 M 的后续任务清理。

### 3. M-2：退避期间不空转

`_idle_seconds` 把"下一次服务端往来"取为 max(心跳到期时间, 退避结束时间)，原来心跳到期时间停在过去、空闲取到 0。令牌吊销后不再把心跳到期时间算进去（以前吊销后同样会空转）；不能执行时也不为推迟的指令醒来。测试用 ManualClock 断言连续失败时建议等待 1、2、4、8 秒，退避期内多跑几轮也不发请求。

### 4. M-3：心跳 4xx 不让进程崩溃

`_server_round` 捕获心跳的 `RequestRejected`，交给 `_heartbeat_rejected`：
- **401**：原有的 `Unauthorized` 路径不变 → `revoked=True`、`last_error=token_revoked`，停止一切服务端往来（加了针对心跳 401 的测试）。
- **409**（契约版本不兼容）：`contract_incompatible=True`、`last_error=contract_incompatible`，按退避继续心跳；期间不领取、不执行、不回传结果和事件。服务端接受心跳后自动解除。`status()` 新增 `contract_incompatible` 键。没有用 `pause()`，因为契约的 PauseReason 里没有合适的值，硬套会发出不合契约的 device_paused 事件。
- **其他 4xx**：`last_error=heartbeat_rejected`，按退避重试；错误随下一次成功的心跳发出。

### 5. client_state 报 suspended（0.3.3）

GUI 挂起期间心跳与 `status()` 的 `client_state` 都报 `suspended`（原来是 unknown）。`ReportedClientState` 只用于上报；内部 `client_state` 不变。

### 6. 测试工具（`core/testing.py`）

- `FakeServer` 的心跳回执带 `account_binding`（`bind()` 设置；`report_binding=False` 模拟旧服务端），`account_confirmed` 只在心跳 account_id 等于绑定时为真，policy_version 只在确认时给出；每个回执都用 `check("heartbeat_ack", ...)` 校验。`make_env(bind=True)` 让服务端绑定与本机一致。
- `make_command` 支持 `search_candidates`（作用于当前页，workflow_id 为 null）。

## 三、新增 / 修改的测试

- `test_core_units.py`：`test_check_rate_counts_outbound_only_including_search`（替换原来"搜索看导航"的用例）、`test_success_is_outbound_for_every_action`；`_executed` 不再对搜索特殊处理。
- `test_core_client.py`：回执绑定的解析；null 与字段缺失的区分。
- `test_core_exceptions.py`：`test_kill9_search_recovery_confirmed_counts_as_outbound`：搜索被 kill 后复核确认 → succeeded、outbound=true、计入最小间隔。
- `test_core_runtime.py`：
  - M-1：回执绑定写入本机后建基线、领取、下一次心跳确认；绑定相同不做任何事；换账户后本机已入账的指令等基线重建后才执行；控制台撤销 → 清除绑定、不领取、`account_unbound`；旧服务端不带字段 → 保留本机绑定；控制台重新确认 → 解除 account_switched 暂停并重建基线。
  - M-2：退避等待 1/2/4/8 秒、退避期内不发请求；令牌吊销后不空转。
  - M-3：422 → heartbeat_rejected + 退避重试、恢复后照常领取；409 → 不领取、不执行、不空转、恢复后自动继续；心跳 401 → token_revoked 后不再发请求。
  - D2c 的挂起用例：断言心跳与 `status()` 的 client_state 为 `suspended`。

全部用 ManualClock 推进，没有固定 sleep。

## 四、接口请求

1. **J / 状态窗口**：`statusbar/viewmodel.py` 的 `CLIENT_TEXT` 没有 `suspended`，会原样显示英文 `suspended`（不崩溃）。建议补一条中文，例如"窗口已归还"。`status()` 新增的 `contract_incompatible` 也可以在状态窗口里显示（"服务端版本不兼容，已暂停"）。
2. **M / integration 清理（可选）**：M-1 已解决，`integration_kit.bind_locally`、`bound_monitor` 里的本机写入、`test_real_server_process.py` 第 92 行的 `rt.bind_account` 都可以删掉，改为依赖心跳回执（本任务按约束没有动）。
3. **runbook**：第四节的 `bind_account.py` 替代步骤已失效（脚本已删），由协调者更新（协调者已说明）。

## 五、问询

无。
