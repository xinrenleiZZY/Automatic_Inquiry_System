"""AI 接口：解析供应商回复 / 生成追问话术 / 查看业务知识库。"""

import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import config, repo
from ..bridge import BridgeError, bridge
from ..security import get_current_user

router = APIRouter(prefix="/api/ai", tags=["ai"])


@router.get("/config")
async def get_config(user: dict = Depends(get_current_user)) -> dict:
    try:
        return await bridge.call("ai.config", {})
    except BridgeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


class ParseBody(BaseModel):
    reply_text: str
    inquiry: str = ""
    product: str = ""
    context: str = ""
    known: dict = {}
    page_price: float | None = None
    # 任务上下文包（都可选）：产品参考图 / 对方发的图 / 逐条原话
    product_image: str = ""
    images: list[str] = []
    utterances: list[dict] = []


@router.post("/parse")
async def parse(body: ParseBody, user: dict = Depends(get_current_user)) -> dict:
    if not body.reply_text.strip():
        raise HTTPException(status_code=400, detail="reply_text 不能为空")
    # 解析器要求"逐条原话 + 第N条证据"，所以这里也得按逐条形式传下去：
    # 调用方给了 utterances 就用它的，没给就把 reply_text 当成唯一一条。
    utterances = body.utterances or [{"time": "", "text": body.reply_text, "kind": "text"}]
    try:
        return await bridge.call("ai.parse", {
            "inquiry": body.inquiry,
            "replyText": body.reply_text,
            "product": body.product,
            "context": body.context,
            "known": body.known,
            "productImage": body.product_image,
            "images": body.images,
            "utterances": utterances,
            "opts": {"pagePrice": body.page_price},
        }, timeout=180)
    except BridgeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


class ComposeBody(BaseModel):
    known: dict = {}
    missing: list[str] = []
    product: str = ""
    order_moq: str = ""


@router.post("/compose")
async def compose(body: ComposeBody, user: dict = Depends(get_current_user)) -> dict:
    try:
        return await bridge.call("ai.compose", body.model_dump(), timeout=180)
    except BridgeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/knowledge")
async def knowledge_base(user: dict = Depends(get_current_user)) -> dict:
    """只读知识库：规则原文 + 红线 + 最近命中记录。"""
    kb_file = config.QIANNIU_DIR / "knowledge" / "1688-inquiry-kb.json"
    if not kb_file.exists():
        raise HTTPException(status_code=404, detail="知识库文件不存在")
    try:
        data = json.loads(kb_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail=f"读取知识库失败：{exc}")

    counts: dict[str, int] = {}
    recent: list[dict] = []
    if config.IM_DB.exists():
        try:
            with repo.connect_im() as conn:
                rows = conn.execute(
                    "SELECT epoch,conv_name,inbound_text,ai_action,ai_reply,detail "
                    "FROM auto_replies WHERE detail LIKE '%\"kb_rule_id\":\"%' "
                    "ORDER BY epoch DESC LIMIT 500"
                ).fetchall()
            for row in rows:
                try:
                    detail = json.loads(row["detail"] or "{}")
                except (TypeError, json.JSONDecodeError):
                    continue
                rule_id = str(detail.get("kb_rule_id") or "")
                if not rule_id:
                    continue
                counts[rule_id] = counts.get(rule_id, 0) + 1
                if len(recent) < 20:
                    recent.append({
                        "epoch": row["epoch"],
                        "shop": row["conv_name"] or "",
                        "inbound": row["inbound_text"] or "",
                        "action": detail.get("kb_action") or row["ai_action"] or "",
                        "risk": detail.get("kb_risk") or "",
                        "rule_id": rule_id,
                        "reply": row["ai_reply"] or "",
                    })
        except Exception:  # noqa: BLE001 - 统计失败不影响查看规则
            pass

    rules = []
    for rule in data.get("faq_rules") or []:
        rules.append({**rule, "hit_count": counts.get(str(rule.get("id") or ""), 0)})

    return {
        **data,
        "faq_rules": rules,
        "stats": {
            "faq_rules": len(rules),
            "redlines": len(data.get("redlines") or []),
            "principles": len(data.get("principles") or []),
            "hits": sum(counts.values()),
        },
        "recent_hits": recent,
        "file": str(kb_file),
    }
