#!/bin/bash
# 卸载招聘 Monitor 的用户级 LaunchAgent。只动 $HOME/Library/LaunchAgents 里本项目的两个文件。
#   LAUNCHCTL 可覆盖（测试用替身）；MONITOR_LAUNCHD_NO_LOAD=1 只删文件不调用 launchctl
set -euo pipefail
[ -n "${HOME:-}" ] || { echo "没有 HOME" >&2; exit 2; }
case "$HOME" in /|/Library|/Library/*|/System|/System/*) echo "HOME=$HOME 不是用户目录，拒绝操作" >&2; exit 2 ;; esac
AGENTS="$HOME/Library/LaunchAgents"
LAUNCHCTL="${LAUNCHCTL:-launchctl}"
for label in com.recruit-monitor.monitor com.recruit-monitor.2ndscreen; do
  if [ "${MONITOR_LAUNCHD_NO_LOAD:-0}" != "1" ]; then
    "$LAUNCHCTL" bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  fi
  if [ -f "$AGENTS/$label.plist" ]; then
    rm -f "$AGENTS/$label.plist"
    echo "已移除 $AGENTS/$label.plist"
  fi
done
