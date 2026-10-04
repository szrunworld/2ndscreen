# 任务 E 交付报告：观察模块（只读识别新投递）

分支：`szrunworld/monitor-E`（基于 bbb197d）。契约 0.2.0，只导入、未修改；core、driver、夹具未修改。

## 一、Commit 列表

| commit | 内容 |
| --- | --- |
| f48a65a | `monitor/client/monitor/observe/`（页面分类、会话行解析、时间文案解析、观察器、`create_observer`）与 3 个测试文件 |
| （本报告） | `docs/monitor/agent-reports/E.md` |

## 二、文件

```
monitor/client/monitor/observe/
├── __init__.py    导出 create_observer、NewApplicationObserver 等
├── page.py        页面分类 PageKind；窗口相对坐标 Layout；『新招呼』页签定位与核对；弹层、『更多』菜单检测
├── rows.py        会话列表可见行解析 ListRow（姓名、岗位、时间、未读数、[已读]/[送达] 前缀）
├── timetext.py    列表时间文案解析 ListTime（分钟 / 日两种精度）与 bucket
└── observer.py    NewApplicationObserver（Observer Protocol）与 create_observer()
monitor/client/tests/test_observe_timetext.py   43 个
monitor/client/tests/test_observe_page.py       94 个（含对 B 全部 42 步夹具的逐步核对）
monitor/client/tests/test_observe_observer.py   41 个
```

## 三、测试命令与结果

```sh
cd monitor && uv sync && uv run pytest contracts client server     # 882 passed（含 observe 178 个）
uv run pytest client/tests/test_observe_*.py -q                     # 178 passed
uv run --with ruff ruff check --select F,E,W --line-length 120 client/monitor/observe client/tests/test_observe*.py   # All checks passed
```

过程中的失败（已修复，留档）：`test_new_row_with_same_name_as_baseline_row_is_ambiguous` 首次失败——基线指纹只按"姓名+岗位"存集合，基线时已可见的候选人B 会把之后新露出的同名同岗位会话一起遮掉。改为按指纹存基线时的行数：同名同岗位的可见行数超过基线时的数量，就逐行按消息时间判断，进而产生歧义事件。

`uv.lock`、`__pycache__` 未提交。没有固定 sleep。没有 screenshot 调用。

## 四、实现的规则（对照派发说明）

1. **新投递 = 『新招呼(N)』页签里的会话**。页签选中态在 AX 中不可见（capabilities 1.2），无法判断当前在哪个页签，所以每次观察都先点一次『新招呼』页签再读。『全部』页签不用于识别。
2. **只读当前可见行**，不滚动。
3. **基线按时间**：`baseline.established=False` 时记录 `baseline_at`（UTC ISO）与当时可见行的指纹计数（姓名+岗位的 sha256 前 24 位，不存明文），只建基线、返回空。之后：
   - 消息时间为分钟精度：晚于基线所在分钟 → 新；同一分钟或更早 → 积压（不猜）。
   - 日精度（『昨天』『10月3日』）：晚于基线日期 → 新；早于 → 积压；同一天 → 不确定，不产生事件、不上报（呈现本身是支持的）。
   - 无法解析的文案（如『周三』『刚刚』、当天时间落在未来）→ 不确定：不产生事件，按"形态"（数字换成 9）上报一次 `unsupported_presentation`（scene=conversation_list）。
   - 支持的文案：`HH:MM`、`昨天/前天[ HH:MM]`、`M月D日[ HH:MM]`、`MM-DD[ HH:MM]`、`YYYY/MM/DD`、`YYYY-MM-DD`、`YYYY年M月D日`（均可带时刻）。B 的夹具里实际只见过 `HH:MM` 与『昨天』（列表）、『昨天 16:25』『09-14 10:55』（聊天区）；其余是按常见写法支持，**未在真机上见过**。`M月D日` 落在未来时取去年（列表只展示近 30 天，只在跨年时出现）。
4. **只读**：唯一的写操作是 `click(『新招呼』页签)`。点击前用 `is_new_greeting_tab` 再核一次：必须是页签栏区域（窗口相对 y 40–110、x 115–510）内 label 为 `新招呼(N)` 的唯一 AXGroup，且与『全部』页签同一行；否则不点（协调者要求的显式约束）。不点任何会话行；识别到附件预览（AXWebArea『PDF预览』）立即返回，不看其他元素；行解析只读姓名、岗位、时间、未读数和前缀，不读消息预览。
5. **同岗位同名** → `conversation_ambiguous`（match_count、candidates[position, hints=[时间文案]]），这些行不产生 `application_observed`。同名不同岗位不算歧义。只有积压行之间同名时不产生事件。
6. **event_id** 用 `compute_event_id`；bucket = 列表消息时间：分钟精度 `2026-10-04T11:03Z`（UTC 分钟），日精度 `2026-10-03/day`（本地日期）。同一文案在不同时刻、不同观察器实例中得到同一 id（有测试）。已产生过事件的会话（指纹）记入 `baseline.data.emitted`，候选人再发消息、时间变化后不重复产生；记录 35 天后清理。
7. **页面分类**：conversation_list / conversation_detail / search / resume_overlay / attachment_preview / unknown。B 夹具 42 步全部与标注一致（标注里的 `other` 对应 attachment_preview）。unknown → 返回空、上报一次 `unsupported_presentation`（scene=unknown）。登录页、验证码没有夹具，现在落在 unknown。
8. 不产生 `attachment_available`、`contact_exchange_updated`。

其他行为：

- 有确认气泡（按钮『确认/确定』）时不点击，返回空并上报一次。
- 点击后页面不是会话列表/详情、或『更多』菜单仍展开、或页签消失 → 返回空并上报一次。
- 简历弹层、附件预览、搜索页：不导航、不读。基线已建立时静默返回空；未建立时上报一次 `observe_baseline_pending`（scene=页面类别），因为 core 在 needs_baseline 期间不领取指令，需要让人看到原因。
- 我方已回复（行内有『[已读]』『[送达]』前缀）的行不算新招呼。
- Driver 的其他错误（窗口丢失、快照过期等）原样抛给 core，由 core 记 last_error，本次基线不落库。

## 五、接口请求

1. **观察时的守卫模式（已与协调者确认，由协调者在合并时改 core）**：`core/runtime.py::_observe` 目前用 `GuardedDriver(mode="read_only")`，点击页签会抛 `ReadOnlyViolation`。E 在这种情况下返回空并上报一次 `observe_navigation_blocked`（有测试）；改为 `mode="verify"`（允许 click/scroll，禁止 type_text/key/outbound）后可正常工作（`test_verify_guard_allows_tab_navigation_only`）。注意：在 core 修改之前，接入 E 的 Monitor 会一直停在"未建立基线"，不会领取指令。
2. **device_id 与上报回调的注入**：`Observer.observe(driver, baseline)` 拿不到 device_id（事件必填），也没有写 `heartbeat.last_error` 的通道；`__main__` 又按 `create_observer()` 无参装配。E 提供 `observer.attach(device_id=..., report=...)`，`report` 与 `MonitorRuntime.record_error(code, message, scene)` 同签名。请 core 在构造 runtime 后调用：

   ```python
   if hasattr(observer, "attach"):
       observer.attach(device_id=config.device_id, report=self.record_error)
   ```

   未注入时：基线照常建立；有事件要产生时不产生，记 `observe_not_ready`（在 `observer.issues` 里），注入后下一次观察补上（不丢事件，有测试）。
3. **首次基线的 account_id**：`MonitorState` 默认的 `Baseline()` 的 `account_id` 为 None，`_observe` 只在"needs_baseline 且基线已建立"时才换成带账户的新基线，所以首次启动建出的基线可能没有 account_id。E 在 account_id 为 None 时不产生事件（上报 `observe_not_ready`）。建议 core 在交给观察器前把 `baseline.account_id` 设成当前绑定账户（或在 bind_account 后重建基线，现在已经这样做）。
4. **上报码**：除 `unsupported_presentation` 外，E 还用了 `observe_navigation_blocked`、`observe_baseline_pending`、`observe_not_ready` 三个 snake_case 码，都在 `LastError.code` 的格式内，不需要改契约；如果控制台要按码展示文案，请 I1 知悉。

## 六、未覆盖项与已知限制

- **夹具通过不等于真机通过**。CliDriver + 真实 BOSS 没有跑过；点击『新招呼』页签后列表是否立即刷新、是否需要等待，没有观察到（B 的点击记录显示点击后再读即为新列表）。E 不做等待：点完立即重读，若读到的还是旧列表，无法从 AX 区分（页签选中态不可见）。→ N 阶段验证。
- **页签状态只能信任"刚点过"**：如果点击被客户端吞掉而没报错，E 会把当前页签的行当成新招呼。『全部』页签前几行通常也是新招呼，但『沟通中』里未回复的行可能被误判。缓解：带『[已读]/[送达]』前缀的行一律排除。
- **只看最上面约 10 行**：积压超过 10 条时，后面的新投递要等前面的移出『新招呼』才会露出；露出时若消息时间早于基线则按积压处理（这是规则 3 的本意）。处理过的会话是否会移出『新招呼』页签，待 N 实测。
- **基线时可见的会话永不产生事件**，即使之后候选人又发消息、时间晚于基线。基线后才露出的积压会话，若候选人在基线后又发了消息（列表时间晚于基线），会被当作新投递——规则按"列表上的最近消息时间"判断，无法区分。
- **同名同岗位**：若旧会话已移出可见范围、只剩新会话，E 看不出两者不同（会当作同一会话：已产生过事件则不再产生；在基线中则不产生）。只有同时可见时才能产生歧义事件。
- **日精度且与基线同一天**的会话不产生事件（不确定）。通常只在 Monitor 离线错过了分钟精度显示时出现。
- **跨午夜**：客户端若在午夜后仍显示前一天的 `HH:MM`，换算到今天会落在未来，按不确定处理，不上报；客户端刷新为『昨天』后按日精度判断。
- **时区**默认 `Asia/Shanghai`（`create_observer(timezone=...)` 可改），未从系统读取。
- 『新招呼』页签内的子筛选（『全部/未读』）E 不切换。如果用户把子筛选留在『未读』，已读的新招呼会看不到。
- 登录页、验证码没有夹具，现在一律是 unknown（上报一次 unsupported_presentation），不产生 `login_required` / `blocked_by_dialog`。K 补夹具后再加分类。
- "只上报一次"的去重键存放在 `baseline.data.reported`，基线重建（generation+1）后会重新上报一次。

## 七、对后续任务的接入说明

- **D2 / core**：按第五节 1–3 改 `_observe`（verify 守卫、attach、带账户的基线）。`baseline.data` 结构由 E 自定（`version`、`baseline_at`、`initial`、`emitted`、`ambiguous`、`reported`），必须原样持久化；版本不认识的数据 E 会清空并重建基线（不产生事件）。观察返回的事件只有 `application_observed` 与 `conversation_ambiguous` 两种。
- **H1（动作）**：`application_observed.conversation.hints` 为空列表（时间文案会随日期变化，不适合作为定位提示），服务端下发指令时请按"姓名 + 岗位"定位。打开会话会产生已读回执，E 从不打开。
- **F2（服务端）**：`conversation_ambiguous` 的 `candidates[].position` 是本次可见行的序号（0 起），`hints` 是该行的时间文案；`summary` 为空（不回传消息预览）。
- **K（登录接力）**：登录页目前分类为 unknown；补夹具后可以在 `page.py` 增加分类，并决定是否由 E 产生 `login_required`。
- **M（集成）**：用 `FakeDriver` + `Advance(method="click", target=Locator(text_contains="新招呼"), goto=...)` 模拟切页签，见 `test_observe_observer.py` 的 `compose` / `step_of` 派生方式。
- **N（真机）**：请核对：点『新招呼』后列表刷新是否即时；处理过的新招呼是否移出该页签；列表时间文案在 1 天前、7 天内、更早时的真实形态（目前只见过 `HH:MM` 与『昨天』）。
