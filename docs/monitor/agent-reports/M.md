# M 交付报告：集成与混沌测试、一键脚本、运维手册

分支：`szrunworld/monitor-M`（基于 `be21dae`，契约 0.3.2）。只新增 `monitor/integration/**`、`monitor/scripts/**`、`docs/monitor/runbook.md` 与本报告；client、server、mail、contracts 的源码一行未改，没有提交 `uv.lock`。

本文中"通过"只表示进程内服务端 + 真实客户端运行时 + FakeDriver 回放夹具（及派生界面）上的行为通过，**不是真机验证**。

## 一、Commit

| commit | 内容 |
| --- | --- |
| `9f97f03` | 集成装配工具 `integration_kit.py`、`conftest.py`，8.1 端到端用例 |
| `b1832b9` | 设备注册 / 暂停 / 吊销、人工换微信（含顺延）、搜索三种结局、登录失效 |
| `06d7b5a` | 混沌测试（进程内）：补传、重复送达、取消、过期、离线 24 小时、服务端重启、租约过期 |
| `7e3117a` | 执行中被杀（真实子进程 `os._exit(9)`）、真实服务端进程冒烟、已知缺陷 strict xfail；`scripts/run_integration.sh`、`scripts/serve.py` |
| `dbda452` | `docs/monitor/runbook.md`；`scripts/bind_account.py` |
| （本报告） | `docs/monitor/agent-reports/M.md` |

## 二、文件

```
monitor/integration/                 （不是工作区成员，没有 pyproject；直接用已安装的 client / server / contracts）
├── conftest.py                      fixture `w`（World）
├── integration_kit.py               装配：Server（进程内 ASGI + SQLite 文件库）、Cluster（可注入故障、可重启服务端的 httpx 传输）、
│                                    Screen（FakeDriver 外壳：换场景、写调用钩子、fsync 日志、写调用分类）、
│                                    Monitor（MonitorRuntime + SQLite 账本 + 观察器 E + 处理器 H1–H3）、World、BOSS 界面剧本
├── kill_child.py                    混沌子进程：点击后 os._exit(9)
├── test_e2e_flow.py                 8.1：新招呼 → 问候 → 求简历（含确认气泡、问候关闭、积压不产生事件）
├── test_e2e_device.py               注册 + 绑定、注册码一次性、控制台暂停 / 恢复、吊销令牌、bind_account 替代步骤；M-1 xfail
├── test_e2e_manual_search_login.py  人工换微信（工作时段内 / 外顺延）、搜索三种结局与时段外拒绝、登录失效暂停与恢复；K xfail
├── test_chaos.py                    进程内混沌 15 个场景
├── test_chaos_kill.py               执行中被杀 3 个场景（真实子进程）
├── test_real_server_process.py      真实 uvicorn 进程上的注册 → 绑定 → 心跳 → 取策略冒烟
└── test_known_defects.py            M-2、M-3、D2c 入口分发的 strict xfail
monitor/scripts/
├── run_integration.sh               一键：all / integration / chaos，其余参数传给 pytest
├── serve.py                         带控制台 / 服务令牌启动服务端（M-4 的替代）
└── bind_account.py                  把控制台确认的账户写进本机账本（M-1 的替代）
docs/monitor/runbook.md
```

## 三、测试命令与结果

```sh
cd monitor && uv sync && uv run pytest contracts client server mail integration
# 1702 passed, 6 xfailed in 45.84s（xfail：H2 原有 1 个 + 本任务 5 个）

monitor/scripts/run_integration.sh           # 同上，--frozen，摘要里列出全部 xfail
monitor/scripts/run_integration.sh chaos     # 18 passed in 6.64s
uv run pytest integration                    # 连跑两次：37 passed, 5 xfailed（各约 15 秒），结果稳定

uv run --with ruff ruff check --select F,E9,B,UP --target-version py312 --line-length 130 integration scripts
# All checks passed!
```

过程中的失败（都已查明，留档）：
1. 第一版把 `Cluster` 直接当 httpx 传输交给 `register_device`，`with httpx.Client(...)` 退出时关闭传输，把服务端也关了——改为 `close()` 空操作、`shutdown()` 才真正关。
2. `claim_wait_seconds=0` 时运行时永远建议等待 0 秒，可控时钟不走，暂停 / 恢复用例卡住——改为保留默认长轮询，由 `Cluster` 把发给服务端的 wait_seconds 改成 0、空手而归时推进可控时钟 wait_seconds（与"等满了"等价）。
3. 换微信失败 `target_not_found`：派生的会话详情沿用了"招聘方未回复"界面，『换微信』是置灰形态（裸 StaticText）。问候之后按 contact_exchange_state#0 的形态补上 57×24 外层 AXGroup（"回复后可用"是推断）。
4. 断网场景卡住，追查出缺陷 M-2；子进程首次心跳 422，追查出缺陷 M-3（触发原因是测试里父子进程同一时刻的心跳撞了幂等键，真实时钟下微秒级的 sent_at 不会撞，但暴露了 4xx 会让进程崩溃）。

## 四、覆盖对照

所有场景都用**同一台 Monitor 的真实运行时 + SQLite 账本**和**同一个服务端 SQLite 文件**，并断言 FakeDriver 收到的对外动作类写调用（`Screen.outbound()`：问候输入 / 发送、求简历、确认气泡、换微信、搜索输入 / 提交）与预期**完全相等**。

### 端到端

| 场景 | 用例 | 关键断言 |
| --- | --- | --- |
| 注册与绑定 | `test_register_with_enrollment_code_then_console_binding` | J 的 `register_device` 换令牌；未绑定时心跳 account_id=null、不领取；绑定后 `account_confirmed`、取到策略 |
| 注册码一次性 | `test_enrollment_code_is_single_use` | 同一安装重试得到同一设备；另一请求体复用注册码被拒 |
| 新招呼 → 问候 → 求简历 → 落库 | `test_new_greeting_to_resume_request_end_to_end` | 基线 19:05 不产生事件；19:11 的候选人L 产生一条 `application_observed`（hints 为空）；服务端一条流程、问候与求简历都 succeeded、求简历 depends_on 问候；本机账本 delivered；对外写 = 输入、发送、求简历各一次 |
| 求简历确认气泡 / 问候关闭 / 积压 | `test_resume_request_with_confirm_bubble_clicks_confirm_once`、`test_greeting_disabled_goes_straight_to_resume_request`、`test_backlog_rows_at_baseline_never_produce_events` | 『确认』只点一次；问候关闭只下发求简历；基线时已在的会话多轮观察都不产生事件 |
| 人工换微信 | `test_manual_wechat_request_in_work_hours` | 201、流程 `contact_requested`、output `{wechat, requested}`、换微信只点一次 |
| 换微信工作时段外顺延 | `test_manual_wechat_outside_work_hours_is_deferred_to_next_window` | 23:40 提交 → `scheduled_for` = 次日 08:00；整夜一直在领取但领不到；08:00 后执行一次 |
| 搜索三种结局 | `test_search_snapshot_three_outcomes[results / no_results / unreadable]` | outcome 与 coverage 分开；无结果与读不出 items 都为空、只能靠 outcome 区分；三个执行标志为 true；输入、提交各一次，不点卡片、不滚动 |
| 搜索时段外 | `test_search_outside_work_hours_is_refused_not_deferred` | 409 `policy_blocked`，不生成指令 |
| 登录失效暂停与恢复 | `test_login_expired_pauses_then_resumes_after_login` | `login_required` 事件、`device_paused(login_required)`、心跳 paused；暂停期间不领取；`login_ok` 后自动恢复并完成主线 |
| 登录失效时指令已在手 | `test_command_running_on_login_page_fails_without_outbound` | 在登录页执行 → `failed`、无对外动作、流程转人工 |
| 控制台暂停 / 恢复 | `test_console_pause_stops_claims_and_resume_continues` | 暂停期间观察照常、事件上报、服务端不生成指令、设备不领取；恢复后由后台推进补发并执行一次 |
| 吊销令牌 | `test_revoked_token_stops_all_server_traffic` | 401 后不再发任何请求；重启进程只发一次就停 |
| 真实进程 | `test_register_bind_heartbeat_against_real_process` | uvicorn 进程 + 真实 HTTP：注册、绑定、心跳在线、取策略、领取 |

### 混沌（`test_chaos.py`、`test_chaos_kill.py`）

| 场景 | 用例 | 对外写调用 |
| --- | --- | --- |
| 回报 500（请求没到服务端）后补传 | `test_result_500_then_redelivered_without_redoing_gui` | 3 次 500 后补传成功，各一次 |
| 服务端已落库、响应丢失 | `test_result_recorded_but_response_lost_is_redelivered_idempotently` | 补传按幂等返回，无冲突，各一次 |
| 服务端不可达 10 分钟 | `test_server_unreachable_for_minutes_then_everything_delivered` | 结果与事件留本机，恢复后补传，各一次 |
| 重复送达 | `test_duplicate_delivery_returns_existing_result` | 网络层重放领取响应 → 回报已有结果，服务端结果不变，各一次 |
| 排队中取消 | `test_cancel_while_queued_on_device` | 入账后用户暂停，控制台取消 → `cancelled`、三标志 false，从未执行（0 次） |
| 执行中取消（对外动作前） | `test_cancel_while_running_before_outbound` | J 的旁路心跳（`CancellationWatcher.poll_once`）收到取消 → 守卫打断 → `cancelled`、navigation=true（0 次对外） |
| 执行中取消（对外动作后） | `test_cancel_arriving_after_outbound_reports_actual_result` | 回报实际 `succeeded`，发送只一次 |
| 指令在设备队列里过期 | `test_command_expires_in_device_queue` | 暂停 3 小时后恢复 → `expired`、三标志 false、流程转人工（0 次） |
| 指令在服务端过期 | `test_unclaimed_command_expires_on_server_while_device_offline` | 离线 3 小时，上线后领不到（0 次） |
| 停机超过 24 小时 | `test_process_down_over_24h_rebuilds_baseline_before_claiming` | 基线 generation+1；每次领取时 needs_baseline 都已清除；离线期间的会话不当新投递（0 次） |
| 断网超过 24 小时 | `test_network_down_over_24h_rebuilds_baseline_before_claiming` | 同上 |
| 服务端重启（动作后） | `test_server_restart_mid_flow` | 结果补传到新实例，新实例生成求简历，各一次 |
| 服务端重启（领取后、ack 前） | `test_server_restart_between_claim_and_ack` | ack 补发到新实例，不重复领取，各一次 |
| 租约过期未 ack 重新领取 | `test_lost_claim_response_is_reclaimed_after_lease_expires` | 领取响应丢失 → 租约内领不到 → 过期后领到同一 command_id，各一次 |
| 入账后 ack 前进程重启 | `test_crash_after_intake_before_ack_executes_once` | 未 ack 列表丢失仍只执行一次 |
| 点『求简历』后被杀，点击生效 | `test_killed_right_after_resume_click[detail_requested-…]` | 子进程 `os._exit(9)`；账本停在 running；重启后 verify_only 复核 → `succeeded`；三段合计：输入、发送、求简历各一次 |
| 点『求简历』后被杀，界面看不出 | `test_killed_right_after_resume_click[detail_greeted-…]` | 复核 → `failed/verification_failed`、流程转人工、不重点 |
| 输入问候后、发送前被杀 | `test_killed_after_greeting_typed_before_send` | 复核不重输、不发送；问候不明不推进求简历 |

## 五、发现的缺陷（请协调者派修）

| 编号 | 归属 | 缺陷 | 失败测试（strict xfail） |
| --- | --- | --- | --- |
| **M-1** | 契约（A）+ core / J | **设备永远得不到绑定账户**。控制台 `PUT /devices/{id}/account-binding` 后，HeartbeatAck 只有 `account_confirmed`，没有 account_id；install / bootstrap 也不询问。全仓库只有测试调用 `runtime.bind_account`，所以真实部署里设备永远"未绑定"、永远不领取。建议：HeartbeatAck 增加 `bound_account_id`（或设备拉取绑定的接口），core 收到后调用 `bind_account`。替代步骤：`scripts/bind_account.py`（runbook 第四节） | `test_e2e_device.py::test_monitor_learns_binding_from_server_without_manual_step` |
| **M-2** | core（D2） | **退避期间空转**。心跳失败后 `_next_heartbeat` 停在过去，`_idle_seconds` 取到负数 → 0，`run_forever` 在退避期内忙循环（满一个 CPU 核），最长到 300 秒退避结束；长时间断网会一直如此。建议把 `backoff.next_at` 作为心跳到期时间的下限（或 `_idle_seconds` 忽略已过期但被退避挡住的时间点） | `test_known_defects.py::test_runtime_does_not_busy_spin_while_backing_off` |
| **M-3** | core（D2） | **心跳 4xx 让进程崩溃**。`_server_round` 只捕获 `ServerUnavailable / Unauthorized`，心跳收到 422 / 403 时 `RequestRejected` 穿出 `run_once`，`run_forever` 退出，launchd 反复拉起。建议捕获后记 `last_error` 并退避 | `test_known_defects.py::test_heartbeat_4xx_does_not_crash_runtime` |
| **M-4** | server（F1） | `python -m app.main serve` 无法配置控制台 / 服务令牌（`StaticTokenAuthenticator` 为空），独立启动的服务端任何控制台接口都 401，连注册码都生成不了；也无法注入 webhook 通知。替代：`scripts/serve.py`（环境变量配置令牌）。建议服务端提供正式的配置入口 | 无（`test_real_server_process.py` 用替代脚本覆盖） |
| 等待 K | K | 观察器把登录页归为 unknown，不产生 `login_required`；处理器也不识别登录页。集成测试用替身 `LoginStandIn` 验证了 core / 服务端一侧的暂停与恢复链路 | `test_e2e_manual_search_login.py::test_real_observer_reports_login_required_on_login_page` |
| 等待 D2c | D2c | `python -m monitor install|mode` 入口分发未实现（runbook 两种写法都给） | `test_known_defects.py::test_monitor_main_dispatches_install_subcommand` |

D2d（搜索按对外动作计数）：本任务的搜索用例只断言结果标志（三个都为 true，H2 已实现）与写调用次数，不依赖 core 的计数方式，没有加 xfail；H2 原有的 `test_core_treats_search_success_as_outbound` xfail 仍在。

## 六、未覆盖项与已知限制

- **不是真机**。点击后的界面（发送后的我方消息、『简历请求已发送』、确认气泡、『请求交换微信已发送』、搜索结果 / 无结果文案、登录页）都是派生假设，派生规则与 H1 / H2 / H3 的单元测试一致；"招聘方回复后换微信可用"也是推断。
- **服务端在进程内**（真实 FastAPI 应用、真实 SQLite 文件、真实路由与幂等），以便与客户端共用可控时钟；真实 uvicorn 进程只做了冒烟。编排的后台推进按可控时钟每 60 秒调用一次 `orchestrator.tick()`，与 lifespan 里的定时器等价。
- **长轮询**：服务端用真实时间等待，`Cluster` 改成 0 秒并在空手而归时推进可控时钟。
- **执行中被杀**：子进程同时承载服务端实例（同一 SQLite 文件），父进程此时停掉自己的实例；子进程的可控时钟比父进程晚 1 秒起步（避免心跳幂等键撞键），父进程重启前把时钟拨后 10 分钟。
- **执行中取消**：在 FakeDriver 写调用钩子里同步调用 J 的 `CancellationWatcher.poll_once()`，等价于取消线程在动作中途醒来一次；没有起真实线程。
- **登录失效**：用 `LoginStandIn` 替身产生 `login_required / login_ok`（形状与 core 的 `make_event` 一致），真实识别等 K。
- **邮件接入与设备管理页**已交接，本任务没有做邮件链路的集成（G 的 `FakeMailService` 未接入）；`resume_linked` 由 F2 的服务端测试覆盖。
- **M-2 的测试替代**：`Monitor.step()` 检测到"退避中且建议等待 0 秒"时记 `busy_spins` 并把可控时钟拨到退避结束，否则断网用例无法推进时间。
- 每日上限、最小间隔在集成层只间接经过（问候与求简历是不同动作）；单元测试由 D2 / D2b 覆盖。

## 七、接口请求

1. **M-1 契约缺口（契约缺口）**：设备需要从服务端得知绑定账户。见第五节，建议 HeartbeatAck 增加 `bound_account_id`。
2. **工作区（可选，非阻塞）**：`monitor/integration` 不需要加入 uv 工作区——它没有自己的依赖，直接导入已安装的成员，`uv run pytest integration` 可用。若协调者希望它出现在 `members` 里，需要给它一个 pyproject（依赖 monitor-client、monitor-server、httpx、pytest）。

## 八、问询

无。

## 九、对后续任务的接入说明

- **修缺陷的任务**：修好后对应 strict xfail 会 XPASS 并让测试失败，删掉标记即可。M-1 修好后把 `integration_kit.bind_locally` 与 runbook 第四节第 2 步、`scripts/bind_account.py` 一并删除。
- **K**：把 `LoginStandIn` 换成真实观察器 / 登录模块，`test_real_observer_reports_login_required_on_login_page` 应转为通过；请同时提供真实登录页夹具，替换 `login_page_step()` 的假设界面。
- **N（真机）**：`runbook.md` 按步骤可在干净账户上完成注册与绑定（含 M-1 替代步骤）；混沌场景里"点击生效 / 不生效"的判定依赖 H1 的复核规则，真机上需要核对『简历请求已发送』在被杀重启后是否仍可读。
- **新增场景**：`World` + `Screen` + 界面剧本（`boss_new_greeting / boss_wechat / boss_search`）+ `Cluster.fail / after_hooks / stop_server / start_server` 可以组合出新的端到端或混沌用例；写调用种类见 `classify_write`。
