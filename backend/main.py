"""Automatic Inquiry System · 接口层入口。

启动：
    python -m uvicorn main:app --host 0.0.0.0 --port 6900
（在 backend 目录下执行）

同源托管前端构建产物（frontend/dist），因此 cookie/SSO 天然可用，不需要 CORS。
"""

import asyncio
import contextlib
import os
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app import config, hostcontrol, store
from app import handlers  # noqa: F401  导入即注册全部作业处理器
from app.api import (ai, auth, browser, campaigns, data, flows, library, outreach,
                     pricing_templates, send, settings, system)
from app.bridge import bridge
from app.queue import queue


async def _event_pump() -> None:
    """把 monitor 写入 events 表的新消息，转成单会话采集作业。

    事件和新消息采集请求会立即进入串行队列；只有“全自动比价/自动采集”
    这类长作业会自己消费事件，事件泵此时让路，避免同一消息被两处抢走。
    事件被 events.tick 标成 queued；作业结束后由 campaign.collect 处理器 ack。
    """
    try:
        await bridge.call("events.resetStale", {"olderThanSec": 120}, timeout=30)
    except Exception as exc:  # noqa: BLE001
        store.add_log("warn", "events", f"启动清理遗留事件失败：{exc}")

    last_reconcile = 0.0
    while True:
        try:
            # 定时对账消息表与客户游标：补齐监听器重建基线时吞掉的入站消息，
            # 也把暂停期间 deferred/ignored 的事件重新激活。
            if time.time() - last_reconcile >= 5:
                last_reconcile = time.time()
                try:
                    rec = await bridge.call("events.reconcile", {}, timeout=60)
                    changed = int((rec or {}).get("recovered") or 0) + int((rec or {}).get("inserted") or 0)
                    if changed:
                        store.add_log(
                            "info", "events",
                            f"入站对账恢复 {changed} 条事件"
                            f"（重新激活 {(rec or {}).get('recovered', 0)} / "
                            f"补建 {(rec or {}).get('inserted', 0)}）",
                        )
                except Exception as exc:  # noqa: BLE001
                    store.add_log("warn", "events", f"入站事件对账失败：{exc}")

            st = queue.status()
            current_type = str((st.get("current") or {}).get("type") or "")
            if st.get("paused") or current_type in ("campaign.fullauto", "campaign.autocollect"):
                await asyncio.sleep(config.EVENT_PUMP_INTERVAL_SEC)
                continue

            r = await bridge.call("events.tick", {
                "limit": 20,
                "maxAgeSec": config.EVENT_PUMP_MAX_AGE_SEC,
            }, timeout=60)
            items = (r or {}).get("items") or []
            for ev in items:
                try:
                    cid = int(ev.get("campaignId") or 0)
                    # 任务级发送模式优先；没有覆盖才用全局设置。
                    _override, eff = store.effective_campaign_params(cid)
                    mode = eff.get("send_mode") or store.get_settings().get("send_mode") or "send"
                    await queue.submit("campaign.collect", {
                        "id": cid,
                        "onlyConvKeys": [str(ev.get("convKey") or "")],
                        "slice": 1,
                        "mode": mode,
                        "_eventId": int(ev.get("eventId") or 0),
                    }, "event-pump", priority=0)
                    store.add_log(
                        "info", "events",
                        f"新消息触发任务 {ev.get('campaignId')} 会话 {str(ev.get('convKey') or '')[:28]}",
                    )
                except Exception as exc:  # noqa: BLE001
                    try:
                        await bridge.call("events.reset", {"ids": [ev.get("eventId")]}, timeout=30)
                    except Exception:  # noqa: BLE001
                        pass
                    store.add_log("warn", "events", f"事件 {ev.get('eventId')} 提交失败：{exc}")
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            store.add_log("warn", "events", f"事件泵异常：{exc}")
        await asyncio.sleep(config.EVENT_PUMP_INTERVAL_SEC)


async def _flow_scheduler() -> None:
    """把到期的全自动小步骤投递到队列；它本身不执行浏览器操作。"""
    try:
        store.reset_stale_flow_steps(600000)
    except Exception as exc:  # noqa: BLE001
        store.add_log("warn", "flow", f"清理遗留流程步骤失败：{exc}")
    while True:
        try:
            store.reset_stale_flow_steps(600000)
            for step in store.due_flow_steps(limit=5):
                if not store.claim_flow_step(step["id"]):
                    continue
                await queue.submit(
                    "flow.step", {"step_id": step["id"]},
                    "flow-scheduler", priority=20,
                )
                store.add_log(
                    "info", "flow",
                    f"流程 {step['flow_id']} 第 {step['step_no']} 步（{step['kind']}）入队",
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            store.add_log("warn", "flow", f"流程调度异常：{exc}")
        await asyncio.sleep(2)


@contextlib.asynccontextmanager
async def lifespan(_: FastAPI):
    config.ensure_dirs()
    store.init_db()
    stale = store.mark_stale_jobs()
    if stale:
        store.add_log("warn", "app", f"启动时清理了 {stale} 个残留的 running 作业")
    try:
        await bridge.start()
    except Exception as exc:  # noqa: BLE001
        store.add_log("error", "bridge", f"桥接启动失败：{exc}")
    if config.HOST_AGENT_REMOTE:
        try:
            await hostcontrol.host_agent.refresh_snapshot(required=True)
        except Exception as exc:  # noqa: BLE001
            store.add_log("error", "host-agent", f"启动时获取数据库快照失败：{exc}")
        hostcontrol.host_agent.start_background()
    if config.QUEUE_AUTOSTART:
        await queue.start()
    event_task = None
    if config.EVENT_PUMP_ENABLED and config.QUEUE_AUTOSTART:
        event_task = asyncio.create_task(_event_pump())
        store.add_log(
            "info", "events",
            f"事件泵已启动（每 {config.EVENT_PUMP_INTERVAL_SEC}s，回看 {config.EVENT_PUMP_MAX_AGE_SEC}s）",
        )
    flow_task = None
    if config.QUEUE_AUTOSTART:
        flow_task = asyncio.create_task(_flow_scheduler())
        store.add_log("info", "flow", "全自动流程调度器已启动")
    store.add_log("info", "app", f"服务已启动，端口 {config.APP_PORT}")
    try:
        yield
    finally:
        if event_task:
            event_task.cancel()
            try:
                await event_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        if flow_task:
            flow_task.cancel()
            try:
                await flow_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        await queue.stop()
        await bridge.stop()
        await hostcontrol.host_agent.stop()


app = FastAPI(title=config.APP_TITLE, version="1.0.0", lifespan=lifespan)

# 默认不开 CORS（前端与 API 同源）。需要跨域时用环境变量显式开启。
_origins = [o.strip() for o in (os.getenv("CORS_ORIGINS") or "").split(",") if o.strip()]
if _origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception) -> JSONResponse:
    store.add_log("error", "app", f"{request.method} {request.url.path} → {exc}")
    return JSONResponse(status_code=500, content={"detail": f"服务内部错误：{exc}"})


app.include_router(auth.router)
app.include_router(system.router)
app.include_router(browser.router)
app.include_router(settings.router)
app.include_router(campaigns.router)
app.include_router(flows.router)
app.include_router(send.router)
app.include_router(outreach.router)
app.include_router(data.router)
app.include_router(library.router)
app.include_router(pricing_templates.router)
app.include_router(ai.router)


@app.get("/api/health", tags=["system"])
async def api_health() -> dict:
    """轻量健康检查（启动脚本也用它判断能不能安全停止）。"""
    current = queue.status().get("current")
    return {
        "status": "ok",
        "app": "automatic-inquiry-system",
        "at": int(time.time() * 1000),
        "busy": bool(current),
        "job": current,
    }


# --------------------------------------------------------------------------
# 前端静态资源（构建产物）+ SPA 兜底路由
# --------------------------------------------------------------------------
_dist = config.FRONTEND_DIST
if _dist.exists():
    _assets = _dist / "assets"
    if _assets.exists():
        app.mount("/assets", StaticFiles(directory=str(_assets)), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str) -> FileResponse:
        if full_path.startswith(("api/", "docs", "redoc", "openapi.json")):
            raise HTTPException(status_code=404, detail="Not Found")
        candidate = _dist / full_path if full_path else _dist / "index.html"
        if full_path and candidate.is_file():
            return FileResponse(str(candidate))
        return FileResponse(str(_dist / "index.html"))
else:  # pragma: no cover - 只有还没构建前端时才会走到
    @app.get("/", include_in_schema=False)
    async def no_frontend() -> JSONResponse:
        return JSONResponse({
            "detail": "前端尚未构建",
            "hint": f"在 {Path(config.SYSTEM_DIR) / 'frontend'} 执行 npm run build",
        })


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host=config.HOST, port=config.APP_PORT, reload=False)
