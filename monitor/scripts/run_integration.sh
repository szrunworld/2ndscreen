#!/usr/bin/env bash
# 招聘 Monitor 一键测试：契约、客户端、服务端、邮件接入的单元测试 + 集成与混沌测试（任务 M）。
#
#   monitor/scripts/run_integration.sh              # 全部（验收命令）
#   monitor/scripts/run_integration.sh integration  # 只跑集成与混沌
#   monitor/scripts/run_integration.sh chaos        # 只跑混沌（含子进程 kill）
#   monitor/scripts/run_integration.sh all -x -k wechat   # 其余参数原样传给 pytest
#
# 不访问真实 BOSS、真实账号、真实邮件服务；服务端在进程内或本机回环地址上启动，数据都在临时目录。
# 依赖：uv（https://docs.astral.sh/uv/）。不修改 uv.lock（--frozen）。
set -euo pipefail

cd "$(dirname "$0")/.."   # monitor/

target="${1:-all}"
if [[ $# -gt 0 ]]; then shift; fi

case "$target" in
  all)         paths=(contracts client server mail integration) ;;
  integration) paths=(integration) ;;
  chaos)       paths=(integration/test_chaos.py integration/test_chaos_kill.py) ;;
  -h|--help)   sed -n '2,10p' "$0"; exit 0 ;;
  *)           echo "未知目标：$target（all / integration / chaos）" >&2; exit 2 ;;
esac

echo "==> uv sync --frozen"
uv sync --frozen

echo "==> pytest ${paths[*]} $*"
# -rxX：在摘要里列出 xfail（已知缺陷与等待中的任务），XPASS 说明缺陷已修好、该删标记了
uv run --frozen pytest "${paths[@]}" -rxX "$@"
