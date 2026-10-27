"""图片库 / 快捷短语库（增删改查 + 绑定 + 图片预览）。"""

import mimetypes
import re
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .. import config, repo
from ..bridge import BridgeError, bridge
from ..security import get_current_user

router = APIRouter(prefix="/api", tags=["library"])

ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}


def _remote_image_relative(p: str) -> str:
    """把宿主图片绝对路径映射成容器图片目录内的相对路径。

    图片列表由 Windows 宿主桥接生成，path 通常是：
      E:\\project\\tools\\qianniu\\image\\foo.jpg
    容器里的同名文件则在：
      /app/project/tools/qianniu/image/foo.jpg

    Docker 内 Path("E:\\...") 会被当成普通相对文件名，最终表现为 404。这里只
    在宿主代理模式下转换；普通相对路径和容器内绝对路径保持原样。
    """
    text = str(p or "").strip()
    if not config.HOST_AGENT_REMOTE:
        return text
    normalized = text.replace("\\", "/")
    if not (re.match(r"^[A-Za-z]:/", normalized) or normalized.startswith("//")):
        return text
    marker = "/tools/qianniu/image/"
    index = normalized.casefold().rfind(marker)
    if index < 0:
        raise HTTPException(status_code=400, detail="宿主图片路径不在 tools/qianniu/image 目录内")
    return normalized[index + len(marker):]


def _safe_image_path(p: str) -> Path:
    """把请求里的路径限制在图片库根目录内，防目录穿越。

    短语库里存的可能是相对路径，而且基准不统一：
    既可能是相对项目根（tools/qianniu/image/x.jpg），也可能是相对 tools/qianniu（image/x.jpg）。
    所以按「图片库 → tools/qianniu → 项目根」依次试，取第一个落库内且真实存在的。
    """
    if not p or not str(p).strip():
        raise HTTPException(status_code=400, detail="路径不能为空")
    root = config.IMAGE_DIR.resolve()
    value = _remote_image_relative(p)
    raw = Path(value)
    candidates = [raw] if raw.is_absolute() else [
        config.IMAGE_DIR / value,
        config.QIANNIU_DIR / value,
        config.PROJECT_ROOT / value,
    ]
    inside: Path | None = None
    for cand in candidates:
        try:
            resolved = cand.resolve()
        except OSError:
            continue
        if resolved == root or root in resolved.parents:
            inside = resolved
            if resolved.exists():
                return resolved
    if inside is not None:
        return inside  # 在库内但不存在 → 让调用方返回 404
    raise HTTPException(status_code=400, detail="路径必须位于图片库目录内")


# --------------------------------------------------------------------------
# 快捷短语
# --------------------------------------------------------------------------
@router.get("/phrases")
async def list_phrases(user: dict = Depends(get_current_user)) -> dict:
    data = await bridge.call("library.phrases.list", {})
    items = data.get("phrases", [])
    images = {i["path"]: i for i in repo.image_library()}
    for it in items:
        it["bound_image"] = images.get(it.get("image") or "", {}).get("image_id") or ""
    return {"file": data.get("file"), "items": items, "total": len(items)}


class PhraseBody(BaseModel):
    id: str | None = None
    name: str = ""
    text: str = ""
    image: str = ""
    keyword: str = ""
    tags: list[str] = Field(default_factory=list)


@router.post("/phrases")
async def add_phrase(body: PhraseBody, user: dict = Depends(get_current_user)) -> dict:
    if not (body.text.strip() or body.image.strip()):
        raise HTTPException(status_code=400, detail="文字和图片至少要有一个")
    try:
        created = await bridge.call("library.phrases.add", body.model_dump())
    except BridgeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"phrase": created}


class PhrasePatch(BaseModel):
    name: str | None = None
    text: str | None = None
    image: str | None = None
    keyword: str | None = None
    tags: list[str] | None = None
    enabled: bool | None = None


@router.put("/phrases/{phrase_id}")
async def update_phrase(phrase_id: str, body: PhrasePatch,
                        user: dict = Depends(get_current_user)) -> dict:
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if not patch:
        raise HTTPException(status_code=400, detail="没有需要更新的字段")
    try:
        updated = await bridge.call("library.phrases.update", {"id": phrase_id, "patch": patch})
    except BridgeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"phrase": updated}


@router.delete("/phrases/{phrase_id}")
async def delete_phrase(phrase_id: str, user: dict = Depends(get_current_user)) -> dict:
    try:
        return await bridge.call("library.phrases.delete", {"id": phrase_id})
    except BridgeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# --------------------------------------------------------------------------
# 图片库
# --------------------------------------------------------------------------
@router.get("/library/images")
async def list_images(user: dict = Depends(get_current_user)) -> dict:
    try:
        files = await bridge.call("library.images.list", {})
    except BridgeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    db_rows = {r["path"]: r for r in repo.image_library()}
    items = []
    for f in files.get("images", []):
        row = db_rows.get(f["path"], {})
        items.append({
            **f,
            "phrase_id": row.get("phrase_id"),
            "status": row.get("status"),
            "image_id": row.get("image_id"),
            "last_run_at": row.get("last_run_at"),
            "note": row.get("note"),
        })
    phrases = (await bridge.call("library.phrases.list", {})).get("phrases", [])
    return {"dir": files.get("dir"), "items": items, "total": len(items), "phrases": phrases}


@router.post("/library/images/sync")
async def sync_images(user: dict = Depends(get_current_user)) -> dict:
    try:
        return await bridge.call("library.images.sync", {})
    except BridgeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


class BindBody(BaseModel):
    image_path: str
    phrase_id: str | None = None


@router.post("/library/images/bind")
async def bind_image(body: BindBody, user: dict = Depends(get_current_user)) -> dict:
    # 用校验过的绝对路径，并且显式转成驼峰 —— 桥接那边读的是 imagePath / phraseId，
    # 直接把 model_dump()（下划线）丢过去会变成空路径（曾经的真实 BUG）。
    target = _safe_image_path(body.image_path)
    if not target.is_file():
        raise HTTPException(status_code=400, detail=f"图片不存在（不是文件）：{target}")
    bridge_path = str(target)
    if config.HOST_AGENT_REMOTE:
        # 容器内的绝对路径在 Windows 宿主上不存在。桥接的 img() 会按
        # tools/qianniu 解析相对路径，所以统一传 image/<子路径>。
        rel = target.relative_to(config.IMAGE_DIR.resolve()).as_posix()
        bridge_path = f"image/{rel}"
    try:
        return await bridge.call("library.images.bind", {
            "imagePath": bridge_path,
            "phraseId": body.phrase_id or None,
        })
    except BridgeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/library/images/repair")
async def repair_images(user: dict = Depends(get_current_user)) -> dict:
    """图片库体检：清理幽灵行、补齐被清空的文件信息、报告磁盘上已丢失的图片。"""
    try:
        return await bridge.call("library.images.repair", {})
    except BridgeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/library/images/upload")
async def upload_image(file: UploadFile = File(...),
                       user: dict = Depends(get_current_user)) -> dict:
    name = Path(file.filename or "").name
    if not name:
        raise HTTPException(status_code=400, detail="文件名为空")
    ext = Path(name).suffix.lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(status_code=400, detail=f"只支持图片格式：{', '.join(sorted(ALLOWED_EXT))}")
    config.IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    dest = config.IMAGE_DIR / name
    with dest.open("wb") as fh:
        shutil.copyfileobj(file.file, fh)
    try:
        await bridge.call("library.images.sync", {})
    except BridgeError:
        pass
    return {"saved": str(dest), "name": name}


@router.delete("/library/images")
async def delete_image(path: str, user: dict = Depends(get_current_user)) -> dict:
    target = _safe_image_path(path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="图片不存在")
    target.unlink()
    return {"deleted": str(target)}


@router.get("/library/file")
async def get_image(path: str, user: dict = Depends(get_current_user)) -> FileResponse:
    target = _safe_image_path(path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="图片不存在")
    media, _ = mimetypes.guess_type(str(target))
    return FileResponse(str(target), media_type=media or "application/octet-stream")
