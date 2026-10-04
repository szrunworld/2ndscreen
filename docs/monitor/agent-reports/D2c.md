# D2c 交付报告：执行管线三处小改（J 的接口请求 1–3）

分支：`szrunworld/monitor-D2c`。中途按协调者通知合入 monitor-v1（`0003a9f`，契约 0.3.1），无冲突，`core/testing.py` 中协调者补的 `mail_retention_days: 30` 与 `company_mailbox: zhaopin@example.com` 原样保留。契约、driver、observe、actions、ledger 未改。

## 一、结果

| 验收项 | 结果 |
| --- | --- |
| `cd monitor && uv sync && uv run pytest contracts client server` | 1542 passed，1 xfailed（xfail 为 H2 的 search 待 D2d） |
| 另跑 `uv run pytest contracts client server mail integration` | 1712 passed，5 xfailed（均为 M-1/M-2/M-3 等其他缺陷） |
| `ruff check --select F`（core、`__main__`、bootstrap、相关测试） | 无告警 |

## 二、变更

### 1. 入口分发（`monitor/__main__.py`）

`main(argv)` 首个参数为 `install` 或 `mode` 时，把**完整** argv 转给 `monitor.install.cli:main(argv)` 并返回其退出码；其余参数照旧按常驻进程解析（缺必填参数仍报错退出 2）。`argv=None` 时读 `sys.argv[1:]`。

**新入口**（`python -m monitor.install install|mode` 继续可用）：

```sh
python -m monitor install [--mode local|remote] [--server ...] [--enrollment-code ...]
python -m monitor mode local|remote
python -m monitor.bootstrap [--no-ui]          # launchd 用，不变
python -m monitor --server-url ... --device-id ... --db ...   # 裸运行时，不变
```

按要求未改 J 报告；`docs/monitor/status.md` 由协调者维护，未改。`bootstrap/app.py` 里"先运行 python -m monitor.install install"的提示仍然有效，未改（不在本任务允许的 J 改动范围内）。

### 2. `MonitorRuntime.status()` 扩充（`core/runtime.py`）

原有键不变，新增：

| 键 | 说明 |
| --- | --- |
| `device_id`、`monitor_version` | 取自配置，让状态窗口不再读 `runtime.config` |
| `outbox_events` | 未送达事件数（与心跳 `queue.outbox_events` 同口径） |
| `last_error` | 由 `{code, at}` 扩为 `{code, message, at, scene}`；无错误时仍为 `None` |
| `current_command_id`、`current_started_at` | 执行中指令的 id（字符串）与开始时间（datetime）；空闲时为 `None` |
| `gui_suspended`、`gui_suspend_reason` | 见第 3 条 |

`status()` 会读账本，只应在运行时线程调用（docstring 已注明）。`client_state` 改为与心跳一致的"报告值"（挂起时为 `unknown`）。

J 文件改动（只为改用 `status()`）：`bootstrap/app.py` 的 `MonitorApp.publish()` 全部字段改从 `status()` 取，不再读 `rt.pipeline.current`、`rt.last_error`、`rt.ledger.pending_events`、`rt.config`。statusbar 本来就只读 `StatusSnapshot`，无需改。

**有意保留的直接访问**（说明理由，均不是状态窗口读取）：
- `CancellationWatcher.poll_once` 读 `runtime.pipeline.current`：它在取消线程里运行，`status()` 会读账本（SQLite 不跨线程），而且快照在 `run_once` 前后才发布，动作执行期间的快照里没有当前指令；`pipeline.current` 是这里唯一实时且线程安全可读的来源。
- `_drain` / 取消线程调用 `pipeline.cancel(...)`：是调用不是读取，D2b 已保证线程安全。
- `build_app` 里 `RuntimeView` 的 `policy` / `pause_state` lambda：供 Session 判断时段与暂停原因，每轮都调，用 `status()` 会多三次账本查询；不在本次请求范围，保持不动。

### 3. 窗口挂起 `suspend_gui(reason)` / `resume_gui()`（`core/runtime.py`、`core/pipeline.py`）

语义：挂起 = 窗口不归 Monitor，"做不了"；与暂停（"不该做"）独立，互不覆盖，心跳 `paused` 不受影响。

- **线程安全、排队**：两个方法任何线程可调，把请求放进 `SimpleQueue` 并 `clock.wake()`；运行时线程在 `run_once` 开头与服务端往来之后按顺序生效（最后一个为准）。另有一把锁保护的"最近请求"标志，使请求**尚未生效**时也能识别窗口已被归还。
- **挂起期间**：不观察、不做崩溃恢复、不执行、不领取（`_can_claim` 为假，指令全都需要界面）；心跳、结果回传、事件补传照常。`_idle_seconds` 不再计入 `pipeline.wake_at`（避免挂起时为到期的推迟指令空转）。
- **window_lost 不记错误**：`record_error("window_lost", ...)` 在已挂起或挂起请求已到时直接忽略（观察器经 `attach(report=...)` 上报也走这里）；观察抛 `WindowLostError` 时同样不记、也不把 `client_state` 改成 `not_running`。尚未随心跳发出的真实错误（如引导失败）不再被覆盖。其他错误码照常记录。
- **竞态兜底**：`Pipeline` 新增可选参数 `gui_available`，`_execute` 拿到 GUI 锁后再确认一次；归还窗口一方持锁期间到达的挂起请求会让指令留在 `queued`，不会在闸门已关时执行出一个 `failed/driver_error`。
- **client_state**：契约枚举没有 `suspended`。挂起生效时把 `client_state` 置 `unknown`，挂起期间心跳与 `status()` 都报 `unknown`（看不到界面，如实）；恢复后保持 `unknown` 直到下一次观察得出新值。见第四节接口请求 1。
- **恢复**：`resume_gui()` 生效后立即安排一次观察（`_next_observe = now`），执行与领取随即恢复。

J 文件改动（只为改调用）：
- `bootstrap/session.py`：`RuntimeView` 新增 `suspend_gui` / `resume_gui` 两个字段（默认空操作，旧的构造方式不受影响）；`LocalSession.start()` 先 `suspend_gui("尚未接管")`（启动时窗口还不归 Monitor）；`_give_back_locked` 在关闸**之前** `suspend_gui(why)`；`_release_quietly`（接管失败兜底）`suspend_gui("接管失败")`；`_take_over` 成功（仍持 GUI 锁）后 `resume_gui()`。RemoteSession 未改。
- `bootstrap/app.py`：`build_app` 把 `runtime.suspend_gui` / `runtime.resume_gui` 传入 `RuntimeView`。
- `tests/test_bootstrap_app.py`：`wire()` 同样传入这两个接口，原有 local 暂停/恢复等测试在真实挂起语义下照常通过。

### 4. 本任务以外的一处改动

`integration/test_known_defects.py::test_monitor_main_dispatches_install_subcommand` 原标 `xfail(strict=True, reason="等待 D2c（入口分发）")`，本任务修好后变为 strict XPASS 导致失败。按该文件头"修好后删掉标记即可"的约定删除了标记，并把行内注释改为现状。

## 三、新增测试

- `test_core_main.py`：`install` / `mode` 转给 install CLI 且透传完整 argv 与退出码；其他参数不转发（缺必填参数仍 SystemExit 2）；`argv=None` 时读 `sys.argv`。
- `test_core_runtime.py`：
  - `test_status_includes_outbox_last_error_and_current_command`：outbox 计数、last_error 的 message/scene/at、执行中读到的 command_id 与 started_at。
  - `test_suspend_gui_stops_observe_execute_and_keeps_real_error`：挂起后不观察、不执行、不领取；先前未发出的 `bootstrap_takeover` 不被 window_lost 覆盖并如实随心跳发出；心跳 `client_state=unknown`、`paused=false`；恢复后立即观察、指令执行完毕，window_lost 重新算错误。
  - `test_suspend_request_is_queued_until_runtime_thread_applies_it`：请求排队、按序生效；未生效前 window_lost 也不记。
  - `test_suspend_after_command_picked_leaves_it_queued`：管线拿锁后发现挂起，指令留在队列。
  - `test_suspend_does_not_busy_loop_on_deferred_command`：挂起时返回的空闲时间为正。

全部用 ManualClock 驱动，无固定 sleep。

## 四、接口请求

1. **契约 / `DeviceHeartbeat.client_state`**：建议增加 `suspended`（或独立字段 `gui_suspended: bool` + `gui_suspend_reason`），让控制台区分"窗口已归还用户 / 不在工作时段"与"界面状态未知"。目前挂起期间报 `unknown`；契约加值后 core 只需改 `_reported_client_state()` 一处。
2. **J / 状态窗口（可选）**：`status()` 已提供 `gui_suspended` / `gui_suspend_reason`，`StatusSnapshot` 尚未展示（本任务不改 J 行为）；Session 自己的 `session_state` 已能显示"已归还"，是否再展示由 J 决定。
3. **D2d**：M-2（退避期间空转）仍在，未在本任务处理；`_idle_seconds` 的改动只涉及挂起时忽略 `pipeline.wake_at`，不影响 M-2 的修法。
