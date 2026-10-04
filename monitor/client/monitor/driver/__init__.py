"""Driver 适配器：Monitor 唯一接触 GUI 的层（2ndscreen CLI 与夹具回放）。

- CliDriver：契约 Driver 的 2ndscreen CLI 实现（cli_driver.py）
- FakeDriver：按 ax 夹具回放（fake.py）
- find_one / find_all：定位器（locator.py）
- FixtureRecorder：录制模式，把 state 脱敏写成夹具（record.py）
- redact_text：脱敏（redact.py）

公共类型（Driver、Snapshot、Element、Locator、错误类型）一律从 monitor_contracts 导入。
"""

from .cli_driver import CliDriver
from .fake import Advance, Call, FakeDriver, load_fixture
from .locator import find_all, find_one
from .record import FixtureRecorder
from .redact import redact_text

__all__ = [
    "Advance",
    "Call",
    "CliDriver",
    "FakeDriver",
    "FixtureRecorder",
    "find_all",
    "find_one",
    "load_fixture",
    "redact_text",
]
