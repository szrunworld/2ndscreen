# D2b 交付报告：执行管线适配契约 0.2.0

分支：`szrunworld/monitor-D2b`，基于 `88d4400`（monitor-v1，含 A2 契约 0.2.0）。契约、driver、ledger 未改。

## 一、结果

| 验收项 | 结果 |
| --- | --- |
| `cd monitor && uv sync && uv run pytest contracts client` | 497 passed，0 failed（改动前 41 failed，全部在 core 测试） |
| `uv run --with ruff ruff check --select F client/monitor/core client/monitor/__main__.py client/tests/test_core*.py` | 无告警 |

`__main__.py` 没有引用写标志，无需改动。

## 二、变更

### 1. 守卫三种模式（`core/guard.py`）

`GuardedDriver(inner, mode=..., cancelled=...)`，原来的 `read_only=` 参数取消：

| 模式 | 用在 | click / scroll | type_text / key | `outbound()` | 截图 |
| --- | --- | --- | --- | --- | --- |
| `execute` | 指令 `run` | 允许 | 允许 | 允许 | 拒绝 |
| `verify` | `verify_only` 指令、崩溃恢复 | 允许（导航） | **拒绝**（视为对外动作） | **拒绝** | 拒绝 |
| `read_only` | 观察 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |

被拒绝的调用抛 `ReadOnlyViolation`（`DriverError` 子类，code=driver_error），不会到达真实 Driver。

计数：`outbound()` 块内的写调用计入 `outbound_calls`，块外计入 `navigation_calls`。计数在转发给 Driver **之前**，写调用中途抛错也按"可能已发生"处理。

### 2. 标志合并（`core/write_flags.py`）

- `flags(navigation=, outbound=, visible=)`：自动满足 outbound ⇒ visible；`none()` 三个全 false。
- `merged(ar, navigated=, outbound_done=, verify_only=)`：处理器声明与守卫记录取并集；verify_only 时 outbound 强制 false（守卫已保证没有对外动作到达 Driver，处理器错报也被清掉），navigation 与 externally_visible 如实保留。
- `counts_toward_limit`：对外动作计入每日上限与最小间隔；`search_candidates` 没有对外动作，改为"动过界面（导航）"就计入（否则搜索的限额会失效）。running 中的仍按原逻辑计入。

### 3. 管线（`core/pipeline.py`）

- **前置拒绝**（过期、账户不符、依赖、白名单、限额、unsupported）与**排队时取消**：不调用 Driver，三个标志全 false（`write_flags.none()`）。
- **驱动错误 / 处理器异常**：守卫记到对外动作（或处理器自己声明了对外动作而结果不合契约）→ `unknown/driver_error`，outbound=true；只导航过 → `failed/driver_error`，navigation 如实记录。0.1.x 里"任何写调用 → unknown"随之收窄。
- **running 中取消**（新增）：`Pipeline.cancel(cid)` 对正在执行的指令登记取消请求（线程安全，可从其他线程调用）。守卫在下一次写调用或进入 `outbound()` 时抛 `CommandCancelled`，前提是**还没有发生对外动作**；对外动作开始后不再打断。处理器结束后（无论正常返回、被打断还是吞掉打断）只要 outbound=false 就落 `cancelled`（executed_at=null，navigation / externally_visible 如实记录，observed / evidence 保留）；否则回报实际结果。
- **崩溃恢复**：上次进程的守卫计数没有落账，按保守值处理：

  | 复核结果 | 终态 | navigation | outbound | externally_visible |
  | --- | --- | --- | --- | --- |
  | succeeded | succeeded | true | true（`search_candidates` 为 false） | true |
  | failed/verification_failed | failed/verification_failed | true | false | true |
  | 其他 / 复核出错 | unknown/crash_recovery | true | true | true |

  verify_only 指令的恢复照旧直接采用复核结果（verify 模式守卫，outbound 恒为 false）。

### 4. 硬上限改值（协调者追加，用户 2026-10-04 确认）

`core/limits.py`，注释写明来源"用户 2026-10-04 确认，N 阶段实测后再调"：

| 动作 | 每日硬上限 | 最小间隔下限（秒） |
| --- | --- | --- |
| send_greeting | 40 | 45 |
| request_resume | 40 | 45 |
| forward_resume | 40 | 45 |
| request_contact_exchange | 40 | 60 |
| search_candidates | 40 | 30 |

新增 `test_hard_limits_values_confirmed_by_user` 锁定数值；`test_check_rate_daily_cap_and_interval` 的期望重试时间改为按 `MIN_INTERVAL_FLOORS` 计算。其余限额测试原本就读常量，无需改。D2 报告第六节的旧数值作废。

### 5. 测试

更新受影响测试（client、units、exceptions、runtime），新增：

- 守卫：`test_guard_execute_splits_navigation_and_outbound`、`test_guard_verify_allows_navigation_blocks_input_and_outbound`、`test_guard_cancel_interrupts_until_first_outbound`、`test_exec_context_outbound_and_cancel_flag`
- verify_only：`test_verify_only_ignores_limits_and_whitelist_and_blocks_outbound`（导航 click/scroll 到达 Driver；type_text、key、`outbound()` 被拦；已读回执如实上报）、`test_verify_only_handler_declaring_outbound_is_cleared`
- 取消：`test_cancel_while_running_after_navigation_reports_cancelled`、`test_cancel_while_running_handler_swallows_and_returns_is_still_cancelled`、`test_cancel_while_running_after_outbound_reports_actual_result`
- 不变式：`test_outbound_implies_externally_visible_in_reported_results`、`test_write_flags_outbound_implies_visible`
- 其他：`test_handler_driver_error_after_navigation_only_is_failed`、`test_check_rate_counts_outbound_only_except_search`；白名单关闭与限额拒绝的测试补了"三个标志全 false"断言；崩溃恢复测试补了标志断言。

执行中取消的测试由处理器在中途调用 `pipeline.cancel()` 模拟取消到达（相当于另一线程调用），不依赖 sleep。

## 三、接入说明（H1–H3 按此实现）

处理器拿到的 `driver` 是 `GuardedDriver`，`ctx` 是 `monitor.core.ExecContext`（`monitor_contracts.ActionContext` 的子类，按 ActionContext 类型声明即可）。

```python
def run(self, command, driver, ctx):
    driver.click(conversation_row)          # 未声明 → 记为导航
    driver.type_text(search_box, "张三")     # 未声明 → 记为导航（搜索框输入）
    if ctx.cancel_requested():               # 可选：耗时步骤之间轮询，尽早返回
        return ActionResult(status="failed", reason="timeout")  # 管线会改判为 cancelled
    with ctx.outbound():                     # 对外动作必须包在这里
        driver.type_text(input_box, command.payload.text)
        driver.click(send_button)
    ...验证...
    return ActionResult(status="succeeded", executed_at=ctx.clock(),
                        externally_visible_side_effect=opened_unread)  # 只需声明守卫看不到的
```

规则：

1. **必须包进 `ctx.outbound()` 的**：发送、确认、提交转发、点击"求简历 / 换电话 / 换微信"、在对方可见的输入框里输入，以及任何对候选人或第三方可见的点击与输入。`driver.outbound()` 与 `ctx.outbound()` 等价，可嵌套。
2. **不要包的**：打开会话、切页签 / 筛选、滚动、关闭弹层、在搜索框输入。漏包对外动作会让 verify_only 拦不住、取消判定错误、限额不计数——这是处理器缺陷，审查时重点看。
3. **verify_only**：只能 click / scroll（导航）和读；`type_text`、`key`、`outbound()` 都抛 `ReadOnlyViolation`。打开未读会话会产生已读回执时，返回 `externally_visible_side_effect=True`。
4. **标志**：navigation 与 outbound 由守卫自动并入，处理器不必重复声明；守卫看不到的副作用（已读回执）要自己声明。core 会补 outbound ⇒ externally_visible。
5. **取消**：收到取消后，守卫在下一次写调用或进入 `outbound()` 时抛 `monitor.core.CommandCancelled`。**不要捕获它**（它不是 `DriverError`，`except DriverError` 不会误吞）；即使被 `except Exception` 吞掉，只要没有对外动作，管线仍回报 cancelled。对外动作开始后不会被打断，请照常完成并验证。
6. **单元测试处理器**：不经过管线时自己构造：

   ```python
   from monitor.core import ExecContext, GuardedDriver
   g = GuardedDriver(FakeDriver(...), mode="execute")   # verify_only 用 mode="verify"
   ctx = ExecContext(account_id=..., device_id=..., mode="local",
                     allowed_actions=frozenset({...}), deadline=..., guard=g)
   handler.run(cmd, g, ctx)
   assert g.outbound_calls == 1
   ```

E（观察）不受影响：仍是 `read_only` 守卫。

## 四、接口请求 / 需要协调者知悉

1. **取消信号来源**：运行时是单线程 tick，心跳与领取在动作执行期间不跑，所以服务端下发的取消实际上只会在指令排队时生效。running 中取消的机制（`Pipeline.cancel` 线程安全、守卫打断）已就绪，但要真正在执行中收到取消，需要 J（状态窗口的"取消当前动作"）或将来的独立心跳线程从另一线程调用 `runtime.pipeline.cancel(cid)`。本任务未加心跳线程。
2. **崩溃恢复的保守值**：守卫计数不落账，恢复时无法区分"只导航过"和"做过对外动作"，unknown 一律 outbound=true（计入限额）。如果希望更精确，需要 D1 在账本里提供"已进入对外动作"的落账点（例如 `ledger.mark_outbound(command_id)`），由 core 在 `outbound()` 首次写调用前落账——这是对 D1 / 契约 Ledger Protocol 的接口请求，本任务未实现。
3. `search_candidates` 计入限额改为看 navigation（见二.2），这是对"限额只针对 outbound"的有意例外，理由是搜索没有对外动作但平台同样限频。如不同意请告知。

## 五、提交

两个 commit：契约 0.2.0 适配；硬上限改值。只改了 `monitor/client/monitor/core/**`、`monitor/client/tests/test_core*.py` 与本报告；未提交 `uv.lock` 与 `__pycache__`。
