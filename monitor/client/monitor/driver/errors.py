"""Driver 错误类型的临时占位。

第 1 阶段：契约尚未提交，定位器先用这里的私有类。协调者已裁决由任务 A 在契约里增加
TargetAmbiguousError / TargetNotFoundError（继承 DriverError）；A 提交后本模块改为
从 monitor_contracts 导入并删除这些类。
"""

from __future__ import annotations


class _TargetAmbiguous(Exception):
    pass


class _TargetNotFound(Exception):
    pass


TargetAmbiguousError = _TargetAmbiguous
TargetNotFoundError = _TargetNotFound
