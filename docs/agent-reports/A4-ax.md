# A4 显式辅助功能按压（岗位筛选箭头）报告

## 范围

分支 `szrunworld/ss-a4-live`：先合入集成分支 `szrunworld/ss-runtime-integration`（`6c318b5`，合并提交 `c83257d`），保留此前的表头身份提交。没有读取 `/tmp` 下的 P0 原始数据，没有操作桌面，没有推送或合并用户分支，没有启动子代理。真实 GUI 验收由主线在评审后进行。

依据（协调者转述的 P0）：BOSS 1.7.4、1440×875 窗口中，职位筛选右侧箭头是 AXGroup（窗口相对 416,31，12×12），声明 AXPress；直接 AXPress 打开职位菜单 3/3（其中一次在重新绑定窗口之后），前台 PID 与真实指针不变。对标签、父容器、箭头的事件点击都无效；父容器 AXPress 无效；AXShowMenu 打开的是浏览器上下文菜单。菜单打开后，对新出现的唯一选项做普通事件点击可以选中；背景行文字仍留在 AX 树中。追加证据：Escape 不关闭菜单，再按一次箭头也不会收起；菜单打开时标签被搜索框（AXTextField，相对 140,20，303×34）替换，栏里剩下的第一个文字是箭头字形（``）；选项在相对 x 155、搜索框下方；选中后菜单异步关闭。

## 设计

默认点击行为完全不变；只有逐个动作显式选择时才走新路由，且失败即失败，不回退。

| 层 | 改动 |
|---|---|
| 契约 `contracts.ts` | click 新增可选 `method?: 'accessibility'`（`ClickMethod`）。`validateAction`：其他取值拒绝；带 method 时目标必须是 element（index 或 role/label），拒绝 right、count 2、modifiers、relative/template/ocr。`InputRoute` 新增 `'accessibility'`，只用于显式按压。 |
| Session | 无改动：先校验，语义 element 定位器解析为唯一 index 时用 `...action` 保留 method。 |
| 适配器 `second-screen.ts` | method 为 accessibility 时发送独立动词 `ax-press --screen … --pid … --window-id … --index N`；只接受 element index，其余在发命令前拒绝（invalid_input）。CLI 回报路由必须是 `ax.press.explicit`，结果路由为 `accessibility`；回报别的路由时为 `unknown` + `capability_missing`。`unknown command`（旧 CLI）、`bad request:`（旧 side instance 解码失败）、`does not advertise AXPress` 归为 `capability_missing`（`classifyPressError`）。默认 click 的命令词与路由不变。 |
| 线上协议 `ControlProtocol.swift` | `InputAction.Kind.accessibilityPress`：独立枚举值而非 click 上的可选标志，旧 app 解码 `ControlRequest` 即失败（`bad request`），在任何输入之前拒绝。 |
| CLI `DriverCommands.swift` | 新动词 `ax-press`（加入 `DriverCommands.verbs`，main.swift 不需改代码）。只接受 `--index`；`--text`、`--x/--y`、`--right`、`--double`、`--modifiers` 一律拒绝。旧 CLI 不认识这个动词，按 unknown command 退出，不会点击（协调者要求的改正：最初设计的 `click --ax-press` 会被旧 CLI 当未知标志忽略而发出事件点击）。 |
| 原生 `InputEngine.swift` | `accessibilityPress` 在解析元素、检查坐标之前单独处理：`checkAccessibilityPress` 只允许 index；只取上一次 `window.state` 缓存的快照（不重新读取、不按文字解析，没有缓存即拒绝）；`pressExplicitly` 要求元素声明 AXPress 且 `AXActions.press` 成功，否则抛错。没有 cursor 叠加、指针、焦点、按键或事件，路由 `ax.press.explicit`（与默认 click 的 `ax.press` 区分）。 |
| 机械改动（已提前告知） | `TarsAgent/AndroidPlan.swift`（抛出“无 Android 形式”）、`Bridge.swift`（effect 与契约形状均为 nil，即拒绝）、`Learning.swift`（不可学习）。 |
| BOSS `select_source` | 见下节。 |

## BOSS select_source

1. 关闭简历/弹层后，若职位菜单已经打开（存在搜索框）：不再按箭头（不会收起），不按 Escape，直接在当前菜单列中按位置取选项并选择。
2. 否则读筛选标签；已恰好是目标职位则成功。菜单打开时 `jobFilter` 返回空，并且永远不接受单字符或私用区字形，所以字形不会被当成已选职位，`listCandidates` 也不会因此滤掉所有行。
3. `jobFilterCaret`：在包含标签的最小 AXGroup（筛选栏）内，找标签右侧、6–24 pt 见方、无文字（或只有字形）的 AXGroup/AXButton，必须恰好一个。没有筛选组、没有箭头、多个箭头分别失败为 `job_filter_no_filter_group` / `job_filter_caret_missing` / `job_filter_caret_ambiguous`，不尝试任何别的路由。
4. 用 `pressElement`（method accessibility）按箭头。`capability_missing` → `job_filter_ax_press_unsupported: <原因>`；其他状态 → `job_filter_press_<status>`。
5. 选项 = 菜单列（相对 x 145–175、宽 ≥16、搜索框下方、非字形）中、打开前不在同一位置出现过的文字（文字@位置来源比对）。背景行的徽标（166）、姓名（192）、职位（240）在列外；列内原有文字靠来源比对排除。
6. 唯一匹配后对选项做普通点击；成功的条件是菜单已关闭且筛选标签与所选选项完整文字精确一致（有界等待，`openTimeoutMs`）。菜单一直不关 → `job_menu_still_open`；关了但标签不符 → `job_not_applied`。歧义或找不到时菜单保持打开并如实报告（Escape 无效，不再按）。
7. `verifyUnit('select_source')`：菜单打开时直接判失败（`the job menu is still open`），其余规则不变。

标签点击路线已删除（P0 证实无效）。

## 测试

全部为合成数据。

- `contracts.test.ts`：accessibility 方法的合法形式（index、显式 left/1、语义 element）；拒绝未知/空 method、right、double、modifiers、relative、ocr、template；不带 method 的右键双击坐标点击照旧合法。
- `second-screen.test.ts`：显式按压发 `ax-press … --index 5`，路由 `accessibility`；默认 click 词与 `element` 路由不变（即使 CLI 回报 `ax.press`）；坐标/右键/双击/未知 method 不发命令；unknown command、bad request、无 AXPress → `capability_missing`；陈旧 index → `stale_snapshot`；ok 但路由不对 → `unknown`。Session + 适配器：role 定位解析为 index 2 并以 `ax-press` 发出；坐标形式的按压在 Session 校验处被拒，不到达适配器。
- `AccessibilityPressTests.swift`（新）：编码为 `accessibilityPress`，不带点击选项；按旧枚举定义的解码器解析单个动作或整个请求都失败，普通 click 两边都能解码。`checkAccessibilityPress` 只接受非负 index，拒绝 text、坐标、right、count（含 1）、modifiers（含空数组）、key、value、foreground，也拒绝普通 click。`pressExplicitly`：不声明 AXPress（只有 AXShowMenu 或无动作）时按压闭包一次都不调用；按压失败只调用一次即报错；成功返回 `ax.press.explicit`。`InputEngine.perform` 在没有缓存状态或带坐标时直接抛错，不碰窗口。
- `boss-resumes.test.ts`：合成 BOSS 改为 P0 形状（筛选组、箭头 AXGroup、字形、打开后的搜索框、x 155 的选项列；事件点击标签/箭头/组无效；只有箭头和组声明 AXPress，按组无效，按箭头打开且不收起；Escape 不关闭；选项点击后可配置延迟关闭）。新测试：只按一次箭头、选项走普通点击、没有对标签/箭头/组的事件点击、等菜单关闭且标签精确后才成功；菜单列里原有的“高级前端工程师”不会让“前端”变成歧义（去掉来源比对的变异会使该测试失败）；菜单打开时 `jobFilter` 为空、校验失败、字形不滤行，已打开时不再按箭头直接选择（放开字形过滤的变异会使该测试失败）；没有箭头、两个箭头、没有筛选组、旧宿主、菜单不关闭，各自如实失败，没有事件点击、按键或坐标替代，校验也失败。原“歧义”测试改为断言菜单保持打开。

运行结果：
- `swift build` 通过；`swift test` 118 个全部通过（含新增 4 个）。
- `packages/task-runtime`：`npm run typecheck` 通过；全部测试 300 个，293 通过、7 跳过（原有，在其他文件）、0 失败；`boss-resumes.test.ts` 52 个、`second-screen.test.ts` 21 个、`contracts.test.ts` 32 个全部通过。
- `agents/boss`：`npm run typecheck` 通过；`npm test` 15 个全部通过。
- CLI 冒烟（不连接 socket）：`ax-press` 带坐标、带 `--right`、缺 `--index` 都在发送前报错退出 1。

## 交接与未完成

- A7：已发消息（`msg_1d0c31e57d40`）请其在 `Sources/ScreenCLI/main.swift` 帮助文字中加入 `ax-press` 一行与说明；main.swift 无需代码改动。MCP 不暴露该选项。
- `UIElement` 契约没有 `actions` 字段，workflow 无法在 TS 侧确认箭头声明了 AXPress，靠几何定位，由原生侧检查后拒绝（`capability_missing`）。
- 真实 GUI 验收（经 Session 与 workflow 实际打开菜单、选择、关闭）由主线完成；需要核对筛选组确实以带 index 的 AXGroup 出现在 `state` 元素中（P0 曾按过父容器，说明它有 index），以及选项列的 x 范围 145–175。
- 菜单打开时的 `listRows`/`classifyPage` 未改动；`select_source` 失败时菜单可能保持打开，后续单元依赖下一次 `select_source` 从已打开状态恢复。
