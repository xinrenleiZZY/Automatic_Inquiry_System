"""数据查询：比价表 / 报价台账 / 客户 / 聊天记录 / 统计 / 导出。

全部是只读 SQL（repo.py），不经队列、不碰浏览器，前端随便刷。
"""

import csv
import io
import re
import time

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

from .. import repo, store
from ..security import get_current_user

router = APIRouter(prefix="/api/data", tags=["data"])


def _ts(value: str | None) -> int | None:
    """把 2026-09-01 / 1790000000000 统一成毫秒时间戳。"""
    if not value:
        return None
    v = value.strip()
    if v.isdigit():
        n = int(v)
        return n if n > 1e11 else n * 1000
    from datetime import datetime

    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d", "%Y/%m/%d"):
        try:
            return int(datetime.strptime(v, fmt).timestamp() * 1000)
        except ValueError:
            continue
    raise HTTPException(status_code=400, detail=f"无法解析时间：{value}")


def _ts_end(value: str | None) -> int | None:
    """区间终点用：只给日期（2026-10-12）时补到当天 23:59:59.999，避免把当天的消息漏掉。"""
    if not value:
        return None
    v = value.strip()
    if v.isdigit():
        return _ts(v)
    ms = _ts(v)
    return None if ms is None else ms + 86_399_999


@router.get("/stats")
async def stats(user: dict = Depends(get_current_user)) -> dict:
    return repo.stats()


@router.get("/compare")
async def compare(
    campaign_id: int | None = None,
    product: str | None = None,
    date_from: str | None = Query(None, alias="from"),
    date_to: str | None = Query(None, alias="to"),
    only_priced: bool = False,
    # 页面默认保留"不做此款"的行（标注结论、能看到对方原话/依据）；导出走 csv_rows，那边强制隐藏
    include_dropped: bool = True,
    limit: int = 1000,
    user: dict = Depends(get_current_user),
) -> dict:
    settings = store.get_settings()
    expected = settings.get("expected_price")
    rows = repo.compare(
        campaign_id=campaign_id,
        product=product,
        frm=_ts(date_from),
        to=_ts(date_to),
        only_priced=only_priced,
        expected_price=float(expected) if expected not in (None, "") else None,
        include_dropped=include_dropped,
        limit=limit,
    )
    priced = [r for r in rows if r["unit_price_final"] is not None]
    summary = {
        "total": len(rows),
        "quoted": sum(1 for r in rows if not r.get("is_dropped")),       # 已询价家数（含需人工联系）
        "not_matching": sum(1 for r in rows if r.get("is_dropped")),     # 不做此款
        "need_human": sum(1 for r in rows if r.get("is_need_human")),    # 需人工联系
        "priced": len(priced),
        "min_price": min((r["unit_price_final"] for r in priced), default=None),
        "max_price": max((r["unit_price_final"] for r in priced), default=None),
        "avg_price": round(sum(r["unit_price_final"] for r in priced) / len(priced), 4) if priced else None,
        "meets_target": sum(1 for r in priced if r.get("meets_target")),
        "expected_price": expected,
    }
    return {"items": rows, "summary": summary}


@router.get("/quotes")
async def quotes(limit: int = 200, campaign_id: int | None = None,
                 user: dict = Depends(get_current_user)) -> dict:
    return {"items": repo.quotes(limit, campaign_id)}


@router.get("/customers")
async def customers(keyword: str | None = None, limit: int = 500,
                    campaign_id: int | None = None,
                    date_from: str | None = Query(None, alias="from"),
                    date_to: str | None = Query(None, alias="to"),
                    user: dict = Depends(get_current_user)) -> dict:
    """客户台账。

    - `campaign_id`：只看该任务联系过的客户
    - `from` / `to`：按"该会话最后一条消息的时间"（台账里「最近消息」那列）过滤
    """
    rows = repo.customers(keyword, limit, frm=_ts(date_from), to=_ts_end(date_to),
                          campaign_id=campaign_id)
    # 名单带任务维度：选了任务就看"全局 + 该任务"生效后的那份
    flags = store.flags_map(campaign_id or 0)
    for r in rows:
        f = flags.get(r["conv_key"])
        r["list_type"] = (f or {}).get("list_type")
        r["flag_note"] = (f or {}).get("note")
        r["flag_scope"] = int((f or {}).get("campaign_id") or 0)
    return {"items": rows, "total": len(rows)}


def _chat_payload(conv_key: str, limit: int, campaign_id: int = 0) -> dict:
    data = repo.chat(conv_key, limit, campaign_id=campaign_id)
    if data is None:
        raise HTTPException(status_code=404, detail="找不到该会话")
    flag = store.flags_map(campaign_id or 0).get(conv_key)
    data["flag"] = flag
    return data


@router.get("/chat")
async def chat_by_query(conv_key: str, limit: int = 500, campaign_id: int = 0,
                        user: dict = Depends(get_current_user)) -> dict:
    """按会话取完整往来。

    注意：conv_key 里含 `#`（如 3159769358.1-...#11156@cntaobao），
    放进 URL 路径会被当成 fragment，所以**推荐用查询参数**调用。
    """
    return _chat_payload(conv_key, limit, campaign_id)


@router.get("/chat/{conv_key:path}")
async def chat_by_path(conv_key: str, limit: int = 500, campaign_id: int = 0,
                       user: dict = Depends(get_current_user)) -> dict:
    return _chat_payload(conv_key, limit, campaign_id)


@router.get("/messages")
async def messages(limit: int = 200, offset: int = 0, conv_key: str | None = None,
                   direction: str | None = None, keyword: str | None = None,
                   user: dict = Depends(get_current_user)) -> dict:
    return repo.messages(limit, offset, conv_key, direction, keyword)


@router.get("/offers")
async def offers(image_id: str | None = None, campaign_id: int | None = None,
                 limit: int = 200, user: dict = Depends(get_current_user)) -> dict:
    return {"items": repo.offer_prices(image_id, campaign_id, limit)}


@router.get("/image-searches")
async def image_searches(limit: int = 50, user: dict = Depends(get_current_user)) -> dict:
    return {"items": repo.image_searches(limit)}


@router.get("/image-contacts")
async def image_contacts(limit: int = 200, user: dict = Depends(get_current_user)) -> dict:
    return {"items": repo.image_contacts(limit)}


@router.get("/phrase-sends")
async def phrase_sends(limit: int = 200, user: dict = Depends(get_current_user)) -> dict:
    return {"items": repo.phrase_sends(limit)}


@router.get("/auto-replies")
async def auto_replies(limit: int = 100, user: dict = Depends(get_current_user)) -> dict:
    return {"items": repo.auto_replies(limit)}


@router.get("/heartbeats")
async def heartbeats(limit: int = 60, user: dict = Depends(get_current_user)) -> dict:
    return {"items": repo.heartbeats(limit)}


@router.get("/export/{kind}.csv")
async def export_csv(kind: str, campaign_id: int | None = None, product: str | None = None,
                     date_from: str | None = Query(None, alias="from"),
                     date_to: str | None = Query(None, alias="to"),
                     mode: str = "detail", only_priced: bool = False,
                     include_dropped: bool = False,
                     user: dict = Depends(get_current_user)) -> StreamingResponse:
    kw: dict = {}
    if kind == "compare":
        kw = {"campaign_id": campaign_id, "product": product,
              "frm": _ts(date_from), "to": _ts(date_to),
              "mode": mode, "only_priced": only_priced,
              "include_dropped": include_dropped}
    elif kind == "customers":
        kw = {"keyword": product, "campaign_id": campaign_id,
              "frm": _ts(date_from), "to": _ts_end(date_to)}
    elif kind == "quotes":
        kw = {"campaign_id": campaign_id}
    else:
        raise HTTPException(status_code=400, detail="导出类型只支持 compare / quotes / customers")
    try:
        headers, rows = repo.csv_rows(kind, **kw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    buf = io.StringIO()
    buf.write("\ufeff")  # BOM，Excel 打开中文不乱码
    writer = csv.writer(buf)
    writer.writerow(headers)
    writer.writerows(rows)
    buf.seek(0)
    filename = f"{kind}-{__import__('time').strftime('%Y%m%d%H%M%S')}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _excel_value(value):
    if value is None:
        return ""
    if not isinstance(value, str):
        return value
    # Excel 不接受 XML 1.0 控制字符。
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", value)[:32760]


@router.get("/export/compare.xlsx")
async def export_compare_xlsx(campaign_id: int | None = None, product: str | None = None,
                              date_from: str | None = Query(None, alias="from"),
                              date_to: str | None = Query(None, alias="to"),
                              only_priced: bool = False, include_dropped: bool = True,
                              user: dict = Depends(get_current_user)) -> StreamingResponse:
    rows = repo.compare(
        campaign_id=campaign_id, product=product,
        frm=_ts(date_from), to=_ts(date_to),
        only_priced=only_priced, include_dropped=include_dropped,
    )
    workbook = Workbook()
    workbook.remove(workbook.active)
    header_fill = PatternFill("solid", fgColor="3B6FE0")
    header_font = Font(color="FFFFFF", bold=True)

    for title, concise in (("详细", False), ("简洁", True)):
        headers, data = repo.compare_export_rows(rows, concise=concise)
        sheet = workbook.create_sheet(title)
        sheet.append(headers)
        for row in data:
            sheet.append([_excel_value(value) for value in row])
        for cell in sheet[1]:
            cell.fill = header_fill
            cell.font = header_font
            cell.alignment = Alignment(horizontal="center", vertical="center")
        sheet.freeze_panes = "A2"
        sheet.auto_filter.ref = sheet.dimensions
        for index, header in enumerate(headers, start=1):
            width = 42 if header in ("回复原文", "询价话术", "备注") else max(12, min(28, len(header) * 2))
            sheet.column_dimensions[sheet.cell(row=1, column=index).column_letter].width = width

    buf = io.BytesIO()
    workbook.save(buf)
    buf.seek(0)
    filename = f"compare-{time.strftime('%Y%m%d%H%M%S')}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
