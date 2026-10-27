"""常驻消息监听的启停。

两个坑都是 2026-10-15 实测踩出来的：

1. **不能用冻结的 `tools/qianniu/start-im.ps1`**：里面有中文字面量且没有 UTF-8 BOM，
   而 `powershell.exe`（5.1）按系统 ANSI 代码页（本机 936）读 .ps1 —— 中文读坏后
   整脚本**解析失败**，于是"停止监听"什么都没做、接口却报成功。冻结源码不能改，
   所以改用我们自己的 `deploy/monitor-control.ps1`（纯 ASCII，行为对齐）。

2. **启动不能由 PowerShell 去 `Start-Process`**：那样起来的 node 会**继承 PowerShell 的
   stdout 管道**，于是 Python 侧 `communicate()` 等不到 EOF，接口一直挂到超时
   （监听其实已经起来了）。所以 `start()` 由 Python 自己拉起 node —— 句柄继承可控；
   `stop()`/`status()` 不产生长命子进程，继续用那个 ASCII 脚本。
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import sys

from . import config
from .chromectl import _parse_json as parse_ps_json
from .proc import pid_alive


def _node_bin() -> str:
    return shutil.which(config.NODE_BIN) or config.NODE_BIN


def _monitor_pid() -> int | None:
    if not config.MONITOR_PID_FILE.exists():
        return None
    try:
        return int(config.MONITOR_PID_FILE.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None


def _tail(path, n: int = 6) -> list[str]:
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    return lines[-n:]


async def start(interval_ms: int, refresh_min: int = 0) -> dict:
    """拉起常驻监听（等价于 start-im.ps1 里监听那一段，但不经由 PowerShell）。"""
    if config.HOST_AGENT_REMOTE:
        from .hostcontrol import HostAgentError, host_agent

        try:
            return await host_agent.monitor_action(
                "start", interval_ms=int(interval_ms), refresh_min=int(refresh_min),
            )
        except HostAgentError as exc:
            return {"ok": False, "action": "start", "error": str(exc)}
    if sys.platform != "win32":
        return {"ok": False, "action": "start", "error": "监听启停目前只支持 Windows"}
    pid = _monitor_pid()
    if pid and pid_alive(pid):
        return {"ok": True, "action": "start", "pid": pid, "alive": True,
                "note": "already running, start skipped"}

    im_mjs = config.QIANNIU_DIR / "im.mjs"
    if not im_mjs.exists():
        return {"ok": False, "action": "start", "error": f"找不到 {im_mjs}"}
    node = _node_bin()
    args = [node, str(im_mjs), "monitor", "--interval", str(int(interval_ms))]
    if int(refresh_min) > 0:
        args += ["--refresh-min", str(int(refresh_min))]
    env = {**os.environ, "CDP_BASE": config.CDP_BASE}

    config.MONITOR_OUT_LOG.parent.mkdir(parents=True, exist_ok=True)
    flags = 0
    if hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
        flags |= subprocess.CREATE_NEW_PROCESS_GROUP
    if hasattr(subprocess, "DETACHED_PROCESS"):
        flags |= subprocess.DETACHED_PROCESS        # 不挂控制台窗口，API 退出后也活着
    try:
        # 覆盖写：与 start-im.ps1 的 Start-Process -RedirectStandardOutput 行为一致
        out = open(config.MONITOR_OUT_LOG, "wb")
        err = open(config.MONITOR_ERR_LOG, "wb")
        try:
            proc = await asyncio.create_subprocess_exec(
                *args, cwd=str(config.QIANNIU_DIR), env=env,
                stdin=asyncio.subprocess.DEVNULL, stdout=out, stderr=err,
                creationflags=flags,
            )
        finally:
            # 子进程已经拿到自己的句柄，父进程这边可以关掉
            out.close()
            err.close()
    except OSError as exc:
        return {"ok": False, "action": "start", "error": f"拉起 node 失败：{exc}"}

    try:
        config.MONITOR_PID_FILE.write_text(str(proc.pid), encoding="ascii")
    except OSError as exc:
        return {"ok": False, "action": "start", "error": f"写 pid 文件失败：{exc}"}

    await asyncio.sleep(4)
    alive = pid_alive(proc.pid)
    result = {
        "ok": bool(alive), "action": "start", "pid": proc.pid, "alive": bool(alive),
        "intervalMs": int(interval_ms), "refreshMin": int(refresh_min),
        "cdpBase": config.CDP_BASE, "outLog": str(config.MONITOR_OUT_LOG),
        "tail": _tail(config.MONITOR_OUT_LOG),
        "error": None if alive else f"监听进程 4 秒内退出了，见 {config.MONITOR_ERR_LOG}",
    }
    if not alive:
        result["stderr_tail"] = "\n".join(_tail(config.MONITOR_ERR_LOG))
    return result


async def _ps_action(action: str, timeout: float = 40.0) -> dict:
    """跑一次 monitor-control.ps1 的 stop/status（这两个不会产生长命子进程）。

    start 特意不走这里：脚本里 Start-Process 起的 node 会继承 PowerShell 的 stdout
    管道，Python 等不到 EOF 会一直挂到超时（见文件头注释第 2 条）。
    """
    if config.HOST_AGENT_REMOTE:
        from .hostcontrol import HostAgentError, host_agent

        try:
            return await host_agent.monitor_action(action)
        except HostAgentError as exc:
            return {"ok": False, "action": action, "error": str(exc)}
    if sys.platform != "win32":
        return {"ok": False, "action": action, "error": "监听启停目前只支持 Windows"}
    script = config.MONITOR_CONTROL_SCRIPT
    if not script.exists():
        return {"ok": False, "action": action, "error": f"控制脚本不存在：{script}"}
    cmd = [
        "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", str(script), "-Action", action,
        "-QianniuDir", str(config.QIANNIU_DIR),
        "-CdpBase", config.CDP_BASE,
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        return {"ok": False, "action": action, "error": f"监听控制脚本超时（{timeout:.0f}s）"}
    except FileNotFoundError:
        return {"ok": False, "action": action, "error": "找不到 powershell.exe"}
    try:
        data = parse_ps_json(out.decode("utf-8", "replace"))
    except RuntimeError as exc:
        return {"ok": False, "action": action, "error": str(exc),
                "stderr_tail": err.decode("utf-8", "replace")[-400:]}
    if err:
        data["stderr_tail"] = err.decode("utf-8", "replace")[-400:]
    return data


async def stop() -> dict:
    return await _ps_action("stop")


async def status() -> dict:
    return await _ps_action("status")
