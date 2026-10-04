# 招聘 Monitor 运维手册

适用版本：monitor-v1（契约 0.3.2）。读者：负责安装、值守 Monitor 设备与桥接服务的运维 / 招聘系统管理员。

Monitor 只是 **BOSS 直聘的本机执行器 + 一层薄桥接服务**（[方案 §一·五](monitor-spec.md)）：本机负责观察『新招呼』、执行问候 / 求简历 / 换微信 / 搜索、本地账本与补传、状态窗口、本地硬上限；桥接服务负责设备注册与令牌、指令队列、事件接收。候选人业务归 ATS；下面两块已交接给服务器端，本手册只引用：

- 简历邮件接入：[handover-mail-ingestion.md](handover-mail-ingestion.md)
- 设备 / 登录 / 执行记录管理页：[handover-device-console.md](handover-device-console.md)（管理页上线前，下文给出等价的 HTTP 调用）

约定：`$API` 是桥接服务的基础地址（如 `https://monitor.example.com/api/v1`），`$CONSOLE` 是控制台令牌，`$DEV` 是设备 ID。所有写接口都要带 `Idempotency-Key`（每次操作一个新 UUID）。

```sh
console() {  # 用法：console METHOD PATH [JSON]
  curl -sS -X "$1" "$API$2" -H "Authorization: Bearer $CONSOLE" -H "Idempotency-Key: $(uuidgen)" \
       -H 'Content-Type: application/json' ${3:+-d "$3"}
}
```

---

## 一、选择运行模式

| | 本机模式 `local` | 独立设备模式 `remote` |
| --- | --- | --- |
| 机器 | 招聘人员自己的 Mac | 专用 Mac，无人值守 |
| BOSS 实例 | 用户自己的；工作时段内 Monitor 把窗口接管到专用屏幕，"暂停并归还窗口"立即交还 | Monitor 在专用屏幕上启动并独占 |
| 登录 | 用户在本机登录；失效时本机提示，不做二维码接力 | 二维码接力到控制台（等待任务 K） |
| 启动 | 登录 macOS 后随会话启动 | 开机自动登录 → launchd 拉起 2ndscreen 与 Monitor |
| 系统前提 | 2ndscreen 运行中、辅助功能、屏幕录制 | 同左 + 自动登录、不启用 FileVault、防休眠（`sudo pmset -a sleep 0`） |

选择建议：招聘人员白天自己也要用 BOSS → `local`；有一台闲置 Mac、希望全天候处理 → `remote`。同一个招聘账户只绑定一台设备。

**约束（必须告知用户）**：Monitor 操作期间不能在同一个 BOSS 实例里手动操作；打开会话会产生已读回执（用户 2026-10-04 已接受）。

## 二、启动桥接服务

服务端是 FastAPI + SQLite（`monitor/server`）。只监听 HTTP，**对外必须放在 HTTPS 反向代理后面**（Monitor 拒绝非 https 地址）。

正式入口是 `python -m app.main serve`（缺陷 M-4 已由任务 F5 修复）：控制台 / 服务令牌从环境变量、令牌文件或命令行读取，令牌不进日志。`monitor/scripts/serve.py` 现在只是转调这个入口，保留作兼容：

```sh
cd monitor && uv sync
export MONITOR_CONSOLE_TOKENS="<控制台令牌>=<操作者邮箱>"     # 可多个，逗号分隔
export MONITOR_SERVICE_TOKENS="<邮件接入令牌>=mail-ingest"   # 邮件接入（已交接）用，可省略
cd server && uv run python -m app.main serve --db /var/lib/monitor/server.db --port 8000
# 参数与环境变量的完整说明：uv run python -m app.main serve --help
# stderr 出现 "monitor-server ready http://127.0.0.1:8000/api/v1" 即就绪
```

- 进程内含编排的后台推进（每 60 秒），设备暂停 / 工作时段外被挂起的流程靠它补发指令。
- 重启服务端是安全的：指令、结果、幂等记录都在 SQLite 里；设备在服务端不可达期间把结果与事件留在本机，恢复后补传（混沌测试 `test_server_restart_*`、`test_server_unreachable_*`）。
- 令牌只放环境变量，不要写在命令行里。

## 三、安装设备与注册码

1. **生成注册码**（一次性，24 小时有效，含模式）：

   ```sh
   console POST /device-enrollments '{"mode":"local","note":"招聘部张三的 MacBook"}'
   # → {"enrollment_code": "...", "expires_at": ...}
   ```

2. **在设备上安装**（用户账户下执行，不要 sudo）：

   ```sh
   cd monitor && uv sync
   uv run python -m monitor.install install --mode local \
       --server "$API" --enrollment-code <注册码> --device-name "招聘部 MacBook"
   # 也可写作：uv run python -m monitor install ...（D2c 已合并）
   ```

   退出码：0 成功；1 前提缺失（逐项列出，什么都不写）；2 参数或环境问题；3 注册或令牌保存失败（若提示"注册成功但令牌保存失败"，先在控制台吊销该设备再重装）。
   令牌存入钥匙串（服务 `com.recruit-monitor.device-token`，账户为 device_id），钥匙串不可用时存 `~/Library/Application Support/RecruitMonitor/device_token`（0600）。安装目录里另有 `install_config.json`（不含令牌）与本地账本 `ledger.sqlite3`。

3. **切换模式**（以后需要时）：`uv run python -m monitor.install mode remote`，会重跑前提检查；launchd 任务要按提示重装。

## 四、绑定招聘账户

1. 控制台确认绑定：

   ```sh
   console PUT /devices/$DEV/account-binding '{"account_id":"<招聘账户 ID>","note":"确认人：李四"}'
   ```

2. **设备自动取得绑定**：设备在下一次心跳回执里收到 `account_binding`，写入本机并开始重建观察基线（首次启用只建基线，不把积压的『新招呼』当成新投递），完成后才领取指令。无需在设备上做任何操作（缺陷 M-1 已由任务 F5 + D2d 修复，原 `bind_account.py` 已删除）。

3. 核对：`console GET /devices/$DEV` 的 `last_heartbeat.account_id` 等于绑定账户、`account_binding` 非空；状态窗口"账户"一栏显示该账户。

换账户：控制台重新确认绑定即可。设备从心跳回执得知账户变更后，暂停对外动作、重建基线，完成后恢复领取。撤销绑定时设备清除本机绑定并停止领取。

## 五、开启自动化策略

策略默认**全部关闭**（`allowed_actions` 为空）。读当前策略、改字段、带 `If-Match` 保存：

```sh
console GET /accounts/<账户>/policy > policy.json      # 记下 policy_version
# 编辑 policy.json：allowed_actions、job_scope、greeting、auto_request_resume、work_hours、daily_limits、min_interval_seconds
curl -sS -X PUT "$API/accounts/<账户>/policy" -H "Authorization: Bearer $CONSOLE" -H "Idempotency-Key: $(uuidgen)" \
     -H "If-Match: <policy_version>" -H 'Content-Type: application/json' -d @policy.json
```

- `work_hours` 为空表示任何时段都不生成对外指令。工作时段外：自动问候 / 求简历挂起到下一时段；人工换微信照常受理、顺延到下一时段开始执行（响应里 `scheduled_for`）；搜索直接返回 409 `policy_blocked`，不顺延。
- 本地硬上限写死在 Monitor 里，策略只能更严：每种对外动作每日 ≤ 40 次；最小间隔问候 / 求简历 45 秒、换微信 60 秒、搜索 30 秒（`core/limits.py`，N 实测后再调）。
- `pause_on_anomaly` 只能为 true；`after_resume_received.action` 只能为 none（换微信只能人工触发）。

## 六、启动

- **开机自启**（推荐）：`monitor/launchd/install.sh local`（或 `remote`）。写入 `~/Library/LaunchAgents/com.recruit-monitor.monitor.plist`（remote 另有 2ndscreen 的 plist），崩溃后 launchd 自动拉起。卸载：`monitor/launchd/uninstall.sh`。
- **前台运行**（排查用）：`uv run python -m monitor.bootstrap`（`--no-ui` 不显示状态窗口）。
- 启动后检查：状态窗口"连接"为在线；`console GET /devices/$DEV` 的 `status=online`、`last_heartbeat.needs_baseline=false`。超过 90 秒无心跳服务端显示 offline。

## 七、暂停与恢复

| 谁 | 怎么做 | 效果 |
| --- | --- | --- |
| 本机用户（local） | 状态窗口『暂停并归还窗口』 | 等当前动作结束后立刻把 BOSS 窗口还给用户；停止领取与新动作；观察也停 |
| 本机用户（remote） | 『暂停自动操作』 | 停止领取与新动作 |
| 本机用户 | 『恢复自动操作』（登录失效时为『我已登录，继续』） | 恢复 |
| 控制台 | `console POST /devices/$DEV:pause '{"note":"原因"}'`，恢复用 `:resume` | 下一次心跳（≤ 30 秒）生效；暂停期间服务端也不为该账户生成对外指令，恢复后由后台推进补发 |

暂停只停"新的"对外动作：已经发生的动作照常记录与回传，不撤回任何已发出的消息。排队中的指令可以在暂停期间取消（`console POST /commands/<id>:cancel '{"note":"..."}'`），设备回报 cancelled 且从不执行。

## 八、吊销令牌

设备丢失、离职交接、令牌疑似泄露时：

```sh
console POST /devices/$DEV:revoke '{"note":"设备丢失"}'
```

设备下一次请求收到 401 后**停止全部服务端往来**（不再领取、不再上报），状态窗口提示"设备令牌已被吊销"。已领取未完成的指令不会自动释放给别的设备，需要人工处理。重新启用：在该设备上 `python -m monitor.install install --reinstall ...`（用新的注册码），再按第四节绑定。

## 九、常见异常与处置

状态窗口"最近异常"与心跳 `last_error.code` 对应下表。执行记录：`console GET "/commands?status=unknown&status=failed"`。

| 现象 | 识别 | Monitor 的行为 | 处置 |
| --- | --- | --- | --- |
| **登录失效** | 心跳 `pause_reason=login_required`，事件 `login_required`；状态窗口"BOSS 需要登录" | 暂停对外动作，继续只读观察；看到登录完成（`login_ok`）后自动恢复 | local：在 BOSS 窗口登录，再点『我已登录，继续』。remote：二维码接力（任务 K 合并后），否则到设备上登录。**注意**：登录页识别要等 K（现在观察器把登录页归为 unknown，见 M 报告）；指令在登录页上执行会 `failed/target_not_found`、流程转人工，不会误点 |
| **验证码 / 风控 / 未知弹窗** | 事件 `blocked_by_dialog`，`pause_reason=anomaly`；结果 reason `unknown_dialog` / `captcha` | 立即暂停，不点任何未知控件 | 到设备上人工处理弹窗（不要让 Monitor 代点），确认界面恢复正常后在状态窗口『恢复自动操作』或控制台 `:resume`。动作后出现的弹窗会让那条指令记为 `unknown`，按下面"unknown 核实"处理 |
| **窗口丢失 / 屏幕丢失** | `last_error.code` 为 `window_lost` / `screen_lost`；`client_state=not_running` | remote：每 30 秒体检，失败按有上限的退避重新引导（每轮 2→120 秒，最多 3 轮），用尽后状态窗口出现『重试』；local：工作时段外或已归还窗口时这是正常现象 | remote：确认 2ndscreen 在运行、BOSS 未被手动关闭，点『重试』；仍失败看 `~/Library/Application Support/RecruitMonitor/logs/`。local：确认 BOSS 已打开并登录 |
| **额度与上限** | 结果 `failed/rate_limited`（本地上限或最小间隔，未调用界面）；平台配额弹窗（如"今日沟通人数已达上限"）→ `unknown_dialog` | 本地上限：不执行；最小间隔：排队等待，等不到过期才失败。平台配额弹窗：暂停 | 本地上限是保护，不要绕过；需要调整时改策略（只能更严）。平台配额：当天停止该动作，次日恢复；把弹窗原文记下来交给 N 更新能力矩阵 |
| **结果 unknown**（人工核实） | `GET /commands?status=unknown`；流程 `needs_human`（`needs_human_reason=unknown_result`） | 不自动推进、不重发；崩溃恢复后仍不能确认的也落 `unknown/crash_recovery` | 只有三种处理，**没有"重试"**：① `POST /commands/<id>:recheck`（生成只读复核指令，会打开会话，不发任何消息）；② 人工到 BOSS 里看过后 `POST /commands/<id>:confirm-sent '{"note":"已在客户端看到求简历提示"}'`；③ `POST /cases/<case>:stop '{"note":"..."}'`。人工确认只记录在服务端，不改写设备证据 |
| **目标歧义** | `failed/target_ambiguous`，或事件 `conversation_ambiguous` | 不执行，流程转人工 | 在 BOSS 里人工确认是哪个会话，人工处理；同名同岗位的候选人 Monitor 永远不会自己挑 |
| **找不到目标** | `failed/target_not_found` | 不执行 | 会话可能被筛选隐藏（『全部职位』下拉、子筛选『未读』）或已滚出最上面约 10 行；恢复筛选为默认后 `recheck` |
| **搜索读不出** | 搜索 `outcome=unreadable`（与 `no_results` 不同） | 不回报空列表 | 不要当成"没有结果"；看 `unreadable_reason`，必要时人工在客户端搜索 |
| **服务端不可达** | `last_error.code=server_unavailable`；状态窗口"离线（自动重试）" | 指数退避（1→300 秒）；结果与事件留在本机账本，恢复后补传，不重做界面动作 | 恢复服务端即可。已知缺陷 M-2：退避期间进程空转占满一个 CPU 核，长时间断网时可先停掉 Monitor |
| **离线超过 24 小时** | 心跳 `needs_baseline=true` | 上线后先重建观察基线，期间不领取；离线期间到达的会话按积压处理、不当新投递 | 无需处理；这些候选人如需跟进，人工在 BOSS 里处理 |
| **心跳被拒（4xx）** | Monitor 进程反复退出、launchd 反复拉起 | 已知缺陷 M-3：心跳 422 / 403 会让进程崩溃 | 看日志里的错误码：422 通常是契约版本不一致（升级 Monitor 或服务端），403 `device_mismatch` 是令牌与设备不符（重装） |
| **令牌被吊销** | 状态窗口"设备令牌已被吊销"；`revoked=true` | 停止全部服务端往来 | 见第八节 |
| **结果被拒 / 结果冲突** | `last_error.code` 为 `result_rejected` / `result_conflict` | 4xx 的结果留在本机、本进程内不再重发；冲突时以服务端首个结果为准 | 契约不一致，需开发排查；不要手工改账本 |

## 十、文件与日志

| 位置 | 内容 |
| --- | --- |
| `~/Library/Application Support/RecruitMonitor/install_config.json` | 服务端地址、device_id、设备名、专用屏幕名、令牌存放方式（不含令牌） |
| `~/Library/Application Support/RecruitMonitor/ledger.sqlite3` | 本地账本：指令与结果、事件 outbox、绑定、暂停状态、观察基线。只允许一个 Monitor 进程打开；不要手工修改 |
| `~/Library/Application Support/RecruitMonitor/logs/` | launchd 的 stdout / stderr |
| 钥匙串 `com.recruit-monitor.device-token` | 设备令牌 |

## 十一、发布前自检

```sh
monitor/scripts/run_integration.sh           # 契约、客户端、服务端、邮件接入单元测试 + 集成与混沌测试
monitor/scripts/run_integration.sh chaos     # 只跑混沌（回报失败、重复送达、取消、过期、离线、服务端重启、租约、执行中被杀）
```

结果末尾的 XFAIL 是已知缺陷与等待中的任务；出现 XPASS 说明某项已修好，按测试里的说明删掉标记。全部通过只说明夹具与派生界面上的行为正确，**不等于真机验证**（N 阶段负责）。
