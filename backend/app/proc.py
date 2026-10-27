"""进程存活判断（Windows 上没有 psutil 时的最小实现）。"""

from __future__ import annotations

import ctypes
import os
import sys


def pid_alive(pid: int | str | None) -> bool:
    """判断进程是否存活。

    注意：Windows 上不能写 os.kill(pid, 0) —— 那会真的把进程杀掉。
    """
    try:
        n = int(pid)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return False
    if n <= 0:
        return False
    if sys.platform == "win32":
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, n)
        if not handle:
            return False
        kernel32.CloseHandle(handle)
        return True
    try:
        os.kill(n, 0)
        return True
    except OSError:
        return False
