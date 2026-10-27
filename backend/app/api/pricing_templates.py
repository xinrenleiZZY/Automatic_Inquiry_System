"""比价配置方案：保存、复用任务级业务参数模板。"""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import store
from ..security import get_current_user, require_admin_or_gm

router = APIRouter(prefix="/api/pricing-templates", tags=["pricing-templates"])


class PricingTemplateBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)
    send_mode: Literal["send", "draft", "dry"]
    inquiry_count: int = Field(ge=0, le=500)
    slice_per_round: int = Field(ge=1, le=50)
    expected_price: float | None = Field(default=None, ge=0)
    expected_price_note: str = Field(default="", max_length=500)
    max_followups: int = Field(default=2, ge=0, le=2)
    duration_sec: int = Field(default=0, ge=0, le=86400)
    reply_timeout_sec: int = Field(default=60, ge=1, le=86400)


def _payload(body: PricingTemplateBody) -> dict:
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="方案名称不能为空")
    return {
        "name": name,
        "description": body.description.strip(),
        "send_mode": body.send_mode,
        "inquiry_count": body.inquiry_count,
        "slice_per_round": body.slice_per_round,
        "expected_price": body.expected_price,
        "expected_price_note": body.expected_price_note.strip(),
        "max_followups": body.max_followups,
        "duration_sec": body.duration_sec,
        "reply_timeout_sec": body.reply_timeout_sec,
    }


@router.get("")
async def list_templates(user: dict = Depends(get_current_user)) -> dict:
    items = store.list_pricing_templates()
    return {
        "items": items,
        "total": len(items),
        "max": store.MAX_PRICING_TEMPLATES,
    }


@router.post("")
async def create_template(body: PricingTemplateBody,
                          user: dict = Depends(require_admin_or_gm)) -> dict:
    try:
        item = store.create_pricing_template(_payload(body), user.get("username", ""))
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    store.add_audit(user.get("username", ""), "pricing_template.create",
                    {"id": item["id"], "name": item["name"]}, "ok")
    return {"item": item}


@router.put("/{template_id}")
async def update_template(template_id: int, body: PricingTemplateBody,
                          user: dict = Depends(require_admin_or_gm)) -> dict:
    try:
        item = store.update_pricing_template(template_id, _payload(body))
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    store.add_audit(user.get("username", ""), "pricing_template.update",
                    {"id": item["id"], "name": item["name"]}, "ok")
    return {"item": item}


@router.delete("/{template_id}")
async def delete_template(template_id: int,
                          user: dict = Depends(require_admin_or_gm)) -> dict:
    deleted = store.delete_pricing_template(template_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="配置方案不存在")
    store.add_audit(user.get("username", ""), "pricing_template.delete",
                    {"id": template_id}, "ok")
    return {"deleted": True, "id": template_id}
