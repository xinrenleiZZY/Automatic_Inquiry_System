"""1688 调试实例（Chrome）的进程级控制。

为什么要单独做一层：`/api/system/health` 里的 `cdp` 只探**端口通不通**，
端口通不等于"浏览器还开着、而且是我们能操作的那个实例"。这里直接问操作系统
（deploy/browser-control.ps1 → Win32_Process 命令行），回答三件事：
    1. 调试实例的进程在不在、PID 多少、什么时候起的；
    2. 调试端口通不通；
    3. 能不能一键拉起 / 一键关掉。

安全边界：**只认命令行里带 --user-data-dir=<CHROME_PROFILE_DIR> 的 chrome.exe**，
所以用户日常用的那个 Chrome 永远不会被误伤。关浏览器优先走 CDP 的
`Browser.close`（bridge 的 browser.close 命令），进程匹配只作为端口不通时的兜底。
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from urllib.parse import urlparse

from . import config

_STATE_TTL = 15.0
_state_cache: dict = {"at": 0.0, "data": None}


def cdp_port() -> int:
    """从 CDP_BASE 解析调试端口（默认 6901）。"""
    try:
        return int(urlparse(config.CDP_BASE).port or 6901)
    except (TypeError, ValueError):
        return 6901


def effective_chrome_exe() -> tuple[str, str]:
    """chrome.exe 路径 → (路径, 来源)。

    来源（优先级从高到低）：
      setting —— 「状态监控」页面上保存的（存在 api.db 的 settings.chrome_exe）
      env     —— .env / 环境变量里的 CHROME_EXE
      ''      —— 都没配，交给脚本自动检测（Program Files / LOCALAPPDATA）
    """
    try:
        from . import store  # 延迟导入：store 会碰数据库，这里只想读一个键

        value = str(store.get_setting("chrome_exe") or "").strip().strip('"')
        if value:
            return value, "setting"
    except Exception:  # noqa: BLE001  —— 读不到设置不该影响体检
        pass
    value = str(config.CHROME_EXE or "").strip().strip('"')
    if value:
        return value, "env"
    return "", ""


def _parse_json(text: str) -> dict:
    """脚本只输出一行 JSON；PowerShell 5.1 偶尔会带 BOM，这里都容忍。"""
    s = text.replace("\ufeff", "").strip()
    for line in reversed(s.splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            data = json.loads(line)
            if isinstance(data, dict):
                return data
        except json.JSONDecodeError:
            continue
    try:
        data = json.loads(s[s.index("{"):])
        if isinstance(data, dict):
            return data
    except (ValueError, json.JSONDecodeError):
        pass
    raise RuntimeError(f"浏览器控制脚本没有输出合法 JSON：{s[-400:] or '(空)'}")


async def run_action(action: str, timeout: float = 45.0, chrome_path: str | None = None,
                     force: bool = False) -> dict:
    """跑一次 browser-control.ps1，返回它那行 JSON。任何失败都转成 ok=False。

    chrome_path 传 None = 用当前生效的配置；传字符串 = 用这个路径（保存前验证用）。
    force = 启动时不管端口是否健康，先把占用者/残留实例清掉再拉起一个干净的。
    """
    if config.HOST_AGENT_REMOTE:
        from .hostcontrol import HostAgentError, host_agent

        try:
            path = effective_chrome_exe()[0] if chrome_path is None else chrome_path
            return await host_agent.browser_action(action, chrome_path=path, force=force)
        except HostAgentError as exc:
            return {"ok": False, "action": action, "error": str(exc)}
    if sys.platform != "win32":
        return {"ok": False, "action": action,
                "error": "浏览器启停目前只支持 Windows（调试实例跑在宿主机上）"}
    script = config.BROWSER_CONTROL_SCRIPT
    if not script.exists():
        return {"ok": False, "action": action, "error": f"控制脚本不存在：{script}"}
    path = effective_chrome_exe()[0] if chrome_path is None else chrome_path
    cmd = [
        "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", str(script), "-Action", action,
        "-CdpPort", str(cdp_port()),
        "-ProfileDir", str(config.CHROME_PROFILE_DIR),
        "-Url", config.BROWSER_START_URL,
        "-ChromePath", path,
    ]
    if force:
        cmd.append("-Force")
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        return {"ok": False, "action": action, "error": f"浏览器控制脚本超时（{timeout:.0f}s）"}
    except FileNotFoundError:
        return {"ok": False, "action": action, "error": "找不到 powershell.exe"}
    text = out.decode("utf-8", "replace")
    try:
        data = _parse_json(text)
    except RuntimeError as exc:
        return {"ok": False, "action": action, "error": str(exc),
                "stderr_tail": err.decode("utf-8", "replace")[-400:]}
    if err:
        data["stderr_tail"] = err.decode("utf-8", "replace")[-400:]
    return data


async def state(ttl: float = _STATE_TTL, refresh: bool = False) -> dict:
    """进程级状态（带缓存：仪表盘每 5 秒问一次，没必要次次枚举进程）。"""
    now = time.time()
    cached = _state_cache.get("data")
    if not refresh and isinstance(cached, dict) and now - float(_state_cache.get("at") or 0) < ttl:
        return cached
    data = await run_action("status", timeout=25.0)
    _state_cache["at"] = now
    _state_cache["data"] = data
    return data


def invalidate() -> None:
    _state_cache["at"] = 0.0
    _state_cache["data"] = None


SOURCE_CN = {"setting": "页面设置", "env": "环境变量 CHROME_EXE", "auto": "自动检测", "": "自动检测"}


async def chrome_info(refresh: bool = False, state_data: dict | None = None) -> dict:
    """给「状态监控」页用的 Chrome 路径信息（配置值 + 解析结果 + 候选）。

    复用带缓存的 state()：页面每 6 秒轮询一次，不该每次都去枚举一遍磁盘与进程。
    """
    configured, source = effective_chrome_exe()
    data = state_data if isinstance(state_data, dict) else await state(refresh=refresh)
    resolved = str(data.get("chromePath") or "")
    candidates = [str(c) for c in (data.get("chromeCandidates") or []) if c]
    return {
        "configured": configured,
        "source": source or "auto",
        "source_cn": SOURCE_CN.get(source or "auto", "自动检测"),
        "resolved": resolved,
        "exists": bool(resolved),
        "resolved_is_custom": bool(data.get("chromePathIsCustom")),
        "candidates": candidates,
        "profile_dir": str(config.CHROME_PROFILE_DIR),
        "env_value": config.CHROME_EXE or "",
        "error": data.get("error"),
    }


async def start(force: bool = False) -> dict:
    data = await run_action("start", timeout=90.0, force=force)
    invalidate()
    return data


async def verify_chrome_path(path: str = "") -> dict:
    """按“拉起浏览器时用的同一套判定”检查路径（PowerShell Test-Path）。

    为什么不用 Python 的 os.path.isfile：两边在受限环境/虚拟化目录下可能给出不同答案，
    一旦不一致就会出现"保存时说能找到、点了启动又说找不到"这种最让人困惑的状态。
    """
    data = await run_action("checkpath", timeout=25.0, chrome_path=path)
    return {
        "ok": bool(data.get("ok")),
        "resolved": str(data.get("chromePath") or ""),
        "exists": bool(data.get("chromePathExists")),
        "candidates": [str(c) for c in (data.get("chromeCandidates") or []) if c],
        "error": data.get("error"),
    }


async def stop_processes() -> dict:
    """兜底：CDP 不通时按进程命令行关掉调试实例。"""
    data = await run_action("stop", timeout=45.0)
    invalidate()
    return data
