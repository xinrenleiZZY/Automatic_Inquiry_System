"""发送接口（真实发送）。

设计：所有发送都进串行队列，避免和采集/搜图抢聊天窗口。
安全：默认要求请求体带 confirm=true —— 防误点，不是防用户。
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import config, store
from ..queue import queue
from ..security import get_current_user

router = APIRouter(prefix="/api/send", tags=["send"])


def _gate(confirm: bool, user: dict, action: str, payload: dict) -> None:
    if config.REQUIRE_SEND_CONFIRM and not confirm:
        raise HTTPException(status_code=400, detail="真实发送需要显式确认（confirm=true）")
    store.add_audit(user.get("username", ""), action, payload, "queued")


@router.get("/mode")
async def mode(user: dict = Depends(get_current_user)) -> dict:
    return {
        "configured_mode": config.SEND_MODE,
        "settings_mode": store.get_settings().get("send_mode"),
        "require_confirm": config.REQUIRE_SEND_CONFIRM,
    }


class SendTextBody(BaseModel):
    text: str
    conv_key: str | None = None
    conv_name: str | None = None
    confirm: bool = False


@router.post("/text")
async def send_text(body: SendTextBody, user: dict = Depends(get_current_user)) -> dict:
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="文本不能为空")
    payload = body.model_dump()
    _gate(body.confirm, user, "send.text", payload)
    job = await queue.submit("send.text", payload, user.get("username", ""))
    return {"job": job}


class SendPhraseBody(BaseModel):
    phrase_id: str
    image: str | None = None
    order: str = "text-first"
    conv_key: str | None = None
    conv_name: str | None = None
    campaign_id: int | None = None
    confirm: bool = False


@router.post("/phrase")
async def send_phrase(body: SendPhraseBody, user: dict = Depends(get_current_user)) -> dict:
    payload = body.model_dump()
    _gate(body.confirm, user, "send.phrase", payload)
    job = await queue.submit("send.phrase", payload, user.get("username", ""))
    return {"job": job}


class SendImageBody(BaseModel):
    file: str
    conv_key: str | None = None
    conv_name: str | None = None
    confirm: bool = False


@router.post("/image")
async def send_image(body: SendImageBody, user: dict = Depends(get_current_user)) -> dict:
    payload = body.model_dump()
    _gate(body.confirm, user, "send.image", payload)
    job = await queue.submit("send.image", payload, user.get("username", ""))
    return {"job": job}


class AutoReplyBody(BaseModel):
    mode: str | None = None
    limit: int = 20
    campaign_id: int | None = None
    product: str | None = None
    inquiry: str | None = None
    order_moq: str | None = None
    confirm: bool = False


@router.post("/reply/run")
async def run_auto_reply(body: AutoReplyBody, user: dict = Depends(get_current_user)) -> dict:
    """触发一轮自动回复（名单与护栏在 handlers 里统一施加）。"""
    payload = body.model_dump()
    if (body.mode or "") == "send":
        _gate(body.confirm, user, "autoreply.run", payload)
    else:
        store.add_audit(user.get("username", ""), "autoreply.run", payload, "queued")
    job = await queue.submit("autoreply.run", payload, user.get("username", ""))
    return {"job": job}
