"""作业失败告警 —— 队列里的失败主动送到飞书群。

分工（两条通道读的是同一份作业记录，互为补充）：
  - 界面：顶部全局告警条 + 「日志中心」作业详情 —— "人去看"；
  - 这里：飞书群卡片 —— "主动送到群里"，不用等人打开界面。

约束：
  - 只报 failed，不报 canceled（取消是用户主动行为，不算异常）；
  - 尽力而为：飞书没配、网络异常、群 ID 无效，一律只记日志，
    绝不抛出去影响作业本身的失败记录（告警不能反过来把事情弄坏）；
  - 群里只放摘要（错误文本截断），完整堆栈在「日志中心」的作业详情里看。
"""

import logging
import time

from . import config, repo, store
from .feishu import notifier

logger = logging.getLogger(__name__)

MAX_ERROR_CHARS = 600

# 作业类型 → 人话（与前端 Logs.tsx 的 JOB_CN 保持一致，新增处理器时两处都补）
JOB_CN = {
    "campaign.launch": "任务·发起询价",
    "campaign.collect": "任务·采集回复并追问",
    "campaign.advance": "任务·推进阶段",
    "campaign.resend": "任务·补发询价",
    "campaign.nudge": "任务·催问",
    "campaign.autocollect": "全自动采集（按客户独立计时）",
    "campaign.fullauto": "全自动比价（一条龙）",
    "campaign.fullauto.flow": "全自动比价（分步流程）",
    "flow.step": "全自动·单步",
    "scheduler.once": "多任务调度器·一轮",
    "image.search": "以图搜图",
    "outreach.contact": "联系商家",
    "send.text": "发送文字",
    "send.phrase": "发送图文短语",
    "send.image": "发送图片",
    "autoreply.run": "自动回复·一轮",
    "page.refresh": "刷新页面",
    "monitor.once": "监控·一轮",
    "tabs.enforce": "标签治理",
    "sweep.run": "抓取会话/消息",
}


def job_cn(job_type: str | None) -> str:
    t = str(job_type or "")
    return JOB_CN.get(t, t or "-")


def _fmt_ts(ms: int | None) -> str:
    if not ms:
        return "-"
    try:
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(int(ms) / 1000))
    except (TypeError, ValueError, OSError):
        return "-"


def _duration(start: int | None, end: int | None) -> str:
    if not start:
        return "-"
    ms = (end or int(time.time() * 1000)) - int(start)
    if ms < 1000:
        return f"{max(ms, 0)}ms"
    if ms < 60_000:
        return f"{ms / 1000:.1f}s"
    return f"{int(ms // 60_000)}分{int((ms % 60_000) // 1000)}秒"


def _campaign_info(job: dict) -> tuple[int | None, str]:
    """从 payload 里取任务号并反查任务名（读 im.db 只读查询，失败就算了）。"""
    payload = job.get("payload") or {}
    if not isinstance(payload, dict):
        return None, ""
    cid = payload.get("id")
    if cid in (None, ""):
        return None, ""
    try:
        cid_int = int(cid)
    except (TypeError, ValueError):
        return None, ""
    try:
        c = repo.get_campaign(cid_int) or {}
    except Exception as exc:  # noqa: BLE001
        logger.warning("告警取任务名失败: %s", exc)
        return cid_int, ""
    return cid_int, str(c.get("name") or "")


def build_failure_card(job: dict, job_id: str = "", campaign_name: str = "") -> dict:
    """飞书交互卡片（红色标题）。卡片结构跟比价表卡片保持一致。"""
    cid, name = _campaign_info(job)
    if campaign_name:
        name = campaign_name
    job_type = str(job.get("type") or "-")
    error = str(job.get("error") or "（没有错误文本）").strip()
    if len(error) > MAX_ERROR_CHARS:
        error = error[:MAX_ERROR_CHARS] + "…（完整内容见日志中心）"
    progress = str((job.get("progress") or {}).get("text") or "-")

    fields = [
        {"is_short": True, "text": {"tag": "lark_md", "content": f"**作业号**\n{job_id or '-'}"}},
        {"is_short": True, "text": {"tag": "lark_md", "content": f"**动作**\n{job_cn(job_type)}"}},
        {"is_short": True, "text": {"tag": "lark_md",
                                    "content": f"**任务**\n" + (f"#{cid} {name}".strip() if cid else "（非任务类作业）")}},
        {"is_short": True, "text": {"tag": "lark_md", "content": f"**发起人**\n{job.get('created_by') or '-'}"}},
        {"is_short": True, "text": {"tag": "lark_md", "content": f"**失败时间**\n{_fmt_ts(job.get('finished_at'))}"}},
        {"is_short": True, "text": {"tag": "lark_md",
                                    "content": f"**用时**\n{_duration(job.get('started_at'), job.get('finished_at'))}"}},
    ]
    elements = [
        {"tag": "div", "fields": fields},
        {"tag": "hr"},
        {"tag": "div", "text": {"tag": "lark_md", "content": f"**错误**\n{error}"}},
    ]
    if progress and progress not in ("-", error):
        elements.append({"tag": "div",
                         "text": {"tag": "lark_md", "content": f"**卡在哪一步**\n{progress[:200]}"}})
    elements.append({"tag": "hr"})
    elements.append({
        "tag": "div",
        "text": {"tag": "lark_md",
                 "content": "🛠 完整堆栈与运行日志：界面「日志中心」→ 作业详情（顶部告警条也能点进来）"},
    })
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "template": "red",
            "title": {"tag": "plain_text", "content": f"❌ 作业失败 · {job_cn(job_type)}"},
        },
        "elements": elements,
    }


async def notify_job_failure(job_id: str, job: dict | None = None) -> dict:
    """把一条失败的作业推到飞书群。**任何情况下都不抛异常。**"""
    job = job or {}
    if not config.FEISHU_ALERT_ENABLED:
        return {"ok": False, "skipped": True, "reason": "FEISHU_ALERT_ENABLED=false"}
    if not notifier.enabled:
        reason = "飞书未配置（FEISHU_APP_ID/SECRET 或 FEISHU_WEBHOOK_URL）"
        try:
            store.add_log("warn", "alerts", f"作业 {job_id} 失败，但{reason}，告警没发出去")
        except Exception:  # noqa: BLE001
            pass
        return {"ok": False, "error": reason}

    target = config.FEISHU_ALERT_CHAT_ID or ""
    try:
        card = build_failure_card(job, job_id=job_id)
        ok = await notifier.send_card(card, chat_id=target or None)
    except Exception as exc:  # noqa: BLE001
        logger.error("失败告警推送异常: %s", exc)
        try:
            store.add_log("error", "alerts", f"作业 {job_id} 失败告警推送异常：{exc}")
        except Exception:  # noqa: BLE001
            pass
        return {"ok": False, "error": str(exc)}

    try:
        if ok:
            store.add_log("info", "alerts", f"作业 {job_id} 失败告警已推送飞书群 {target or '(默认群)'}")
        else:
            store.add_log("error", "alerts",
                          f"作业 {job_id} 失败告警推送失败（看服务日志里的飞书返回码）")
    except Exception:  # noqa: BLE001
        pass
    return {"ok": ok, "target": target, "job_id": job_id, "job_type": job.get("type")}
