# J 交付报告：安装、运行模式、launchd、bootstrap、状态窗口

分支：`szrunworld/monitor-J`（基于 `c74a2d0`）。契约 0.2.0，只导入、未修改；core、driver、ledger、observe 未改动。
没有新增依赖（状态窗口用 Tk，随 Python 自带），`monitor/client/pyproject.toml` 未改，没有提交 `uv.lock`。

## 一、Commit

| commit | 内容 |
| --- | --- |
| `2446fa1` | install / mode / launchd / bootstrap / statusbar 全部代码与测试 |
| （本报告） | `docs/monitor/agent-reports/J.md` |

## 二、文件

```
monitor/client/monitor/install/     python -m monitor.install install|mode
├── cli.py        参数 / 交互、写入顺序、退出码（0 成功 / 1 前提缺失 / 2 参数或环境 / 3 注册或令牌失败）
├── prereq.py     前提检查（2ndscreen、辅助功能、屏幕录制；remote 另查自动登录、FileVault、休眠）
├── register.py   device_registration 构造与校验、POST /devices、能力探测
├── secrets.py    令牌：keychain（security -i）/ 0600 文件
└── paths.py      ~/Library/Application Support/RecruitMonitor/ 布局与 install_config.json
monitor/client/monitor/bootstrap/   python -m monitor.bootstrap [--no-ui]（launchd 入口）
├── app.py        进程装配：运行时线程、取消线程（CancellationWatcher）、状态窗口
├── session.py    RemoteSession / LocalSession / GateDriver
├── screen.py     screen create/list/destroy、app launch、window move/release（经 driver 的 CliRunner）
├── retry.py      有上限退避重试 + record_error
├── caffeinate.py 防休眠子进程
├── workhours.py  策略工作时段判断
└── testing.py    FakeCli / FakePopen / FakeKeychain（M 可复用）
monitor/client/monitor/statusbar/   viewmodel.py（纯函数）+ window.py（Tk）
monitor/launchd/                     templates/*.plist.template、install.sh、uninstall.sh、README.md
monitor/client/tests/test_install.py、test_install_launchd.py、test_bootstrap.py、test_bootstrap_app.py、test_statusbar.py
```

## 三、测试

```sh
cd monitor && uv sync && uv run pytest contracts client server
# 982 passed（基线 884 + 本任务 98）
uv run --with ruff ruff check --select F,E9,B,UP --target-version py312 --line-length 130 \
  client/monitor/install client/monitor/bootstrap client/monitor/statusbar client/tests/test_install*.py \
  client/tests/test_bootstrap*.py client/tests/test_statusbar.py
# All checks passed!
```

冒烟（临时 HOME，不碰 2ndscreen）：`python -m monitor.install mode local` → 2「尚未安装」；`install --mode local </dev/null` → 2「缺少 --server --enrollment-code」；`python -m monitor.bootstrap --no-ui` → 2「尚未安装」。

过程中的失败（已修复，留档）：
1. 真实 `window release` 在窗口已不在本屏时的文案是 `has no matching window on screen "X"`，driver 的分类表只收了 `has no matching on-screen window`，被分成 cli_failed。已在 `screen.py` 里按文案识别为"已归还"，没有改 driver。
2. local 首版把"判断是否接管"也按 30 秒节流，拿到策略后要等一个周期才接管；改为每轮判断（不调 CLI），只对失败后的重试节流。

验收对照：

| 验收项 | 测试 |
| --- | --- |
| 缺前提时准确列出缺项并退出非零、不写状态 | `test_install_missing_prereqs_exits_nonzero_and_writes_nothing`（4 项缺失全部出现、无 HTTP 请求、无安装目录、keychain 空）、`test_remote_lists_every_missing_item`、`test_missing_permissions_are_all_listed`、`test_2ndscreen_not_running_lists_dependent_checks` |
| mode 写入本地并出现在注册请求体 | `test_install_local_registers_with_mode_and_stores_everything`（请求体过 `validate_device_registration`，`mode=local`；真实 SQLite 账本 `monitor_state.mode=local`）、`test_install_remote_mode_in_body_and_state`、`test_mode_switch_reruns_checks_and_writes_state`；心跳带 mode：`test_build_app_assembles_from_install_config` |
| bootstrap 失败有上限重试并上报 | `test_remote_bootstrap_failure_is_bounded_and_reported`（2 轮 × 3 次后停止，每次 `bootstrap_remote` 上报，退避 2/4 秒走 ManualClock）、`test_remote_bootstrap_failure_reaches_heartbeat_last_error`（进入服务端心跳 last_error）、`test_local_boss_not_running_is_reported_not_launched`、`test_local_release_failure_is_bounded_and_explained`、`test_retry_*` |
| 状态窗口视图模型有测试，UI 能启动 | `test_statusbar.py`：视图模型 11 个用例；窗口用 fake Tk 验证启动、渲染、按钮回调、关窗最小化、停止时退出主循环（测试里不弹真实窗口） |
| 执行中取消 | `test_cancel_arrives_while_action_running`（动作执行中旁路心跳收到取消 → `pipeline.cancel` → 守卫打断 → `cancelled`，navigation=true、outbound=false）、`test_cancel_for_queued_command_is_deferred_to_runtime_thread`、`test_watcher_stops_on_unauthorized_and_survives_server_errors` |

## 四、设计要点

1. **前提检查的权限探测**：两项权限属于 2ndscreen 菜单栏应用（读树、点击、截图都由它做），CLI 没有查询命令。做法是建一块临时小屏（`--ttl 2m --owner-pid`），对本进程（没有窗口）执行 `window move`：2ndscreen 先查辅助功能权限再找窗口，所以"no matching on-screen window"表示有权限；对这块空屏截图判断屏幕录制权限（截不到用户内容）。探测后销毁临时屏。2ndscreen 不在运行时三项一起列为缺失。
2. **remote 系统项**：`defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser` 等于当前用户；`fdesetup status` 为 Off 且无进行中的加解密；`pmset -g` 当前 `sleep` 为 0。都不需要 root。
3. **写入顺序**：前提全部满足后才写。POST /devices → 令牌（keychain，失败或不可用退回 0600 文件）→ install_config.json（0600，不含令牌）→ 账本 `monitor_state.mode`。注册成功但令牌保存失败时退出码 3 并提示吊销该设备。`Idempotency-Key = register:<sha256(注册码)[:32]>`，重试复用。
4. **keychain**：`security -i` 从 stdin 读 `add-generic-password` 命令，令牌不出现在进程参数里；写后读回校验。只接受 URL 安全字符集的令牌，其他字符走文件。
5. **remote 引导**：`screen create --idle-timeout 0 --owner-pid <Monitor pid>` → `app launch --bundle com.zhipin.www --fill`（"refused to move"但窗口已在屏上时接受）；已在运行则用 lsappinfo 找 pid 后 `window move --fill` → `bind_window(pid)` → `caffeinate -d -i -s -w <Monitor pid>`。之后每 30 秒用 `screen_ok()` 体检，失败重新引导。`--owner-pid` / `-w` 保证 Monitor 崩溃后不留下屏幕或 caffeinate。
6. **local 接管**：只在策略 `work_hours` 内、且未因 user_request / account_switched / login_required 暂停时，把用户自己的 BOSS 窗口 `window move --fit-screen` 到专用屏；其他时候 `window release`。local 从不启动 BOSS（找不到进程就上报）。退出时归还并销毁专用屏；进程崩溃时 `--owner-pid` 让 2ndscreen 销毁屏幕，窗口回到主屏。
7. **GateDriver 闸门**：运行时拿到的 Driver 外包一层，窗口不归 Monitor 时所有界面方法直接抛 `WindowLostError`。归还时先关闸再 release，运行时任何时刻都碰不到用户窗口。
8. **"暂停并归还窗口"不等长轮询**：按钮在 UI 线程起一个短线程：置 `user_hold` → 等 GUI 锁（当前动作结束）→ 关闸 → `window release`；正式的 `runtime.pause("user_request")` 由运行时线程处理。测试 `test_local_release_now_from_another_thread_waits_for_gui_lock` 证明动作进行中不会动窗口。
9. **线程**：MonitorRuntime 与 Session 只在运行时线程里调用；UI 只读快照、把请求放进队列并 `clock.wake()`。取消线程只在有动作执行时，用独立的 CommandClient 发心跳（字段取自最近的快照），当前指令的取消直接调用 `pipeline.cancel`（D2b 已声明线程安全），其他指令的取消交回运行时线程（会写账本）。
10. **有上限**：每轮最多 `RetryPolicy.attempts`（默认 6，退避 2→120 秒），每个进程最多 `max_rounds`（默认 3）轮；用尽后停在 failed，状态窗口出现"重试"按钮，或恢复操作时重置。caffeinate 意外退出最多重启 5 次。

## 五、接口请求

1. **D2 / `__main__.py`（入口）**：任务要求的 `python -m monitor install` / `python -m monitor mode` 需要 `monitor/__main__.py` 在首个参数为 `install` 或 `mode` 时转给 `monitor.install.cli:main(argv)`（现在 `__main__` 的 `--server-url` 等是必填，不能直接加子命令）。本任务不改 `__main__`，目前入口是 `python -m monitor.install install|mode`。launchd 用 `python -m monitor.bootstrap`。
2. **D2 / `MonitorRuntime.status()`**：状态窗口还需要 `outbox_events` 计数、`last_error.message`、当前动作的 `command_id` 与 `started_at`。现在由 `app.py` 从 `runtime.ledger.pending_events`、`runtime.last_error`、`runtime.pipeline.current` 只读取得，建议并入 `status()`，J 改为只调 `status()`。
3. **D2 / 运行时的"窗口不归 Monitor"状态**：local 在工作时段外或归还窗口后，运行时仍会按周期观察，闸门抛 `WindowLostError` 后记 `last_error=window_lost`（文案说明是窗口已归还）。这会覆盖尚未随心跳发出的其他错误（例如引导失败）。建议 core 提供 `runtime.suspend_gui(reason)` / `resume_gui()`，或增加暂停原因 `off_hours`（需契约变更，`pause_reason` 是枚举）；届时 LocalSession 改调这个接口。
4. **D2 / 线程安全入口（可选）**：取消线程把非当前指令的取消交回运行时线程，用的是 J 自己的队列，不需要 core 改。若 core 将来想自己处理旁路心跳，可提供 `runtime.request_cancel(cid)`（线程安全，内部排队）。
5. **C / `CliFailure`**：`CliFailure` 是 `frozen=True` 的 dataclass 异常。它穿过 `contextlib.contextmanager` 写的 `with`（例如 `GuiLock.hold`）时，contextlib 给异常设 `__traceback__` 会抛 `FrozenInstanceError`，原异常被替换。J 的代码在 `with` 内都先把 CliFailure 转成别的异常，不受影响；其他在 `with gui_lock.hold()` 里直接调 CLI 的模块会受影响。建议 C 去掉 `frozen=True`（或改为普通异常类）。另外 driver 的错误分类表可补收 `has no matching window on screen`（window release 的文案）。

## 六、未覆盖与已知限制

- **没有在真机上跑过**：没有调用真实 2ndscreen、没有写真实钥匙串或 `~/Library/LaunchAgents`、没有动用户的 BOSS 窗口。权限探测、`app launch --bundle com.zhipin.www`、`window move --fit-screen` / `window release` 对 BOSS 的行为、Tk 窗口在 launchd 下的显示，都要按第七节在测试机上验证。
- **Tk 窗口**：测试用 fake Tk，没有在测试里弹出真实窗口（用户在用这台机器）。真实 Tk 能 import（uv 的 CPython 3.12 带 Tk 9.0），launchd 下能否显示依赖 `LimitLoadToSessionType=Aqua`，待真机确认。
- **launchd 顺序**：2ndscreen 与 Monitor 两个 LaunchAgent 同时加载，没有先后保证；靠引导的有上限重试等 2ndscreen 就绪（每轮约 2+4+8+16+32 秒）。
- **remote 的 2ndscreen LaunchAgent** 直接运行 `.app/Contents/MacOS/<可执行文件>`，`KeepAlive.SuccessfulExit=false`。用户在菜单里退出 2ndscreen（正常退出）不会被拉起。
- **local 暂停的时延**：归还窗口是立即的（等当前动作结束）；`runtime.pause` 记账要等运行时线程从长轮询（≤30 秒）回来。这期间若有排队指令开始执行，会因闸门关闭得到 `failed/driver_error`（没有对外动作）。
- **local 的登录失效**：窗口归还用户登录后，观察器看不到窗口，不能自动发现 `login_ok`；用户点"我已登录，继续"恢复。
- **能力声明**：`detect_capabilities` 按已合并模块声明（observe 有；`monitor.actions` 与 `monitor.login` 尚未合并，所以现在不声明动作能力与 login_relay）。H / K 合并后重新安装或由服务端以心跳为准。
- **mode 切换**只改本地并在下一次心跳上报；不重新注册，launchd 任务需要手动按提示重装。
- **电源检查**只看当前生效档位的 `sleep`；笔记本用电池时 `caffeinate -s` 不阻止系统休眠。remote 默认是接电的专用机。
- 引导与 `release_now` 调用 `record_error` 的线程：引导在运行时线程；用户点归还时，失败上报来自短线程（`record_error` 只是两次属性赋值）。

## 七、给协调者的真机验证步骤

前置：测试机已装 BOSS直聘（`com.zhipin.www`）与 2ndscreen.app，`cd monitor && uv sync`。控制台/服务端可用 F1 本地实例（只接受 https；联调可加隐藏参数 `--allow-insecure-http`）。

1. **前提检查（不满足）**：关掉 2ndscreen，`uv run python -m monitor.install install --mode remote --server https://… --enrollment-code X`，应退出码 1，列出 2ndscreen、辅助功能、屏幕录制，以及未满足的自动登录 / FileVault / 休眠；`~/Library/Application Support/RecruitMonitor/` 不应出现。
2. **前提检查（满足）**：打开 2ndscreen、授权两项权限、开启自动登录、关闭 FileVault、`sudo pmset -a sleep 0`，重跑，应全部 ✓；`2ndscreen screen list` 里不残留 `monitor-probe-*`。
3. **注册**：用控制台生成的注册码安装，确认服务端设备卡片 `mode=remote`；`security find-generic-password -s com.recruit-monitor.device-token -a <device_id>` 能找到；`install_config.json` 里没有令牌。
4. **launchd**：`monitor/launchd/install.sh remote`，确认 `~/Library/LaunchAgents/com.recruit-monitor.{monitor,2ndscreen}.plist`，`launchctl print gui/$(id -u)/com.recruit-monitor.monitor` 状态为 running。
5. **重启拉起**：重启测试机，不手动登录。自动登录后应看到：2ndscreen 菜单栏图标、状态窗口（独立设备模式）、`2ndscreen screen list` 有 `monitor` 屏且 BOSS 在上面、`pgrep -fl caffeinate` 有 `-w <Monitor pid>`、控制台设备在线且心跳 `client_state` 不是 not_running。
6. **崩溃恢复**：`kill -9 <Monitor pid>`，应在约 30 秒内由 launchd 拉起；caffeinate 旧进程随之退出、新进程出现；BOSS 窗口回到专用屏（`already running` → `window move`）。
7. **引导失败上报**：退出 2ndscreen 后 `kill` Monitor，确认控制台心跳 `last_error.code=bootstrap_remote`，几轮后停止重试，状态窗口出现"重试"。
8. **local**：另一台（或同一台切换）`python -m monitor.install mode local`；策略设当前时段，自己打开并登录 BOSS，启动 `uv run python -m monitor.bootstrap`。时段内 BOSS 窗口应移到专用屏；点"暂停并归还窗口"，窗口应立即回到主屏（若有动作在执行，等它结束）；点"恢复自动操作"后再次接管；把策略时段改到现在之外，下一轮（≤30 秒）归还；关闭 Monitor（Ctrl-C），窗口应回到主屏、`monitor` 屏消失。
9. **执行中取消**：开启一个动作白名单并下发指令，在动作执行中从控制台取消，确认结果为 cancelled（若对外动作尚未发生）。
10. **卸载**：`monitor/launchd/uninstall.sh`，两个 plist 消失、`launchctl print` 找不到任务。
