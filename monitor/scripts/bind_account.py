"""把控制台确认的招聘账户写进本机账本（缺陷 M-1 的运维替代步骤）。

背景：控制台 `PUT /devices/{id}/account-binding` 之后，Monitor 没有任何途径得知绑定的 account_id
（心跳响应只有 account_confirmed），install / bootstrap 也不询问，所以绑定永远停在"未绑定"。
在契约与 core 补上之前，由运维在设备上执行本脚本，语义与 MonitorRuntime.bind_account 相同：
写入绑定、换过账户时要求重建基线（generation + 1）、因换账户而暂停的设备解除暂停。

**必须在 Monitor 停止时执行**（账本只允许一个进程使用）：

    launchctl bootout gui/$(id -u)/com.recruit-monitor.monitor      # 或在前台 Ctrl-C
    uv run python scripts/bind_account.py --account <account_id> --confirmed-by <控制台操作者>
    monitor/launchd/install.sh <local|remote>                       # 重新加载

--ledger 缺省为 ~/Library/Application Support/RecruitMonitor/ledger.sqlite3。
"""

from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime
from pathlib import Path


def bind(ledger_path: Path, account_id: str, confirmed_by: str, *, now: datetime | None = None) -> bool:
    """写入绑定；返回是否换了账户（换了就要求重建基线）。"""
    from monitor_contracts import AccountBinding, Baseline

    from monitor.ledger import open_ledger

    now = now or datetime.now(UTC)
    ledger = open_ledger(ledger_path)
    try:
        state = ledger.load_state()
        old = state.account_binding.account_id if state.account_binding else None
        changed = old != account_id
        switched = state.paused and state.pause_reason == "account_switched"
        state.account_binding = AccountBinding(account_id=account_id, bound_at=now, confirmed_by=confirmed_by)
        if changed or switched:
            state.needs_baseline = True
            state.baseline = Baseline(account_id=account_id, established=False, generation=state.baseline.generation + 1)
        if switched:
            state.paused = False
            state.pause_reason = None
        ledger.save_state(state)
        return changed
    finally:
        ledger.close()


def main(argv: list[str] | None = None) -> int:
    from monitor.install.paths import MonitorPaths

    p = argparse.ArgumentParser(prog="bind_account.py", description="把控制台确认的绑定账户写进本机账本")
    p.add_argument("--account", required=True, help="控制台确认的 account_id")
    p.add_argument("--confirmed-by", required=True, help="在控制台确认绑定的操作者")
    p.add_argument("--ledger", type=Path, help="账本路径（缺省为安装目录里的 ledger.sqlite3）")
    args = p.parse_args(argv)
    path = args.ledger or MonitorPaths.from_env().ledger
    if not path.exists():
        print(f"bind_account.py: 账本不存在：{path}（先运行安装）", file=sys.stderr)
        return 2
    changed = bind(path, args.account, args.confirmed_by)
    print(f"已绑定 {args.account}" + ("（账户变更：下次启动先重建观察基线）" if changed else "（账户未变）"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
