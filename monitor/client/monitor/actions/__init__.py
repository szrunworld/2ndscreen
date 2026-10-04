"""动作处理器（契约 ActionHandler）。

`python -m monitor` 默认按 `monitor.actions:create_handlers` 装配（见 monitor/__main__.py）。

本包注册 send_greeting（greeting.py）与 request_resume（request_resume.py）。其余动作的注册点：
在本包内新增 EXTENSION_MODULES 中列出的模块，并在模块里提供
``create_handlers(*, clock) -> Iterable[ActionHandler]``，create_handlers() 会自动装上，不必改本文件：

- search.py            → search_candidates（任务 H2）
- contact_exchange.py  → request_contact_exchange（任务 H3）

模块不存在时跳过；模块存在但导入失败（包括它自己缺依赖）照常抛错，不静默吞掉。
"""

from __future__ import annotations

import importlib

from monitor_contracts import ActionHandler

from monitor.core.clock import Clock, SystemClock

from .greeting import SendGreetingHandler
from .request_resume import RequestResumeHandler

EXTENSION_MODULES: tuple[str, ...] = ("search", "contact_exchange")

__all__ = ["EXTENSION_MODULES", "RequestResumeHandler", "SendGreetingHandler", "create_handlers"]


def _load_extension(name: str, clock: Clock) -> list[ActionHandler]:
    full = f"{__name__}.{name}"
    try:
        module = importlib.import_module(full)
    except ModuleNotFoundError as exc:
        if exc.name == full:
            return []
        raise
    return list(module.create_handlers(clock=clock))


def create_handlers(*, clock: Clock | None = None) -> list[ActionHandler]:
    """返回全部动作处理器。同一 action 注册两次视为装配错误。

    clock 供结果等待轮询使用（now / sleep），缺省为系统时钟；测试注入 ManualClock。
    """
    clock = clock or SystemClock()
    handlers: list[ActionHandler] = [SendGreetingHandler(clock=clock), RequestResumeHandler(clock=clock)]
    for name in EXTENSION_MODULES:
        handlers.extend(_load_extension(name, clock))
    seen: set[str] = set()
    for handler in handlers:
        if handler.action in seen:
            raise ValueError(f"动作 {handler.action} 重复注册")
        seen.add(handler.action)
    return handlers
