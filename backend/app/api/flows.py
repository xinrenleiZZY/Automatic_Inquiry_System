"""流程启停：常驻监听 / 串行队列 / 作业中心。"""

import asyncio
import time

from fastapi import APIRouter, Depends, HTTPException

from .. import config, monitorctl, repo, store
from ..bridge import BridgeError, bridge
from ..queue import queue
from ..security import get_current_user, require_admin_or_gm
from .system import monitor_info

router = APIRouter(prefix="/api", tags=["flows"])


@router.get("/flows")
async def flows(user: dict = Depends(get_current_user)) -> dict:
    return {
        "monitor": monitor_info(),
        "queue": queue.status(),
        "bridge": bridge.status(),
    }


@router.get("/flows/runs")
async def flow_runs(campaign_id: int | None = None, limit: int = 50,
                    user: dict = Depends(get_current_user)) -> dict:
    """任务中心：可选的流程列表（按任务过滤）。"""
    campaigns = {int(c["id"]): c for c in repo.list_campaigns(200, include_archived=True)}
    items = []
    for run in store.list_flow_runs(campaign_id, limit):
        c = campaigns.get(int(run.get("campaign_id") or 0)) or {}
        items.append({
            **run,
            "campaign_name": c.get("name") or f"任务 #{run.get('campaign_id')}",
            "campaign_status": c.get("status") or "",
            "campaign_stage": c.get("stage") or "",
        })
    return {"items": items}


@router.get("/flows/runs/{flow_id}")
async def flow_run_detail(flow_id: str, user: dict = Depends(get_current_user)) -> dict:
    """任务中心：单条流程 + 每一步的状态/子作业。"""
    run = store.get_flow_run(flow_id)
    if not run:
        raise HTTPException(status_code=404, detail="流程不存在")
    summary = next(
        (r for r in store.list_flow_runs(int(run.get("campaign_id") or 0), 200)
         if r.get("id") == flow_id),
        {},
    )
    for key in ("total_steps", "done_steps", "failed_steps", "current_kind", "current_step_no"):
        if key in summary:
            run[key] = summary[key]
    steps = store.list_flow_steps(flow_id)
    jobs = store.jobs_for_step_ids([s["id"] for s in steps])
    for step in steps:
        step["jobs"] = jobs.get(step["id"], [])
    campaign = repo.get_campaign(int(run.get("campaign_id") or 0)) or {}
    run["campaign_name"] = campaign.get("name") or f"任务 #{run.get('campaign_id')}"
    run["campaign_status"] = campaign.get("status") or ""
    run["campaign_stage"] = campaign.get("stage") or ""
    return {"run": run, "steps": steps}


@router.post("/flows/runs/{flow_id}/terminate")
async def terminate_flow(flow_id: str, user: dict = Depends(require_admin_or_gm)) -> dict:
    """从任务中心终止一次完整流程，并暂停所属任务。

    这是任务级操作，不再要求用户逐个子作业去日志中心点停止。
    """
    run = store.get_flow_run(flow_id)
    if not run:
        raise HTTPException(status_code=404, detail="流程不存在")
    if run.get("status") in ("done", "failed", "canceled"):
        return {"run": run, "note": "流程已经结束，无需终止", "canceled_jobs": 0}

    cid = int(run.get("campaign_id") or 0)
    steps = store.list_flow_steps(flow_id)
    jobs = store.jobs_for_step_ids([str(s.get("id") or "") for s in steps])
    canceled_jobs: list[str] = []
    now = int(time.time() * 1000)
    for rows in jobs.values():
        for job in rows:
            if job.get("status") not in ("queued", "running"):
                continue
            store.update_job(
                str(job["id"]),
                status="canceled",
                error="任务中心终止流程",
                finished_at=now,
                progress={"text": "已按要求终止", "at": now},
            )
            canceled_jobs.append(str(job["id"]))

    terminated = store.terminate_flow_run(flow_id, "任务中心终止流程")

    campaign = None
    campaign_error = ""
    if cid:
        try:
            campaign = await bridge.call(
                "campaign.update", {"id": cid, "patch": {"status": "paused"}},
                timeout=60,
            )
        except Exception as exc:  # noqa: BLE001
            campaign_error = str(exc)
            store.add_log("error", "flow", f"流程 {flow_id} 终止了，但暂停任务 {cid} 失败：{exc}")

    store.add_audit(
        user.get("username", ""), "flow.terminate",
        {"flow_id": flow_id, "campaign_id": cid},
        f"canceled_steps={terminated['canceled_steps']}, jobs={len(canceled_jobs)}",
    )
    store.add_log(
        "info", "flow",
        f"用户终止流程 {flow_id}｜任务 {cid} 已暂停｜取消步骤 "
        f"{terminated['canceled_steps']} 个｜取消子作业 {len(canceled_jobs)} 个",
    )
    return {
        "run": store.get_flow_run(flow_id),
        "campaign": campaign,
        "campaign_error": campaign_error,
        "canceled_steps": terminated["canceled_steps"],
        "canceled_jobs": canceled_jobs,
        "note": "流程已终止，任务已暂停；当前浏览器动作会在安全检查点退出",
    }


async def start_monitor(interval_sec: int | None = None, refresh_min: int | None = None,
                        user_name: str = "") -> dict:
    """启动常驻监听（抽成普通函数，好让「状态监控」一键启动直接复用）。"""
    info = monitor_info()
    if info["alive"]:
        return {"already_running": True, "monitor": info}
    interval = int(interval_sec or config.MONITOR_INTERVAL_SEC) * 1000
    refresh = config.MONITOR_REFRESH_MIN if refresh_min is None else int(refresh_min)
    result = await monitorctl.start(interval, refresh)
    store.add_audit(user_name, "flow.monitor.start",
                    {"interval_sec": interval_sec, "refresh_min": refresh},
                    "ok" if result.get("ok") else f"fail: {result.get('error')}")
    if not result.get("ok"):
        raise HTTPException(status_code=500, detail=f"监听启动失败：{result.get('error') or result}")
    return {"result": result, "monitor": monitor_info()}


async def stop_monitor(user_name: str = "") -> dict:
    """停止常驻监听。"""
    result = await monitorctl.stop()
    store.add_audit(user_name, "flow.monitor.stop", {},
                    "ok" if result.get("ok") else f"fail: {result.get('error')}")
    if not result.get("ok"):
        # 以前这里不看退出码，"停止失败"也会被当成成功（2026-10-15 实测踩过）
        raise HTTPException(status_code=500, detail=f"监听停止失败：{result.get('error') or result}")
    return {"result": result, "monitor": monitor_info()}


@router.post("/flows/monitor/start")
async def monitor_start(interval_sec: int | None = None, refresh_min: int | None = None,
                        user: dict = Depends(require_admin_or_gm)) -> dict:
    return await start_monitor(interval_sec, refresh_min, user.get("username", ""))


@router.post("/flows/monitor/stop")
async def monitor_stop(user: dict = Depends(require_admin_or_gm)) -> dict:
    return await stop_monitor(user.get("username", ""))


@router.get("/flows/monitor/status")
async def monitor_status(user: dict = Depends(get_current_user)) -> dict:
    return monitor_info()


@router.post("/flows/monitor/once")
async def monitor_once(user: dict = Depends(require_admin_or_gm)) -> dict:
    """单次巡检（手动），走队列以免和别的浏览器操作撞车。"""
    job = await queue.submit("monitor.once", {}, user.get("username", ""))
    return {"job": job}


@router.post("/flows/queue/start")
async def queue_start(user: dict = Depends(require_admin_or_gm)) -> dict:
    await queue.start()
    store.add_audit(user.get("username", ""), "flow.queue.start", {}, "ok")
    return queue.status()


@router.post("/flows/queue/stop")
async def queue_stop(user: dict = Depends(require_admin_or_gm)) -> dict:
    await queue.stop()
    store.add_audit(user.get("username", ""), "flow.queue.stop", {}, "ok")
    return queue.status()


@router.post("/flows/queue/pause")
async def queue_pause(user: dict = Depends(get_current_user)) -> dict:
    queue.pause()
    return queue.status()


@router.post("/flows/queue/resume")
async def queue_resume(user: dict = Depends(get_current_user)) -> dict:
    queue.resume()
    return queue.status()


@router.post("/flows/queue/tick")
async def queue_tick(user: dict = Depends(require_admin_or_gm)) -> dict:
    """手动踢一次：把所有 running 任务各推进一步。"""
    job = await queue.submit("scheduler.once", {}, user.get("username", ""))
    store.add_audit(user.get("username", ""), "flow.queue.tick", {}, job["id"])
    return {"job": job}


@router.post("/flows/refresh")
async def refresh_pages(wait_ms: int | None = None, user: dict = Depends(require_admin_or_gm)) -> dict:
    """刷新聊天网页（由队列在空闲点执行，避免打断进行中的操作）。"""
    job = await queue.submit("page.refresh", {"waitMs": wait_ms or 5000}, user.get("username", ""))
    return {"job": job}


@router.post("/flows/sweep")
async def sweep_history(conv_key: str | None = None, scroll: int = 5, limit: int = 20,
                        user: dict = Depends(require_admin_or_gm)) -> dict:
    """抓会话历史入库。

    1688 网页版只在**打开某个会话**时才按页加载它的消息，所以"抓全历史"必须
    真的点开这个会话并向上翻页（不是加密问题，是懒加载）。
      - 传 conv_key：只抓这一个会话（客户中心抽屉里的「抓全历史」）；
      - 不传：按会话列表顺序抓前 limit 个。
    会短暂占用聊天窗口（队列串行，跟其它任务不会打架）。
    """
    payload: dict = {"limit": max(1, int(limit)), "scroll": max(0, int(scroll)), "all": not conv_key}
    if conv_key:
        payload["onlyConvKeys"] = [conv_key]
        payload["limit"] = 1
    job = await queue.submit("sweep.run", payload, user.get("username", ""))
    store.add_audit(user.get("username", ""), "flow.sweep", payload, job["id"])
    return {"job": job}


@router.post("/flows/tabs/enforce")
async def enforce_tabs(keep_chat: int = 1, user: dict = Depends(require_admin_or_gm)) -> dict:
    try:
        data = await bridge.call("tabs.enforce", {"keepChat": keep_chat})
    except BridgeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return data


@router.get("/jobs")
async def list_jobs(limit: int = 50, status: str | None = None,
                    user: dict = Depends(get_current_user)) -> dict:
    return {"items": store.list_jobs(limit, status)}


@router.get("/jobs/summary")
async def jobs_summary(user: dict = Depends(get_current_user)) -> dict:
    """「日志中心」三个分页的计数 + 当前正在跑的作业。

    注意：这条必须声明在 /jobs/{job_id} **之前**，否则会被当成 job_id='summary'。
    """
    return {"counts": store.job_status_counts(), "current": queue.status().get("current"),
            "queue": queue.status()}


@router.get("/jobs/{job_id}")
async def get_job(job_id: str, user: dict = Depends(get_current_user)) -> dict:
    job = store.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="作业不存在")
    return job


@router.get("/jobs/{job_id}/detail")
async def get_job_detail(job_id: str, log_limit: int = 200,
                         user: dict = Depends(get_current_user)) -> dict:
    """单个作业的详情：本体 + 该作业的日志 + 相关审计（「日志中心」右侧详情窗口）。"""
    job = store.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="作业不存在")
    try:
        logs = store.list_logs_for_job(job_id, log_limit)
    except Exception as exc:  # noqa: BLE001
        logs = [{"level": "error", "source": "log", "message": f"读日志失败：{exc}"}]
    try:
        # 审计表里作业号记在 result 字段（部分动作也写进 params）
        audit = [a for a in store.list_audit(500)
                 if job_id in (str(a.get("result") or ""), str(a.get("params") or ""))]
    except Exception:  # noqa: BLE001
        audit = []
    return {"job": job, "logs": logs, "audit": audit}


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: str, user: dict = Depends(get_current_user)) -> dict:
    job = store.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="作业不存在")
    if job["status"] in ("done", "failed", "canceled"):
        return {"job": job, "note": "作业已结束，无需取消"}
    import time as _t

    running = job["status"] == "running"
    store.update_job(job_id, status="canceled", error="用户取消", finished_at=int(_t.time() * 1000))
    store.add_audit(user.get("username", ""), "job.cancel", {"id": job_id}, "ok")
    return {
        "job": store.get_job(job_id),
        "note": (
            "该作业正在执行中，浏览器动作无法中途打断；已标记为取消，执行完的结果不会被保留"
            if running else "已取消，尚未开始执行"
        ),
    }


def _resume_rounds(payload: dict, progress_text: str) -> int:
    """续跑仍使用原“每客户最多轮数”。

    新采集器把每个客户的已完成轮次、截止时间写进 task_contacts；续跑时按
    各客户自己的状态继续计时即可，不能再按全局进度扣减总轮数。
    """
    _ = progress_text
    return max(1, int(payload.get("rounds") or 5))


@router.post("/jobs/{job_id}/resume")
async def resume_job(job_id: str, user: dict = Depends(get_current_user)) -> dict:
    """从中断处续跑全自动比价。

    只对「服务重启导致中断」等已结束的 campaign.fullauto 作业开放。
    续跑会跳过启动/联系商家，直接回到自动采集，最后照常补分析和推送飞书。
    """
    job = store.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="作业不存在")
    if job.get("type") != "campaign.fullauto":
        raise HTTPException(status_code=400, detail="只有「全自动比价（一条龙）」作业支持续跑")
    if job.get("status") != "failed":
        raise HTTPException(status_code=409, detail="只有已失败的作业可以续跑")
    if "服务重启" not in str(job.get("error") or ""):
        raise HTTPException(status_code=409, detail="只有服务重启导致中断的作业支持续跑")

    old = job.get("payload") or {}
    if not isinstance(old, dict):
        old = {}
    cid = int(old.get("id") or 0)
    if not cid:
        raise HTTPException(status_code=400, detail="作业里没有关联的比价任务，无法续跑")

    payload = {k: v for k, v in old.items() if not str(k).startswith("_")}
    progress_text = str((job.get("progress") or {}).get("text") or "")
    payload.update({
        "skip_launch": True,
        "resume_of": job_id,
        "rounds": _resume_rounds(old, progress_text),
    })
    new_job = await queue.submit("campaign.fullauto", payload, user.get("username", ""))
    store.add_audit(user.get("username", ""), "job.resume",
                    {"source": job_id, "campaign": cid, "rounds": payload["rounds"]}, new_job["id"])
    store.add_log("info", f"job:{new_job['id']}",
                  f"从中断作业 {job_id} 续跑（跳过联系商家，剩余 {payload['rounds']} 轮）")
    return {"job": new_job, "payload": payload}
