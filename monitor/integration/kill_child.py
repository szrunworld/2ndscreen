"""混沌测试的子进程：在同一个工作目录（服务端库 server.db、本机账本 monitor.db）上跑 Monitor，
当指定种类的写调用到达 FakeDriver 之后立即 os._exit(9)——模拟"点击之后进程被杀"。

写调用逐条追加到 journal（每条 fsync），父进程据此核对子进程里发生过哪些写操作。
子进程里同时承载服务端实例（同一个 SQLite 文件）；父进程在此期间停掉自己的服务端实例。

用法：python kill_child.py '<json 参数>'
  workdir、device_id、token、mode、now（ISO 时间）、start_step、kill_on、journal、max_rounds
退出码：9 = 按计划被杀；3 = 跑完 max_rounds 也没等到 kill_on。
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from integration_kit import Cluster, DeviceIdentity, Monitor, Screen, boss_new_greeting  # noqa: E402
from monitor.core import ManualClock  # noqa: E402


def main() -> int:
    args = json.loads(sys.argv[1])
    workdir = Path(args["workdir"])
    # 比父进程最后一刻晚 1 秒启动（心跳的幂等键按 sent_at 生成，同一时刻会与父进程最后一次心跳撞键）
    clock = ManualClock(datetime.fromisoformat(args["now"]) + timedelta(seconds=1))
    cluster = Cluster(workdir, clock)
    fake = boss_new_greeting(clock)
    fake.goto(args["start_step"])
    screen = Screen(fake, journal=Path(args["journal"]))

    def kill(rec, scr):
        if rec.kind == args["kill_on"]:
            os._exit(9)  # 不做任何清理：不关库、不回报、不 flush 别的东西

    screen.hooks.append(kill)
    ident = DeviceIdentity(device_id=args["device_id"], token=args["token"], mode=args.get("mode", "local"))
    m = Monitor(cluster, ident, screen, ledger_path=workdir / "monitor.db")
    for _ in range(int(args.get("max_rounds", 300))):
        m.step()
    m.close()
    cluster.shutdown()
    return 3


if __name__ == "__main__":
    raise SystemExit(main())
