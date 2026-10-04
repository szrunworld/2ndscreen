# 2ndscreen CLI 输出样例

任务 C 在 2026-10-04 用 2ndscreen-main（67b34c5，release 构建）实测采集。应用只用了
TextEdit 与 Calculator（`--new-instance` 启动在专用屏幕 `monitor-c` 上），没有碰 BOSS直聘。

每个文件是一次调用：

```json
{"note": "说明", "argv": ["state", "--screen", "..."], "exit_code": 0, "stdout": {...} | null, "stderr": ""}
```

`stdout` 是 CLI 打印的 JSON（参数解析失败时为 null，原因在 stderr）。本机路径已替换为
`<SCRATCH>`、`/Users/<USER>`。`monitor/client/tests/test_driver_cli.py` 对每个样例断言解析结果或错误分类。

`window_release_gone.json` 不是实测：采集它要新建一块 agent 屏幕（会改动用户的显示器布局），
所以按 2ndscreen 源码 `AgentScreens.swift` 的 `releaseWindows` 文案构造，`note` 里有说明。

`recorded/textedit_fixture.json` 是用录制模式（`monitor.driver.record`）从 TextEdit 真机录的
两步 ax 夹具，FakeDriver 的回放测试用它。

## 观察到的 CLI 行为

- 成功：`ok: true`，退出码 0。失败：`ok: false` + `error`，退出码 1。参数解析失败：只有 stderr，退出码 2。
- `state` 的元素字段只有 `index`、`role`（含子角色，如 `AXCheckBox/AXSegment`）、`label`、`value`、
  `frame`、`actions`。**没有 enabled / focused / selected。**
- 不带 `--query` 时元素 index 从 0 连续；带 `--query` 只过滤输出，index 仍是整棵树的编号。
- `click`/`type`/`scroll` 的回执带 `route`（`ax.press`、`ax.insert`、`ax.value`、`event.click`、
  `event.wheel`、`event.key`、`event.key.menu`），按 index/text 作用时还带 `element`（来自菜单栏应用缓存的快照，值可能已旧）。
- `--index` 指向菜单栏应用为该窗口缓存的最近一次 state；任何进程对同一窗口调 state 都会替换缓存，CLI 不报错。
- `--text` 先取第一个精确匹配，再取第一个包含匹配，**不报歧义**。
- 错误 pid 与"应用已退出"是同一文案（`pid N has no window on screen ...`）。
- `app launch --fill` 对 TextEdit 返回 `ok: false`（"the app refused to move its window"），但窗口已在屏上。
- Calculator 显示区的值带 U+200E（从左到右标记）。
- 整屏截图按 HiDPI 输出 2 倍像素（1280x800 点 → 2560x1600 像素）。
- 动作 `ok` 只表示送达：TextEdit 上点了 bold/italic 后再读 state，复选框的 value 仍是 `0`。
