# BOSS macOS P0 基线

检查日期为 2026 年 10 月 4 日。P0 由主协调者执行，开发 agent 不占用真实 BOSS 窗口。

## 环境与代码

| 项目 | 实测值 |
| --- | --- |
| 系统 | macOS 15.1，24B2083，arm64 |
| Swift | 6.0.3，Swift Package 最低 macOS 14 |
| Node | 22.23.2 |
| BOSS | 1.7.4，com.zhipin.www；已有登录状态 |
| 开始时 HEAD | 329e052，六个 Swift 文件已有修改 |
| 开发期间外部变更 | 主工作区切到 iphone-commands，HEAD 4108e74；原修改已提交 |
| 集成基线 | 4108e74，专用分支 szrunworld/ss-runtime-integration |
| 开发模型 | Claude Code 2.1.283，claude-opus-5-5；实际调用返回 modelUsage 同名，启动回执 requested/effective 一致 |

原有修改保留于原工作区历史；开始时的 binary diff 在本地证据目录备份。新模块合并到专用集成分支，避免覆盖用户切换分支后的工作。

## 已执行检查

| 命令 | 结果 | 边界 |
| --- | --- | --- |
| swift test | 66 项通过 | 开始时工作区源码，不代表真实 BOSS 界面验收 |
| agents/boss 下 npm test | 15 项通过 | 开始时 BOSS 源码，合成/脱敏夹具 |
| agents/boss 下 npm run typecheck | 通过 | TypeScript 静态检查 |
| A0 下 npm ci、npm test、npm run typecheck | 31 项通过，协调者复跑测试和类型检查通过 | 公共契约，不是实现模块 |

外部新增基线提交之后，还需在集成工作区重新执行旧功能回归；A7 集成验收也必须再次执行。

## 证据存放

真实页面截图、元素树、OCR 输出、文件哈希清单与 P0 临时验证脚本存放在本机 `~/Library/Application Support/2ndscreen/p0/2026-10-04/`，目录权限 0700、文件 0600。不提交候选人资料到 Git。原始临时采样位于 `/tmp/2ndscreen-p0/`；证据清单是 `evidence-manifest.json`。

测试使用独立 Second Screen 控制 Socket `/tmp/2ndscreen-p0/control.sock` 和 `p0-boss` 屏幕。BOSS 为 P0 启动；没有发送招聘消息、点击索取确认或触发岗位/招聘状态变更。打开会话会改变已读状态，这是已约定的采集行为。

## 评审记录

A0 首次提交 4f9b02a；协调者复跑 27 项测试并审查代码后，要求修正未知 token 用量、连续成功晋级及应用租约冲突规则。修订 c6ed717 的 31 项测试通过后合并。A0 的交付与协调者验收分别记录，不将 worker_done 自动视为合并许可。
