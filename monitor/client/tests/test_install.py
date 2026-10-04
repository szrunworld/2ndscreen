"""任务 J：安装、前提检查、注册、令牌存放、模式切换。

全部用临时 HOME、fake 2ndscreen CLI、fake keychain 与 httpx.MockTransport；不写真实钥匙串或 LaunchAgents。
"""

from __future__ import annotations

import io
import json
import stat
import subprocess
from pathlib import Path

import httpx
import pytest
from monitor_contracts import __version__ as CONTRACTS_VERSION
from monitor_contracts import validate_device_registration

from monitor.bootstrap.testing import FakeCli, FakeKeychain, fail, ok, subprocess_table
from monitor.install import (
    EXIT_OK,
    EXIT_PREREQ,
    EXIT_REGISTER,
    EXIT_USAGE,
    FileStore,
    InstallEnv,
    KeychainStore,
    MonitorPaths,
    PrereqChecker,
    RegistrationError,
    TokenStoreError,
    build_registration,
    detect_capabilities,
    load_config,
    main,
    register_device,
    save_token,
)
from monitor.install.cli import derive_console_url
from monitor.install.register import registration_key
from monitor.ledger import open_ledger

SERVER = "https://monitor.test/api/v1"
CODE = "ENROLL-123456"

REMOTE_OK = {
    ("defaults", "read"): (0, "alice\n"),
    ("fdesetup", "status"): (0, "FileVault is Off.\n"),
    ("pmset", "-g"): (0, "System-wide power settings:\nCurrently in use:\n standby 0\n sleep                0\n displaysleep 10\n"),
}
REMOTE_BAD = {
    ("defaults", "read"): (1, ""),
    ("fdesetup", "status"): (0, "FileVault is On.\n"),
    ("pmset", "-g"): (0, "Currently in use:\n sleep                10 (sleep prevented by coreaudiod)\n"),
}


def healthy_cli() -> FakeCli:
    return FakeCli(responses={"window move": fail("pid 77 has no matching on-screen window")})


def checker(cli: FakeCli, table=REMOTE_OK) -> PrereqChecker:
    return PrereqChecker(cli=cli.runner(), runner=subprocess_table(table), user="alice", pid=77)


# ---------------------------------------------------------------------------
# 前提检查
# ---------------------------------------------------------------------------


def test_local_prereqs_pass_and_probe_screen_is_destroyed():
    cli = healthy_cli()
    report = checker(cli).check("local")
    assert report.ok, report.render()
    assert [r.key for r in report.results] == ["twondscreen_running", "accessibility", "screen_recording"]
    # 探测屏：带 ttl 与 owner-pid，用完销毁
    create = next(c for c in cli.calls if c[:2] == ("screen", "create"))
    assert "--ttl" in create and "--owner-pid" in create and "77" in create
    assert cli.count("screen destroy") == 1 and cli.screens == set()
    # 权限探测只对本进程（没有窗口）执行 window move
    move = next(c for c in cli.calls if c[:2] == ("window", "move"))
    assert move[move.index("--pid") + 1] == "77"


def test_missing_permissions_are_all_listed():
    cli = FakeCli(
        responses={
            "window move": fail("2ndscreen needs the Accessibility permission to move windows"),
            "screenshot": fail("2ndscreen needs the Screen Recording permission to take screenshots"),
        }
    )
    report = checker(cli).check("local")
    assert not report.ok
    assert {r.key for r in report.missing} == {"accessibility", "screen_recording"}
    text = report.render()
    assert "辅助功能" in text and "屏幕录制" in text and "缺少 2 项" in text
    assert cli.screens == set()  # 失败也销毁探测屏


def test_2ndscreen_not_running_lists_dependent_checks():
    cli = FakeCli(responses={"screen list": (1, None, "error: 2ndscreen is not running")})
    report = checker(cli).check("local")
    assert [r.key for r in report.missing] == ["twondscreen_running", "accessibility", "screen_recording"]
    assert cli.count("screen create") == 0


def test_probe_screen_create_failure_marks_permissions_unknown():
    cli = FakeCli(responses={"screen create": fail("at most 8 agent screens")})
    report = checker(cli).check("local")
    assert {r.key for r in report.missing} == {"accessibility", "screen_recording"}
    assert "无法检查" in report.render()


def test_remote_prereqs_pass():
    report = checker(healthy_cli()).check("remote")
    assert report.ok, report.render()
    assert {r.key for r in report.results} >= {"auto_login", "filevault_off", "sleep_disabled"}


def test_remote_lists_every_missing_item():
    cli = FakeCli(responses={"window move": fail("2ndscreen needs the Accessibility permission to move windows")})
    report = checker(cli, REMOTE_BAD).check("remote")
    assert {r.key for r in report.missing} == {"accessibility", "auto_login", "filevault_off", "sleep_disabled"}
    text = report.render()
    assert "未开启自动登录" in text and "FileVault is On" in text and "10 分钟" in text


def test_remote_auto_login_other_user_and_unreadable_commands():
    table = dict(REMOTE_OK)
    table[("defaults", "read")] = (0, "bob\n")
    table[("fdesetup", "status")] = (0, "FileVault is Off, but Encryption in progress\n")
    del table[("pmset", "-g")]
    report = checker(healthy_cli(), table).check("remote")
    details = {r.key: r.detail for r in report.missing}
    assert "bob" in details["auto_login"]
    assert "filevault_off" in details
    assert details["sleep_disabled"] == "无法读取电源设置"


# ---------------------------------------------------------------------------
# install 命令
# ---------------------------------------------------------------------------


class Server:
    def __init__(self, status: int = 201, body: dict | None = None, raise_exc: Exception | None = None):
        self.status = status
        self.body = body if body is not None else {
            "device_id": "dev_abc123", "device_token": "tok_SECRET-value_1", "server_time": "2026-10-04T00:00:00Z",
            "contracts_version": CONTRACTS_VERSION,
        }
        self.raise_exc = raise_exc
        self.requests: list[httpx.Request] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.raise_exc:
            raise self.raise_exc
        return httpx.Response(self.status, json=self.body)

    @property
    def bodies(self) -> list[dict]:
        return [json.loads(r.content) for r in self.requests]


def make_env(tmp_path: Path, *, cli: FakeCli | None = None, table=REMOTE_OK, server: Server | None = None,
             keychain: FakeKeychain | None = None, stdin: str = "", interactive: bool = False) -> tuple[InstallEnv, Server]:
    server = server or Server()
    cli = cli or healthy_cli()
    env = InstallEnv(
        paths=MonitorPaths(tmp_path / "home"),
        checker_factory=lambda binary: checker(cli, table),
        keychain=keychain if keychain is not None else FakeKeychain(),  # type: ignore[arg-type]
        transport=httpx.MockTransport(server.handle),
        stdin=io.StringIO(stdin),
        stdout=io.StringIO(),
        stderr=io.StringIO(),
        interactive=interactive,
        capabilities=lambda mode: detect_capabilities(mode, handler_actions=["send_greeting", "request_resume"]),
        hostname=lambda: "test-mac",
    )
    return env, server


def install_args(mode: str = "local", *extra: str) -> list[str]:
    return ["install", "--mode", mode, "--server", SERVER, "--enrollment-code", CODE, "--device-name", "招聘机", *extra]


def stored_mode(env: InstallEnv) -> str | None:
    ledger = open_ledger(env.paths.ledger)
    try:
        return ledger.load_state().mode
    finally:
        ledger.close()


def test_install_missing_prereqs_exits_nonzero_and_writes_nothing(tmp_path):
    cli = FakeCli(responses={"window move": fail("2ndscreen needs the Accessibility permission to move windows")})
    env, server = make_env(tmp_path, cli=cli, table=REMOTE_BAD)
    code = main(install_args("remote"), env)
    assert code == EXIT_PREREQ
    out = env.stdout.getvalue()
    for title in ("辅助功能", "自动登录", "FileVault", "休眠"):
        assert title in out
    assert server.requests == []  # 没有注册
    assert not env.paths.app_dir.exists()  # 没有任何状态文件
    assert env.keychain.items == {}  # type: ignore[union-attr]


def test_install_local_registers_with_mode_and_stores_everything(tmp_path):
    env, server = make_env(tmp_path)
    assert main(install_args("local"), env) == EXIT_OK
    [body] = server.bodies
    validate_device_registration(body)
    assert body["mode"] == "local"
    assert body["enrollment_code"] == CODE and body["device_name"] == "招聘机"
    assert body["contracts_version"] == CONTRACTS_VERSION
    assert "login_relay" not in body["capabilities"]
    assert server.requests[0].url.path == "/api/v1/devices"
    assert server.requests[0].headers["Idempotency-Key"] == registration_key(CODE)
    assert "Authorization" not in server.requests[0].headers
    # 令牌进 keychain，不进配置文件
    assert env.keychain.items == {"dev_abc123": "tok_SECRET-value_1"}  # type: ignore[union-attr]
    cfg = load_config(env.paths)
    assert cfg is not None and cfg.mode == "local" and cfg.token_store == "keychain" and cfg.device_id == "dev_abc123"
    assert cfg.console_url == "https://monitor.test/"
    assert "tok_SECRET" not in env.paths.config.read_text()
    assert stat.S_IMODE(env.paths.config.stat().st_mode) == 0o600
    # mode 写入本地 monitor_state
    assert stored_mode(env) == "local"


def test_install_remote_mode_in_body_and_state(tmp_path):
    env, server = make_env(tmp_path)
    assert main(install_args("remote"), env) == EXIT_OK
    assert server.bodies[0]["mode"] == "remote"
    assert stored_mode(env) == "remote"


def test_install_falls_back_to_0600_file_without_keychain(tmp_path):
    env, _ = make_env(tmp_path, keychain=FakeKeychain(is_available=False))
    assert main(install_args(), env) == EXIT_OK
    token_file = env.paths.token_file
    assert token_file.read_text() == "tok_SECRET-value_1"
    assert stat.S_IMODE(token_file.stat().st_mode) == 0o600
    assert load_config(env.paths).token_store == "file"  # type: ignore[union-attr]


def test_install_keychain_write_failure_falls_back_to_file(tmp_path):
    env, _ = make_env(tmp_path, keychain=FakeKeychain(fail_save=True))
    assert main(install_args(), env) == EXIT_OK
    assert load_config(env.paths).token_store == "file"  # type: ignore[union-attr]


@pytest.mark.parametrize(
    ("status", "needle"),
    [(403, "注册码无效"), (409, "契约版本不兼容"), (422, "拒绝请求体"), (500, "HTTP 500")],
)
def test_install_registration_rejected_writes_nothing(tmp_path, status, needle):
    env, _ = make_env(tmp_path, server=Server(status=status, body={"code": "x", "message": "m"}))
    assert main(install_args(), env) == EXIT_REGISTER
    assert needle in env.stderr.getvalue()
    assert load_config(env.paths) is None
    assert env.keychain.items == {}  # type: ignore[union-attr]
    assert not env.paths.ledger.exists()


def test_install_network_error(tmp_path):
    env, _ = make_env(tmp_path, server=Server(raise_exc=httpx.ConnectError("down")))
    assert main(install_args(), env) == EXIT_REGISTER
    assert "无法连接服务端" in env.stderr.getvalue()


def test_install_non_interactive_missing_args(tmp_path):
    env, server = make_env(tmp_path)
    assert main(["install", "--server", SERVER], env) == EXIT_USAGE
    assert "--mode" in env.stderr.getvalue() and "--enrollment-code" in env.stderr.getvalue()
    assert server.requests == []


def test_install_rejects_plain_http(tmp_path):
    env, server = make_env(tmp_path)
    args = ["install", "--mode", "local", "--server", "http://x/api/v1", "--enrollment-code", CODE]
    assert main(args, env) == EXIT_USAGE
    assert server.requests == []


def test_install_interactive_prompts(tmp_path):
    env, server = make_env(tmp_path, stdin="bogus\nremote\nhttps://monitor.test/api/v1\nENROLL-999999\n\n", interactive=True)
    assert main(["install"], env) == EXIT_OK
    body = server.bodies[0]
    assert body["mode"] == "remote" and body["enrollment_code"] == "ENROLL-999999"
    assert body["device_name"] == "test-mac"  # 回车取默认主机名
    assert "请输入 local 或 remote" in env.stdout.getvalue()


def test_install_interactive_eof(tmp_path):
    env, _ = make_env(tmp_path, stdin="", interactive=True)
    assert main(["install"], env) == EXIT_USAGE


def test_install_refuses_when_already_installed(tmp_path):
    env, server = make_env(tmp_path)
    assert main(install_args(), env) == EXIT_OK
    assert main(install_args(), env) == EXIT_USAGE
    assert "已安装" in env.stderr.getvalue()
    assert len(server.requests) == 1
    assert main(install_args("local", "--reinstall"), env) == EXIT_OK
    assert len(server.requests) == 2


# ---------------------------------------------------------------------------
# mode 切换
# ---------------------------------------------------------------------------


def test_mode_switch_reruns_checks_and_writes_state(tmp_path):
    env, _ = make_env(tmp_path)
    assert main(install_args("local"), env) == EXIT_OK
    assert main(["mode", "remote"], env) == EXIT_OK
    assert stored_mode(env) == "remote"
    assert load_config(env.paths).mode == "remote"  # type: ignore[union-attr]
    assert "local → remote" in env.stdout.getvalue()


def test_mode_switch_with_missing_prereqs_keeps_old_mode(tmp_path):
    env, _ = make_env(tmp_path, table=REMOTE_BAD)
    assert main(install_args("local"), env) == EXIT_OK  # local 不查 remote 项
    assert main(["mode", "remote"], env) == EXIT_PREREQ
    assert stored_mode(env) == "local"
    assert load_config(env.paths).mode == "local"  # type: ignore[union-attr]


def test_mode_without_install(tmp_path):
    env, _ = make_env(tmp_path)
    assert main(["mode", "local"], env) == EXIT_USAGE
    assert "尚未安装" in env.stderr.getvalue()


def test_corrupt_config_is_reported(tmp_path):
    env, _ = make_env(tmp_path)
    env.paths.ensure_app_dir()
    env.paths.config.write_text("{not json")
    assert main(["mode", "local"], env) == EXIT_USAGE
    assert main(install_args(), env) == EXIT_USAGE
    assert main(install_args("local", "--reinstall"), env) == EXIT_OK


# ---------------------------------------------------------------------------
# 注册与能力
# ---------------------------------------------------------------------------


def test_build_registration_validates_and_local_excludes_login_relay():
    body = build_registration(enrollment_code=CODE, device_name="m", mode="remote",
                              capabilities=["observe", "login_relay"], os_version="15.1", arch="arm64")
    assert body["platform"] == {"os": "macos", "os_version": "15.1", "arch": "arm64"}
    with pytest.raises(ValueError):
        build_registration(enrollment_code=CODE, device_name="m", mode="local", capabilities=["login_relay"])
    with pytest.raises(ValueError):
        build_registration(enrollment_code="123", device_name="m", mode="local", capabilities=[])


def test_detect_capabilities():
    caps = detect_capabilities("remote", handler_actions=["send_greeting", "send_greeting"])
    assert caps.count("send_greeting") == 1
    assert "observe" in caps  # 观察模块已合并
    assert "login_relay" not in detect_capabilities("local", handler_actions=["login_relay"])


def test_register_device_requires_https_and_parses_response():
    body = build_registration(enrollment_code=CODE, device_name="m", mode="local", capabilities=[])
    with pytest.raises(RegistrationError, match="HTTPS"):
        register_device("http://x", body)
    srv = Server()
    reg = register_device(SERVER, body, transport=httpx.MockTransport(srv.handle))
    assert reg.device_id == "dev_abc123"
    assert "tok_" not in repr(reg)
    bad = Server(body={"device_id": "d"})
    with pytest.raises(RegistrationError, match="device_token"):
        register_device(SERVER, body, transport=httpx.MockTransport(bad.handle))
    with pytest.raises(RegistrationError, match="不合契约"):
        register_device(SERVER, {**body, "mode": "cloud"}, transport=httpx.MockTransport(srv.handle))


def test_derive_console_url():
    assert derive_console_url("https://h.example:8443/api/v1") == "https://h.example:8443/"


# ---------------------------------------------------------------------------
# 令牌存放
# ---------------------------------------------------------------------------


class SecurityFake:
    def __init__(self, stored: str = "tok_abcdefgh", stderr: str = "", returncode: int = 0):
        self.calls: list[tuple[list[str], str | None]] = []
        self.stored = stored
        self.stderr = stderr
        self.returncode = returncode

    def __call__(self, argv, **kw):
        self.calls.append((list(argv), kw.get("input")))
        if argv[1] == "default-keychain":
            return subprocess.CompletedProcess(argv, 0, '    "/Users/x/Library/Keychains/login.keychain-db"\n', "")
        if argv[1] == "-i":
            return subprocess.CompletedProcess(argv, self.returncode, "", self.stderr)
        if argv[1] == "find-generic-password":
            return subprocess.CompletedProcess(argv, 0 if self.stored else 44, self.stored + "\n", "")
        return subprocess.CompletedProcess(argv, 0, "", "")


def test_keychain_token_never_in_argv():
    fake = SecurityFake(stored="tok_abcdefgh")
    store = KeychainStore(runner=fake)
    assert store.available()
    store.save("dev_1", "tok_abcdefgh")
    for argv, _stdin in fake.calls:
        assert "tok_abcdefgh" not in argv
    stdin_line = next(i for a, i in fake.calls if a[1] == "-i")
    assert "add-generic-password -U -a dev_1" in stdin_line and "tok_abcdefgh" in stdin_line
    assert store.load("dev_1") == "tok_abcdefgh"


def test_keychain_failures():
    with pytest.raises(TokenStoreError, match="无法安全传递"):
        KeychainStore(runner=SecurityFake()).save("dev_1", "tok with space")
    with pytest.raises(TokenStoreError, match="写入 keychain 失败"):
        KeychainStore(runner=SecurityFake(stderr="security: SecKeychainItemCreate failed")).save("dev_1", "tok_abcdefgh")
    with pytest.raises(TokenStoreError, match="不一致"):
        KeychainStore(runner=SecurityFake(stored="tok_other_value")).save("dev_1", "tok_abcdefgh")
    with pytest.raises(TokenStoreError, match="没有本设备"):
        KeychainStore(runner=SecurityFake(stored="")).load("dev_1")

    def broken(argv, **kw):
        raise FileNotFoundError("security")

    assert not KeychainStore(runner=broken).available()


def test_file_store_permissions(tmp_path):
    fs = FileStore(tmp_path / "d" / "token")
    fs.save("dev", "tok_abcdefgh")
    assert stat.S_IMODE(fs.path.stat().st_mode) == 0o600
    assert fs.load("dev") == "tok_abcdefgh"
    fs.path.chmod(0o644)
    with pytest.raises(TokenStoreError, match="权限过宽"):
        fs.load("dev")
    fs.delete("dev")
    with pytest.raises(TokenStoreError, match="不存在"):
        fs.load("dev")
    with pytest.raises(TokenStoreError):
        fs.save("dev", "  ")


def test_save_token_prefers_keychain(tmp_path):
    kc = FakeKeychain()
    store = save_token("dev", "tok_abcdefgh", keychain=kc, file_store=FileStore(tmp_path / "t"))  # type: ignore[arg-type]
    assert store is kc and not (tmp_path / "t").exists()


def test_paths_from_env_requires_home():
    with pytest.raises(ValueError):
        MonitorPaths.from_env({})
    p = MonitorPaths.from_env({"HOME": "/tmp/h"})
    assert p.launch_agents == Path("/tmp/h/Library/LaunchAgents")
    assert str(p.ledger).startswith("/tmp/h/Library/Application Support/RecruitMonitor/")


def test_fake_cli_ok_helper_shape():
    assert ok(a=1) == (0, {"ok": True, "a": 1}, "")
