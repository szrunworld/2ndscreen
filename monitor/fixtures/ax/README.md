# BOSS直聘 macOS 元素树夹具（任务 B）

录制对象：BOSS直聘 macOS 客户端 1.7.4，已登录招聘账户，窗口 1440×875 位于 2ndscreen 测试屏幕 `monitor-b`。录制时间 2026-10-04 19:10–19:20（+08:00）。读取命令为 `2ndscreen state --screen monitor-b --pid <pid> --window-id <id>`；只做了导航类点击，完整点击记录见 `docs/monitor/agent-reports/B.md`。

| 目录 | 内容 |
| --- | --- |
| `conversation_list/` | 消息页页签、子筛选、『更多』筛选菜单、行结构、未读角标、后台滚动无效 |
| `new_application_marker/` | 新招呼页签与计数、实时到达、牛人发起、『向您发起沟通』文案 |
| `conversation_detail/` | 会话详情表头、按钮条、系统提示 |
| `attachment_entry/` | 附件简历入口两种形态、索取简历确认气泡、PDF 预览 |
| `resume_overlay/` | 在线简历弹层、转发对话框三种方式 |
| `search_page/` | 搜索页结构、结果卡、结果区滚动 |
| `contact_exchange_state/` | 未请求 / 微信待同意 / 不可用 / 已交换（筛选为空） |

登录页与二维码：没有录制。录制时账户已登录，按约束不登出。

## 格式约定

格式按任务 A 的 `monitor/fixtures/schema/ax-fixture.schema.json` 草稿（fixture_version 1）编写，已用 jsonschema 校验通过。

- `elements[i].index == i`。`attachment_entry` 第 5 步删掉了 PDF 文字层，那一步的 index 与录制时的 CLI index 不同；其余步骤与录制时的 CLI index 相同。
- `frame` 是全局点坐标（左上原点），与 CLI 输出一致。窗口位于 x=3360、y=25，减去 `window.frame` 就是窗口内的相对坐标。显示器重排后全局坐标会变，用窗口相对坐标做规则。
- `text` 的取法：有 label 就用 label；label 和 value 都有而且不同时，写成 `label | value`（例如 `过滤近14天查看 | 0`、`… | 3`）；只有 value 时用 value。
- `enabled` 一律是 `true`。CLI 不输出可用状态。在截图上核对过的置灰状态记在 `annotations.x_visual_state` 里。
- `annotations` 的扩展键都以 `x_` 开头。`x_refs` 是按文本查到的元素 index；`x_conversations_unclassified` 用于单看本步无法判断是不是新投递的列表行。

## 脱敏

- 真实候选人按出现顺序换成固定代号：候选人A…P，同一个人在所有夹具里用同一个代号。搜索页上平台已经打码的姓名（形如『X**』）换成『候选人S1**』…。
- 手机号、邮箱、链接删除；没有观察到微信号。
- 候选人经历里的公司、院校换成 `<公司已脱敏>` / `<院校已脱敏>`；含个人经历细节的消息和搜索简介换成占位文本；头像 URL 换成 `<图片URL已脱敏>`。
- 附件 PDF 预览的文字层整步删除（`x_dropped_elements`）。
- 岗位名、年龄、年限、学历、薪资、普通寒暄消息原样保留。
- 截图只留在本机临时目录，没有进入仓库。

## 迁移记录（任务 C，2026-10-04）

契约 0.1.1 的夹具元素是 `{index, role, label, value, frame, enabled}`，本目录原来的 `text` 形状不再通过
`validate_ax_fixture`。经协调者授权，任务 C 用 `monitor/client/monitor/driver/tools/migrate_legacy_fixture.py`
一次性迁移了 7 个 `fixture.json`（commit `0604a29`）。只改元素形状，观察结论、标注、窗口与步骤都没有改动。

- `text` 含 ` | ` 的，按上面"`text` 的取法"拆成 `label` 与 `value`（共 42 个元素）。
- 不含的按角色放：`AXTextField`、`AXTextArea`、`AXComboBox`、`AXSearchField`、`AXStaticText` 放 `value`，
  其余放 `label`，另一边为空串。`AXStaticText` 归 `value` 的依据：2ndscreen 的
  `Sources/SecondScreenCore/Accessibility.swift` 只在静态文本有 value 时才列出它
  （`interesting = actionable || (role == "AXStaticText" && value != nil)`），真机输出的文字在 `value` 上。
- `enabled` 一律改为 `null`：CLI 不输出可用状态，原来的 `true` 不是观察结果。置灰信息仍在 `annotations.x_visual_state`。
- 上面"格式约定"里关于 `text` 与 `enabled` 的两条描述的是迁移前的形状。
