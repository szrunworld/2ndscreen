"""__main__：参数解析、令牌读取、工厂装配（不启动循环、不访问网络）。"""

from __future__ import annotations

import sys
import types

import pytest

import monitor.__main__ as entry
from monitor.core import MonitorRuntime
from monitor.core.testing import InMemoryLedger, ScriptedHandler, ScriptedObserver


@pytest.fixture
def fake_modules(monkeypatch):
    """把 ledger / observe / actions 的工厂替换成测试替身（这些模块由其他任务提供）。"""
    made = {}

    def open_ledger(path):
        made["db"] = path
        return InMemoryLedger()

    mods = {
        "fake_ledger": types.SimpleNamespace(open_ledger=open_ledger),
        "fake_observe": types.SimpleNamespace(create_observer=ScriptedObserver),
        "fake_actions": types.SimpleNamespace(create_handlers=lambda: [ScriptedHandler("send_greeting")]),
    }
    for name, mod in mods.items():
        monkeypatch.setitem(sys.modules, name, mod)
    monkeypatch.setattr(entry, "_make_driver", lambda args: object())
    return made


def _args(tmp_path, *extra):
    return entry.build_parser().parse_args(
        [
            "--server-url", "https://monitor.test/api/v1",
            "--device-id", "dev_1",
            "--db", str(tmp_path / "m.db"),
            "--ledger", "fake_ledger:open_ledger",
            "--observer", "fake_observe:create_observer",
            "--handlers", "fake_actions:create_handlers",
            *extra,
        ]
    )


def test_assemble_with_env_token(tmp_path, fake_modules):
    args = _args(tmp_path, "--mode", "remote", "--observe-interval", "20", "--allow-action", "send_greeting")
    rt = entry.assemble(args, env={entry.TOKEN_ENV: "tok_abcdefgh"})
    assert isinstance(rt, MonitorRuntime)
    assert rt.config.mode == "remote" and rt.config.observe_interval == 20
    assert rt.config.local_allowed_actions == frozenset({"send_greeting"})
    assert set(rt.pipeline.handlers) == {"send_greeting"}
    assert fake_modules["db"] == tmp_path / "m.db"


def test_assemble_without_observer(tmp_path, fake_modules):
    args = _args(tmp_path, "--observer", "none")
    rt = entry.assemble(args, env={entry.TOKEN_ENV: "tok_abcdefgh"})
    assert rt.observer is None


def test_token_file_permissions(tmp_path):
    f = tmp_path / "token"
    f.write_text("tok_from_file\n")
    f.chmod(0o600)
    assert entry.read_token(f, {}) == "tok_from_file"
    f.chmod(0o644)
    with pytest.raises(entry.SetupError, match="权限"):
        entry.read_token(f, {})
    with pytest.raises(entry.SetupError, match="不存在"):
        entry.read_token(tmp_path / "missing", {})
    with pytest.raises(entry.SetupError, match="没有设备令牌"):
        entry.read_token(None, {})


def test_http_url_refused(tmp_path, fake_modules):
    args = entry.build_parser().parse_args(
        ["--server-url", "http://x", "--device-id", "d", "--db", str(tmp_path / "m.db")]
    )
    with pytest.raises(entry.SetupError, match="HTTPS"):
        entry.assemble(args, env={entry.TOKEN_ENV: "tok_abcdefgh"})


def test_load_factory_errors():
    with pytest.raises(entry.SetupError, match="模块:属性"):
        entry.load_factory("no_colon")
    with pytest.raises(entry.SetupError, match="无法导入"):
        entry.load_factory("monitor.not_merged_yet:factory")
    with pytest.raises(entry.SetupError, match="没有"):
        entry.load_factory("monitor.core:nope")
    assert entry.load_factory("monitor.core:GuiLock").__name__ == "GuiLock"


def test_main_returns_2_on_setup_error(tmp_path, capsys, monkeypatch):
    monkeypatch.delenv(entry.TOKEN_ENV, raising=False)
    code = entry.main(["--server-url", "https://x/api/v1", "--device-id", "d", "--db", str(tmp_path / "m.db")])
    assert code == 2
    assert "monitor:" in capsys.readouterr().err


def test_parser_rejects_unknown_allow_action():
    with pytest.raises(SystemExit):
        entry.build_parser().parse_args(
            ["--server-url", "https://x", "--device-id", "d", "--db", "m.db", "--allow-action", "provide_input"]
        )


@pytest.mark.parametrize("cmd", ["install", "mode"])
def test_install_and_mode_dispatch_to_install_cli(monkeypatch, cmd):
    import monitor.install.cli as install_cli

    seen = []
    monkeypatch.setattr(install_cli, "main", lambda argv: seen.append(list(argv)) or 7)
    assert entry.main([cmd, "remote"]) == 7
    assert seen == [[cmd, "remote"]]


def test_other_args_are_not_dispatched(monkeypatch, capsys):
    import monitor.install.cli as install_cli

    monkeypatch.setattr(install_cli, "main", lambda argv: pytest.fail("不应转给安装命令"))
    with pytest.raises(SystemExit) as exc:
        entry.main(["--device-id", "dev_1"])  # 缺必填参数：仍由常驻进程的解析器报错
    assert exc.value.code == 2
    assert "--server-url" in capsys.readouterr().err


def test_dispatch_reads_sys_argv_when_argv_omitted(monkeypatch):
    import monitor.install.cli as install_cli

    seen = []
    monkeypatch.setattr(install_cli, "main", lambda argv: seen.append(list(argv)) or 0)
    monkeypatch.setattr(sys, "argv", ["python -m monitor", "mode", "local"])
    assert entry.main() == 0
    assert seen == [["mode", "local"]]
