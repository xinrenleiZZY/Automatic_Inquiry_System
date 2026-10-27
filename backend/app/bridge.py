"""Node 桥接客户端。

常驻一个 `node tools/api/bridge.mjs` 子进程，用 JSON-line 协议（stdio）通信：
    请求  {"id": 1, "cmd": "campaign.list", "args": {"limit": 20}}
    响应  {"id": 1, "ok": true, "data": {...}, "error": null, "elapsed_ms": 12}

桥接脚本只是 `import blocks/index.mjs` 的薄壳，不改动冻结源码。
"""

import asyncio
import json
import shutil
import time
from collections import deque
from typing import Any

from . import config, store


class BridgeError(RuntimeError):
    pass


class NodeBridge:
    def __init__(self) -> None:
        self._proc: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()
        self._seq = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._stdout_task: asyncio.Task | None = None
        self._stderr_task: asyncio.Task | None = None
        self._stderr_buf: deque[str] = deque(maxlen=300)
        self._started_at: float | None = None
        self._restarts = 0
        self._last_error: str | None = None
        self._calls = 0

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------
    @property
    def running(self) -> bool:
        if config.HOST_AGENT_REMOTE:
            from .hostcontrol import host_agent

            return bool(host_agent.cached_bridge().get("running"))
        return self._proc is not None and self._proc.returncode is None

    async def start(self) -> None:
        if config.HOST_AGENT_REMOTE:
            from .hostcontrol import host_agent

            await host_agent.start()
            return
        if self.running:
            return
        script = config.BRIDGE_SCRIPT
        if not script.exists():
            raise BridgeError(f"桥接脚本不存在：{script}")
        node = shutil.which(config.NODE_BIN) or config.NODE_BIN
        self._proc = await asyncio.create_subprocess_exec(
            node,
            str(script),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(script.parent),
            limit=16 * 1024 * 1024,
        )
        self._started_at = time.time()
        self._stdout_task = asyncio.create_task(self._read_stdout())
        self._stderr_task = asyncio.create_task(self._read_stderr())
        store.add_log("info", "bridge", f"桥接进程已启动 PID={self._proc.pid}")

    async def stop(self) -> None:
        if config.HOST_AGENT_REMOTE:
            # 宿主代理和桥接的生命周期独立于容器，容器重启不能连带停掉浏览器。
            return
        proc, self._proc = self._proc, None
        for task in (self._stdout_task, self._stderr_task):
            if task:
                task.cancel()
        self._stdout_task = self._stderr_task = None
        if proc and proc.returncode is None:
            try:
                proc.terminate()
                await asyncio.wait_for(proc.wait(), timeout=5)
            except (ProcessLookupError, asyncio.TimeoutError):
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
        for fut in list(self._pending.values()):
            if not fut.done():
                fut.set_exception(BridgeError("桥接进程已停止"))
        self._pending.clear()

    async def restart(self) -> None:
        await self.stop()
        self._restarts += 1
        await self.start()

    # ------------------------------------------------------------------
    # 读写循环
    # ------------------------------------------------------------------
    async def _read_stdout(self) -> None:
        proc = self._proc
        assert proc is not None and proc.stdout is not None
        try:
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                text = line.decode("utf-8", "replace").strip()
                if not text:
                    continue
                try:
                    msg = json.loads(text)
                except json.JSONDecodeError:
                    self._stderr_buf.append("[非协议输出] " + text[:300])
                    continue
                fut = self._pending.pop(msg.get("id"), None)
                if fut is not None and not fut.done():
                    fut.set_result(msg)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            self._last_error = f"读取桥接输出失败：{exc}"
        finally:
            for fut in list(self._pending.values()):
                if not fut.done():
                    fut.set_exception(BridgeError("桥接进程已退出"))
            self._pending.clear()

    async def _read_stderr(self) -> None:
        proc = self._proc
        assert proc is not None and proc.stderr is not None
        try:
            while True:
                line = await proc.stderr.readline()
                if not line:
                    break
                text = line.decode("utf-8", "replace").rstrip()
                if text:
                    self._stderr_buf.append(text)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            pass

    # ------------------------------------------------------------------
    # 调用
    # ------------------------------------------------------------------
    async def call(self, cmd: str, args: dict[str, Any] | None = None,
                   timeout: float | None = None) -> Any:
        if config.HOST_AGENT_REMOTE:
            from .hostcontrol import HostAgentError, host_agent

            try:
                return await host_agent.rpc(cmd, args or {}, timeout=timeout)
            except HostAgentError as exc:
                raise BridgeError(str(exc)) from exc
        if not self.running:
            await self.start()
        limit = float(timeout or config.BRIDGE_TIMEOUT)
        async with self._lock:
            proc = self._proc
            if proc is None or proc.returncode is not None or proc.stdin is None:
                raise BridgeError("桥接进程不可用")
            self._seq += 1
            rid = self._seq
            loop = asyncio.get_running_loop()
            fut: asyncio.Future = loop.create_future()
            self._pending[rid] = fut
            payload = json.dumps({"id": rid, "cmd": cmd, "args": args or {}}, ensure_ascii=False)
            try:
                proc.stdin.write((payload + "\n").encode("utf-8"))
                await proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError) as exc:
                self._pending.pop(rid, None)
                raise BridgeError(f"写入桥接失败：{exc}")
            try:
                msg = await asyncio.wait_for(fut, timeout=limit)
            except asyncio.TimeoutError:
                self._pending.pop(rid, None)
                raise BridgeError(f"桥接调用超时（{cmd}，{limit:.0f}s）")
            finally:
                self._calls += 1
            if not msg.get("ok"):
                raise BridgeError(msg.get("error") or f"{cmd} 执行失败")
            return msg.get("data")

    def status(self) -> dict:
        if config.HOST_AGENT_REMOTE:
            from .hostcontrol import host_agent

            return host_agent.cached_bridge()
        return {
            "running": self.running,
            "pid": self._proc.pid if self._proc else None,
            "script": str(config.BRIDGE_SCRIPT),
            "script_exists": config.BRIDGE_SCRIPT.exists(),
            "uptime_sec": int(time.time() - self._started_at) if self._started_at else 0,
            "restarts": self._restarts,
            "calls": self._calls,
            "pending": len(self._pending),
            "last_error": self._last_error,
            "stderr_tail": list(self._stderr_buf)[-20:],
        }


bridge = NodeBridge()
