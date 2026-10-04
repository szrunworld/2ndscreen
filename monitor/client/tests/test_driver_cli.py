"""_cli 的测试：每个 CLI 样例的解析、错误分类、超时与子进程调用方式。"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from monitor.driver import _cli
from monitor.driver._cli import CliFailure, CliRunner, interpret

SAMPLES = Path(__file__).resolve().parents[2] / "fixtures" / "cli-samples"

# 样例名 → 期望：成功样例写解析器名，失败样例写错误分类。
EXPECTED = {
    "screen_create": "ok",
    "screen_list": "screens",
    "app_launch_calc": "windows",
    "window_move_ok": "windows",
    "state_textedit": "state",
    "state_calc": "state",
    "state_calc_after": "state",
    "state_query": "state",
    "state_wid_ok": "state",
    "click_index_ok": "action",
    "click_text_ok": "action",
    "click_xy_ok": "action",
    "click_calc_7": "action",
    "type_index_ok": "action",
    "type_replace_ok": "action",
    "key_ok": "action",
    "key_mod_ok": "action",
    "scroll_ok": "action",
    "screenshot_ok": "ok",
    "app_launch_textedit": _cli.CLI_FAILED,
    "app_launch_already": _cli.CLI_FAILED,
    "state_bad_pid": _cli.WINDOW_LOST,
    "state_window_lost": _cli.WINDOW_LOST,
    "state_window_lost_wid": _cli.WINDOW_LOST,
    "click_window_lost": _cli.WINDOW_LOST,
    "window_move_bad_pid": _cli.WINDOW_LOST,
    "state_bad_window_id": _cli.WINDOW_LOST,
    "state_no_screen": _cli.SCREEN_LOST,
    "screenshot_no_screen": _cli.SCREEN_LOST,
    "click_bad_index": _cli.STALE_SNAPSHOT,
    "click_text_missing": _cli.NOT_FOUND,
    "click_xy_outside": _cli.CLI_FAILED,
    "click_no_target": _cli.CLI_FAILED,
    "scroll_bad_amount": _cli.CLI_FAILED,
    "key_bad": _cli.CLI_FAILED,
    "type_no_value": _cli.CLI_FAILED,
    "arg_missing_value": _cli.CLI_FAILED,
}


def load(name: str) -> dict:
    return json.loads((SAMPLES / f"{name}.json").read_text())


def replay(sample: dict):
    stdout = json.dumps(sample["stdout"], ensure_ascii=False) if sample["stdout"] is not None else ""
    return interpret(["2ndscreen", *sample["argv"]], sample["exit_code"], stdout, sample["stderr"])


def test_every_sample_has_an_expectation():
    names = {p.stem for p in SAMPLES.glob("*.json")}
    assert names == set(EXPECTED), names ^ set(EXPECTED)


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_sample_interpretation(name):
    sample = load(name)
    expected = EXPECTED[name]
    if expected in {"ok", "state", "action", "windows", "screens"}:
        outcome = replay(sample)
        assert outcome.payload["ok"] is True
        if expected == "state":
            state = _cli.parse_state(outcome.payload)
            assert state.elements, name
            assert state.window_id > 0 and state.pid > 0
            assert all(e.index >= 0 and e.role.startswith("AX") for e in state.elements)
            # CLI 的 --query 只过滤输出，index 仍是整棵树的编号。
            if "--query" in sample["argv"]:
                assert state.elements[0].index > 0
        elif expected == "action":
            assert outcome.payload["route"].split(".")[0] in {"ax", "event"}
            if "element" in outcome.payload:
                _cli.parse_element(outcome.payload["element"])
        elif expected == "windows":
            windows = _cli.parse_windows(outcome.payload)
            assert windows and windows[0].window_id > 0
        elif expected == "screens":
            screens = _cli.parse_screens(outcome.payload)
            assert "monitor-c" not in screens or screens["monitor-c"] is not None
            assert all(f is not None for f in screens.values())
    else:
        with pytest.raises(CliFailure) as info:
            replay(sample)
        assert info.value.kind == expected, info.value.message
        assert info.value.message


def test_textedit_state_fields():
    state = _cli.parse_state(replay(load("state_textedit")).payload)
    assert state.app == "TextEdit"
    assert state.window_frame == _cli.RawFrame(4800, 25, 1280, 775)
    bold = next(e for e in state.elements if e.label == "bold")
    assert bold.role == "AXCheckBox/AXSegment" and bold.value == "0" and bold.actions == ("AXPress",)
    assert state.screenshot == "<SCRATCH>/state1.png"
    assert state.tree.startswith("- [0] AXWindow")


def test_calculator_value_keeps_bidi_mark():
    # CLI 原样输出 U+200E；规范化交给定位器。
    state = _cli.parse_state(replay(load("state_calc_after")).payload)
    assert any(e.value == "‎7" for e in state.elements)


def test_launch_refused_still_reports_windows():
    with pytest.raises(CliFailure) as info:
        replay(load("app_launch_textedit"))
    assert info.value.payload is not None
    assert _cli.parse_windows(info.value.payload)[0].window_id == 131479


def test_ok_true_with_nonzero_exit_is_failure():
    with pytest.raises(CliFailure) as info:
        interpret(["x"], 1, '{"ok": true}', "")
    assert info.value.kind == _cli.CLI_FAILED


def test_non_json_stdout_is_failure():
    with pytest.raises(CliFailure) as info:
        interpret(["x"], 0, "not json", "")
    assert info.value.kind == _cli.CLI_FAILED


def test_not_running_on_stderr():
    with pytest.raises(CliFailure) as info:
        interpret(["x", "screen", "list"], 1, "", "2ndscreen is not running; open 2ndscreen.app first\n")
    assert info.value.kind == _cli.CLI_FAILED
    assert "not running" in info.value.message


@pytest.mark.parametrize(
    "message,kind",
    [
        ('window 42 is not on screen "monitor-c"; move it there first', _cli.WINDOW_LOST),
        ("TextEdit does not expose window 42 to accessibility", _cli.WINDOW_LOST),
        ("the window is on no screen", _cli.WINDOW_LOST),
        ("no screen monitor-c", _cli.SCREEN_LOST),
        ("2ndscreen needs the Accessibility permission to read and drive apps", _cli.CLI_FAILED),
    ],
)
def test_classify_source_messages(message, kind):
    # 这些文案来自 CLI 源码，未在样例中复现。
    assert _cli.classify_error(message) == kind


def test_parse_state_missing_fields():
    with pytest.raises(CliFailure) as info:
        _cli.parse_state({"ok": True, "elements": []})
    assert info.value.kind == _cli.CLI_FAILED


def test_parse_element_missing_index():
    with pytest.raises(CliFailure):
        _cli.parse_element({"role": "AXButton"})


class Recorder:
    def __init__(self, result=None, exc=None):
        self.calls = []
        self.result = result
        self.exc = exc

    def __call__(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        if self.exc:
            raise self.exc
        return self.result


def test_runner_passes_argv_without_shell_and_with_timeout():
    rec = Recorder(subprocess.CompletedProcess([], 0, '{"ok": true, "route": "event.key"}', ""))
    runner = CliRunner("/bin/2ndscreen", runner=rec)
    outcome = runner.run(["key", "--screen", "s", "--pid", 1, "--key", "return"])
    argv, kwargs = rec.calls[0]
    assert argv == ["/bin/2ndscreen", "key", "--screen", "s", "--pid", "1", "--key", "return"]
    assert kwargs["shell"] is False and kwargs["timeout"] == _cli.DEFAULT_ACTION_TIMEOUT
    assert outcome.payload["route"] == "event.key"


def test_runner_state_timeout_and_override():
    rec = Recorder(subprocess.CompletedProcess([], 0, '{"ok": true}', ""))
    runner = CliRunner("cli", runner=rec)
    runner.run(["state"])
    runner.run(["state"], timeout=3)
    assert [c[1]["timeout"] for c in rec.calls] == [30.0, 3]


def test_runner_timeout_is_classified():
    rec = Recorder(exc=subprocess.TimeoutExpired(["cli"], 5, stderr=b"partial"))
    with pytest.raises(CliFailure) as info:
        CliRunner("cli", runner=rec).run(["state"], timeout=5)
    assert info.value.kind == _cli.TIMEOUT
    assert info.value.stderr == "partial"


def test_runner_missing_binary(tmp_path):
    with pytest.raises(CliFailure) as info:
        CliRunner(str(tmp_path / "missing")).run(["screen", "list"])
    assert info.value.kind == _cli.CLI_FAILED


def test_runner_real_subprocess_timeout(tmp_path):
    # 用一个真实的慢脚本确认超时会终止子进程而不是等它结束。
    script = tmp_path / "slow.sh"
    script.write_text("#!/bin/sh\nsleep 5\n")
    script.chmod(0o755)
    with pytest.raises(CliFailure) as info:
        CliRunner(str(script)).run(["state"], timeout=0.2)
    assert info.value.kind == _cli.TIMEOUT


def test_runner_real_subprocess_argument_with_shell_metacharacters(tmp_path):
    # 参数原样传给 CLI，不经 shell 解释。
    script = tmp_path / "echo.sh"
    script.write_text('#!/bin/sh\nprintf \'{"ok": true, "arg": "%s"}\' "$2"\n')
    script.chmod(0o755)
    outcome = CliRunner(str(script)).run(["type", "$(echo hi); rm -rf x"])
    assert outcome.payload["arg"] == "$(echo hi); rm -rf x"
