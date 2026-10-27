"""比价任务：CRUD + 阶段推进（搜图 → 联系 → 采集）+ 比价表。"""

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import repo, store
from ..bridge import BridgeError, bridge
from ..feishu import notifier
from ..queue import queue
from ..report import (build_price_report, price_report_csv_bytes, push_price_report_to_feishu,
                      write_price_report_csv)
from ..security import get_current_user

router = APIRouter(prefix="/api/campaigns", tags=["campaigns"])


def _archived_block(campaign_id: int) -> None:
    """归档任务的写操作一律拒绝（归档 = 这个任务结束了，只读留档）。"""
    c = repo.get_campaign(campaign_id)
    if not c:
        raise HTTPException(status_code=404, detail="任务不存在")
    if str(c.get("status") or "") == "archived":
        raise HTTPException(
            status_code=409,
            detail="该任务已归档（只读）。如需继续操作，请先点「取消归档」。",
        )


@router.get("")
async def list_campaigns(limit: int = 100, status: str | None = None,
                         include_archived: bool = True,
                         user: dict = Depends(get_current_user)) -> dict:
    """任务列表。include_archived=False 隐藏已归档（任务列表页默认传 false，
    比价表/客户页的任务筛选下拉要传 true，否则选不到归档任务的报价）。"""
    items = repo.list_campaigns(limit, status, include_archived)
    overrides = store.all_campaign_params()
    base = {k: store.get_settings().get(k) for k in store.CAMPAIGN_PARAM_RULES}
    for it in items:
        ov = overrides.get(int(it["id"]), {})
        it["params_override"] = ov
        it["params_effective"] = {**base, **ov}
        it["params_customized"] = bool(ov)
    return {"items": items}


class CampaignCreate(BaseModel):
    name: str
    # 产品图片可以留空：选了带配图的询价短语时，直接用短语的配图
    image: str | None = None
    phrase_id: str | None = None
    note: str = ""
    # 业务参数覆盖：只填想改的字段，其余留空 = 用参数设置里的全局默认
    params: dict | None = None
    # 可选：先套用配置方案，再用 params 中的显式值覆盖
    template_id: int | None = None


@router.post("")
async def create_campaign(body: CampaignCreate, user: dict = Depends(get_current_user)) -> dict:
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="任务名不能为空")
    image = (body.image or "").strip()
    phrase = None
    if body.phrase_id:
        try:
            phrases = (await bridge.call("library.phrases.list", {})).get("phrases", [])
        except BridgeError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        phrase = next((p for p in phrases if p.get("id") == body.phrase_id), None)
    # 产品图片：手动选的优先；没选就用询价短语的配图。两者都没有才报错。
    if not image and phrase:
        image = str(phrase.get("image") or "").strip()
    if not image:
        raise HTTPException(status_code=400, detail="请选择产品图片，或选择一条带配图的询价快捷短语")
    # 先校验参数，避免"任务建好了、参数却非法"的半成品
    try:
        clean_params = store.validate_campaign_params(body.params or {})
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if body.template_id is not None:
        template = store.get_pricing_template(body.template_id)
        if not template:
            raise HTTPException(status_code=404, detail="业务参数模版不存在")
        template_params = store.validate_campaign_params({
            "send_mode": template["send_mode"],
            "inquiry_count": template["inquiry_count"],
            "slice_per_round": template["slice_per_round"],
            "expected_price": template["expected_price"],
            "expected_price_note": template["expected_price_note"],
            "max_followups": template["max_followups"],
            "duration_sec": template["duration_sec"],
            "reply_timeout_sec": template["reply_timeout_sec"],
        })
        clean_params = {**template_params, **clean_params}
    try:
        created = await bridge.call("campaign.create", {
            "image": image, "phraseId": body.phrase_id,
            "name": body.name, "note": body.note,
        })
    except BridgeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if clean_params:
        store.set_campaign_params(int(created["id"]), clean_params)
    store.add_audit(user.get("username", ""), "campaign.create", body.model_dump(), str(created))
    ov, eff = store.effective_campaign_params(int(created["id"]))
    return {"campaign": created, "params_override": ov, "params_effective": eff}


@router.get("/{campaign_id}")
async def get_campaign(campaign_id: int, user: dict = Depends(get_current_user)) -> dict:
    data = repo.get_campaign(campaign_id)
    if not data:
        raise HTTPException(status_code=404, detail="任务不存在")
    ov, eff = store.effective_campaign_params(campaign_id)
    data["params_override"] = ov
    data["params_effective"] = eff
    data["params_customized"] = bool(ov)
    return data


class CampaignParamsBody(BaseModel):
    params: dict = Field(default_factory=dict)


@router.put("/{campaign_id}/params")
async def update_campaign_params(campaign_id: int, body: CampaignParamsBody,
                                 user: dict = Depends(get_current_user)) -> dict:
    """覆盖本任务的业务参数；传空对象表示全部恢复用全局默认。"""
    if not repo.get_campaign(campaign_id):
        raise HTTPException(status_code=404, detail="任务不存在")
    try:
        clean = store.set_campaign_params(campaign_id, body.params)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    store.add_audit(user.get("username", ""), "campaign.params",
                    {"id": campaign_id, "params": clean}, "ok")
    ov, eff = store.effective_campaign_params(campaign_id)
    return {"params_override": ov, "params_effective": eff}


class CampaignPatch(BaseModel):
    name: str | None = None
    note: str | None = None
    status: str | None = None
    phrase_id: str | None = None
    stage: str | None = None


@router.put("/{campaign_id}")
async def update_campaign(campaign_id: int, body: CampaignPatch,
                          user: dict = Depends(get_current_user)) -> dict:
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if not patch:
        raise HTTPException(status_code=400, detail="没有需要更新的字段")
    if patch.get("status") and patch["status"] not in (
        "running", "paused", "done", "archived", "draft", "stopped"
    ):
        raise HTTPException(status_code=400, detail="status 取值非法")
    # 已归档的任务不能被"恢复运行"，必须先取消归档（防止手滑把结束的任务又跑起来）
    if patch.get("status") == "running":
        _archived_block(campaign_id)
    try:
        updated = await bridge.call("campaign.update", {"id": campaign_id, "patch": patch})
    except BridgeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    store.add_audit(user.get("username", ""), "campaign.update", {"id": campaign_id, **patch}, "ok")
    if patch.get("status") == "running":
        try:
            rec = await bridge.call("events.reconcile", {"campaignId": campaign_id}, timeout=120)
            if int((rec or {}).get("recovered") or 0) + int((rec or {}).get("inserted") or 0):
                store.add_log(
                    "info", "events",
                    f"任务 {campaign_id} 恢复后补投入站事件："
                    f"重新激活 {(rec or {}).get('recovered', 0)} / 补建 {(rec or {}).get('inserted', 0)}",
                )
        except Exception as exc:  # noqa: BLE001
            store.add_log("warn", "events", f"任务 {campaign_id} 恢复后入站对账失败：{exc}")
    return {"campaign": updated}


class ArchiveBody(BaseModel):
    send_feishu: bool = False        # 归档时顺手把最终比价表推到飞书（默认不发）
    feishu_chat_id: str = ""


@router.delete("/{campaign_id}")
async def archive_campaign(campaign_id: int, body: ArchiveBody | None = None,
                           user: dict = Depends(get_current_user)) -> dict:
    """归档 = 这个任务结束了（只读留档）。

    收尾动作：先把**最终比价表**落一份 CSV 到 data/exports/（可选推飞书），再改状态为 archived；
    归档后所有写操作（启动/采集/推进/补发/自动采集/全自动）都会被拒绝，可用「取消归档」还原。
    """
    c = repo.get_campaign(campaign_id)
    if not c:
        raise HTTPException(status_code=404, detail="任务不存在")
    if str(c.get("status") or "") == "archived":
        return {"campaign": c, "note": "该任务已经是归档状态"}

    body = body or ArchiveBody()
    out: dict = {}
    # ① 收尾：落一份最终比价表（失败不影响归档本身）
    try:
        rep = build_price_report(campaign_id)
        path = write_price_report_csv(campaign_id, rep)
        out["csv"] = str(path)
        out["csv_name"] = path.name
        out["summary"] = rep.get("summary")
    except Exception as exc:  # noqa: BLE001
        out["csv_error"] = str(exc)
        store.add_log("warn", "campaign", f"任务 {campaign_id} 归档时导出比价表失败：{exc}")
    # ② 可选推飞书
    if body.send_feishu:
        try:
            out["feishu"] = await push_price_report_to_feishu(campaign_id, body.feishu_chat_id.strip())
        except Exception as exc:  # noqa: BLE001
            out["feishu_error"] = str(exc)
            store.add_log("warn", "campaign", f"任务 {campaign_id} 归档时推飞书失败：{exc}")
    # ③ 冻结
    try:
        updated = await bridge.call("campaign.update",
                                    {"id": campaign_id, "patch": {"status": "archived"}})
    except BridgeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    store.add_audit(user.get("username", ""), "campaign.archive",
                    {"id": campaign_id, "csv": out.get("csv_name", "")}, "ok")
    store.add_log("info", "campaign",
                  f"任务 {campaign_id} 已归档（冻结）｜最终比价表：{out.get('csv_name') or '导出失败'}")
    return {"campaign": updated, **out}


@router.post("/{campaign_id}/unarchive")
async def unarchive_campaign(campaign_id: int, user: dict = Depends(get_current_user)) -> dict:
    """取消归档：回到「已暂停」状态（不会自动开跑，避免误触）。"""
    c = repo.get_campaign(campaign_id)
    if not c:
        raise HTTPException(status_code=404, detail="任务不存在")
    if str(c.get("status") or "") != "archived":
        return {"campaign": c, "note": "该任务不是归档状态"}
    try:
        updated = await bridge.call("campaign.update",
                                    {"id": campaign_id, "patch": {"status": "paused"}})
    except BridgeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    store.add_audit(user.get("username", ""), "campaign.unarchive", {"id": campaign_id}, "ok")
    store.add_log("info", "campaign", f"任务 {campaign_id} 已取消归档（回到已暂停）")
    return {"campaign": updated}


def _settings_defaults(campaign_id: int | None = None) -> dict:
    """生效的业务参数 = 参数设置里的全局默认 ← 本任务显式覆盖。"""
    override, eff = store.effective_campaign_params(campaign_id)
    return {
        "limit": int(eff.get("inquiry_count") or 10),
        "slice": int(eff.get("slice_per_round") or 2),
        "mode": eff.get("send_mode") or "send",
        "expected_price": eff.get("expected_price"),
        "duration_sec": int(eff.get("duration_sec") or 0),
        "reply_timeout_sec": int(eff.get("reply_timeout_sec") or 60),
        "max_followups": int(eff.get("max_followups") if eff.get("max_followups") is not None else 2),
        "override": override,
    }


def _apply_pricing_template(campaign_id: int, template_id: int) -> dict:
    """把配置方案合并进任务级参数；不覆盖模板未设置的字段。"""
    template = store.get_pricing_template(int(template_id))
    if not template:
        raise HTTPException(status_code=404, detail="业务参数模版不存在")
    from_template = {
        "send_mode": template["send_mode"],
        "inquiry_count": template["inquiry_count"],
        "slice_per_round": template["slice_per_round"],
        "expected_price": template["expected_price"],
        "expected_price_note": template["expected_price_note"],
        "max_followups": template["max_followups"],
        "duration_sec": template["duration_sec"],
        "reply_timeout_sec": template["reply_timeout_sec"],
    }
    current = store.get_campaign_params(campaign_id)
    store.set_campaign_params(campaign_id, {**current, **from_template})
    return from_template


class LaunchBody(BaseModel):
    limit: int | None = None
    yes: bool = True
    product: str | None = None
    phrase_id: str | None = None


@router.post("/{campaign_id}/launch")
async def launch(campaign_id: int, body: LaunchBody | None = None,
                 user: dict = Depends(get_current_user)) -> dict:
    _archived_block(campaign_id)
    body = body or LaunchBody()
    d = _settings_defaults(campaign_id)
    payload = {
        "id": campaign_id,
        "limit": body.limit if body.limit is not None else d["limit"],
        "yes": body.yes,
    }
    job = await queue.submit("campaign.launch", payload, user.get("username", ""))
    store.add_audit(user.get("username", ""), "campaign.launch", payload, job["id"])
    return {"job": job}


class CollectBody(BaseModel):
    slice: int | None = None
    mode: str | None = None


@router.post("/{campaign_id}/collect")
async def collect(campaign_id: int, body: CollectBody | None = None,
                  user: dict = Depends(get_current_user)) -> dict:
    _archived_block(campaign_id)
    body = body or CollectBody()
    d = _settings_defaults(campaign_id)
    payload = {
        "id": campaign_id,
        "slice": body.slice or d["slice"],
        "mode": body.mode or d["mode"],
    }
    job = await queue.submit("campaign.collect", payload, user.get("username", ""))
    store.add_audit(user.get("username", ""), "campaign.collect", payload, job["id"])
    return {"job": job}


class AdvanceBody(BaseModel):
    slice: int | None = None
    per_task: int | None = None
    mode: str | None = None
    dry: bool = False


@router.post("/{campaign_id}/advance")
async def advance(campaign_id: int, body: AdvanceBody | None = None,
                  user: dict = Depends(get_current_user)) -> dict:
    _archived_block(campaign_id)
    body = body or AdvanceBody()
    d = _settings_defaults(campaign_id)
    payload = {
        "id": campaign_id,
        "slice": body.slice or d["slice"],
        "perTask": body.per_task or d["limit"],
        "mode": body.mode or d["mode"],
        "dry": body.dry,
    }
    job = await queue.submit("campaign.advance", payload, user.get("username", ""))
    store.add_audit(user.get("username", ""), "campaign.advance", payload, job["id"])
    return {"job": job}


@router.post("/{campaign_id}/pause")
async def pause(campaign_id: int, user: dict = Depends(get_current_user)) -> dict:
    return await update_campaign(campaign_id, CampaignPatch(status="paused"), user)


@router.post("/{campaign_id}/resume")
async def resume(campaign_id: int, user: dict = Depends(get_current_user)) -> dict:
    return await update_campaign(campaign_id, CampaignPatch(status="running"), user)


@router.post("/{campaign_id}/resend")
async def resend(campaign_id: int, user: dict = Depends(get_current_user)) -> dict:
    """补发询价短语：把"联系过、但短语没发出去"的商家补一遍。

    为什么需要它：点卡片「联系卖家」偶尔点不动，代码会退化成直接开链接，
    那种窗口不会激活会话 → 短语发送 35s 超时 → 商家其实一条都没收到。
    这里改成"复用聊天窗口 + 按店铺名切换会话"再发，成功率高得多。
    """
    _archived_block(campaign_id)
    if not repo.get_campaign(campaign_id):
        raise HTTPException(status_code=404, detail="任务不存在")
    payload = {"id": campaign_id}
    job = await queue.submit("campaign.resend", payload, user.get("username", ""))
    store.add_audit(user.get("username", ""), "campaign.resend", payload, job["id"])
    return {"job": job}


class AutoCollectBody(BaseModel):
    # 发送模式：send=真发 / draft=只填草稿 / dry=只解析不发；留空 = 用本任务生效的全局值
    mode: str | None = None
    rounds: int = Field(default=5, ge=1, le=200)            # 兼容旧参数；当前不再限制客户问答轮数
    duration_sec: int | None = Field(default=None, ge=0, le=86400)  # 任务最长运行时间（0 = 人工停止）
    wait_sec: int = Field(default=0, ge=0, le=3600)         # 兼容旧参数；独立轮次模式不再使用
    reply_timeout_sec: int | None = Field(default=None, ge=1, le=86400)  # 每个客户每轮的超时判定
    max_followups: int | None = Field(default=None, ge=0, le=2)  # 超时主动追问上限，最多 2 次
    slice: int | None = Field(default=None, ge=1, le=50)    # 兼容旧参数；独立轮次模式不再裁剪客户
    followup_text: str = ""                                 # 催问话术，留空用默认模板
    ensure_sent: bool = True                                # 开跑前先补发没发成功的询价短语
    stop_when_complete: bool = True                         # 兼容旧参数；客户进入终态时始终停止该客户
    send_table: bool = False                                # 结束后是否发送本次会话表
    table_target: str = ""                                  # 会话表发到哪个会话（店铺名/旺旺号）
    # 飞书推送（比价表总结 + 比价表文件）
    send_feishu: bool = False
    feishu_chat_id: str = ""                                # 留空 = 用 .env 里的默认群
    feishu_file: bool = True                                # 是否连比价表文件一起发
    template_id: int | None = None                           # 可选：启动前套用业务参数模板


async def _ensure_campaign_running(campaign_id: int, username: str = "") -> dict:
    """启动自动流程前，把暂停/停止的任务显式恢复为 running。

    之前“全自动”只创建流程，不检查任务状态；暂停任务点启动后，第一步会立刻
    因 status=paused 被取消。启动本身就是明确的人工动作，因此这里先恢复，
    再投递流程，避免出现“刚运行 1 秒就取消”。
    """
    campaign = repo.get_campaign(campaign_id)
    if not campaign:
        raise HTTPException(status_code=404, detail="任务不存在")
    updated = campaign
    if str(campaign.get("status") or "") != "running":
        try:
            updated = await bridge.call(
                "campaign.update",
                {"id": campaign_id, "patch": {"status": "running"}},
                timeout=60,
            )
        except BridgeError as exc:
            raise HTTPException(status_code=400, detail=f"恢复任务运行状态失败：{exc}")
        store.add_audit(
            username, "campaign.update",
            {"id": campaign_id, "status": "running", "reason": "自动流程启动前恢复"},
            "ok",
        )
        store.add_log("info", "campaign", f"任务 {campaign_id} 已恢复运行，准备启动自动流程")

    # 无论此前是否已经是 running，都在启动前做一次消息/游标对账。
    try:
        rec = await bridge.call("events.reconcile", {"campaignId": campaign_id}, timeout=120)
        if int((rec or {}).get("recovered") or 0) + int((rec or {}).get("inserted") or 0):
            store.add_log(
                "info", "events",
                f"任务 {campaign_id} 启动前恢复入站事件："
                f"重新激活 {(rec or {}).get('recovered', 0)} / 补建 {(rec or {}).get('inserted', 0)}",
            )
    except Exception as exc:  # noqa: BLE001
        store.add_log("warn", "events", f"任务 {campaign_id} 启动前入站对账失败：{exc}")
    return updated or campaign


@router.post("/{campaign_id}/autocollect")
async def autocollect(campaign_id: int, body: AutoCollectBody | None = None,
                      user: dict = Depends(get_current_user)) -> dict:
    """自动采集：每个客户独立计时；回复即解析，超时即追问并重新计时。"""
    _archived_block(campaign_id)
    if not repo.get_campaign(campaign_id):
        raise HTTPException(status_code=404, detail="任务不存在")
    body = body or AutoCollectBody()
    template_used = {}
    if body.template_id is not None:
        template_used = _apply_pricing_template(campaign_id, body.template_id)
    d = _settings_defaults(campaign_id)
    duration_sec = body.duration_sec if body.duration_sec is not None else d["duration_sec"]
    reply_timeout_sec = (body.reply_timeout_sec if body.reply_timeout_sec is not None
                         else d["reply_timeout_sec"])
    max_followups = body.max_followups if body.max_followups is not None else d["max_followups"]
    if body.send_table and not body.table_target.strip():
        raise HTTPException(status_code=400, detail="勾了「发送会话表」就必须填发送到哪个会话")
    await _ensure_campaign_running(campaign_id, user.get("username", ""))
    payload = {
        "id": campaign_id,
        "mode": body.mode or d["mode"],
        "rounds": body.rounds,
        "duration_sec": duration_sec,
        "wait_sec": body.wait_sec,
        "reply_timeout_sec": reply_timeout_sec,
        "max_followups": max_followups,
        "slice": body.slice or d["slice"],
        "followup_text": body.followup_text,
        "ensure_sent": body.ensure_sent,
        "stop_when_complete": body.stop_when_complete,
        "send_table": body.send_table,
        "table_target": body.table_target.strip(),
        "send_feishu": body.send_feishu,
        "feishu_chat_id": body.feishu_chat_id.strip(),
        "feishu_file": body.feishu_file,
        "template_id": body.template_id,
        "template_params": template_used,
    }
    job = await queue.submit("campaign.autocollect", payload, user.get("username", ""))
    store.add_audit(user.get("username", ""), "campaign.autocollect", payload, job["id"])
    return {"job": job, "payload": payload}


class AuditRepliesBody(BaseModel):
    limit: int | None = Field(default=None, ge=1, le=500)


@router.post("/{campaign_id}/audit-replies")
async def audit_replies(campaign_id: int, body: AuditRepliesBody | None = None,
                        user: dict = Depends(get_current_user)) -> dict:
    """补分析：拿库里的入站文本补调 DeepSeek，判「做不了」就落 dropped 并停止追问。

    补的正是"被批量抓取进库、没走实时通道"的那批回复（冻结分析器看不到它们，
    于是不但不判放弃，反而去追问报价 —— 2026-10-15 实测）。
    """
    payload = {"id": campaign_id, "limit": (body.limit if body else None) or 200}
    job = await queue.submit("campaign.audit_replies", payload, user.get("username", ""))
    store.add_audit(user.get("username", ""), "campaign.audit_replies", payload, job["id"])
    return {"job": job}


class FullAutoBody(AutoCollectBody):
    """全自动比价：启动 → 自动采集 → 飞书推送。启动参数只有联系几家。"""

    limit: int | None = Field(default=None, ge=0, le=500)   # 启动时联系几家（留空 = 本任务生效值）
    yes: bool = True                                        # 真实发送（前端默认就传 true）
    send_feishu: bool = True                                # 全自动默认发飞书


@router.post("/{campaign_id}/fullauto")
async def fullauto(campaign_id: int, body: FullAutoBody | None = None,
                   user: dict = Depends(get_current_user)) -> dict:
    """全自动比价：点一下 = 启动（以图搜图 → 联系 → 发询价）→ 自动采集 → 飞书推总结+文件。"""
    _archived_block(campaign_id)
    if not repo.get_campaign(campaign_id):
        raise HTTPException(status_code=404, detail="任务不存在")
    body = body or FullAutoBody()
    template_used = {}
    if body.template_id is not None:
        template_used = _apply_pricing_template(campaign_id, body.template_id)
    d = _settings_defaults(campaign_id)
    duration_sec = body.duration_sec if body.duration_sec is not None else d["duration_sec"]
    reply_timeout_sec = (body.reply_timeout_sec if body.reply_timeout_sec is not None
                         else d["reply_timeout_sec"])
    max_followups = body.max_followups if body.max_followups is not None else d["max_followups"]
    if body.send_table and not body.table_target.strip():
        raise HTTPException(status_code=400, detail="勾了「发送会话表」就必须填发送到哪个会话")
    await _ensure_campaign_running(campaign_id, user.get("username", ""))
    if body.send_feishu and not body.feishu_file:
        store.add_log("info", "campaign", f"全自动任务 {campaign_id} 只发飞书总结，不发文件")
    payload = {
        "id": campaign_id,
        "limit": body.limit if body.limit is not None else d["limit"],
        "yes": body.yes,
        "mode": body.mode or d["mode"],
        "rounds": body.rounds,
        "duration_sec": duration_sec,
        "wait_sec": body.wait_sec,
        "reply_timeout_sec": reply_timeout_sec,
        "max_followups": max_followups,
        "slice": body.slice or d["slice"],
        "followup_text": body.followup_text,
        "ensure_sent": body.ensure_sent,
        "stop_when_complete": body.stop_when_complete,
        "send_table": body.send_table,
        "table_target": body.table_target.strip(),
        "send_feishu": body.send_feishu,
        "feishu_chat_id": body.feishu_chat_id.strip(),
        "feishu_file": body.feishu_file,
        "template_id": body.template_id,
        "template_params": template_used,
    }
    job = await queue.submit("campaign.fullauto.flow", payload, user.get("username", ""))
    store.add_audit(user.get("username", ""), "campaign.fullauto.flow", payload, job["id"])
    return {"job": job, "payload": payload}


@router.get("/{campaign_id}/price-report")
async def price_report(campaign_id: int, user: dict = Depends(get_current_user)) -> dict:
    """比价表总结预览（就是飞书要发的那段），用来在没配飞书时先看内容。"""
    if not repo.get_campaign(campaign_id):
        raise HTTPException(status_code=404, detail="任务不存在")
    rep = build_price_report(campaign_id)
    return {
        "summary": rep["summary"],
        "text": rep["text"],
        "card": rep["card"],
        "csv_name": rep["csv_name"],
        "feishu": notifier.status(),
    }


@router.get("/{campaign_id}/price-report.csv")
async def price_report_csv(campaign_id: int, user: dict = Depends(get_current_user)) -> StreamingResponse:
    """该任务的比价表 CSV 文件（和发到飞书的是同一份）。"""
    if not repo.get_campaign(campaign_id):
        raise HTTPException(status_code=404, detail="任务不存在")
    rep = build_price_report(campaign_id)
    data = price_report_csv_bytes(campaign_id)
    # 中文文件名不能直接塞 HTTP 头（latin-1 限制）：ASCII 兜底 + RFC 5987 的 filename*
    from urllib.parse import quote
    ascii_name = f"price-report-{campaign_id}.csv"
    disposition = (
        f'attachment; filename="{ascii_name}"; '
        f"filename*=UTF-8''{quote(rep['csv_name'])}"
    )
    return StreamingResponse(
        iter([data]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": disposition},
    )


class FeishuPushBody(BaseModel):
    chat_id: str = ""          # 留空 = 用 .env 里配置的群
    send_file: bool = True     # 是否连比价表 CSV 一起发


@router.post("/{campaign_id}/feishu")
async def push_feishu(campaign_id: int, body: FeishuPushBody | None = None,
                      user: dict = Depends(get_current_user)) -> dict:
    """手动把该任务的比价表（总结 + 文件）推到飞书（随时可补发，不用重跑采集）。"""
    if not repo.get_campaign(campaign_id):
        raise HTTPException(status_code=404, detail="任务不存在")
    body = body or FeishuPushBody()
    result = await push_price_report_to_feishu(campaign_id, body.chat_id.strip(), body.send_file)
    store.add_audit(user.get("username", ""), "campaign.feishu",
                    {"id": campaign_id, "chat_id": body.chat_id, "send_file": body.send_file},
                    str(result.get("ok")))
    return result


@router.get("/{campaign_id}/report")
async def report(campaign_id: int, product: str | None = None,
                 date_from: str | None = None, date_to: str | None = None,
                 only_priced: bool = False,
                 user: dict = Depends(get_current_user)) -> dict:
    """本任务的比价表（复用全局比价逻辑，按 campaign_id 过滤）。"""
    from .data import _ts

    expected = _settings_defaults(campaign_id)["expected_price"]
    rows = repo.compare(
        campaign_id=campaign_id, product=product,
        frm=_ts(date_from), to=_ts(date_to), only_priced=only_priced,
        expected_price=float(expected) if expected not in (None, "") else None,
    )
    priced = [r for r in rows if r["unit_price_final"] is not None]
    return {
        "items": rows,
        "summary": {
            "total": len(rows), "priced": len(priced),
            "min_price": min((r["unit_price_final"] for r in priced), default=None),
            "max_price": max((r["unit_price_final"] for r in priced), default=None),
            "avg_price": round(sum(r["unit_price_final"] for r in priced) / len(priced), 4) if priced else None,
            "expected_price": expected,
        },
    }


@router.get("/{campaign_id}/contacts")
async def contacts(campaign_id: int, user: dict = Depends(get_current_user)) -> dict:
    return {"items": repo.campaign_contacts(campaign_id)}
