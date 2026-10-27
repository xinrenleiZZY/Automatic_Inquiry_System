"""以图搜图 + 联系商家。"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import repo, store
from ..bridge import BridgeError, bridge
from ..queue import queue
from ..security import get_current_user

router = APIRouter(prefix="/api", tags=["outreach"])


@router.get("/outreach/sellers")
async def sellers(limit: int = 10, match: str | None = None,
                  user: dict = Depends(get_current_user)) -> dict:
    """只读：读出当前结果页 TOP N 商家（不点击、不发消息）。"""
    try:
        data = await bridge.call("image.sellers", {"limit": limit, "match": match}, timeout=120)
    except BridgeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return data


class ContactBody(BaseModel):
    limit: int | None = None
    campaign_id: int | None = None
    phrase_id: str | None = None
    image: str | None = None
    image_id: str | None = None
    order: str = "text-first"
    skip_sent: bool = True
    product: str | None = None
    screen_titles: bool | None = None
    match: str | None = None
    confirm: bool = False


@router.post("/outreach/contact")
async def contact(body: ContactBody, user: dict = Depends(get_current_user)) -> dict:
    settings = store.get_settings()
    limit = body.limit if body.limit is not None else int(settings.get("inquiry_count") or 10)

    # 全局上限：所有任务累计联系商家数
    max_total = int(settings.get("max_inquiry_count") or 0)
    if max_total:
        # 按唯一商家计数：同一家店的多张商品卡片、名单排除行都不能占上限
        current = repo.actual_contact_count()
        if current + limit > max_total:
            raise HTTPException(
                status_code=400,
                detail=f"超出全局上限：已联系 {current} 家，上限 {max_total} 家，本次要联系 {limit} 家",
            )

    payload = {
        "limit": limit,
        "campaignId": body.campaign_id,
        "imageId": body.image_id,
        "imageFile": body.image,
        "order": body.order,
        "skipSent": body.skip_sent,
        "product": body.product,
        "screenTitles": body.screen_titles,
        "match": body.match,
    }
    payload["phraseId"] = body.phrase_id  # 由桥接侧按 id 解析成完整短语
    store.add_audit(user.get("username", ""), "outreach.contact", payload, "queued")
    job = await queue.submit("outreach.contact", payload, user.get("username", ""))
    return {"job": job}


class SearchImageBody(BaseModel):
    file: str
    keyword: str = ""
    capture: bool = True
    save: bool = True


@router.post("/search/image")
async def search_image(body: SearchImageBody, user: dict = Depends(get_current_user)) -> dict:
    if not body.file.strip():
        raise HTTPException(status_code=400, detail="必须指定图片路径")
    store.add_audit(user.get("username", ""), "search.image", body.model_dump(), "queued")
    job = await queue.submit("search.image", body.model_dump(), user.get("username", ""))
    return {"job": job}


@router.get("/search/recent")
async def search_recent(limit: int = 20, user: dict = Depends(get_current_user)) -> dict:
    return {"items": repo.image_searches(limit)}


@router.get("/outreach/contacts")
async def contacts(limit: int = 200, user: dict = Depends(get_current_user)) -> dict:
    return {"items": repo.image_contacts(limit)}
