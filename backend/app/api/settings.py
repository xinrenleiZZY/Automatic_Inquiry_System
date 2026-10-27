"""业务参数 / 客户名单 / 终止追踪。

这些配置存在本系统自己的 api.db 里，运行时翻译成调用参数传给 Node 区块，
因此不需要改动冻结源码。
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import repo, store
from ..security import get_current_user, require_admin_or_gm

router = APIRouter(prefix="/api", tags=["settings"])


@router.get("/settings")
async def get_settings(user: dict = Depends(get_current_user)) -> dict:
    return {"settings": store.public_settings()}


class SettingsPatch(BaseModel):
    model_config = {"extra": "forbid"}

    send_mode: str | None = None
    inquiry_count: int | None = Field(None, ge=0, le=500)
    max_inquiry_count: int | None = Field(None, ge=0, le=100000)
    expected_price: float | None = None
    expected_price_note: str | None = None
    slice_per_round: int | None = Field(None, ge=1, le=50)
    min_interval_ms: int | None = Field(None, ge=0, le=3600000)
    max_per_hour: int | None = Field(None, ge=0, le=1000)
    quiet_hours_start: int | None = Field(None, ge=0, le=23)
    quiet_hours_end: int | None = Field(None, ge=0, le=23)
    auto_refresh_min: int | None = Field(None, ge=0, le=1440)
    scheduler_round_sec: int | None = Field(None, ge=10, le=86400)


@router.put("/settings")
async def put_settings(body: SettingsPatch, user: dict = Depends(require_admin_or_gm)) -> dict:
    patch = {k: v for k, v in body.model_dump().items() if v is not None or k == "expected_price"}
    if patch.get("send_mode") not in (None, "send", "draft", "dry"):
        raise HTTPException(status_code=400, detail="send_mode 只能是 send / draft / dry")
    try:
        store.update_settings(patch)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    store.add_audit(user.get("username", ""), "settings.update", patch, "ok")
    return {"settings": store.public_settings()}


# --------------------------------------------------------------------------
# 名单
# --------------------------------------------------------------------------
@router.get("/settings/lists")
async def get_lists(campaign_id: int | None = None,
                    user: dict = Depends(get_current_user)) -> dict:
    """名单（支持任务维度）。

    - 不带 campaign_id：全部（给"全部任务"视图，各行带自己的 campaign_id）
    - 带 campaign_id=N：全局名单 + 任务 N 的专属名单（生效值按任务覆盖全局）
    """
    items = store.list_flags(campaign_id=campaign_id)
    names = repo.conv_names([i["conv_key"] for i in items])
    for it in items:
        # 历史"只按店名/旺旺简称"加进名单的条目没有会话，就把 key 本身当名字显示（否则页面上是一行空白）
        it["conv_name"] = it.get("conv_name") or names.get(it["conv_key"]) or it["conv_key"]
    if campaign_id is not None:
        eff = store.flags_map(int(campaign_id))
        for it in items:
            cur = eff.get(it["conv_key"])
            it["effective"] = bool(cur and cur["campaign_id"] == it["campaign_id"])
    return {
        "items": items,
        "whitelist": [i for i in items if i["list_type"] == "whitelist"],
        "blacklist": [i for i in items if i["list_type"] == "blacklist"],
        "dropped": [i for i in items if i["list_type"] == "dropped"],
    }


class ListBody(BaseModel):
    list_type: str
    conv_keys: list[str] = Field(default_factory=list)
    note: str = ""
    campaign_id: int = 0        # 0 = 全部（所有任务）；>0 = 只对该任务生效


@router.post("/settings/lists")
async def add_to_list(body: ListBody, user: dict = Depends(require_admin_or_gm)) -> dict:
    if body.list_type not in ("whitelist", "blacklist", "dropped"):
        raise HTTPException(status_code=400, detail="list_type 只能是 whitelist / blacklist / dropped")
    if not body.conv_keys:
        raise HTTPException(status_code=400, detail="conv_keys 不能为空")
    names = repo.conv_names(body.conv_keys)
    added = []
    for key in body.conv_keys:
        key = key.strip()
        if not key:
            continue
        added.append(store.set_flag(key, body.list_type, names.get(key, "") or key, body.note,
                                    campaign_id=body.campaign_id))
    store.add_audit(user.get("username", ""), "list.add", body.model_dump(), f"ok:{len(added)}")
    return {"added": added, "count": len(added)}


@router.delete("/settings/lists/{conv_key}")
async def remove_from_list(conv_key: str, campaign_id: int = 0,
                           user: dict = Depends(require_admin_or_gm)) -> dict:
    ok = store.delete_flag(conv_key, campaign_id=campaign_id)
    store.add_audit(user.get("username", ""), "list.remove",
                    {"conv_key": conv_key, "campaign_id": campaign_id}, str(ok))
    if not ok:
        raise HTTPException(status_code=404, detail="该客户不在任何名单里")
    return {"removed": True}


@router.post("/customers/{conv_key}/drop")
async def drop_customer(conv_key: str, campaign_id: int = 0,
                        user: dict = Depends(require_admin_or_gm)) -> dict:
    """终止追踪（放弃该客户）。campaign_id=0 对全部任务生效，>0 只对该任务。"""
    names = repo.conv_names([conv_key])
    flag = store.set_flag(conv_key, "dropped", names.get(conv_key, ""), "人工终止追踪",
                          campaign_id=campaign_id)
    store.add_audit(user.get("username", ""), "customer.drop",
                    {"conv_key": conv_key, "campaign_id": campaign_id}, "ok")
    return {"flag": flag}


@router.post("/customers/{conv_key}/restore")
async def restore_customer(conv_key: str, campaign_id: int = 0,
                           user: dict = Depends(require_admin_or_gm)) -> dict:
    ok = store.delete_flag(conv_key, campaign_id=campaign_id)
    store.add_audit(user.get("username", ""), "customer.restore",
                    {"conv_key": conv_key, "campaign_id": campaign_id}, str(ok))
    return {"restored": ok}
