"""作业处理器：把队列里的作业翻译成一次桥接调用。

import 本模块即完成注册（main.py 在启动时导入）。
"""

import asyncio
import re
import time
from datetime import datetime
from typing import Any

from . import config, repo, store
from .bridge import bridge
from .queue import handler, queue
from .report import push_price_report_to_feishu


# --------------------------------------------------------------------------
# 比价任务
# --------------------------------------------------------------------------
async def _apply_blocked(campaign_id: int | None) -> dict:
    """派发任务前，把名单（黑名单 + 放弃名单）翻译成冻结层认的两样东西写进 im.db。

    冻结的 launchCampaign 只按 image_contacts 去重、冻结的追问只跳过台账
    status='dropped' —— 都不认名单。所以这一步不做，"名单"就只对手动联系生效
    （2026-10-15 实测：10-12 就拉黑的商家，今天照样被联系 + 追问）。
    """
    cid = int(campaign_id or 0)
    if not cid:
        return {}
    blocked, _white = _contact_filters(cid)
    # 名单为空也要写一次：清掉 im.db 里的持久化名单，避免取消拉黑后
    # CLI/调度器仍按旧名单拦截。
    try:
        return await bridge.call("campaign.applyBlocked",
                                 {"campaignId": cid, "keys": blocked}, timeout=300)
    except Exception as exc:  # noqa: BLE001  —— 名单落地失败不该拦住任务
        return {"error": str(exc), "keys": len(blocked)}


@handler("campaign.launch")
async def _campaign_launch(payload: dict) -> dict:
    """启动 + 自愈补发。

    启动阶段点卡片「联系卖家」偶尔点不动（实测：第 2 家会退化成直接开链接，
    窗口不激活会话 → 短语超时没发出去）。跑完立刻补一遍：
    补发是"切会话再发"，不依赖卡片点击，能把这个漏补上。
    """
    cid = int(payload.get("id") or 0)
    applied = await _apply_blocked(cid)
    blocked, _white = _contact_filters(cid)
    launch_args = dict(payload, blocked=blocked)
    launched = await bridge.call("campaign.launch", launch_args, timeout=3600)
    try:
        sc = (launched or {}).get("screen") or {}
        if sc:
            store.add_log(
                "info" if sc.get("matched") else "warn", "campaign",
                f"任务 {payload.get('id')} 商品名称 AI 审核："
                f"符合 {sc.get('matched', 0)} / 跳过 {sc.get('skipped', 0)}"
                f"（共审 {sc.get('checked', 0)} 条）"
            )
    except Exception:  # noqa: BLE001  —— 日志失败不影响主流程
        pass
    try:
        fixed = await bridge.call("campaign.resend", {"id": cid, "blocked": blocked}, timeout=3600)
    except Exception as exc:  # noqa: BLE001
        fixed = {"error": str(exc)}
    return {"launch": launched, "resend": fixed, "blocked": applied}


@handler("campaign.collect")
async def _campaign_collect(payload: dict) -> dict:
    cid = int(payload.get("id") or 0)
    await _apply_blocked(cid)
    blocked, _white = _contact_filters(cid)
    res = await bridge.call("campaign.collect", dict(payload, blocked=blocked), timeout=3600)
    # 事件泵触发的单会话采集：处理到 0 个（会话没加载/没匹配上）时退回 pending，
    # 别把消息事件永久吞掉；正常批量采集没有 _eventId，不受影响。
    event_id = payload.get("_eventId")
    if event_id:
        try:
            await bridge.call("events.ack", {
                "id": int(event_id),
                # opened=0 表示会话没打开/没匹配上，退回 pending 重试；
                # 打开成功但“没有新消息”也算处理完成。
                "ok": bool((res or {}).get("opened")),
            }, timeout=30)
        except Exception as exc:  # noqa: BLE001
            store.add_log("warn", "events", f"事件 {event_id} 回执失败：{exc}")
    return res


@handler("campaign.advance")
async def _campaign_advance(payload: dict) -> dict:
    cid = int(payload.get("id") or 0)
    await _apply_blocked(cid)
    blocked, _white = _contact_filters(cid)
    return await bridge.call("campaign.advance", dict(payload, blocked=blocked), timeout=3600)


@handler("campaign.resend")
async def _campaign_resend(payload: dict) -> dict:
    """补发询价短语：把"联系过但短语没发出去"的商家补一遍。"""
    cid = int(payload.get("id") or 0)
    await _apply_blocked(cid)
    blocked, _white = _contact_filters(cid)
    return await bridge.call("campaign.resend", dict(payload, blocked=blocked), timeout=3600)


# --------------------------------------------------------------------------
# 自动采集：客户独立计时 → 回复即解析 → 超时追问 → 逐客户完成
# --------------------------------------------------------------------------
def _job_canceled(job_id: str) -> bool:
    """作业被"停止"了没（/api/jobs/{id}/cancel 只改状态，这里轮询它）。"""
    if not job_id:
        return False
    job = store.get_job(job_id) or {}
    return job.get("status") == "canceled"


async def _sleep_watch(seconds: float, job_id: str) -> bool:
    """等待若干秒，期间每 2 秒查一次是否被取消。返回 True = 被取消。"""
    end = time.time() + max(0.0, float(seconds))
    while time.time() < end:
        if _job_canceled(job_id):
            return True
        await asyncio.sleep(min(2.0, max(0.1, end - time.time())))
    return _job_canceled(job_id)


def _chat_time_ms(value: Any) -> int:
    """把聊天页的绝对时间转成毫秒；识别不了返回 0。"""
    text = str(value or "").strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S"):
        try:
            return int(datetime.strptime(text, fmt).timestamp() * 1000)
        except ValueError:
            pass
    return 0


_NORM_RE = re.compile(r"有限责任公司|有限公司|公司|工厂|厂|商行|店|批发|\s+")
_BASIS_CN = {
    "absolute": "直接报价", "page_plus": "页面价加价",
    "page_minus": "页面价减价", "page_same": "与页面价相同", "unknown": "口径未知",
}
_STATUS_CN = {
    "quoted": "已报价", "asking": "已追问", "dropped": "已放弃",
    "need_human": "需人工联系", "give_up": "信息止步",
    "pending": "待跟进", "new": "新会话",
}


def _norm_name(s: Any) -> str:
    return _NORM_RE.sub("", str(s or ""))


def _render_session_table(campaign_id: int, rows: list[dict]) -> str:
    """把本次采集结果渲染成一条可以直接发出去的「会话表」文本。"""
    campaign = repo.get_campaign(campaign_id) or {}
    head = f"【{campaign.get('name') or ('任务' + str(campaign_id))}】采集会话表 " + \
        time.strftime("%m-%d %H:%M")
    lines = [head, "-" * 16]
    priced = 0
    replied: set[str] = set()
    for i, r in enumerate(rows, 1):
        price = r.get("unit_price_final")
        if price is not None:
            priced += 1
        shop = str(r.get("offer_shop_name") or r.get("supplier_wangwang") or "-").split(":")[0][:18]
        replied.add(_norm_name(shop))
        page = r.get("page_price_num")
        lines.append(
            f"{i}. {shop}｜报价 {('¥' + str(price)) if price is not None else '未报价'}"
            f"｜页面价 {page if page is not None else '-'}"
            f"｜{_BASIS_CN.get(str(r.get('price_basis') or ''), r.get('price_basis') or '-')}"
            f"｜{_STATUS_CN.get(str(r.get('status') or ''), r.get('status') or '-')}"
        )
    lines.append("-" * 16)
    lines.append(f"共解析 {len(rows)} 家｜已报价 {priced} 家｜未报价 {len(rows) - priced} 家")
    try:
        silent = [
            str(c.get("shop_name") or c.get("seller_nick") or "")
            for c in repo.campaign_contacts(campaign_id)
            if _norm_name(c.get("shop_name") or c.get("seller_nick")) not in replied
        ]
        silent = [s for s in silent if s]
        if silent:
            lines.append("还没开口：" + "、".join(silent[:6]) + ("…" if len(silent) > 6 else ""))
    except Exception:  # noqa: BLE001
        pass
    return "\n".join(lines)[:1800]


@handler("campaign.autocollect")
async def _campaign_autocollect(payload: dict) -> dict:
    """按客户独立计时的自动采集。

    每个客户从最近一次发言开始独立计时。超时最多主动追问两次；第二次仍未
    回复后进入静默等待，不再主动打扰。客户任何新回复都会立即触发 AI 解析和
    回答，并重新获得两次超时追问机会。任务持续到总运行时长上限或人工停止。
    """
    job_id = str(payload.get("_jobId") or "")
    cid = int(payload.get("id") or 0)
    mode = str(payload.get("mode") or "send")
    duration_sec = max(0, int(payload.get("duration_sec") or 0))
    step_only = bool(payload.get("step_only"))
    step_runtime_sec = max(0, int(payload.get("step_runtime_sec") or 0))
    reply_timeout_sec = max(1, int(payload.get("reply_timeout_sec") or 60))
    timeout_ms = reply_timeout_sec * 1000
    raw_followups = payload.get("max_followups")
    max_followups = 2 if raw_followups is None else max(0, min(2, int(raw_followups)))
    followup_text = str(payload.get("followup_text") or "")
    ensure_sent = bool(payload.get("ensure_sent", True))
    send_table = bool(payload.get("send_table"))
    table_target = str(payload.get("table_target") or "")
    guards = store.get_guards()

    # 名单先"落地"（写 dropped 台账 + 结果页清单），再据此建目标与追问名单
    blocked_applied = await _apply_blocked(cid)
    blocked_keys, blocked_names = _contact_filters(cid)
    blocked_norm = {_norm_shop(x) for x in (list(blocked_keys) + list(blocked_names)) if x}
    blocked_norm.discard("")

    def prog(text: str) -> None:
        if job_id:
            try:
                queue.progress(job_id, text)
            except Exception:  # noqa: BLE001
                pass

    async def completeness() -> dict:
        """本任务比价单需求收齐了没（判定标准在冻结源码的 missingQuoteFields）。"""
        try:
            return await bridge.call("campaign.completeness", {"id": cid}, timeout=300)
        except Exception as exc:  # noqa: BLE001
            return {"error": str(exc)}

    t0 = time.time()
    now_ms = lambda: int(time.time() * 1000)  # noqa: E731
    elapsed = lambda: time.time() - t0  # noqa: E731

    contact_data = await bridge.call("campaign.roundStates", {"id": cid})
    contacts = (contact_data or {}).get("items") or []
    targets: list[dict] = []
    seen: set[str] = set()
    for c in contacts:
        status = str(c.get("contactStatus") or "").strip().lower()
        if status in {"dropped", "failed", "no-link", "duplicate", "skipped-duplicate",
                      "blocked", "excluded", "skipped-not-doing", "dry"}:
            continue
        name = str(c.get("name") or c.get("sellerNick") or "").strip()
        key = str(c.get("convKey") or "").strip()
        if not name and not key:
            continue
        if name and _norm_shop(name) in blocked_norm:    # 名单里的商家不进目标
            continue
        if name in seen:
            continue
        seen.add(name)
        completed = 0
        timeout_followups = min(max_followups, max(0, int(c.get("taskAttempts") or 0)))
        last_sent_at = int(c.get("lastSentAt") or 0)
        last_inbound_at = int(c.get("lastInboundAt") or 0)
        latest_inbound_at = int(c.get("latestInboundAt") or 0)
        unseen_inbound = latest_inbound_at > last_inbound_at
        deadline = int(c.get("nextActionAt") or 0)
        quote_status = str(c.get("quoteStatus") or "")
        task_state = str(c.get("state") or "")
        dropped = quote_status == "dropped" or task_state == "dropped"
        silent = not unseen_inbound and (
            (not dropped and timeout_followups >= max_followups) or
            task_state in ("waiting_silent", "quoted", "need_human", "needs_human", "give_up")
        )
        if unseen_inbound:
            deadline = now_ms()
        if silent:
            deadline = 0
        else:
            activity_at = max(last_sent_at, last_inbound_at)
            if deadline <= 0 or (activity_at > 0 and deadline < activity_at):
                deadline = (activity_at + timeout_ms) if activity_at else (now_ms() + timeout_ms)
        terminal = dropped
        done = terminal
        reason = ""
        if terminal:
            reason = str(c.get("terminalReason") or quote_status or task_state or "已结束")
        targets.append({
            "convKey": key,
            "name": name,
            "offerId": str(c.get("offerId") or ""),
            "completed": completed,
            "followups": timeout_followups,
            "deadlineAt": deadline,
            "lastSentAt": last_sent_at,
            "lastInboundAt": last_inbound_at,
            "latestInboundAt": latest_inbound_at,
            "unseenInbound": unseen_inbound,
            "state": str(c.get("state") or "waiting"),
            "decision": str(c.get("decision") or ""),
            "quoteStatus": quote_status,
            "done": done,
            "doneReason": reason,
            "retryAt": 0,
            "lastAction": reason if done else (
                "检测到未处理的新入站消息" if unseen_inbound else
                ("静默等待客户回复" if silent else "等待客户回复")
            ),
        })

    summary: dict = {
        "campaign": cid, "mode": mode, "rounds_planned": 0, "rounds_done": 0,
        "followup_limit": max_followups,
        "reply_timeout_sec": reply_timeout_sec,
        "max_followups": max_followups, "targets": len(targets),
        "followups": 0, "stopped": "", "sent_table": False, "steps": [],
        "blocked_applied": blocked_applied, "customers": [],
    }
    if not targets:
        summary["stopped"] = "该任务还没有联系过任何商家，先执行「启动」"
        return summary

    # ① 自动发送：先把没发成功的询价短语补上（演练模式不动浏览器）
    if ensure_sent and mode != "dry":
        prog("补发没发出去的询价短语…")
        try:
            r = await bridge.call("campaign.resend", {
                "id": cid, "blocked": blocked_keys + blocked_names,
            }, timeout=3600)
            still = r.get("stillFailed") or []
            summary["resend"] = {
                "total": r.get("total"), "sent": r.get("sent"), "failed": r.get("failed"),
                "rounds": r.get("rounds") or [],
                # 多轮补发后仍没收到询价的商家（图+文没都发出去）——单独列出来，避免"静默漏发"
                # permanent=会话不存在这类，再补也没用，需要人工处理
                "still_failed": [
                    {"shop": x.get("shop") or x.get("offerId"),
                     "attempts": x.get("attempts"), "permanent": bool(x.get("permanent")),
                     "why": x.get("why")}
                    for x in still
                ],
            }
        except Exception as exc:  # noqa: BLE001
            summary["resend"] = {"error": str(exc)}

    states = {t["convKey"]: t for t in targets}

    async def persist(st: dict) -> None:
        try:
            await bridge.call("campaign.roundPatch", {
                "campaignId": cid, "convKey": st["convKey"],
                "shopName": st["name"], "offerId": st["offerId"],
                "state": "dropped" if st["done"] else
                         ("waiting_silent" if st["deadlineAt"] <= 0 else "waiting"),
                "decision": st["decision"] or
                            ("silent_wait" if (not st["done"] and st["deadlineAt"] <= 0) else "waiting"),
                "attempts": st["followups"],
                "lastSentAt": st["lastSentAt"] or None,
                "lastInboundAt": st["lastInboundAt"] or None,
                "nextActionAt": 0 if st["done"] else st["deadlineAt"],
                "terminalReason": st["doneReason"] if st["done"] else "",
            }, timeout=60)
        except Exception as exc:  # noqa: BLE001
            store.add_log("warn", "campaign", f"客户轮次状态写回失败（{st['name']}）：{exc}")

    async def refresh(keys: set[str] | None = None) -> None:
        try:
            rr = await bridge.call("campaign.roundStates", {"id": cid}, timeout=300)
        except Exception as exc:  # noqa: BLE001
            store.add_log("warn", "campaign", f"读取客户轮次状态失败：{exc}")
            return
        for row in (rr or {}).get("items") or []:
            key = str(row.get("convKey") or "")
            st = states.get(key)
            if st is None or (keys is not None and key not in keys):
                continue
            st["followups"] = min(
                max_followups,
                max(st["followups"], max(0, int(row.get("taskAttempts") or 0))),
            )
            st["lastSentAt"] = max(st["lastSentAt"], int(row.get("lastSentAt") or 0))
            st["lastInboundAt"] = max(st["lastInboundAt"],
                                       int(row.get("lastInboundAt") or 0))
            latest_inbound_at = int(row.get("latestInboundAt") or 0)
            st["quoteStatus"] = str(row.get("quoteStatus") or "")
            quote_status = str(row.get("quoteStatus") or "")
            task_state = str(row.get("state") or "")
            if quote_status == "dropped" or task_state == "dropped":
                st["done"] = True
                st["doneReason"] = str(row.get("terminalReason") or "客户明确不做")
            elif task_state in ("waiting_silent", "quoted", "need_human", "needs_human", "give_up"):
                st["deadlineAt"] = 0
                if task_state == "waiting_silent":
                    st["decision"] = "silent_wait"
            # 新入站必须高于历史静默/转人工状态；否则客户主动回复后仍会 forever 静默。
            if latest_inbound_at > st["lastInboundAt"] and not st["done"]:
                st["latestInboundAt"] = latest_inbound_at
                st["unseenInbound"] = True
                st["deadlineAt"] = now_ms()
                st["retryAt"] = 0
                st["state"] = "waiting"
                st["decision"] = "new_inbound"
                st["lastAction"] = "检测到未处理的新入站消息"

    async def finish_round(st: dict, why: str, previous_completed: int = 0) -> None:
        """客户有回复：产生一个新问答回合，并重置该客户的两次超时追问额度。"""
        _ = previous_completed
        st["completed"] += 1
        st["followups"] = 0
        st["lastAction"] = why
        if st["done"]:
            return
        st["deadlineAt"] = now_ms() + timeout_ms
        st["retryAt"] = 0
        st["state"] = "waiting"
        st["decision"] = "waiting"
        await persist(st)

    async def collect_one(st: dict, source: str) -> tuple[dict, bool]:
        started = now_ms() - 1000
        previous_completed = st["completed"]
        try:
            res = await bridge.call("campaign.collect", {
                "id": cid, "onlyConvKeys": [st["convKey"]], "slice": 1,
                "mode": mode, "maxFollowups": 50,
                "blocked": blocked_keys + blocked_names,
            }, timeout=1800)
        except Exception as exc:  # noqa: BLE001
            res = {"error": str(exc), "opened": 0}
        try:
            replies = await bridge.call("campaign.replies", {
                "id": cid, "since": started, "limit": 50,
            }, timeout=60) or []
        except Exception:  # noqa: BLE001
            replies = []
        has_reply = any(
            str(r.get("conv_key") or "") == st["convKey"]
            and bool(str(r.get("inbound_text") or "").strip())
            and str(r.get("ai_action") or "") not in ("nudge", "nudge_failed")
            for r in replies
        )
        before_inbound = st["lastInboundAt"]
        await refresh({st["convKey"]})
        has_reply = has_reply or st["lastInboundAt"] > before_inbound
        if has_reply:
            await finish_round(st, f"{source}：AI 已采集解析", previous_completed)
        return res, has_reply

    async def latest_ui_inbound() -> tuple[int, str]:
        """读当前聊天窗口最后一条对方消息。

        `collect_one` 刚打开过目标会话，所以这里读到的就是该客户。用于堵住
        “客户消息刚出现、超时追问同时发出”的 1～2 秒竞态。
        """
        try:
            rows = await bridge.call("messages.read", {}, timeout=60) or []
        except Exception:  # noqa: BLE001
            return 0, ""
        for m in reversed(rows):
            if str(m.get("kind") or "") != "msg" or m.get("mine"):
                continue
            text = str(m.get("text") or "").strip()
            if text or m.get("imageUrl"):
                return _chat_time_ms(m.get("time")), text or "[图片]"
        return 0, ""

    async def nudge_one(st: dict) -> tuple[dict, bool]:
        previous_followups = st["followups"]
        try:
            nr = await bridge.call("campaign.nudge", {
                "id": cid,
                "targets": [{
                    "convKey": st["convKey"], "name": st["name"],
                    "offerId": st["offerId"],
                }],
                "text": followup_text,
                "blocked": blocked_keys + blocked_names, **guards,
            }, timeout=1800)
        except Exception as exc:  # noqa: BLE001
            nr = {"error": str(exc), "sent": 0, "results": []}
        result = next(iter(nr.get("results") or []), {})
        ok = bool(result.get("ok"))
        await refresh({st["convKey"]})
        if ok:
            st["lastSentAt"] = now_ms()
            st["followups"] = min(
                max_followups,
                max(st["followups"], previous_followups + 1),
            )
            summary["followups"] += 1
            if st["followups"] >= max_followups:
                st["deadlineAt"] = 0
                st["retryAt"] = 0
                st["state"] = "waiting_silent"
                st["decision"] = "silent_wait"
                st["lastAction"] = f"已完成 {max_followups} 次超时追问，静默等待客户回复"
            else:
                st["deadlineAt"] = now_ms() + timeout_ms
                st["retryAt"] = 0
                st["state"] = "waiting"
                st["decision"] = "waiting"
                st["lastAction"] = f"第 {st['followups']}/{max_followups} 次超时追问已发送"
            await persist(st)
        else:
            # 追问失败绝不消耗次数；20 秒后重试，避免被 20 秒发送护栏
            # 拦住后立刻空转，也避免 60 秒等待被重复拉长。
            retry_sec = max(20, min(30, reply_timeout_sec))
            st["retryAt"] = now_ms() + retry_sec * 1000
            st["lastAction"] = "追问失败，等待重试：" + str(
                result.get("blocked") or result.get("why") or nr.get("error") or "未知原因"
            )
        return nr, ok

    def progress_text() -> str:
        active = [s for s in states.values() if not s["done"]]
        if not active:
            return "所有客户均已结束"
        now = now_ms()
        scheduled = [s for s in active if s["retryAt"] or s["deadlineAt"]]
        if not scheduled:
            return f"{len(active)} 家已静默等待客户回复（新回复会立即处理）"
        nearest = min(scheduled, key=lambda x: x["retryAt"] or x["deadlineAt"])
        until = max(0, (nearest["retryAt"] or nearest["deadlineAt"]) - now)
        return (f"{len(active)} 家等待中｜{nearest['name']} 已问答 {nearest['completed']} 轮、"
                f"超时追问 {nearest['followups']}/{max_followups}，"
                f"{int((until + 999) // 1000)}s 后{'重试追问' if nearest['retryAt'] else '超时判定'}")

    # ② 按客户独立推进：先消费实时回复，再处理只属于该客户的超时。
    while any(not s["done"] for s in states.values()):
        if _job_canceled(job_id):
            summary["stopped"] = "手动停止"
            break
        if duration_sec and elapsed() >= duration_sec:
            summary["stopped"] = f"已到时间上限 {duration_sec}s"
            break
        if step_runtime_sec and elapsed() >= step_runtime_sec:
            summary["step_paused"] = True
            summary["stopped"] = f"步骤时间上限 {step_runtime_sec}s"
            break

        try:
            ev = await bridge.call("events.tick", {
                "campaignId": cid, "limit": max(5, len(states)),
                "maxAgeSec": max(60, int(config.EVENT_PUMP_MAX_AGE_SEC)),
            }, timeout=60)
            for item in (ev or {}).get("items") or []:
                if int(item.get("campaignId") or 0) != cid:
                    continue
                key = str(item.get("convKey") or "")
                st = states.get(key)
                if not st or st["done"]:
                    try:
                        await bridge.call("events.ack", {
                            "id": int(item.get("eventId") or 0), "ok": True,
                        }, timeout=30)
                    except Exception:  # noqa: BLE001
                        pass
                    continue
                prog(f"{st['name']} 收到新消息，立即采集解析…")
                res, replied = await collect_one(st, "客户回复")
                try:
                    await bridge.call("events.ack", {
                        "id": int(item.get("eventId") or 0),
                        "ok": bool((res or {}).get("opened")),
                    }, timeout=30)
                except Exception as exc:  # noqa: BLE001
                    store.add_log("warn", "events", f"事件 {item.get('eventId')} 回执失败：{exc}")
                summary["steps"].append({
                    "at": now_ms(), "customer": st["name"],
                    "round": st["completed"], "event": "reply",
                    "replied": replied, "action": st["lastAction"],
                })
        except Exception as exc:  # noqa: BLE001
            store.add_log("warn", "campaign", f"自动采集读取客户回复失败：{exc}")

        now = now_ms()
        due = [
            s for s in states.values()
            if not s["done"] and (s["retryAt"] or s["deadlineAt"])
            and now >= (s["retryAt"] or s["deadlineAt"])
        ]
        due.sort(key=lambda x: x["retryAt"] or x["deadlineAt"])
        for st in due:
            if st["done"]:
                continue
            prog(f"{st['name']} 已到 {reply_timeout_sec}s → 先采集确认，再按需追问")
            # 到期先打开这个客户的会话确认一次，避免"回复刚到、事件还没落库"
            # 就误发超时追问。
            prior_inbound = st["lastInboundAt"]
            _res, replied = await collect_one(st, "超时前复核")
            if replied or st["done"]:
                continue

            # 再给聊天页 2 秒落定：实测出现过客户 18:17:21 回复、系统
            # 18:17:22 就发通用追问的竞态。发现新消息后先补做 AI 解析，
            # 解析失败也不发通用追问，留给下一轮重试。
            if await _sleep_watch(2, job_id):
                summary["stopped"] = "手动停止"
                break
            live_at, live_text = await latest_ui_inbound()
            if live_at > prior_inbound:
                store.add_log(
                    "info", "campaign",
                    f"{st['name']} 超时边界收到新消息：{live_text[:80]}",
                )
                _res2, replied2 = await collect_one(st, "超时边界新消息")
                if replied2 or st["done"]:
                    continue
                st["retryAt"] = now_ms() + 5000
                st["lastAction"] = "客户有新消息，已暂停通用追问，等待重新解析"
                continue
            nr, sent = await nudge_one(st)
            summary["steps"].append({
                "at": now_ms(), "customer": st["name"],
                "round": st["completed"], "event": "timeout",
                "sent": sent, "action": st["lastAction"],
                "detail": {
                    "sent": (nr or {}).get("sent"),
                    "failed": (nr or {}).get("failed"),
                    "blocked": (nr or {}).get("blocked"),
                    "error": (nr or {}).get("error"),
                },
            })

        active = [s for s in states.values() if not s["done"]]
        if not active:
            summary["stopped"] = "所有客户均已结束"
            break
        prog(progress_text())
        scheduled = [s["retryAt"] or s["deadlineAt"] for s in active
                     if s["retryAt"] or s["deadlineAt"]]
        next_ms = min(scheduled) if scheduled else (now_ms() + 2000)
        pause = max(0.2, min(2.0, (next_ms - now_ms()) / 1000))
        if await _sleep_watch(pause, job_id):
            summary["stopped"] = "手动停止"
            break

    # 分步模式只跑一小段，审计/报表由流程调度器在流程结束时统一执行。
    if step_only:
        summary["customers"] = [{
            "name": s["name"], "conv_key": s["convKey"],
            "rounds_done": s["completed"],
            "followups": s["followups"],
            "followup_limit": max_followups,
            "state": "done" if s["done"] else
                     ("silent_wait" if s["deadlineAt"] <= 0 else "waiting"),
            "reason": s["doneReason"] or s["lastAction"],
            "next_action_at": 0 if s["done"] else s["deadlineAt"],
        } for s in sorted(states.values(), key=lambda x: x["name"])]
        summary["all_done"] = all(s["done"] for s in states.values())
        summary["completeness"] = await completeness()
        summary["rounds_done"] = max((s["completed"] for s in states.values()), default=0)
        summary["elapsed_sec"] = int(elapsed())
        if not summary["stopped"]:
            summary["stopped"] = "步骤完成，继续等待"
        return summary

    # ⑥ 补分析：用库里的入站文本补判一次
    # （被顺手抓取(sweep)进库的回复不走实时通道，冻结分析器拿到的入站文本是空的，
    #   不补这一步就会出现"商家明明说做不了，系统反而去追问"——2026-10-15 实测）
    if mode != "dry":
        prog("补分析：用库里的入站文本补判一次（做不了→放弃）…")
        try:
            summary["audit"] = await bridge.call("campaign.auditReplies", {"id": cid}, timeout=1800)
            prog(f"补分析完成：检查 {summary['audit'].get('checked')} 家，新判放弃 {summary['audit'].get('dropped')} 家")
        except Exception as exc:  # noqa: BLE001
            summary["audit"] = {"error": str(exc)}

    # ⑦ 会话表（可选发送）
    try:
        rows = repo.compare(campaign_id=cid, limit=200)
    except Exception as exc:  # noqa: BLE001
        rows = []
        summary["table_error"] = str(exc)
    summary["table_rows"] = len(rows)
    summary["table"] = _render_session_table(cid, rows)
    if send_table and table_target and rows:
        prog(f"发送本次会话表到「{table_target}」…")
        try:
            await bridge.call("send.to", {
                "convName": table_target, "text": summary["table"],
                "blocked": blocked_keys + blocked_names,
            }, timeout=600)
            summary["sent_table"] = True
        except Exception as exc:  # noqa: BLE001
            summary["table_error"] = str(exc)

    # ⑦ 飞书推送（可选）：比价表总结 + 比价表文件
    if payload.get("send_feishu"):
        prog("推送飞书：比价表总结 + 比价表文件…")
        try:
            summary["feishu"] = await push_price_report_to_feishu(
                cid,
                str(payload.get("feishu_chat_id") or ""),
                bool(payload.get("feishu_file", True)),
            )
        except Exception as exc:  # noqa: BLE001
            summary["feishu"] = {"ok": False, "error": str(exc)}

    summary["rounds_done"] = max((s["completed"] for s in states.values()), default=0)
    summary["customers"] = [{
        "name": s["name"], "conv_key": s["convKey"],
        "rounds_done": s["completed"],
        "followups": s["followups"],
        "followup_limit": max_followups,
        "state": "done" if s["done"] else
                 ("silent_wait" if s["deadlineAt"] <= 0 else "waiting"),
        "reason": s["doneReason"] or s["lastAction"],
        "next_action_at": 0 if s["done"] else s["deadlineAt"],
    } for s in sorted(states.values(), key=lambda x: x["name"])]
    summary["completeness"] = await completeness()
    if not summary["stopped"]:
        summary["stopped"] = "所有客户均已结束"
    summary["elapsed_sec"] = int(elapsed())
    return summary


@handler("campaign.fullauto.flow")
async def _campaign_fullauto_flow(payload: dict) -> dict:
    """全自动流程协调器：只创建父流程和第一个小步骤，不长时间占用队列。"""
    cid = int(payload.get("id") or 0)
    try:
        rec = await bridge.call("events.reconcile", {"campaignId": cid}, timeout=120)
        if int((rec or {}).get("recovered") or 0) + int((rec or {}).get("inserted") or 0):
            store.add_log(
                "info", "events",
                f"全自动流程启动前补投入站：重新激活 "
                f"{(rec or {}).get('recovered', 0)} / 补建 {(rec or {}).get('inserted', 0)}",
            )
    except Exception as exc:  # noqa: BLE001
        store.add_log("warn", "events", f"全自动流程启动前入站对账失败：{exc}")
    flow = store.create_flow_run(cid, payload)
    first_kind = "collect" if payload.get("skip_launch") else "advance"
    first = store.create_flow_step(
        flow["id"], cid, 1, first_kind, dict(payload), run_after=0,
    )
    store.add_log(
        "info", "flow",
        f"全自动流程 {flow['id']} 已创建：任务 {cid}，首步 {first_kind}",
    )
    return {
        "campaign": cid, "flow_id": flow["id"], "status": "scheduled",
        "first_step": {"id": first["id"], "kind": first["kind"]},
    }


@handler("flow.step")
async def _flow_step(payload: dict) -> dict:
    """执行一个全自动小步骤；下一步由流程调度器按时间投递。"""
    step_id = str(payload.get("step_id") or "")
    step_job_id = str(payload.get("_jobId") or "")
    step = store.get_flow_step(step_id)
    if not step:
        return {"error": f"流程步骤不存在：{step_id}"}
    flow = store.get_flow_run(step["flow_id"])
    if not flow:
        return {"error": f"流程不存在：{step['flow_id']}"}
    base = dict(flow.get("payload") or {})
    base.update(step.get("payload") or {})
    if step_job_id:
        # 内层自动采集要检查“当前这个 flow.step 作业”是否被终止，
        # 不能继续沿用最初创建流程时那个已经完成的作业号。
        base["_jobId"] = step_job_id
    cid = int(step["campaign_id"])
    now = int(time.time() * 1000)
    camp = repo.get_campaign(cid)
    if not camp or str(camp.get("status") or "") not in ("running", "collecting"):
        store.update_flow_step(step_id, status="canceled", error="任务已暂停/归档")
        store.update_flow_run(flow["id"], status="canceled")
        return {"step": step_id, "stopped": "任务已暂停/归档"}
    store.update_flow_step(step_id, status="running")

    def stopped_result() -> dict | None:
        latest_flow = store.get_flow_run(flow["id"]) or {}
        if not _job_canceled(step_job_id) and latest_flow.get("status") == "running":
            return None
        store.update_flow_step(step_id, status="canceled", error="用户终止任务")
        if latest_flow.get("status") == "running":
            store.update_flow_run(flow["id"], status="canceled")
        store.add_log("info", "flow", f"流程 {flow['id']} 已按用户操作终止")
        return {"step": step_id, "stopped": "用户终止任务"}

    stopped = stopped_result()
    if stopped:
        return stopped

    def next_step(kind: str, delay_ms: int = 0, **extra) -> dict:
        nxt_payload = {**base, **extra, "step_only": kind == "collect"}
        nxt = store.create_flow_step(
            flow["id"], cid, int(step["step_no"]) + 1, kind,
            nxt_payload, run_after=int(time.time() * 1000) + max(0, int(delay_ms)),
        )
        store.add_log(
            "info", "flow",
            f"流程 {flow['id']} 下一步排期：{kind}（{delay_ms}ms 后）",
        )
        return {"id": nxt["id"], "kind": kind, "run_after": nxt["run_after"]}

    try:
        if step["kind"] == "advance":
            limit = max(1, int(base.get("limit") or base.get("perTask") or 10))
            res = await _campaign_advance({
                **base, "id": cid,
                "perTask": limit, "slice": 1,
                "mode": base.get("mode") or "send",
                "dry": not bool(base.get("yes", True)),
            })
            stopped = stopped_result()
            if stopped:
                return stopped
            contacted_data = await bridge.call("campaign.contactedShops", {"id": cid}, timeout=120)
            contacted = int((contacted_data or {}).get("count") or 0)
            stage = str((res or {}).get("stage") or "")
            if not bool(base.get("yes", True)):
                nxt = next_step("audit", 0)
            elif stage == "contacted" or contacted >= limit:
                nxt = next_step("collect", int(base.get("wait_sec") or 60) * 1000)
            else:
                nxt = next_step("advance", 2500)
            store.update_flow_step(step_id, status="done")
            return {"step": step_id, "kind": "advance", "result": res,
                    "contacted": contacted, "next": nxt}

        if step["kind"] == "collect":
            flow_age = max(0, (now - int(flow.get("created_at") or now)) / 1000)
            total_limit = int(base.get("duration_sec") or 0)
            remaining = 0
            if total_limit > 0:
                remaining = max(0, int(total_limit - flow_age))
                if remaining <= 0:
                    nxt = next_step("audit", 0)
                    store.update_flow_step(step_id, status="done")
                    return {"step": step_id, "kind": "collect",
                            "stopped": "流程时长上限", "next": nxt}
            res = await _campaign_autocollect({
                **base, "id": cid, "step_only": True,
                "step_runtime_sec": 20, "duration_sec": remaining,
                "ensure_sent": False, "send_feishu": False,
            })
            stopped = stopped_result()
            if stopped:
                return stopped
            all_done = bool((res or {}).get("all_done")) or \
                bool(((res or {}).get("completeness") or {}).get("all_complete"))
            if all_done:
                nxt = next_step("audit", 0)
            else:
                nxt = next_step("collect", int(base.get("wait_sec") or 60) * 1000)
            store.update_flow_step(step_id, status="done")
            return {"step": step_id, "kind": "collect", "result": res,
                    "all_done": all_done, "next": nxt}

        if step["kind"] == "audit":
            audit = await _campaign_audit_replies({**base, "id": cid})
            stopped = stopped_result()
            if stopped:
                return stopped
            result = {"audit": audit}
            if base.get("send_table") and str(base.get("table_target") or "").strip():
                try:
                    rows = repo.compare(campaign_id=cid, limit=200)
                    if rows:
                        await bridge.call("send.to", {
                            "convName": str(base.get("table_target") or ""),
                            "text": _render_session_table(cid, rows),
                            "blocked": [],
                        }, timeout=600)
                        result["table_sent"] = True
                except Exception as exc:  # noqa: BLE001
                    result["table_error"] = str(exc)
                stopped = stopped_result()
                if stopped:
                    return stopped
            if base.get("send_feishu", True):
                try:
                    result["feishu"] = await push_price_report_to_feishu(
                        cid, str(base.get("feishu_chat_id") or ""),
                        bool(base.get("feishu_file", True)),
                    )
                except Exception as exc:  # noqa: BLE001
                    result["feishu"] = {"ok": False, "error": str(exc)}
            store.update_flow_step(step_id, status="done")
            store.update_flow_run(flow["id"], status="done")
            store.add_log("info", "flow", f"流程 {flow['id']} 已完成")
            return {"step": step_id, "kind": "audit", "result": result}

        raise ValueError(f"未知流程步骤：{step['kind']}")
    except Exception as exc:
        store.update_flow_step(step_id, status="failed", error=str(exc))
        store.update_flow_run(flow["id"], status="failed", payload={**flow.get("payload", {}), "error": str(exc)})
        store.add_log("error", "flow", f"流程 {flow['id']} 第 {step['step_no']} 步失败：{exc}")
        raise


@handler("campaign.fullauto")
async def _campaign_fullauto(payload: dict) -> dict:
    """全自动比价：启动（含漏发自愈）→ 自动采集 → 飞书推送总结 + 比价表文件。

    三个阶段的参数都从同一个 payload 来：
      - 启动：limit（联系几家）、yes
      - 自动采集：reply_timeout_sec（每客户超时） / max_followups（最多2次） /
        duration_sec / followup_text / ensure_sent / send_table / table_target
      - 飞书：send_feishu / feishu_chat_id / feishu_file

    skip_launch=true 用于“服务重启后续跑”：跳过启动/联系商家，只补采集、补分析和推送，
    避免同一批商家被重复询价。
    """
    job_id = str(payload.get("_jobId") or "")
    cid = int(payload.get("id") or 0)

    def prog(text: str) -> None:
        if job_id:
            try:
                queue.progress(job_id, text)
            except Exception:  # noqa: BLE001
                pass

    result: dict = {"campaign": cid}

    if payload.get("skip_launch"):
        prog("① 续跑：跳过启动阶段（不重复联系商家）")
        result["launch"] = {
            "skipped": True,
            "resume_of": payload.get("resume_of") or "",
            "reason": "从中断处续跑，保留已经发出的询价",
        }
    else:
        prog("① 启动：以图搜图 → 联系商家 → 发送询价（含漏发自愈）")
        result["launch"] = await _campaign_launch(dict(payload, yes=True))

    prog("② 自动采集：客户独立计时 → 回复即解析 → 超时追问")
    # 飞书放到全自动的最后统一发，这里先把开关关掉，避免采集阶段重复推一次
    result["autocollect"] = await _campaign_autocollect(dict(payload, send_feishu=False))

    if payload.get("send_feishu", True):
        prog("③ 飞书推送：比价表总结 + 比价表文件")
        try:
            result["feishu"] = await push_price_report_to_feishu(
                cid,
                str(payload.get("feishu_chat_id") or ""),
                bool(payload.get("feishu_file", True)),
            )
        except Exception as exc:  # noqa: BLE001
            result["feishu"] = {"ok": False, "error": str(exc)}
    else:
        result["feishu"] = {"ok": False, "skipped": True, "error": "本次未勾选发送飞书"}

    return result


@handler("scheduler.once")
async def _scheduler_once(payload: dict) -> dict:
    """把所有 running 任务各推进一步（队列轮转的粒度）。"""
    s = store.get_settings()
    campaigns = repo.list_campaigns(100, "running")
    if not campaigns:
        return {"advanced": 0, "detail": "没有 running 状态的任务"}
    per_task = int(payload.get("perTask") or s.get("inquiry_count") or 10)
    slice_ = int(payload.get("slice") or s.get("slice_per_round") or 2)
    mode = payload.get("mode") or s.get("send_mode") or "send"
    dry = bool(payload.get("dry", mode != "send"))
    max_tasks = int(payload.get("maxTasks") or 3)
    results = []
    for c in campaigns[:max_tasks]:
        try:
            blocked, _white = _contact_filters(c["id"])
            r = await bridge.call("campaign.advance", {
                "id": c["id"], "slice": slice_, "perTask": per_task, "mode": mode, "dry": dry,
                "blocked": blocked,
            }, timeout=3600)
            results.append({"id": c["id"], "name": c.get("name"), "ok": True, "result": r})
        except Exception as exc:  # noqa: BLE001
            results.append({"id": c["id"], "name": c.get("name"), "ok": False, "error": str(exc)})
    return {"advanced": len(results), "mode": mode, "dry": dry, "results": results}


# --------------------------------------------------------------------------
# 搜图 / 联系商家
# --------------------------------------------------------------------------
def _norm_shop(s: str) -> str:
    """店名归一化（与冻结源码 db/outreach 里那套保持一致），用于名单比对。"""
    return re.sub(r"公司|厂|店|商行|有限公司|有限责任公司", "", str(s or "")).strip()


@handler("search.image")
async def _search_image(payload: dict) -> dict:
    return await bridge.call("image.search", payload, timeout=900)


@handler("campaign.audit_replies")
async def _campaign_audit_replies(payload: dict) -> dict:
    """补分析（手动触发）：拿库里的入站文本补调 DeepSeek，判"做不了"就落 dropped。"""
    cid = int(payload.get("id") or 0)
    await _apply_blocked(cid)
    return await bridge.call("campaign.auditReplies",
                             {"id": cid, "limit": int(payload.get("limit") or 200)}, timeout=1800)


def _contact_filters(campaign_id: int | None = 0) -> tuple[list[str], list[str]]:
    """联系商家/发送时要排除的名单（黑名单+放弃名单）与白名单。

    campaign_id 给具体任务时：该任务专属名单覆盖全局名单 ——
    同一家商家可以"任务一放弃、任务二照常联系"。
    """
    flags = store.flags_map(campaign_id)
    blocked = [k for k, v in flags.items() if v["list_type"] in ("blacklist", "dropped")]
    blocked += [v.get("conv_name") for v in flags.values()
                if v["list_type"] in ("blacklist", "dropped") and v.get("conv_name")]
    white = [k for k, v in flags.items() if v["list_type"] == "whitelist"]
    white += [v.get("conv_name") for v in flags.values()
              if v["list_type"] == "whitelist" and v.get("conv_name")]
    return sorted({b for b in blocked if b}), sorted({w for w in white if w})


@handler("outreach.contact")
async def _outreach_contact(payload: dict) -> dict:
    args = dict(payload)
    blocked, white = _contact_filters(args.get("campaignId") or args.get("campaign_id") or 0)
    args["blocked"] = blocked
    args["allow"] = white
    return await bridge.call("outreach.contactFiltered", args, timeout=3600)


# --------------------------------------------------------------------------
# 发送
# --------------------------------------------------------------------------
@handler("send.text")
async def _send_text(payload: dict) -> dict:
    if payload.get("conv_key"):
        blocked, _white = _contact_filters(payload.get("campaign_id") or 0)
        return await bridge.call("send.to", {
            "convKey": payload["conv_key"], "convName": payload.get("conv_name", ""),
            "text": payload.get("text", ""),
            "blocked": blocked,
        }, timeout=300)
    return await bridge.call("send.text", {"text": payload.get("text", "")}, timeout=300)


@handler("send.phrase")
async def _send_phrase(payload: dict) -> dict:
    blocked, _white = _contact_filters(payload.get("campaign_id") or 0)
    if payload.get("conv_key"):
        return await bridge.call("send.to", {
            "convKey": payload["conv_key"], "convName": payload.get("conv_name", ""),
            "phraseId": payload.get("phrase_id"), "image": payload.get("image"),
            "order": payload.get("order") or "text-first",
            "campaignId": payload.get("campaign_id"),
            "blocked": blocked,
        }, timeout=600)
    return await bridge.call("send.phrase", {
        "phraseId": payload.get("phrase_id"), "image": payload.get("image"),
        "order": payload.get("order") or "image-first",
        "campaignId": payload.get("campaign_id"),
        "convKey": payload.get("conv_key"),
        "blocked": blocked,
    }, timeout=600)


@handler("send.image")
async def _send_image(payload: dict) -> dict:
    if payload.get("conv_key"):
        blocked, _white = _contact_filters(payload.get("campaign_id") or 0)
        return await bridge.call("send.to", {
            "convKey": payload["conv_key"], "convName": payload.get("conv_name", ""),
            "image": payload.get("file"),
            "blocked": blocked,
        }, timeout=600)
    return await bridge.call("send.image", {"file": payload.get("file")}, timeout=600)


# --------------------------------------------------------------------------
# 自动回复（名单在这里生效）
# --------------------------------------------------------------------------
@handler("autoreply.run")
async def _autoreply_run(payload: dict) -> dict:
    args = dict(payload)
    cid = args.get("campaignId") or 0
    blocked, _white = _contact_filters(cid)
    args["blocked"] = blocked
    if not args.get("onlyConvKeys"):
        keys = repo.all_conv_keys()
        args["onlyConvKeys"] = store.allowed_conv_keys(keys, cid)
    else:
        args["onlyConvKeys"] = store.allowed_conv_keys(args["onlyConvKeys"], cid)
    guards = store.get_guards()
    for k, v in guards.items():
        args.setdefault(k, v)
    args.setdefault("mode", store.get_settings().get("send_mode") or "send")
    return await bridge.call("autoreply.run", args, timeout=3600)


# --------------------------------------------------------------------------
# 运维
# --------------------------------------------------------------------------
@handler("page.refresh")
async def _page_refresh(payload: dict) -> dict:
    return await bridge.call("page.refresh", payload, timeout=300)


@handler("monitor.once")
async def _monitor_once(payload: dict) -> dict:
    return await bridge.call("monitor.once", payload, timeout=300)


@handler("tabs.enforce")
async def _tabs_enforce(payload: dict) -> dict:
    return await bridge.call("tabs.enforce", payload, timeout=120)


@handler("browser.open")
async def _browser_open(payload: dict) -> dict:
    """「状态监控」页的"打开聊天页 / 工作台"：会新建标签页，必须走队列。"""
    return await bridge.call("browser.open", payload, timeout=180)


@handler("browser.login")
async def _browser_login(payload: dict) -> dict:
    """1688 登录：机器切页签、填账号密码、点登录并自动拖动一次滑块。

    凭证**不进作业参数**（作业 payload 会落库、日志中心也看得到）——
    这里在执行时才从 settings 读，返回值里也绝不回显密码。
    """
    s = store.get_settings()
    args = {
        "user": (payload.get("user") or s.get("login_account") or "").strip(),
        "password": s.get("login_password") or "",
        "keepLogin": payload.get("keepLogin", True),
        "waitMs": payload.get("waitMs") or 4000,
        "autoSolveCaptcha": payload.get("autoSolveCaptcha", True),
        "captchaAttempts": payload.get("captchaAttempts") or 1,
        "mode": payload.get("mode") or "password",   # password = 填表登录；qr = 二维码扫码
    }
    return await bridge.call("browser.login", args, timeout=300)


@handler("sweep.run")
async def _sweep(payload: dict) -> dict:
    return await bridge.call("sweep.run", payload, timeout=3600)
