"""CliDriver 测试：用 cli-samples 的真实输出作子进程替身，不调用真实 CLI。"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from monitor_contracts import (
    CliFailedError,
    Driver,
    DriverError,
    DriverTimeoutError,
    Frame,
    Locator,
    ScreenLostError,
    StaleSnapshotError,
    TargetAmbiguousError,
    TargetNotFoundError,
    WindowLostError,
    WindowSelector,
)

from monitor.driver import _cli
from monitor.driver.cli_driver import ENABLED_UNKNOWN, CliDriver, parse_tree, split_keys
from monitor.driver.fake import solid_png

SAMPLES = Path(__file__).resolve().parents[2] / "fixtures" / "cli-samples"


def sample(name: str) -> dict:
    return json.loads((SAMPLES / f"{name}.json").read_text())


class SampleRunner:
    """按顺序回放样例的 subprocess.run 替身；记录每次 argv。"""

    def __init__(self, *responses):
        self.queue = list(responses)
        self.argv: list[list[str]] = []

    def push(self, *responses):
        self.queue.extend(responses)

    def __call__(self, argv, **kwargs):
        assert kwargs["shell"] is False and kwargs["timeout"] > 0
        self.argv.append(argv)
        item = self.queue.pop(0)
        if isinstance(item, BaseException):
            raise item
        if callable(item):
            item = item(argv)
        if isinstance(item, str):
            item = sample(item)
        out = json.dumps(item["stdout"], ensure_ascii=False) if item.get("stdout") is not None else ""
        return subprocess.CompletedProcess(argv, item["exit_code"], out, item.get("stderr", ""))

    def verbs(self):
        return [a[1] for a in self.argv]


def make(*responses, **kwargs) -> tuple[CliDriver, SampleRunner]:
    runner = SampleRunner(*responses)
    driver = CliDriver("monitor-c", runner=_cli.CliRunner("2ndscreen", runner=runner), **kwargs)
    return driver, runner


def bound(*responses, **kwargs) -> tuple[CliDriver, SampleRunner]:
    driver, runner = make("state_textedit", *responses, **kwargs)
    driver.bind_window(WindowSelector(pid=52468))
    return driver, runner


def test_conforms_to_protocol():
    driver, _ = make()
    assert isinstance(driver, Driver)


# ---- bind_window ----


def test_bind_by_pid():
    driver, runner = make("state_textedit")
    window = driver.bind_window(WindowSelector(pid=52468))
    assert (window.pid, window.window_id, window.title, window.app_name) == (52468, 131479, "Untitled 2", "TextEdit")
    assert runner.argv[0][1:] == ["state", "--screen", "monitor-c", "--pid", "52468"]


def test_bind_skips_pids_without_window_on_screen():
    driver, runner = make("state_bad_pid", "state_textedit", pid_resolver=lambda s: [999999, 52468])
    assert driver.bind_window(WindowSelector(bundle_id="com.apple.TextEdit")).pid == 52468
    assert len(runner.argv) == 2


def test_bind_filters_by_title_and_app():
    driver, _ = make("state_textedit", pid_resolver=lambda s: [52468])
    with pytest.raises(WindowLostError):
        driver.bind_window(WindowSelector(app_name="TextEdit", title_contains="Report"))
    driver, _ = make("state_textedit", pid_resolver=lambda s: [52468])
    with pytest.raises(WindowLostError):
        driver.bind_window(WindowSelector(app_name="Calculator"))


def test_bind_nothing_found():
    driver, _ = make("state_window_lost", pid_resolver=lambda s: [59225])
    with pytest.raises(WindowLostError):
        driver.bind_window(WindowSelector(app_name="Calculator"))
    driver, _ = make(pid_resolver=lambda s: [])
    with pytest.raises(WindowLostError):
        driver.bind_window(WindowSelector(app_name="Calculator"))


def test_bind_screen_lost_propagates():
    driver, _ = make("state_no_screen")
    with pytest.raises(ScreenLostError):
        driver.bind_window(WindowSelector(pid=52468))


def test_bind_ambiguous_windows():
    driver, _ = make("state_textedit", "state_calc", pid_resolver=lambda s: [52468, 59225])
    with pytest.raises(DriverError, match="多个窗口"):
        driver.bind_window(WindowSelector(title_contains=""))


def test_bind_without_selector_uses_default_or_fails():
    driver, _ = make("state_textedit", default_selector=WindowSelector(pid=52468))
    assert driver.bind_window().window_id == 131479
    driver, _ = make()
    with pytest.raises(WindowLostError):
        driver.bind_window()


# ---- state ----


def test_state_requires_binding():
    driver, runner = make()
    with pytest.raises(WindowLostError):
        driver.state()
    assert runner.argv == []


def test_state_snapshot():
    driver, runner = bound("state_textedit")
    snap = driver.state()
    assert runner.argv[-1][1:] == ["state", "--screen", "monitor-c", "--pid", "52468", "--window-id", "131479"]
    assert len(snap.elements) == 30
    bold = snap.elements[13]
    assert (bold.role, bold.label, bold.value) == ("AXCheckBox/AXSegment", "bold", "0")
    assert bold.frame == Frame(x=5166, y=57, w=22, h=21)
    assert bold.snapshot_id == snap.snapshot_id
    assert bold.enabled is ENABLED_UNKNOWN
    assert bold.parent_index is None and bold.depth is None
    assert snap.window is not None and snap.window.title == "Untitled 2"


def test_state_include_tree():
    driver, _ = bound("state_textedit")
    snap = driver.state(include_tree=True)
    assert (snap.elements[13].parent_index, snap.elements[13].depth) == (12, 3)
    assert (snap.elements[0].parent_index, snap.elements[0].depth) == (None, 0)
    assert snap.elements[1].parent_index == 0


def test_state_with_query_output_is_rejected():
    # --query 的输出编号不连续，不能当快照用（CliDriver 从不加 --query）。
    driver, _ = bound("state_query")
    with pytest.raises(CliFailedError, match="不连续"):
        driver.state()


def test_parse_tree_skips_unindexed_ancestors():
    tree = '- [0] AXWindow "W"\n  - AXGroup\n    - [1] AXButton "OK"\n  - [2] AXButton "X"'
    assert parse_tree(tree) == {0: (None, 0), 1: (0, 2), 2: (0, 1)}


# ---- 写方法：目标与过期 ----


def test_click_element_verifies_then_clicks_by_index():
    driver, runner = bound("state_textedit", "state_textedit", "click_text_ok")
    snap = driver.state()
    receipt = driver.click(snap.elements[13])
    assert runner.verbs()[-3:] == ["state", "state", "click"]
    assert runner.argv[-1][-2:] == ["--index", "13"]
    assert "--window-id" in runner.argv[-1]
    assert (receipt.op, receipt.method, receipt.detail) == ("click", "ax_press", "route=ax.press")
    assert receipt.element == snap.elements[13] and receipt.snapshot_id == snap.snapshot_id


def test_click_without_verification():
    driver, runner = bound("state_textedit", "click_text_ok", verify_before_write=False)
    driver.click(driver.state().elements[13])
    assert runner.verbs()[-2:] == ["state", "click"]


def test_click_element_from_older_snapshot_is_stale():
    driver, runner = bound("state_textedit", "state_textedit")
    old = driver.state().elements[13]
    driver.state()
    calls = len(runner.argv)
    with pytest.raises(StaleSnapshotError):
        driver.click(old)
    assert len(runner.argv) == calls  # 没有调用 CLI


def test_click_element_without_snapshot_id_is_stale():
    driver, _ = bound("state_textedit")
    element = driver.state().elements[13].model_copy(update={"snapshot_id": None})
    with pytest.raises(StaleSnapshotError):
        driver.click(element)


def test_click_when_ui_changed_is_stale_and_not_delivered():
    driver, runner = bound("state_textedit", "state_calc")
    element = driver.state().elements[13]
    with pytest.raises(StaleSnapshotError, match="界面已变化"):
        driver.click(element)
    assert "click" not in runner.verbs()


def test_click_delivered_to_other_element_reports_stale():
    def wrong(argv):
        out = sample("click_text_ok")
        out["stdout"]["element"] = sample("click_index_ok")["stdout"]["element"]
        return out

    driver, _ = bound("state_textedit", "state_textedit", wrong)
    with pytest.raises(StaleSnapshotError) as info:
        driver.click(driver.state().elements[13])
    assert info.value.delivered is True


def test_click_locator_resolves_in_fresh_snapshot():
    driver, runner = bound("state_textedit", "click_text_ok")
    receipt = driver.click(Locator(text="bold"))
    assert runner.verbs()[-2:] == ["state", "click"]
    assert runner.argv[-1][-2:] == ["--index", "13"]
    assert receipt.element.label == "bold"


@pytest.mark.parametrize(
    "locator,error",
    [(Locator(role="AXButton"), TargetAmbiguousError), (Locator(text="Send"), TargetNotFoundError)],
)
def test_click_locator_errors_do_not_click(locator, error):
    driver, runner = bound("state_textedit")
    with pytest.raises(error):
        driver.click(locator)
    assert "click" not in runner.verbs()


def test_click_event_mode_uses_center_point():
    driver, runner = bound("state_textedit", "state_textedit", "click_xy_ok")
    receipt = driver.click(driver.state().elements[13], mode="event")
    assert runner.argv[-1][-4:] == ["--x", "5177", "--y", "67.5"]
    assert receipt.method == "event"


def test_click_ax_press_mode_requires_press_action():
    driver, runner = bound("state_textedit", "state_textedit")
    area = driver.state().elements[1]  # AXTextArea 只有 AXShowMenu
    with pytest.raises(CliFailedError, match="AXPress"):
        driver.click(area, mode="ax_press")
    assert "click" not in runner.verbs()


def test_type_text_to_focus_and_to_element():
    driver, runner = bound("type_index_ok")
    receipt = driver.type_text(None, "你好 $(x)")
    assert runner.argv[-1][-2:] == ["--value", "你好 $(x)"] and "--index" not in runner.argv[-1]
    assert receipt.element is None
    runner.push("state_textedit", "state_textedit", "type_index_ok")
    area = driver.state().elements[1]
    receipt = driver.type_text(area, "abc")
    assert runner.argv[-1][-4:] == ["--index", "1", "--value", "abc"]
    assert receipt.method == "ax_insert"


@pytest.mark.parametrize(
    "keys,tail",
    [
        ("return", ["--key", "return"]),
        ("cmd+a", ["--key", "a", "--modifiers", "cmd"]),
        (["cmd", "shift", "v"], ["--key", "v", "--modifiers", "cmd,shift"]),
    ],
)
def test_key(keys, tail):
    driver, runner = bound("key_mod_ok")
    receipt = driver.key(keys)
    assert runner.argv[-1][-len(tail) :] == tail
    assert receipt.method == "keystroke" and receipt.element is None


def test_split_keys_empty():
    with pytest.raises(CliFailedError):
        split_keys(" + ")


def test_scroll_window_and_element():
    driver, runner = bound("scroll_ok")
    driver.scroll(None, "down", 3)
    assert runner.argv[-1][-4:] == ["--direction", "down", "--amount", "3"]
    runner.push("state_textedit", "state_textedit", "scroll_ok")
    receipt = driver.scroll(driver.state().elements[1], "up", 5)
    assert runner.argv[-1][-6:] == ["--direction", "up", "--amount", "5", "--index", "1"]
    assert receipt.method == "event"


# ---- 错误分类（每类一个失败路径） ----


@pytest.mark.parametrize(
    "name,error",
    [
        ("state_window_lost_wid", WindowLostError),
        ("state_no_screen", ScreenLostError),
        ("click_bad_index", StaleSnapshotError),
        ("click_text_missing", TargetNotFoundError),
        ("key_bad", CliFailedError),
        ("arg_missing_value", CliFailedError),
    ],
)
def test_cli_failures_map_to_contract_errors(name, error):
    driver, runner = bound(name)
    with pytest.raises(error):
        driver.key("return")
    assert len(runner.argv) == 2  # 不重试


def test_cli_exit_code_kept():
    driver, _ = bound("arg_missing_value")
    with pytest.raises(CliFailedError) as info:
        driver.key("return")
    assert info.value.returncode == 2 and "--pid needs a value" in info.value.stderr


def test_timeout_maps_to_driver_timeout():
    driver, runner = bound(subprocess.TimeoutExpired(["2ndscreen"], 20))
    with pytest.raises(DriverTimeoutError):
        driver.state()
    assert len(runner.argv) == 2


# ---- screen_ok ----


def test_screen_ok_true():
    driver, runner = bound("screen_list", "state_textedit")
    assert driver.screen_ok() is True and driver.last_problem is None
    assert runner.verbs()[-2:] == ["screen", "state"]


def test_screen_ok_false_when_screen_missing():
    runner = SampleRunner("screen_list")
    driver = CliDriver("monitor-gone", runner=_cli.CliRunner("2ndscreen", runner=runner))
    assert driver.screen_ok() is False and driver.last_problem.startswith("screen_lost")


def test_screen_ok_false_when_window_lost():
    driver, _ = bound("screen_list", "state_window_lost_wid")
    assert driver.screen_ok() is False and driver.last_problem.startswith("window_lost")


def test_screen_ok_false_on_timeout():
    driver, _ = bound(subprocess.TimeoutExpired(["2ndscreen"], 15))
    assert driver.screen_ok() is False and driver.last_problem.startswith("timeout")


# ---- screenshot_region ----


def _write_screen_png(argv):
    out = Path(argv[argv.index("--output") + 1])
    out.write_bytes(solid_png(2560, 1600))  # 1280x800 点的 HiDPI 屏
    return sample("screenshot_ok")


def test_screenshot_region_crop_math(tmp_path):
    tools = []

    def tool(argv):
        tools.append(list(argv))
        return "  pixelWidth: 2560\n  pixelHeight: 1600\n" if "-g" in argv else ""

    runner = SampleRunner("screen_list", _write_screen_png)
    driver = CliDriver("monitor-c", runner=_cli.CliRunner("2ndscreen", runner=runner), tool_runner=tool)
    out = driver.screenshot_region(Frame(x=4900, y=50, w=200, h=100), tmp_path / "qr.png")
    assert out == tmp_path / "qr.png"
    assert tools[-1][:6] == ["sips", "-c", "200", "400", "--cropOffset", "100"]
    assert tools[-1][6] == "200"


@pytest.mark.skipif(sys.platform != "darwin" or not shutil.which("sips"), reason="需要 macOS sips")
def test_screenshot_region_real_crop(tmp_path):
    runner = SampleRunner("screen_list", _write_screen_png)
    driver = CliDriver("monitor-c", runner=_cli.CliRunner("2ndscreen", runner=runner))
    out = driver.screenshot_region(Frame(x=4900, y=50, w=200, h=100), tmp_path / "qr.png")
    info = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", str(out)], capture_output=True, text=True)
    assert "pixelWidth: 400" in info.stdout and "pixelHeight: 200" in info.stdout


def test_screenshot_region_outside_screen(tmp_path):
    driver, runner = make("screen_list")
    with pytest.raises(DriverError, match="不在屏幕"):
        driver.screenshot_region(Frame(x=0, y=0, w=10, h=10), tmp_path / "x.png")
    assert runner.verbs() == ["screen"]


def test_screenshot_region_screen_lost(tmp_path):
    driver, _ = make("screen_list", "screenshot_no_screen")
    with pytest.raises(ScreenLostError):
        driver.screenshot_region(Frame(x=4900, y=50, w=10, h=10), tmp_path / "x.png")
