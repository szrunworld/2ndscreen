# 任务 C 交付报告：Driver 适配器（CliDriver 与 FakeDriver）

分支：`szrunworld/monitor-C`。CLI：`/Users/kevinshi/orca/2ndscreen-main/.build/release/2ndscreen`（2ndscreen-main 67b34c5）。
采集与真机冒烟只用了本任务在专用屏幕 `monitor-c`（1280x800，`--ttl 2h`）上用 `--new-instance` 启动的 TextEdit 与 Calculator；
没有对 BOSS直聘 调用过 state、click 或 window move。

## Commit

| commit | 内容 |
| --- | --- |
| `213ba02` | 第 1 阶段：CLI 调用底层、37 个样例、定位器、脱敏 |
| `c4beaf0` | 第 2 阶段：CliDriver、FakeDriver、录制模式，接入契约 |
| `f49fd7c` | FakeDriver 适配契约 `FixtureElement` |
| `0604a29` | B 夹具一次性迁移（只改形状，不改语义）+ 迁移脚本与测试 |
| `e77bb5f` | 契约 0.1.1 收尾：enabled 记为 null；ax README 追加迁移记录；cli-samples README |
| `d13246d` | screen destroy 样例与 `no agent screen named` 错误分类 |
| （本报告） | `docs/monitor/agent-reports/C.md` |

为编译合入（最终以协调者合并版本为准）：A 的 `4f033c7`、`a76c0a1`、`ffd598b`，B 的 `201001d`（迁移的基础）。

## 产物

| 路径 | 内容 |
| --- | --- |
| `monitor/client/monitor/driver/_cli.py` | 子进程调用（参数列表、`shell=False`、每次调用有超时、不重试）、JSON 解析、错误文案分类 |
| `monitor/client/monitor/driver/cli_driver.py` | `CliDriver`：契约 `Driver` 的 CLI 实现；快照过期检测；错误映射；`screenshot_region`（仅登录二维码） |
| `monitor/client/monitor/driver/locator.py` | `find_one` / `find_all`：按契约 `Locator`（text、text_contains、role、region、index、right_of）唯一定位 |
| `monitor/client/monitor/driver/fake.py` | `FakeDriver`：按 ax 夹具回放，`Advance` 规则脚本化步骤切换，记录写调用，`fail_next` 注入失败 |
| `monitor/client/monitor/driver/record.py` | `FixtureRecorder`：录制模式，state 快照脱敏后写成 ax 夹具并用 `validate_ax_fixture` 校验 |
| `monitor/client/monitor/driver/redact.py` | 替换表 + 手机号 / 微信号 / 邮箱正则删除 |
| `monitor/client/monitor/driver/tools/migrate_legacy_fixture.py` | B 夹具一次性迁移（text → label/value，enabled → null） |
| `monitor/fixtures/cli-samples/*.json` | 39 个 CLI 实测样例（20 个成功、19 个失败），附 README |
| `monitor/fixtures/cli-samples/recorded/textedit_fixture.json` | 用录制模式从真机 TextEdit 录的两步示例夹具 |
| `monitor/fixtures/ax/**/fixture.json` | B 的 7 个夹具迁移到契约形状（协调者临时授权，只改形状） |
| `monitor/client/pyproject.toml` | 新建，`monitor-client`，依赖 `monitor-contracts`（路径依赖） |
| `monitor/client/tests/test_driver_*.py` | 测试 |

## 测试

```sh
cd monitor/client && uv run pytest
# 181 passed in 2.90s

cd monitor/client && uvx ruff check --select F,E9,B,UP --target-version py312 --line-length 130 monitor tests
# All checks passed!
```

| 文件 | 覆盖 |
| --- | --- |
| `test_driver_cli.py` | 每个 cli-samples 样例的解析或错误分类（有断言"每个样例都有期望"的测试）；子进程不经 shell、超时、真实慢脚本超时、可执行文件不存在 |
| `test_driver_cli_driver.py` | 用样例当子进程替身：绑定、state、include_tree、写前核对、过期、送达到别的元素、Locator 歧义/未找到不执行、四个写方法参数、每类错误映射且不重试、screen_ok、screenshot_region 换算与真实 `sips` 裁剪 |
| `test_driver_locator.py` | 精确/包含/角色/区域/index/同一行右侧/nearest/锚点错误传递/规范化 |
| `test_driver_fake.py` | 回放示例夹具并断言写方法计数；Advance 规则；auto_advance；过期；失败注入；**回放 B 的全部 7 个夹具** |
| `test_driver_record.py` | 脱敏（元素与窗口标题）、校验、写文件后可被 FakeDriver 回放、非法夹具不写 |
| `test_driver_migrate.py` | 迁移规则、只改元素行、幂等、跨行元素拒绝、校验失败不写、仓库夹具已迁移 |

真机冒烟（不在 pytest 里，脚本在本 worker 的 scratchpad）：对 `monitor-c` 上的 TextEdit 依次
`bind_window(pid)` → `state(include_tree=True)` → `click(Locator(text="bold"))`（route ax.press）→
`click(Element)`（event.click）→ `type_text`（ax.insert）→ `key("cmd+a")`（event.key.menu）→
`scroll(None, "down", 2)`（event.wheel）→ 旧元素点击得到 StaleSnapshotError → `screen_ok()` 为 True →
`screenshot_region` 裁出 200x100 点（400x200 像素）且画面正确 → 录制两步夹具；绑定到不存在的
window id 时 `screen_ok()` 为 False、`last_problem` 为 `window_lost`。**夹具通过不等于真机通过**：BOSS 上没有跑过 CliDriver。

## CLI 行为发现（尤其是限制）

1. **index 缓存会被别人覆盖。** `--index` 指向菜单栏应用为该窗口缓存的"最近一次 state"，任何进程对同一窗口调 state
   都会替换它，CLI 不报错。CliDriver 因此在每次按 Element 写之前再读一次 state，核对同一 index 上的角色、label、位置，
   不一致就抛 StaleSnapshotError 不点击（`verify_before_write=True`，默认开）；写完再核对 CLI 回执里的元素，
   不一致抛 StaleSnapshotError 且 `delivered=True`。代价是每次写多一次 state。
2. **`--text` 不报歧义**（先取第一个精确匹配，再取第一个包含匹配）。CliDriver 从不使用 `--text`，一律自己定位后按 index 执行。
3. **没有 enabled / focused / selected。** 元素只有 index、role、label、value、frame、actions。CliDriver 的 `enabled` 填"未知"。
   置灰按钮只能靠截图或文案判断（B 把截图核对结果记在 `x_visual_state`）。
4. **AXStaticText 只在有 value 时才列出**，文字在 value 上（Accessibility.swift 的 `interesting` 条件）。
5. **错误 pid 与"应用已退出"文案相同**，都归为 window_lost。参数解析失败只有 stderr、退出码 2，归为 cli_failed。
6. **`app launch --fill` 可能 `ok: false` 但窗口已到屏上**（TextEdit 拒绝改尺寸）。
7. **动作 ok 只表示送达。** TextEdit 上点了 bold / italic，复选框 value 仍是 `0`。B 也记录了 BOSS 会话列表上后台滚轮
   返回 ok 但列表不动。动作结果必须重新 state 验证。
8. **state 树有上限**（maxDepth 40、maxNodes 4000，见 Accessibility.swift），超大页面会被截断且没有标记。
9. **整屏截图是 HiDPI 像素**；`screenshot_region` 按屏幕框与像素比例换算后用 `sips` 裁剪。
10. CLI 对菜单栏应用的请求有 60 秒套接字超时；CliDriver 默认 state/screenshot 30 秒、动作 20 秒，构造时可改。
11. **屏幕不存在的文案不统一**：state/screenshot 是 `no screen named "X"`，screen destroy 是 `no agent screen named "X"`，两者都归 screen_lost。
12. **全局坐标会随显示器增删整体平移。** 同一个 TextEdit 窗口在测试期间从 x=4800 变成 x=3360（别的 agent 屏被销毁）。
    CliDriver 每次 state 都重读窗口框；夹具与规则应使用窗口相对坐标（B 的 README 也这样建议）。

## 对后续任务的接入说明

- **通用**：公共类型一律从 `monitor_contracts` 导入；本包导出 `CliDriver`、`FakeDriver`、`Advance`、`find_one`/`find_all`、
  `FixtureRecorder`、`redact_text`。CliDriver 构造：`CliDriver(screen, binary=..., default_selector=WindowSelector(...))`，
  CLI 路径也可用环境变量 `MONITOR_2NDSCREEN_CLI`。
- **D2（管线 / 重试）**：CliDriver 不重试。可重试的通常是 `DriverTimeoutError`、`StaleSnapshotError`（重新 state 后）；
  `WindowLostError` / `ScreenLostError` 要先恢复绑定或屏幕（`bind_window` / J 的 bootstrap）；`CliFailedError` 一般不重试
  （`returncode`、`stderr` 有原文）。`TargetAmbiguousError` / `TargetNotFoundError` 是业务层判断，不要重试。
  StaleSnapshotError 带 `delivered=True` 时动作已经送达，**不能重做**，按 unknown 处理。健康检查用 `screen_ok()` + `last_problem`。
  测试里用 `FakeDriver.fail_next(method, error)` 注入失败，用 `count()` 断言"同一 command 的写操作只发生一次"。
- **E（观察）**：`state()` 后用 `find_all` / `find_one` 读元素；需要层级时 `state(include_tree=True)` 取 `parent_index` / `depth`。
  文本匹配同时比较 label 与 value，静态文本在 value 上。测试用 `FakeDriver(path)` 回放 `monitor/fixtures/ax/**`，
  `goto(step)` 模拟界面变化。
- **H1/H2/H3（动作）**：写方法可直接传 `Locator`（Driver 在新快照里唯一定位，歧义/未找到抛错、不执行），或传刚 state 出来的
  `Element`。同一行操作用 `Locator(text=..., right_of=Locator(text=候选人名))`；`find_one(..., nearest=True)` 取最近的一个。
  点击后必须重新 state 验证结果。FakeDriver 的 `Advance(method="click", on_step=..., target=Locator(...), goto=...)` 能脚本化
  "点了某按钮进入确认弹窗"；白名单关闭时断言 `fake.count() == 0`。
- **K（登录接力）**：`screenshot_region(rect, out_path) -> Path` 只用于登录二维码；`rect` 是全局点坐标，必须在专用屏幕内。
  FakeDriver 的 `screenshot_region` 写入构造时给的 PNG（`screenshot_png=`，`fake.solid_png()` 可造纯色图），并计入 `count("screenshot_region")`。
- **定位语义（与契约文字的差别，请协调者确认）**：契约写 Locator 的 text 匹配 `Element.text`；本实现对 `text`/`text_contains`
  同时比较 `text`、`label`、`value`，`role` 不含 "/" 时也命中带子角色的元素。比契约宽，命中更多时按歧义处理，不会替调用方挑选。
- **录制新夹具**：`FixtureRecorder(scene, description, app=..., replacements={真实姓名: "候选人A"})`，
  `driver.record_step(recorder, label, {"page": ...})`，`recorder.write(path)`。正则只覆盖常见写法，提交前人工抽查。

## 接口请求

1. 把 `client` 加入 `monitor/pyproject.toml` 的工作区成员；之后 `monitor/client/pyproject.toml` 的
   `monitor-contracts` 来源可改为 `{ workspace = true }`（现在是 `{ path = "../contracts", editable = true }`）。
2. 仓库没有忽略 Python 产物：`monitor/client/` 下会生成 `.venv/`、`uv.lock`、`__pycache__/`。建议由工作区根所有者加
   `monitor/.gitignore`（或 `monitor/client/.gitignore`）；本任务没有提交这些文件。

## 已知限制

- CliDriver 只在 TextEdit / Calculator 上真机跑过；BOSS（Electron）上的 type、scroll、Stale 检测都没有用 CliDriver 验证过。
- `bind_window` 只看每个进程在本屏的最前窗口（CLI 没有列窗口的命令）；同一应用在本屏开多个窗口时，按标题筛选只能看到最前那个。
  绑定后固定 window id，应用新开的窗口（如弹出的独立窗口）不会被 state 看到，需要重新绑定。
- `ClickMode="ax_press"` 只预先检查元素有 AXPress 动作，实际路由由 2ndscreen 决定（回执 `detail` 有原始 route）。
- `verify_before_write` 只比较角色、label、位置，不比较 value（文本框输入后 value 会变）；同位置同 label 的不同元素无法区分。
- 脱敏正则不保证删净；B 夹具迁移时 enabled 改为 null，原来的 true 不是观察结果。
- 没有实现重试、等待、业务语义（按任务划分属于 D2 / H）。

## 清理

专用屏幕 `monitor-c` 已 `screen destroy`；本任务启动的 TextEdit（pid 52468）与 Calculator（pid 59225）实例都已退出。
用户自己的 TextEdit（另一个 pid）没有动过。
