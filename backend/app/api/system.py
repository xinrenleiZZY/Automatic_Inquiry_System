"""系统状态：健康检查 / 总览 / 命令清单 / 配置快照 / 日志 / 审计。"""

import asyncio
import time

import httpx
from fastapi import APIRouter, Depends

from .. import browserprobe, config, hostcontrol, repo, store
from ..proc import pid_alive
from ..bridge import bridge
from ..queue import known_types, queue
from ..security import get_current_user

router = APIRouter(prefix="/api/system", tags=["system"])


def monitor_info() -> dict:
    if config.HOST_AGENT_REMOTE:
        return hostcontrol.host_agent.cached_monitor()
    pid: int | None = None
    if config.MONITOR_PID_FILE.exists():
        try:
            pid = int(config.MONITOR_PID_FILE.read_text(encoding="utf-8").strip())
        except (ValueError, OSError):
            pid = None
    tail: list[str] = []
    if config.MONITOR_OUT_LOG.exists():
        try:
            lines = config.MONITOR_OUT_LOG.read_text(encoding="utf-8", errors="replace").splitlines()
            tail = lines[-12:]
        except OSError:
            tail = []
    return {
        "pid": pid,
        "alive": pid_alive(pid),
        "pid_file": str(config.MONITOR_PID_FILE),
        "log_file": str(config.MONITOR_OUT_LOG),
        "log_tail": tail,
        "interval_sec": config.MONITOR_INTERVAL_SEC,
        "refresh_min": config.MONITOR_REFRESH_MIN,
    }


_CDP_CACHE: dict = {"at": 0.0, "data": None}


async def cdp_info(ttl: float = 2.0) -> dict:
    """探测 Chrome 调试端口。

    两个要点：
      1. 必须是 async —— 之前用同步 httpx 会阻塞事件循环，健康检查一慢，
         仪表盘其它请求就全被拖住（表现为"组件全异常"）；
      2. 加 2 秒缓存 —— 健康检查每 5 秒轮询一次，没必要每次都真去问 CDP。
    """
    now = time.time()
    cached = _CDP_CACHE.get("data")
    if cached is not None and now - float(_CDP_CACHE.get("at") or 0) < ttl:
        return cached  # type: ignore[return-value]
    if config.HOST_AGENT_REMOTE:
        probe = await browserprobe.raw_status(ttl=ttl)
        raw = probe.get("cdp") or {}
        out = {
            **raw,
            "reachable": bool(raw.get("reachable")),
            "base": raw.get("base") or config.CDP_BASE,
            "via": "host-agent-bridge",
        }
        _CDP_CACHE["at"] = now
        _CDP_CACHE["data"] = out
        return out
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get(config.CDP_BASE.rstrip("/") + "/json/version")
            if r.status_code == 200:
                data = r.json()
                out = {
                    "reachable": True,
                    "browser": data.get("Browser"),
                    "protocol": data.get("Protocol-Version"),
                    "base": config.CDP_BASE,
                }
            else:
                out = {"reachable": False, "base": config.CDP_BASE, "error": f"HTTP {r.status_code}"}
    except httpx.HTTPError as exc:
        out = {"reachable": False, "base": config.CDP_BASE, "error": str(exc)}
    _CDP_CACHE["at"] = now
    _CDP_CACHE["data"] = out
    return out


async def browser_login_info(timeout: float = 8.0) -> dict:
    """第七项体检：**1688 到底还登录着没有**。

    为什么必须单独有这么一项：Chrome 起在那里、6901 端口通、其它六项全绿，
    但账号早就掉线时，仪表盘看起来一切正常，实际所有业务动作都做不了
    （2026-10-08 就出现过"静默失效 45 小时、面板全绿"）。
    取数走 browserprobe（CDP + 服务端探测），带缓存，不会把健康检查拖慢。
    """
    try:
        data = await asyncio.wait_for(browserprobe.raw_status(), timeout=timeout)
    except Exception as exc:  # noqa: BLE001  —— 测不到也要给个明确结论
        data = {"login": {"logged_in": False, "reason": f"登录态检测超时或失败：{exc}"},
                "verdict": {"label": "检测失败", "reason": str(exc)}}
    login = data.get("login") or {}
    verdict = data.get("verdict") or {}
    return {
        "ok": bool(login.get("logged_in")),
        "logged_in": bool(login.get("logged_in")),
        "account": login.get("account") or "",
        "validity": login.get("validity") or "unknown",
        "verdict": verdict.get("label") or "",
        "reason": login.get("reason") or verdict.get("reason") or "",
        "at": data.get("at"),
    }


@router.get("/health")
async def health() -> dict:
    im_ok = False
    im_error = None
    try:
        with repo.connect_im() as conn:
            conn.execute("SELECT 1").fetchone()
        im_ok = True
    except Exception as exc:  # noqa: BLE001
        im_error = str(exc)
    mon = monitor_info()
    cdp = await cdp_info()
    br = bridge.status()
    bl = await browser_login_info()
    return {
        # 总开关跟着"能不能干活"走：端口通但 1688 掉线，就不能算健康
        "ok": bool(im_ok and cdp.get("reachable") and bl.get("ok")),
        "components": {
            "im_db": {"ok": im_ok, "path": str(config.IM_DB), "error": im_error},
            "api_db": {"ok": config.API_DB.exists(), "path": str(config.API_DB)},
            "cdp": cdp,
            "bridge": {"ok": br["running"], "pid": br["pid"], "restarts": br["restarts"]},
            "queue": {"ok": queue.running, "depth": queue.status()["depth"]},
            "monitor": {"ok": mon["alive"], "pid": mon["pid"]},
            "browser_login": bl,
        },
        "at": int(time.time() * 1000),
    }


@router.get("/status")
async def status() -> dict:
    st = repo.stats()
    return {
        "stats": st,
        "counts": st.get("counts", {}),
        "queue": queue.status(),
        "bridge": bridge.status(),
        "monitor": monitor_info(),
        "cdp": await cdp_info(),
        "jobs": {"queued": store.count_jobs("queued"), "running": store.count_jobs("running"),
                 "total": store.count_jobs()},
        "at": int(time.time() * 1000),
    }


@router.get("/commands")
async def commands(user: dict = Depends(get_current_user)) -> dict:
    """把桥接层的能力暴露给前端（做功能菜单用）。"""
    data = await bridge.call("bridge.commands")
    return {"bridge": data, "job_types": known_types()}


@router.get("/config")
async def get_config(user: dict = Depends(get_current_user)) -> dict:
    # settings 用 public_settings()：里面剔掉了登录密码这类敏感项
    return {"runtime": config.summary(), "settings": store.public_settings()}


@router.get("/logs")
async def logs(limit: int = 200, source: str | None = None,
               user: dict = Depends(get_current_user)) -> dict:
    return {"items": store.list_logs(limit, source)}


@router.get("/audit")
async def audit(limit: int = 200, user: dict = Depends(get_current_user)) -> dict:
    return {"items": store.list_audit(limit)}


@router.get("/ai-calls")
async def ai_calls(limit: int = 100, source: str | None = None,
                   status: str | None = None, campaign_id: int | None = None,
                   conv_key: str | None = None, job_id: str | None = None,
                   user: dict = Depends(get_current_user)) -> dict:
    """DeepSeek 每次 HTTP 调用的提示词、响应、用量、耗时与业务上下文。"""
    return await bridge.call("ai.calls", {
        "limit": max(1, min(limit, 1000)),
        "source": source or "",
        "status": status or "",
        "campaignId": campaign_id,
        "convKey": conv_key or "",
        "jobId": job_id or "",
    })


@router.get("/events")
async def events(limit: int = 100, user: dict = Depends(get_current_user)) -> dict:
    return {"items": repo.events(limit)}


@router.get("/news")
async def news(limit: int = 40, user: dict = Depends(get_current_user)) -> dict:
    """最近事件（新闻）：客户回复新增了比价表字段才算，不是聊天记录。"""
    return {"items": repo.news(limit)}
