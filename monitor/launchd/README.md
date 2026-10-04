# Monitor 的 launchd 用户级任务

只写 `~/Library/LaunchAgents`，不碰 `/Library/LaunchAgents`、`/Library/LaunchDaemons` 或 `/System`。

| 文件 | 用途 |
| --- | --- |
| `templates/monitor.plist.template` | Monitor 常驻进程：`<venv python> -m monitor.bootstrap`，RunAtLoad，崩溃重启（`KeepAlive.SuccessfulExit=false`），只在 Aqua 图形会话加载 |
| `templates/2ndscreen.plist.template` | 仅 remote：拉起 2ndscreen 菜单栏应用（直接运行 `.app/Contents/MacOS/<可执行文件>`，保持应用身份，权限不丢） |
| `install.sh local\|remote` | 渲染模板、`plutil -lint` 校验、`launchctl bootstrap gui/<uid>` 加载 |
| `uninstall.sh` | `launchctl bootout` 并删除两个 plist |

```sh
cd monitor && uv sync
python -m monitor.install install --mode remote ...   # 先安装（注册设备、写模式）
monitor/launchd/install.sh remote                      # 再装开机自启
monitor/launchd/uninstall.sh                           # 卸载
```

remote 的开机链路：macOS 自动登录 → launchd 加载两个 LaunchAgent → 2ndscreen 菜单栏应用与 Monitor 同时启动。
launchd 不保证先后顺序：Monitor 引导时若 2ndscreen 尚未就绪，按有上限的退避重试（见 `monitor/client/monitor/bootstrap/retry.py`）。

日志：`~/Library/Application Support/RecruitMonitor/logs/`。

环境变量：`MONITOR_PYTHON`、`SECONDSCREEN_APP`（默认 `/Applications/2ndscreen.app`）、`MONITOR_2NDSCREEN_CLI`、
`LAUNCHCTL`（测试替身）、`MONITOR_LAUNCHD_NO_LOAD=1`（只写文件不加载）。
