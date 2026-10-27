"""容器 API 与 Windows 宿主控制代理之间的客户端。

远程模式只改传输层：桥接命令、Chrome 启停和监听启停仍由宿主机上的原实现执行。
im.db 不由容器直接挂载；代理生成 SQLite 快照，容器读取稳定副本，避免跨 Windows/Linux
bind mount 使用 WAL 数据库。
"""

from __future__ import annotations

import asyncio
import os
import sqlite3
import time
from pathlib import Path
from typing import Any

import httpx

from . import config


class HostAgentError(RuntimeError):
    pass


class HostAgentClient:
    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None
        self._status: dict[str, Any] = {}
        self._last_error = ""
        self._last_status_at = 0.0
        self._last_snapshot_at = 0.0
        self._snapshot_etag = ""
        self._tasks: list[asyncio.Task] = []
        self._snapshot_lock = asyncio.Lock()

    @property
    def enabled(self) -> bool:
        return config.HOST_AGENT_REMOTE

    def _http(self) -> httpx.AsyncClient:
        if not self.enabled:
            raise HostAgentError("当前不是宿主代理远程模式")
        if not config.HOST_AGENT_TOKEN:
            raise HostAgentError("HOST_AGENT_TOKEN 未配置")
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=config.HOST_AGENT_URL,
                timeout=config.HOST_AGENT_TIMEOUT,
                headers={"X-AIS-Agent-Token": config.HOST_AGENT_TOKEN},
            )
        return self._client

    async def _request(self, method: str, path: str, *,
                       json: dict | None = None, timeout: float | None = None) -> Any:
        try:
            resp = await self._http().request(
                method, path, json=json,
                timeout=timeout or config.HOST_AGENT_TIMEOUT,
            )
            resp.raise_for_status()
            data = resp.json()
        except HostAgentError:
            raise
        except httpx.HTTPStatusError as exc:
            detail = ""
            try:
                detail = (exc.response.json() or {}).get("detail") or ""
            except Exception:  # noqa: BLE001
                detail = exc.response.text[:300]
            raise HostAgentError(f"宿主代理 HTTP {exc.response.status_code}：{detail}") from exc
        except (httpx.HTTPError, ValueError) as exc:
            raise HostAgentError(f"宿主代理不可用：{exc}") from exc
        self._last_error = ""
        return data

    async def ping(self) -> dict:
        data = await self._request("GET", "/health", timeout=5.0)
        return data

    async def start(self) -> None:
        if not self.enabled:
            return
        await self.ping()

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self._tasks.clear()
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def rpc(self, cmd: str, args: dict | None = None,
                  timeout: float | None = None) -> Any:
        data = await self._request(
            "POST", "/rpc",
            json={"cmd": cmd, "args": args or {}},
            timeout=float(timeout or config.BRIDGE_TIMEOUT),
        )
        return data.get("data")

    async def browser_action(self, action: str, *, chrome_path: str | None = None,
                             force: bool = False) -> dict:
        data = await self._request("POST", "/browser", json={
            "action": action,
            "chrome_path": chrome_path,
            "force": bool(force),
        }, timeout=120.0)
        return data.get("result") or {}

    async def monitor_action(self, action: str, *, interval_ms: int | None = None,
                             refresh_min: int | None = None) -> dict:
        data = await self._request("POST", "/monitor", json={
            "action": action,
            "interval_ms": interval_ms,
            "refresh_min": refresh_min,
        }, timeout=90.0)
        if isinstance(data.get("monitor"), dict):
            current = dict(self._status)
            current["monitor"] = data["monitor"]
            current["at"] = int(time.time() * 1000)
            self._status = current
        return data.get("result") or {}

    async def portal_exchange(self, code: str) -> dict:
        return await self._request(
            "POST", "/portal/exchange",
            json={"code": code},
            timeout=15.0,
        )

    async def refresh_status(self) -> dict:
        data = await self._request("GET", "/status", timeout=10.0)
        self._status = data if isinstance(data, dict) else {}
        self._last_status_at = time.time()
        return self._status

    def cached_monitor(self) -> dict:
        data = self._status.get("monitor")
        if isinstance(data, dict):
            return {**data, "via": "host-agent"}
        return {
            "pid": None,
            "alive": False,
            "pid_file": "",
            "log_file": "",
            "log_tail": [],
            "interval_sec": config.MONITOR_INTERVAL_SEC,
            "refresh_min": config.MONITOR_REFRESH_MIN,
            "error": self._last_error or "宿主代理状态尚未同步",
            "via": "host-agent",
        }

    def cached_bridge(self) -> dict:
        data = self._status.get("bridge")
        if isinstance(data, dict):
            return {**data, "via": "host-agent"}
        return {
            "running": False,
            "pid": None,
            "script": "",
            "script_exists": False,
            "uptime_sec": 0,
            "restarts": 0,
            "calls": 0,
            "pending": 0,
            "last_error": self._last_error or "宿主代理状态尚未同步",
            "stderr_tail": [],
            "via": "host-agent",
        }

    async def refresh_snapshot(self, required: bool = False) -> Path:
        """下载并原子替换 im.db 快照。调用方只能看到完整的数据库文件。"""
        if not self.enabled:
            return config.IM_DB
        async with self._snapshot_lock:
            config.IM_DB.parent.mkdir(parents=True, exist_ok=True)
            tmp = config.IM_DB.with_name(f"{config.IM_DB.name}.{os.getpid()}.download")
            try:
                async with self._http().stream(
                    "GET", "/db/snapshot",
                    headers={"If-None-Match": self._snapshot_etag} if (
                        self._snapshot_etag and config.IM_DB.exists()
                    ) else None,
                    timeout=httpx.Timeout(60.0, connect=10.0),
                ) as resp:
                    if resp.status_code == 304 and config.IM_DB.exists():
                        self._last_snapshot_at = time.time()
                        return config.IM_DB
                    resp.raise_for_status()
                    etag = resp.headers.get("etag") or ""
                    with tmp.open("wb") as fh:
                        async for chunk in resp.aiter_bytes(256 * 1024):
                            if chunk:
                                fh.write(chunk)
                if not tmp.exists() or tmp.stat().st_size <= 0:
                    raise HostAgentError("宿主代理返回了空数据库快照")
                conn = sqlite3.connect(str(tmp), timeout=5)
                try:
                    conn.execute("PRAGMA query_only=ON")
                    check = conn.execute("PRAGMA quick_check").fetchone()
                    if not check or str(check[0]).lower() != "ok":
                        raise HostAgentError(f"数据库快照校验失败：{check}")
                finally:
                    conn.close()
                os.replace(tmp, config.IM_DB)
                self._snapshot_etag = etag
                self._last_snapshot_at = time.time()
                return config.IM_DB
            except HostAgentError:
                raise
            except httpx.HTTPStatusError as exc:
                raise HostAgentError(f"下载数据库快照失败：HTTP {exc.response.status_code}") from exc
            except (httpx.HTTPError, sqlite3.Error, OSError) as exc:
                self._last_error = str(exc)
                if required:
                    raise HostAgentError(f"获取数据库快照失败：{exc}") from exc
                return config.IM_DB
            finally:
                try:
                    tmp.unlink(missing_ok=True)
                except OSError:
                    pass

    async def _status_loop(self) -> None:
        while True:
            try:
                await self.refresh_status()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                self._last_error = str(exc)
            await asyncio.sleep(config.HOST_AGENT_STATUS_INTERVAL_SEC)

    async def _snapshot_loop(self) -> None:
        while True:
            try:
                await self.refresh_snapshot()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                self._last_error = str(exc)
            await asyncio.sleep(config.HOST_AGENT_SNAPSHOT_INTERVAL_SEC)

    def start_background(self) -> None:
        if not self.enabled or self._tasks:
            return
        self._tasks = [
            asyncio.create_task(self._status_loop(), name="host-agent-status"),
            asyncio.create_task(self._snapshot_loop(), name="host-agent-snapshot"),
        ]


host_agent = HostAgentClient()
