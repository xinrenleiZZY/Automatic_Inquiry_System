"""Windows 宿主控制代理。

只允许受信任的应用容器或本机进程调用。代理负责：
  - Node bridge 命令转发；
  - Chrome / monitor 的 Windows 进程控制；
  - 为容器生成 im.db 稳定快照。
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import os
import sqlite3
import sys
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, Response
import httpx
from pydantic import BaseModel, Field

# 必须在 import config 前设置：即使 .env 里配了 HOST_AGENT_URL，代理本身也必须直连本机。
os.environ["HOST_AGENT_SERVER_MODE"] = "true"

from . import chromectl, config, monitorctl, store  # noqa: E402
from .bridge import BridgeError, bridge  # noqa: E402
from .proc import pid_alive  # noqa: E402

_snapshot_lock = threading.Lock()
_snapshot_source_signature: tuple | None = None
_snapshot_etag = ""


def _tail(path: Path, n: int = 12) -> list[str]:
    try:
        return path.read_text(encoding="utf-8", errors="replace").splitlines()[-n:]
    except OSError:
        return []


def monitor_info() -> dict:
    pid: int | None = None
    if config.MONITOR_PID_FILE.exists():
        try:
            pid = int(config.MONITOR_PID_FILE.read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            pid = None
    return {
        "pid": pid,
        "alive": pid_alive(pid),
        "pid_file": str(config.MONITOR_PID_FILE),
        "log_file": str(config.MONITOR_OUT_LOG),
        "log_tail": _tail(config.MONITOR_OUT_LOG),
        "interval_sec": config.MONITOR_INTERVAL_SEC,
        "refresh_min": config.MONITOR_REFRESH_MIN,
    }


def require_token(x_ais_agent_token: str = Header(default="")) -> None:
    expected = config.HOST_AGENT_TOKEN
    if not expected:
        raise HTTPException(status_code=503, detail="宿主代理未配置 HOST_AGENT_TOKEN")
    if not hmac.compare_digest(x_ais_agent_token, expected):
        raise HTTPException(status_code=401, detail="宿主代理令牌无效")


class RpcBody(BaseModel):
    cmd: str = Field(min_length=1)
    args: dict[str, Any] = Field(default_factory=dict)


class BrowserBody(BaseModel):
    action: str = Field(pattern="^(status|start|stop|checkpath)$")
    chrome_path: str | None = None
    force: bool = False


class MonitorBody(BaseModel):
    action: str = Field(pattern="^(status|start|stop)$")
    interval_ms: int | None = None
    refresh_min: int | None = None


class PortalExchangeBody(BaseModel):
    code: str = Field(min_length=1)


def _source_signature() -> tuple:
    parts = []
    for path in (config.IM_DB, Path(str(config.IM_DB) + "-wal")):
        try:
            st = path.stat()
            parts.append((str(path), st.st_size, st.st_mtime_ns))
        except OSError:
            parts.append((str(path), 0, 0))
    return tuple(parts)


def _create_snapshot() -> tuple[Path, str]:
    global _snapshot_source_signature, _snapshot_etag
    if not config.IM_DB.is_file():
        raise FileNotFoundError(f"事实库不存在：{config.IM_DB}")
    target = config.DATA_DIR / "host-im.snapshot.db"
    tmp = target.with_name(target.name + ".tmp")
    target.parent.mkdir(parents=True, exist_ok=True)
    with _snapshot_lock:
        signature = _source_signature()
        if target.is_file() and signature == _snapshot_source_signature and _snapshot_etag:
            return target, _snapshot_etag
        try:
            tmp.unlink(missing_ok=True)
            with sqlite3.connect(str(config.IM_DB), timeout=30) as conn:
                conn.execute("PRAGMA busy_timeout=30000")
                escaped = str(tmp).replace("'", "''")
                conn.execute(f"VACUUM INTO '{escaped}'")
            os.replace(tmp, target)
            digest = hashlib.sha256(repr(signature).encode("utf-8")).hexdigest()[:24]
            _snapshot_etag = f'"{digest}"'
            _snapshot_source_signature = signature
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
    return target, _snapshot_etag


@contextlib.asynccontextmanager
async def lifespan(_: FastAPI):
    config.ensure_dirs()
    store.init_db()
    await bridge.start()
    yield
    await bridge.stop()


app = FastAPI(
    title="Automatic Inquiry System · Windows Host Agent",
    version="1.0.0",
    lifespan=lifespan,
)


@app.get("/health", dependencies=[Depends(require_token)])
async def health() -> dict:
    return {
        "ok": True,
        "service": "automatic-inquiry-host-agent",
        "platform": sys.platform,
        "pid": os.getpid(),
        "at": int(time.time() * 1000),
    }


@app.get("/status", dependencies=[Depends(require_token)])
async def status() -> dict:
    return {
        "ok": True,
        "bridge": bridge.status(),
        "monitor": monitor_info(),
        "im_db": str(config.IM_DB),
        "at": int(time.time() * 1000),
    }


@app.post("/rpc", dependencies=[Depends(require_token)])
async def rpc(body: RpcBody) -> dict:
    try:
        data = await bridge.call(body.cmd, body.args)
    except BridgeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True, "data": data}


@app.post("/browser", dependencies=[Depends(require_token)])
async def browser_action(body: BrowserBody) -> dict:
    result = await chromectl.run_action(
        body.action, chrome_path=body.chrome_path, force=body.force,
    )
    return {"ok": bool(result.get("ok")), "result": result}


@app.post("/monitor", dependencies=[Depends(require_token)])
async def monitor_action(body: MonitorBody) -> dict:
    if body.action == "status":
        result = await monitorctl.status()
    elif body.action == "start":
        interval = body.interval_ms or config.MONITOR_INTERVAL_SEC * 1000
        refresh = config.MONITOR_REFRESH_MIN if body.refresh_min is None else body.refresh_min
        result = await monitorctl.start(int(interval), int(refresh))
    else:
        result = await monitorctl.stop()
    return {"ok": bool(result.get("ok")), "result": result, "monitor": monitor_info()}


@app.post("/portal/exchange", dependencies=[Depends(require_token)])
async def portal_exchange(body: PortalExchangeBody) -> dict:
    """由 Windows 宿主访问内网门户，避开 Docker 到门户网段的 NAT 路由差异。"""
    url = config.PORTAL_API_BASE_URL.rstrip("/") + "/api/auth/sso-exchange"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(url, json={"code": body.code})
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"宿主访问门户失败：{exc}") from exc
    try:
        payload = resp.json()
    except ValueError:
        payload = {"detail": resp.text[:500]}
    return {"ok": 200 <= resp.status_code < 300, "status": resp.status_code, "data": payload}


@app.get("/db/snapshot", dependencies=[Depends(require_token)])
async def db_snapshot(request: Request) -> Response:
    try:
        path, etag = await asyncio.to_thread(_create_snapshot)
    except (FileNotFoundError, OSError, sqlite3.Error) as exc:
        raise HTTPException(status_code=503, detail=f"生成数据库快照失败：{exc}") from exc
    if request.headers.get("if-none-match") == etag:
        return Response(
            status_code=304,
            headers={"Cache-Control": "no-store", "ETag": etag},
        )
    return FileResponse(
        str(path),
        media_type="application/vnd.sqlite3",
        filename="im.snapshot.db",
        headers={"Cache-Control": "no-store", "ETag": etag},
    )


def main() -> None:
    import uvicorn

    if not config.HOST_AGENT_TOKEN:
        raise SystemExit("HOST_AGENT_TOKEN 不能为空；请用 deploy/start-host-agent.ps1 启动")
    uvicorn.run(
        "app.host_agent:app",
        host=config.HOST_AGENT_BIND,
        port=config.HOST_AGENT_PORT,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()
