#!/bin/bash
# 安装招聘 Monitor 的用户级 LaunchAgent。只写 $HOME/Library/LaunchAgents，不碰 /Library 或 /System。
#
#   install.sh remote   开机自启：2ndscreen 菜单栏应用 + Monitor（配合 macOS 自动登录）
#   install.sh local    可选：Monitor 随用户登录启动（不管理 2ndscreen）
#
# 可用环境变量覆盖：
#   MONITOR_PYTHON       Monitor 所在虚拟环境的 python（默认 <仓库>/monitor/.venv/bin/python）
#   SECONDSCREEN_APP     2ndscreen.app 路径（默认 /Applications/2ndscreen.app）
#   MONITOR_2NDSCREEN_CLI  2ndscreen CLI 路径（默认 PATH 里的 2ndscreen；仓库构建在 .build/release/2ndscreen）
#   LAUNCHCTL            launchctl 路径（测试用替身）；MONITOR_LAUNCHD_NO_LOAD=1 只写文件不加载
set -euo pipefail

usage() { echo "用法: $0 local|remote" >&2; exit 2; }
[ $# -eq 1 ] || usage
MODE="$1"
case "$MODE" in local|remote) ;; *) usage ;; esac

[ -n "${HOME:-}" ] || { echo "没有 HOME" >&2; exit 2; }
case "$HOME" in /|/Library|/Library/*|/System|/System/*) echo "HOME=$HOME 不是用户目录，拒绝写入" >&2; exit 2 ;; esac

HERE="$(cd "$(dirname "$0")" && pwd)"
MONITOR_DIR="$(cd "$HERE/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
LOGDIR="$HOME/Library/Application Support/RecruitMonitor/logs"
PYTHON="${MONITOR_PYTHON:-$MONITOR_DIR/.venv/bin/python}"
APP="${SECONDSCREEN_APP:-/Applications/2ndscreen.app}"
LAUNCHCTL="${LAUNCHCTL:-launchctl}"
LABEL_MONITOR="com.recruit-monitor.monitor"
LABEL_SCREEN="com.recruit-monitor.2ndscreen"

if [ -z "${MONITOR_2NDSCREEN_CLI:-}" ]; then
  if command -v 2ndscreen >/dev/null 2>&1; then MONITOR_2NDSCREEN_CLI="$(command -v 2ndscreen)"; else MONITOR_2NDSCREEN_CLI="2ndscreen"; fi
fi

[ -x "$PYTHON" ] || { echo "找不到 Monitor 的 python：$PYTHON（先在 monitor/ 下运行 uv sync，或设置 MONITOR_PYTHON）" >&2; exit 1; }

# XML 转义后再转义成 sed 替换文本（分隔符用 |）
esc() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/[|\\&]/\\&/g'; }

render() {  # render 模板 目标 标签
  local tpl="$1" dest="$2" label="$3" app_exec="${4:-}"
  local tmp="$dest.tmp.$$"
  sed -e "s|@LABEL@|$(esc "$label")|g" \
      -e "s|@PYTHON@|$(esc "$PYTHON")|g" \
      -e "s|@WORKDIR@|$(esc "$MONITOR_DIR")|g" \
      -e "s|@LOGDIR@|$(esc "$LOGDIR")|g" \
      -e "s|@CLI@|$(esc "$MONITOR_2NDSCREEN_CLI")|g" \
      -e "s|@APP_EXEC@|$(esc "$app_exec")|g" \
      "$tpl" > "$tmp"
  if command -v plutil >/dev/null 2>&1; then plutil -lint -s "$tmp" >/dev/null || { rm -f "$tmp"; echo "渲染出的 plist 不合法：$dest" >&2; exit 1; }; fi
  chmod 0644 "$tmp"
  mv -f "$tmp" "$dest"
  echo "已写入 $dest"
}

load() {  # 先卸载旧的同名任务再加载；失败只警告（例如在没有图形会话的 ssh 里运行）
  local label="$1" plist="$2" domain="gui/$(id -u)"
  [ "${MONITOR_LAUNCHD_NO_LOAD:-0}" = "1" ] && return 0
  "$LAUNCHCTL" bootout "$domain/$label" >/dev/null 2>&1 || true
  if ! "$LAUNCHCTL" bootstrap "$domain" "$plist"; then
    echo "警告：launchctl bootstrap $label 失败；下次登录时会自动加载" >&2
  fi
}

mkdir -p "$AGENTS" "$LOGDIR"

if [ "$MODE" = "remote" ]; then
  [ -d "$APP" ] || { echo "找不到 2ndscreen.app：$APP（设置 SECONDSCREEN_APP）" >&2; exit 1; }
  EXEC_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist" 2>/dev/null || echo 2ndscreen)"
  render "$HERE/templates/2ndscreen.plist.template" "$AGENTS/$LABEL_SCREEN.plist" "$LABEL_SCREEN" "$APP/Contents/MacOS/$EXEC_NAME"
  load "$LABEL_SCREEN" "$AGENTS/$LABEL_SCREEN.plist"
else
  # local 不管理 2ndscreen；切换回 local 时移除 remote 留下的 2ndscreen 自启
  if [ -f "$AGENTS/$LABEL_SCREEN.plist" ]; then
    [ "${MONITOR_LAUNCHD_NO_LOAD:-0}" = "1" ] || "$LAUNCHCTL" bootout "gui/$(id -u)/$LABEL_SCREEN" >/dev/null 2>&1 || true
    rm -f "$AGENTS/$LABEL_SCREEN.plist"
    echo "已移除 $AGENTS/$LABEL_SCREEN.plist"
  fi
fi
render "$HERE/templates/monitor.plist.template" "$AGENTS/$LABEL_MONITOR.plist" "$LABEL_MONITOR"
load "$LABEL_MONITOR" "$AGENTS/$LABEL_MONITOR.plist"
echo "完成（$MODE）。日志：$LOGDIR"
