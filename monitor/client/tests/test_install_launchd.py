"""任务 J：launchd 安装 / 卸载脚本。临时 HOME + fake launchctl，不写真实 ~/Library/LaunchAgents。"""

from __future__ import annotations

import os
import plistlib
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

LAUNCHD = Path(__file__).resolve().parents[2] / "launchd"
INSTALL = LAUNCHD / "install.sh"
UNINSTALL = LAUNCHD / "uninstall.sh"


@pytest.fixture
def sandbox(tmp_path):
    home = tmp_path / "home & <odd>"  # 路径里带 XML / sed 特殊字符
    home.mkdir()
    log = tmp_path / "launchctl.log"
    fake = tmp_path / "launchctl"
    fake.write_text(f'#!/bin/bash\necho "$@" >> "{log}"\nexit 0\n')
    fake.chmod(0o755)
    app = tmp_path / "2ndscreen.app"
    (app / "Contents" / "MacOS").mkdir(parents=True)
    with open(app / "Contents" / "Info.plist", "wb") as fh:
        plistlib.dump({"CFBundleExecutable": "2ndscreen"}, fh)
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(home),
        "LAUNCHCTL": str(fake),
        "MONITOR_PYTHON": sys.executable,
        "SECONDSCREEN_APP": str(app),
        "MONITOR_2NDSCREEN_CLI": "/opt/2nd screen/2ndscreen",
    }
    return {"home": home, "env": env, "log": log, "app": app, "tmp": tmp_path}


def run(script: Path, *args: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["/bin/bash", str(script), *args], env=env, capture_output=True, text=True, timeout=60)


def files_under(root: Path) -> set[Path]:
    return {p.relative_to(root) for p in root.rglob("*") if p.is_file()}


def test_remote_install_writes_only_user_launch_agents(sandbox):
    home = sandbox["home"]
    done = run(INSTALL, "remote", env=sandbox["env"])
    assert done.returncode == 0, done.stderr
    agents = home / "Library" / "LaunchAgents"
    assert {p.name for p in agents.iterdir()} == {"com.recruit-monitor.monitor.plist", "com.recruit-monitor.2ndscreen.plist"}
    # HOME 下只多了 LaunchAgents 与日志目录
    assert {p.parts[1] for p in files_under(home)} <= {"LaunchAgents"}
    assert (home / "Library" / "Application Support" / "RecruitMonitor" / "logs").is_dir()

    with open(agents / "com.recruit-monitor.monitor.plist", "rb") as fh:
        mon = plistlib.load(fh)
    assert mon["Label"] == "com.recruit-monitor.monitor"
    assert mon["ProgramArguments"] == [sys.executable, "-m", "monitor.bootstrap"]
    assert mon["RunAtLoad"] is True and mon["KeepAlive"] == {"SuccessfulExit": False}
    assert mon["LimitLoadToSessionType"] == "Aqua"
    assert mon["EnvironmentVariables"]["MONITOR_2NDSCREEN_CLI"] == "/opt/2nd screen/2ndscreen"
    assert mon["StandardErrorPath"].startswith(str(home))
    with open(agents / "com.recruit-monitor.2ndscreen.plist", "rb") as fh:
        scr = plistlib.load(fh)
    assert scr["ProgramArguments"] == [str(sandbox["app"] / "Contents" / "MacOS" / "2ndscreen")]

    calls = sandbox["log"].read_text().splitlines()
    uid = os.getuid()
    assert f"bootstrap gui/{uid} {agents}/com.recruit-monitor.2ndscreen.plist" in calls
    assert f"bootstrap gui/{uid} {agents}/com.recruit-monitor.monitor.plist" in calls
    assert all(c.split()[0] in ("bootstrap", "bootout") for c in calls)


def test_local_install_only_monitor_and_removes_remote_leftover(sandbox):
    assert run(INSTALL, "remote", env=sandbox["env"]).returncode == 0
    done = run(INSTALL, "local", env=sandbox["env"])
    assert done.returncode == 0, done.stderr
    agents = sandbox["home"] / "Library" / "LaunchAgents"
    assert {p.name for p in agents.iterdir()} == {"com.recruit-monitor.monitor.plist"}
    assert f"bootout gui/{os.getuid()}/com.recruit-monitor.2ndscreen" in sandbox["log"].read_text()


def test_uninstall_removes_both(sandbox):
    assert run(INSTALL, "remote", env=sandbox["env"]).returncode == 0
    done = run(UNINSTALL, env=sandbox["env"])
    assert done.returncode == 0, done.stderr
    assert list((sandbox["home"] / "Library" / "LaunchAgents").iterdir()) == []
    assert "bootout" in sandbox["log"].read_text()


def test_no_load_mode_skips_launchctl(sandbox):
    env = {**sandbox["env"], "MONITOR_LAUNCHD_NO_LOAD": "1"}
    assert run(INSTALL, "local", env=env).returncode == 0
    assert not sandbox["log"].exists()


@pytest.mark.parametrize("home", ["/", "/Library", "/System/Library"])
def test_refuses_system_directories(sandbox, home):
    env = {**sandbox["env"], "HOME": home}
    for script, args in ((INSTALL, ("local",)), (UNINSTALL, ())):
        done = run(script, *args, env=env)
        assert done.returncode == 2
        assert "拒绝" in done.stderr
    assert not sandbox["log"].exists()


def test_bad_arguments_and_missing_prerequisites(sandbox):
    assert run(INSTALL, env=sandbox["env"]).returncode == 2
    assert run(INSTALL, "cloud", env=sandbox["env"]).returncode == 2
    env = {**sandbox["env"], "MONITOR_PYTHON": str(sandbox["tmp"] / "nope")}
    assert run(INSTALL, "local", env=env).returncode == 1
    shutil.rmtree(sandbox["app"])
    done = run(INSTALL, "remote", env=sandbox["env"])
    assert done.returncode == 1 and "2ndscreen.app" in done.stderr
    assert not (sandbox["home"] / "Library" / "LaunchAgents" / "com.recruit-monitor.monitor.plist").exists()


def test_templates_are_valid_plists_after_substitution():
    for tpl in (LAUNCHD / "templates").glob("*.template"):
        text = tpl.read_text()
        for key in ("@LABEL@", "@PYTHON@", "@WORKDIR@", "@LOGDIR@", "@CLI@", "@APP_EXEC@"):
            text = text.replace(key, "x")
        data = plistlib.loads(text.encode())
        assert data["Label"] == "x"
        assert "/Library/LaunchDaemons" not in tpl.read_text()
