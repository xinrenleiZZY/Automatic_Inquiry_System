"""只读数据访问层（im.db）。

铁律：这里**只发 SELECT**。所有写操作（含建任务、发消息）一律走桥接交给 Node，
避免 SQLite 出现两个写者。

连接用 `mode=rw` + `PRAGMA query_only=ON`：
  - 不用 `mode=ro`：WAL 库以纯只读方式打开会失败（拿不到 -shm）；
  - query_only 保证即使代码写错也写不进去。
"""

import re
import sqlite3
import time
from contextlib import contextmanager
from typing import Any

from . import config

_NUM_RE = re.compile(r"(\d+(?:\.\d+)?)")


@contextmanager
def connect_im():
    uri = "file:" + config.IM_DB.as_posix() + "?mode=rw"
    conn = sqlite3.connect(uri, uri=True, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=10000")
    conn.execute("PRAGMA query_only=ON")
    try:
        yield conn
    finally:
        conn.close()


def parse_price(text: Any) -> float | None:
    """从任意文本里抠出第一个价格数字（'0.74元/支' → 0.74）。"""
    if text is None:
        return None
    if isinstance(text, (int, float)):
        return float(text)
    m = _NUM_RE.search(str(text))
    if not m:
        return None
    try:
        return float(m.group(1))
    except ValueError:
        return None


def _rows(cur: sqlite3.Cursor) -> list[dict]:
    return [dict(r) for r in cur.fetchall()]


def _one(cur: sqlite3.Cursor) -> dict | None:
    r = cur.fetchone()
    return dict(r) if r else None


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    return _one(conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (name,)
    )) is not None


# --------------------------------------------------------------------------
# 总览
# --------------------------------------------------------------------------
def stats() -> dict:
    if not config.IM_DB.exists():
        return {"available": False, "error": f"数据库不存在：{config.IM_DB}"}
    with connect_im() as conn:
        def count(table: str) -> int:
            if not table_exists(conn, table):
                return 0
            return _one(conn.execute(f"SELECT COUNT(*) c FROM {table}"))["c"]

        def count_where(table: str, where: str) -> int:
            if not table_exists(conn, table):
                return 0
            return _one(conn.execute(
                f"SELECT COUNT(*) c FROM {table} WHERE {where}"))["c"]

        hb = None
        if table_exists(conn, "heartbeats"):
            hb = _one(conn.execute("SELECT * FROM heartbeats ORDER BY id DESC LIMIT 1"))
        latest_msg = None
        if table_exists(conn, "messages"):
            latest_msg = _one(conn.execute(
                "SELECT text, conv_name, direction, COALESCE(msg_epoch, captured_at) t "
                "FROM messages ORDER BY COALESCE(msg_epoch, captured_at) DESC LIMIT 1"
            ))
        per_day = []
        if table_exists(conn, "messages"):
            per_day = _rows(conn.execute(
                "SELECT date(COALESCE(msg_epoch, captured_at)/1000,'unixepoch','localtime') d, "
                "SUM(CASE WHEN direction='in' THEN 1 ELSE 0 END) inbound, "
                "SUM(CASE WHEN direction='out' THEN 1 ELSE 0 END) outbound "
                "FROM messages GROUP BY d ORDER BY d DESC LIMIT 14"
            ))
        return {
            "available": True,
            "db_path": str(config.IM_DB),
            "db_size": config.IM_DB.stat().st_size,
            "counts": {
                "conversations": count("conversations"),
                "messages": count("messages"),
                "events": count("events"),
                "campaigns": count("campaigns"),
                "image_contacts": count("image_contacts"),
                "phrase_sends": count("phrase_sends"),
                # “名单排除”占位行不是报价，不能算进业务统计
                "supplier_quotes": count_where(
                    "supplier_quotes", "COALESCE(quote_source,'') <> 'blocked'"),
                "offer_prices": count("offer_prices"),
                "auto_replies": count("auto_replies"),
                "image_library": count("image_library"),
                "phrase_library": count("phrase_library"),
            },
            "last_heartbeat": hb,
            "latest_message": latest_msg,
            "per_day": list(reversed(per_day)),
        }


def heartbeats(limit: int = 60) -> list[dict]:
    if not config.IM_DB.exists():
        return []
    with connect_im() as conn:
        if not table_exists(conn, "heartbeats"):
            return []
        return _rows(conn.execute("SELECT * FROM heartbeats ORDER BY id DESC LIMIT ?", (int(limit),)))


def events(limit: int = 100) -> list[dict]:
    if not config.IM_DB.exists():
        return []
    with connect_im() as conn:
        if not table_exists(conn, "events"):
            return []
        return _rows(conn.execute("SELECT * FROM events ORDER BY id DESC LIMIT ?", (int(limit),)))


# 比价表核心字段（顺序/文案与 tools/qianniu/blocks/db.mjs 的 QUOTE_FIELDS 对齐）。
# 「备注」是 AI 的自由文本摘要，几乎每条回复都会写，不算"新增比价字段"，故排除。
NEWS_QUOTE_FIELDS = [
    "单价", "起订量", "运费", "打样工期", "大货工期",
    "打样费（大货是否退）", "大货不退含打样费的单价", "保密协议", "次品率",
]


def _missing_fields(raw: Any) -> set[str]:
    """auto_replies.missing 是"、"-分隔的字段名清单。"""
    return {s.strip() for s in str(raw or "").split("、") if s and s.strip()}


def news(limit: int = 40) -> list[dict]:
    """最近事件（新闻）＝ 某客户回复**新增了比价表字段**，而不是聊天记录。

    数据来源：auto_replies —— 每一次"客户回复 → AI 解析 → 写入比价表"都会留一条，
    并记下这次解析后**还缺哪些字段**。把同一会话相邻两条一相减，就知道这次回复
    新填上了哪些比价字段。AI 判定"不做这款产品/放弃客户"（drop）的回复不算新闻。
    """
    if not config.IM_DB.exists():
        return []
    with connect_im() as conn:
        if not table_exists(conn, "auto_replies"):
            return []
        rows = _rows(conn.execute(
            "SELECT id, epoch, conv_key, conv_name, inbound_text, ai_action, missing "
            "FROM auto_replies ORDER BY conv_key ASC, epoch ASC, id ASC"
        ))

    known = set(NEWS_QUOTE_FIELDS)
    seen: dict[str, set[str]] = {}
    out: list[dict] = []
    for r in rows:
        key = str(r.get("conv_key") or "")
        if str(r.get("ai_action") or "") == "drop":
            seen[key] = set(known)          # 放弃该客户，后续重新从"全部缺失"起算
            continue
        cur = _missing_fields(r.get("missing")) & known
        prev = seen.get(key, known)
        added = [f for f in NEWS_QUOTE_FIELDS if f in prev and f not in cur]
        seen[key] = cur
        if not added:
            continue
        out.append({
            "id": r.get("id"),
            "epoch": r.get("epoch"),
            "type": "quote-update",
            "conv": r.get("conv_name") or "",
            "conv_key": key,
            "text": "、".join(added),
            "descr": f"比价表新增 {len(added)} 项字段",
            "raw": r.get("inbound_text") or "",
        })

    out.sort(key=lambda x: x.get("epoch") or 0, reverse=True)
    return out[: int(limit)]


# --------------------------------------------------------------------------
# 任务（比价任务）
# --------------------------------------------------------------------------
def list_campaigns(limit: int = 100, status: str | None = None,
                   include_archived: bool = True) -> list[dict]:
    """任务列表。include_archived=False 时隐藏已归档（任务列表页默认隐藏，筛选下拉仍要全量）。"""
    if not config.IM_DB.exists():
        return []
    sql = """
        SELECT c.*,
               /* 已联系数按"唯一商家"算：
                  同一家店的多张商品卡片会落多条记录，不能把 10 家目标凑满；
                  名单排除行（dropped）和失败/重复行也不算已联系。 */
               (SELECT COUNT(*) FROM (
                    /* conv_key 是打开聊天框后读到的真实会话主键，优先按它算唯一客户；
                       老数据没有 conv_key 时才退回 chat_uid / 昵称 / 店名 / offer。 */
                    SELECT COALESCE(NULLIF(ic.conv_key,''), NULLIF(ic.chat_uid,''),
                                    NULLIF(ic.seller_nick,''), NULLIF(ic.shop_name,''),
                                    ic.offer_id) AS merchant_key
                      FROM image_contacts ic
                     WHERE ic.campaign_id = c.id
                       AND COALESCE(ic.status,'') NOT IN
                           ('dropped','failed','no-link','duplicate','skipped-duplicate',
                            'blocked','excluded','dry','skipped-not-doing')
                     GROUP BY merchant_key
               )) AS contact_count,
               (SELECT COUNT(*) FROM supplier_quotes sq
                 WHERE sq.campaign_id = c.id
                   AND COALESCE(sq.quote_source,'') <> 'blocked') AS quote_count,
               (SELECT COUNT(*) FROM supplier_quotes sq WHERE sq.campaign_id = c.id
                  AND COALESCE(sq.quote_source,'') <> 'blocked'
                  AND sq.unit_price_final IS NOT NULL) AS priced_count,
               (SELECT COUNT(*) FROM offer_prices op WHERE op.campaign_id = c.id) AS offer_count
        FROM campaigns c
    """
    args: list[Any] = []
    if status:
        sql += " WHERE c.status = ?"
        args.append(status)
    elif not include_archived:
        sql += " WHERE COALESCE(c.status,'') <> 'archived'"
    sql += " ORDER BY c.id DESC LIMIT ?"
    args.append(int(limit))
    with connect_im() as conn:
        return _rows(conn.execute(sql, args))


def get_campaign(campaign_id: int) -> dict | None:
    if not config.IM_DB.exists():
        return None
    with connect_im() as conn:
        row = _one(conn.execute("SELECT * FROM campaigns WHERE id = ?", (campaign_id,)))
        if not row:
            return None
        row["contacts"] = _rows(conn.execute(
            "SELECT * FROM image_contacts WHERE campaign_id = ? ORDER BY rank", (campaign_id,)))
        row["quotes"] = _rows(conn.execute(
            "SELECT * FROM supplier_quotes WHERE campaign_id = ? "
            "AND COALESCE(quote_source,'') <> 'blocked' ORDER BY id DESC", (campaign_id,)))
        row["offers"] = _rows(conn.execute(
            "SELECT * FROM offer_prices WHERE campaign_id = ? ORDER BY page_price_num", (campaign_id,)))
        row["phrase_sends"] = _rows(conn.execute(
            "SELECT * FROM phrase_sends WHERE campaign_id = ? ORDER BY id DESC", (campaign_id,)))
    return row


def campaign_contacts(campaign_id: int) -> list[dict]:
    if not config.IM_DB.exists():
        return []
    with connect_im() as conn:
        return _rows(conn.execute(
            "SELECT * FROM image_contacts WHERE campaign_id = ? ORDER BY rank", (campaign_id,)))


def _compact_text(value: Any, limit: int = 30) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip(" ：:；;，,。")
    return text[:limit]


def _summary_moq(value: Any) -> str:
    text = _compact_text(value, 40)
    if not text:
        return "—"
    match = re.search(
        r"(\d+(?:\.\d+)?(?:\s*[-~至]\s*\d+(?:\.\d+)?)?)\s*"
        r"(套|张|件|个|只|盒|支|条|包|箱|台|本)", text, re.I,
    )
    if match:
        number = re.sub(r"\s+", "", match.group(1)).replace("至", "-").replace("~", "-")
        return f"{number}（{match.group(2)}）"
    cn_match = re.search(r"([一二两三四五六七八九十]+)\s*(套|张|件|个|只|盒|支|条|包|箱|台|本)", text)
    if cn_match:
        raw_number, unit = cn_match.groups()
        digits = "零一二三四五六七八九"
        if raw_number == "十":
            number = 10
        elif "十" in raw_number:
            left, _, right = raw_number.partition("十")
            number = (digits.index(left) if left else 1) * 10 + (digits.index(right) if right else 0)
        else:
            number = digits.index(raw_number[0])
        return f"{number}（{unit}）"
    return text[:16]


def _summary_freight(value: Any) -> str:
    text = _compact_text(value, 60)
    if not text:
        return "—"
    if re.search(r"待定|稍后确认|需确认", text):
        return "待定"
    if re.search(r"不含税运|不含税和运|税费?运费?另议", text):
        return "不含税运"
    if re.search(r"运费另议|另算|另计|再议", text) or (
        "运费" in text and re.search(r"另|协商|不包", text)
    ):
        return "运费另议"
    if re.search(r"不含运费|运费自理|买家承担|到付", text):
        return "不含运费" if "到付" not in text else "运费到付"
    if re.search(r"包邮|免运费|免邮", text):
        return "包邮"
    if re.search(r"含运费|含运", text):
        return "含运费"
    match = re.search(r"[￥¥]?\s*(\d+(?:\.\d+)?)\s*元?", text)
    if match and "运" in text:
        return f"运费¥{match.group(1)}"
    return text[:12]


def _summary_duration(value: Any, sample: bool = False) -> str:
    text = _compact_text(value, 60)
    if not text:
        return "—"
    match = re.search(
        r"(\d+(?:\.\d+)?(?:\s*[-~至]\s*\d+(?:\.\d+)?)?)\s*"
        r"(工作日|个工作日|小时|天|周)",
        text,
    )
    if match:
        number = re.sub(r"\s+", "", match.group(1)).replace("至", "-").replace("~", "-")
        unit = "工作日" if "工作日" in match.group(2) else match.group(2)
        short = number + unit
        if sample and re.search(r"首样|首件", text):
            short += "（首样）"
        return short
    if "当天" in text or "今天" in text:
        short = "当天"
        if sample and re.search(r"首样|首件", text):
            short += "（首样）"
        return short
    text = re.sub(r"^(打样|大货)?(工期|周期|交期)\s*[：:]?\s*", "", text)
    text = re.sub(r"^(约|大概|预计|需要|需)\s*", "", text)
    text = re.sub(r"(左右|上下)$", "", text)
    text = re.sub(r"\s*[~至]\s*", "-", text)
    text = re.sub(r"(\d+)\s*[hH](?![a-zA-Z])", r"\1小时", text)
    text = re.sub(r"(\d+)\s*个小时", r"\1小时", text)
    text = text.replace("个工作日", "工作日").strip()
    if sample and "首样" not in text and re.search(r"首样|首件", _compact_text(value, 60)):
        text += "（首样）"
    return text[:18]


def _summary_refund(value: Any) -> str:
    text = _compact_text(value, 60)
    if not text:
        return "—"
    if re.search(r"不退|不可退|不予退|不退费", text):
        return "不退"
    if re.search(r"可抵|抵扣", text):
        return "可抵大货款"
    if re.search(r"可退|退还|退回|返现", text):
        return "可退"
    if re.search(r"免费|免收", text):
        return "免费"
    fee = re.search(r"(\d+(?:\.\d+)?)\s*元", text)
    if fee:
        return f"另收{fee.group(1)}元"
    return text[:10]


def _summary_sample_price(value: Any) -> str:
    text = _compact_text(value, 60)
    if not text:
        return "—"
    match = re.search(r"[￥¥]?\s*(\d+(?:\.\d+)?)", text)
    return f"¥{match.group(1)}" if match else text[:12]


def _summary_defect(value: Any) -> str:
    text = _compact_text(value, 60)
    if not text:
        return "—"
    match = re.search(r"(\d+(?:\.\d+)?(?:\s*[-~至]\s*\d+(?:\.\d+)?)?)\s*%", text)
    if match:
        return re.sub(r"\s+", "", match.group(1)).replace("至", "-").replace("~", "-") + "%"
    if re.search(r"无次品|零次品|没有次品|0\s*个点", text):
        return "0%"
    if re.search(r"没有|未|不清楚|不知道", text):
        return "未提供"
    return text[:10]


def _summary_nda(value: Any) -> str:
    text = _compact_text(value, 60)
    if not text:
        return "—"
    if re.search(r"不签|不支持|不接受|拒绝", text):
        return "不可签"
    if re.search(r"可签|能签|可以签|支持|同意|可以", text):
        return "可签"
    if re.search(r"另签|单独签", text):
        return "可另签"
    return text[:10]


def compare_summary_fields(row: dict[str, Any]) -> dict[str, str]:
    """把比价表原始字段压成固定、简短的展示格式。"""
    return {
        "moq": _summary_moq(row.get("moq")),
        "freight": _summary_freight(row.get("freight")),
        "sample_lead_time": _summary_duration(row.get("sample_lead_time"), sample=True),
        "bulk_lead_time": _summary_duration(row.get("bulk_lead_time")),
        "sample_fee_refundable": _summary_refund(row.get("sample_fee_refundable")),
        "price_incl_sample_fee": _summary_sample_price(row.get("price_incl_sample_fee")),
        "defect_rate": _summary_defect(row.get("defect_rate")),
        "nda": _summary_nda(row.get("nda")),
    }


# --------------------------------------------------------------------------
# 比价表
# --------------------------------------------------------------------------
def compare(campaign_id: int | None = None, product: str | None = None,
            frm: int | None = None, to: int | None = None,
            only_priced: bool = False, expected_price: float | None = None,
            include_dropped: bool = False, limit: int = 1000) -> list[dict]:
    """比价表：把「商家真实回复的价格」和「页面价」对齐。

    - 名单占位行（quote_source='blocked'）永远排除：它们是 applyBlocked 为了
      兼容旧过滤逻辑写进 supplier_quotes 的占位记录，没有回复原文、没有报价，
      不是真实商家，也不该出现在比价表里；
    - 页面价优先取 offer_prices.page_price_num（同 offer_id 最近一条），
      否则退回 supplier_quotes.page_price 里解析出来的数字；
    - 可比单价优先用 unit_price_final（AI/规则已按口径换算过），
      否则从 unit_price 里解析；
    - 口径 price_basis：absolute / page_plus / page_minus / page_same。
    """
    if not config.IM_DB.exists():
        return []
    sql = """
        SELECT q.*,
               c.name AS campaign_name,
               c.image_file AS campaign_image,
               (SELECT o.page_price_num FROM offer_prices o
                 WHERE q.offer_id <> '' AND o.offer_id = q.offer_id
                 ORDER BY o.id DESC LIMIT 1) AS offer_page_price,
               (SELECT o.shop_name FROM offer_prices o
                 WHERE q.offer_id <> '' AND o.offer_id = q.offer_id
                 ORDER BY o.id DESC LIMIT 1) AS offer_shop_name
        FROM supplier_quotes q
        LEFT JOIN campaigns c ON c.id = q.campaign_id
        WHERE 1 = 1
          AND COALESCE(q.quote_source,'') <> 'blocked'
    """
    args: list[Any] = []
    if campaign_id is not None:
        sql += " AND q.campaign_id = ?"
        args.append(campaign_id)
    if product:
        sql += " AND (q.product_image LIKE ? OR q.phrase LIKE ? OR q.supplier_wangwang LIKE ?)"
        like = f"%{product}%"
        args += [like, like, like]
    if frm is not None:
        sql += " AND q.updated_at >= ?"
        args.append(frm)
    if to is not None:
        sql += " AND q.updated_at <= ?"
        args.append(to)
    if not include_dropped:
        sql += " AND COALESCE(q.status,'') <> 'dropped'"
    sql += " ORDER BY (q.unit_price_final IS NULL), q.unit_price_final ASC LIMIT ?"
    args.append(int(limit))

    with connect_im() as conn:
        rows = _rows(conn.execute(sql, args))

    out: list[dict] = []
    for r in rows:
        page = r.get("offer_page_price")
        if page is None:
            page = parse_price(r.get("page_price"))
        final = r.get("unit_price_final")
        if final is None:
            final = parse_price(r.get("unit_price"))
        diff = None
        diff_pct = None
        status = str(r.get("status") or "")
        # 不做此款的行不显示页面价：那个价往往是图搜串进来的同店**其它商品**价
        # （实测"定制纸杯"任务里挂着义乌市林旭玩具厂自家啪啪圈手环的 ￥0.2），
        # 留着会被误读成"这家的报价"。
        if status == "dropped":
            page = None
        # 结论：先看"这家是不是做这款"，再看价格对比
        #   不做此款   → 对方明确不做/只做自家品类（页面价/可比单价都空，导出时默认隐藏）
        #   需人工联系 → 对方把球踢给联系人，自动追问已止步（联系人+原话在备注里）
        #   信息不全   → 已问到上限仍没给出价格所需的字段
        verdict = "无法比价"
        if status == "dropped":
            verdict = "不做此款"
        elif status == "need_human":
            verdict = "需人工联系"
        elif status == "give_up":
            verdict = "信息不全"
        elif page is not None and final is not None:
            diff = round(float(final) - float(page), 4)
            if page:
                diff_pct = round(diff / float(page) * 100, 2)
            if diff > 0.0001:
                verdict = "高于页面价"
            elif diff < -0.0001:
                verdict = "低于页面价"
            else:
                verdict = "与页面价持平"
        meets = None
        if expected_price is not None and final is not None:
            meets = float(final) <= float(expected_price)
        item = {
            **r,
            "page_price_num": page,
            "unit_price_final": final,
            "diff": diff,
            "diff_pct": diff_pct,
            "verdict": verdict,
            "expected_price": expected_price,
            "meets_target": meets,
            "is_dropped": (r.get("status") == "dropped"),
            "is_need_human": (r.get("status") == "need_human"),
            "is_give_up": (r.get("status") == "give_up"),
            "not_doing_reason": r.get("not_doing_reason") or "",
            "handoff_contact": r.get("handoff_contact") or "",
        }
        item["summary_fields"] = compare_summary_fields(item)
        out.append(item)
    if only_priced:
        out = [x for x in out if x["unit_price_final"] is not None]
    return out


# --------------------------------------------------------------------------
# 客户
# --------------------------------------------------------------------------
def customers(keyword: str | None = None, limit: int = 500,
              frm: int | None = None, to: int | None = None,
              campaign_id: int | None = None) -> list[dict]:
    """客户台账。

    筛选口径：
      - keyword      客户名 / 会话号 / 对方账号
      - frm / to     按"该会话最后一条消息的时间"（= 台账里「最近消息」那列）过滤，
                     毫秒时间戳，闭区间
      - campaign_id  按任务筛选：这条会话是不是该任务联系过的客户。
                     匹配依次是 ①短语发送记录（conv_key/会话名/offer_id）
                                 ②报价记录（conv_key/旺旺号）
                                 ③兜底：会话里出现过该任务的询价话术（老任务没有
                                   campaign_id 关联时也能查到）
    """
    if not config.IM_DB.exists():
        return []
    last_at_sql = ("(SELECT COALESCE(m.msg_epoch, m.captured_at) FROM messages m "
                   "WHERE m.conv_key = c.conv_key "
                   "ORDER BY COALESCE(m.msg_epoch, m.captured_at) DESC LIMIT 1)")
    sql = """
        SELECT c.conv_key, c.name, c.peer, c.is_self, c.site,
               c.first_seen, c.last_seen, c.last_desc, c.ui_time, c.unread,
               (SELECT COUNT(*) FROM messages m WHERE m.conv_key = c.conv_key) AS msg_count,
               (SELECT COUNT(*) FROM messages m WHERE m.conv_key = c.conv_key AND m.direction='in') AS in_count,
               (SELECT COUNT(*) FROM messages m WHERE m.conv_key = c.conv_key AND m.direction='out') AS out_count,
               (SELECT m.text FROM messages m WHERE m.conv_key = c.conv_key
                 ORDER BY COALESCE(m.msg_epoch, m.captured_at) DESC LIMIT 1) AS last_text,
               (SELECT COALESCE(m.msg_epoch, m.captured_at) FROM messages m
                 WHERE m.conv_key = c.conv_key ORDER BY COALESCE(m.msg_epoch, m.captured_at) DESC LIMIT 1) AS last_at,
               (SELECT COUNT(*) FROM supplier_quotes q
                 WHERE q.conv_key = c.conv_key
                   AND COALESCE(q.quote_source,'') <> 'blocked') AS quote_count,
               (SELECT MIN(q.unit_price_final) FROM supplier_quotes q
                 WHERE q.conv_key = c.conv_key
                   AND COALESCE(q.quote_source,'') <> 'blocked'
                   AND q.unit_price_final IS NOT NULL) AS best_price,
               (SELECT q.unit_price_final FROM supplier_quotes q WHERE q.conv_key = c.conv_key
                 AND COALESCE(q.quote_source,'') <> 'blocked'
                 ORDER BY q.id DESC LIMIT 1) AS last_price,
               /* 关联「图片 / 短语」的三条线索（按可靠性排序）：
                  ① offer_id：供应商报价表里有真实 conv_key，最可靠；
                  ② conv_key 直接相等；
                  ③ 名字互相包含（phrase_sends.conv_key 存的是店铺名，不是会话主键）。 */
               (SELECT GROUP_CONCAT(DISTINCT ps.phrase_id) FROM phrase_sends ps
                 WHERE ps.phrase_id IS NOT NULL AND (
                       ps.conv_key = c.conv_key
                    OR ps.conv_name = c.name
                    OR (ps.offer_id <> '' AND ps.offer_id IN (
                         SELECT q2.offer_id FROM supplier_quotes q2
                          WHERE q2.conv_key = c.conv_key AND q2.offer_id <> ''))
                    OR (ps.conv_key <> '' AND (
                         c.name LIKE '%' || ps.conv_key || '%'
                      OR ps.conv_key LIKE '%' || c.name || '%'))
                 )) AS phrase_ids,
               (SELECT GROUP_CONCAT(DISTINCT ic.image_id) FROM phrase_sends ps
                 JOIN image_contacts ic ON ic.offer_id = ps.offer_id
                 WHERE ps.offer_id <> '' AND (
                       ps.conv_key = c.conv_key
                    OR ps.conv_name = c.name
                    OR ps.offer_id IN (
                         SELECT q3.offer_id FROM supplier_quotes q3
                          WHERE q3.conv_key = c.conv_key AND q3.offer_id <> '')
                    OR (ps.conv_key <> '' AND (
                         c.name LIKE '%' || ps.conv_key || '%'
                      OR ps.conv_key LIKE '%' || c.name || '%'))
                 )) AS image_ids,
               (SELECT GROUP_CONCAT(DISTINCT ps.campaign_id) FROM phrase_sends ps
                 WHERE ps.conv_key = c.conv_key AND ps.campaign_id IS NOT NULL) AS campaign_ids
        FROM conversations c
        WHERE 1 = 1
    """
    args: list[Any] = []
    if keyword:
        like = f"%{keyword}%"
        sql += " AND (c.name LIKE ? OR c.conv_key LIKE ? OR c.peer LIKE ?)"
        args += [like, like, like]
    if frm is not None:
        sql += f" AND COALESCE({last_at_sql}, 0) >= ?"
        args.append(int(frm))
    if to is not None:
        sql += f" AND COALESCE({last_at_sql}, 0) <= ?"
        args.append(int(to))
    if campaign_id is not None:
        sql += """
          AND (
            EXISTS (SELECT 1 FROM phrase_sends ps
                     WHERE ps.campaign_id = ?
                       AND ( ps.conv_key = c.conv_key
                          OR ps.conv_name = c.name
                          OR ps.conv_key = c.name
                          OR (ps.conv_name <> '' AND (
                               c.name LIKE '%' || ps.conv_name || '%'
                            OR ps.conv_name LIKE '%' || c.name || '%'))
                          OR (ps.offer_id <> '' AND ps.offer_id IN (
                               SELECT q2.offer_id FROM supplier_quotes q2
                                WHERE q2.conv_key = c.conv_key AND q2.offer_id <> ''))))
            OR EXISTS (SELECT 1 FROM supplier_quotes q
                        WHERE q.campaign_id = ?
                          AND COALESCE(q.quote_source,'') <> 'blocked'
                          AND ( q.conv_key = c.conv_key
                             OR (q.supplier_wangwang <> '' AND c.name <> ''
                                 AND q.supplier_wangwang LIKE c.name || ':%')))
            OR EXISTS (SELECT 1 FROM messages m2 JOIN campaigns cp ON cp.id = ?
                        WHERE m2.conv_key = c.conv_key
                          AND m2.direction = 'out'
                          AND COALESCE(cp.phrase_text, '') <> ''
                          AND m2.text LIKE '%' || substr(cp.phrase_text, 1, 24) || '%')
          )
        """
        args += [int(campaign_id)] * 3
    # 默认排序：按「最近消息」时间倒序（= 台账里那一列显示的时间）。
    # 没抓到消息的会话（last_at 为空）退到按首次看到的时间排，避免堆在最上面。
    sql += f" ORDER BY COALESCE({last_at_sql}, c.first_seen, 0) DESC, c.last_seen DESC LIMIT ?"
    args.append(int(limit))
    with connect_im() as conn:
        rows = _rows(conn.execute(sql, args))
    with connect_im() as conn:
        for r in rows:
            r["is_self"] = bool(r.get("is_self"))
            if campaign_id is not None:
                q = _one(conn.execute(
                    "SELECT * FROM supplier_quotes WHERE conv_key = ? AND campaign_id = ? "
                    "AND COALESCE(quote_source,'') <> 'blocked' "
                    "ORDER BY updated_at DESC, id DESC LIMIT 1",
                    (r["conv_key"], int(campaign_id)),
                ))
                t = _one(conn.execute(
                    "SELECT * FROM task_contacts WHERE campaign_id = ? AND conv_key = ?",
                    (int(campaign_id), r["conv_key"]),
                ))
                aggregate = _one(conn.execute(
                    "SELECT COUNT(*) AS quote_count, MIN(unit_price_final) AS best_price "
                    "FROM supplier_quotes WHERE conv_key = ? AND campaign_id = ? "
                    "AND COALESCE(quote_source,'') <> 'blocked'",
                    (r["conv_key"], int(campaign_id)),
                )) or {}
                r["quote_count"] = int(aggregate.get("quote_count") or 0)
                r["best_price"] = aggregate.get("best_price")
            else:
                q = _one(conn.execute(
                    "SELECT * FROM supplier_quotes WHERE conv_key = ? "
                    "AND COALESCE(quote_source,'') <> 'blocked' "
                    "ORDER BY updated_at DESC, id DESC LIMIT 1",
                    (r["conv_key"],),
                ))
                t = _one(conn.execute(
                    "SELECT * FROM task_contacts WHERE conv_key = ? "
                    "ORDER BY updated_at DESC LIMIT 1",
                    (r["conv_key"],),
                ))
            status = str((q or {}).get("status") or "")
            task_state = str((t or {}).get("state") or "")
            decision = str((t or {}).get("decision") or "")
            reason = ""
            result_status = "waiting"
            result_label = "跟进中"
            if status == "dropped" or task_state == "dropped":
                result_status = "dropped"
                result_label = "不做此款"
                reason = ((q or {}).get("not_doing_reason") or (t or {}).get("terminal_reason")
                          or "对方明确不做此款")
            elif status == "need_human" or task_state == "needs_human":
                result_status = "needs_human"
                result_label = "需人工联系"
                reason = ((q or {}).get("handoff_contact") or (q or {}).get("remark")
                          or "自动追问已止步")
            elif status == "give_up" or task_state == "give_up":
                result_status = "give_up"
                result_label = "信息不全"
                reason = (q or {}).get("remark") or "追问已达上限，信息仍未补齐"
            elif status == "quoted" or task_state == "quoted":
                result_status = "complete"
                result_label = "信息已集齐"
                if decision == "ack_sent":
                    reason = "已向客户回复收到信息，并请对方稍候"
                elif decision == "ack_drafted":
                    reason = "收到确认已填入草稿，尚未发送给客户"
                elif decision in ("ack", "ack_pending"):
                    reason = "信息已集齐，收到确认尚未成功发送"
                else:
                    reason = "报价字段已集齐，等待确认回复"
            elif task_state in ("sent", "waiting", "opened", "history_scanned"):
                result_label = "已询价，待回复"
                reason = "询价已发出，尚未收到完整回复"
            result_detail = reason
            reason = _compact_text(reason, 72)
            r["quote_status"] = status
            r["task_state"] = task_state
            r["task_decision"] = decision
            r["result_status"] = result_status
            r["result_label"] = result_label
            r["result_reason"] = reason
            r["result_detail"] = result_detail
    return rows


def chat(conv_key: str, limit: int = 500, campaign_id: int = 0) -> dict | None:
    if not config.IM_DB.exists():
        return None
    with connect_im() as conn:
        conv = _one(conn.execute("SELECT * FROM conversations WHERE conv_key = ?", (conv_key,)))
        msgs = _rows(conn.execute(
            "SELECT * FROM messages WHERE conv_key = ? "
            "ORDER BY COALESCE(msg_epoch, captured_at) ASC LIMIT ?",
            (conv_key, int(limit)),
        ))
        scope = " AND campaign_id = ?" if campaign_id else ""
        scope_args = (conv_key, int(campaign_id)) if campaign_id else (conv_key,)
        quotes = _rows(conn.execute(
            "SELECT * FROM supplier_quotes WHERE conv_key = ? "
            "AND COALESCE(quote_source,'') <> 'blocked'" + scope +
            " ORDER BY id DESC", scope_args))
        sends = _rows(conn.execute(
            "SELECT * FROM phrase_sends WHERE conv_key = ?" + scope +
            " ORDER BY id DESC", scope_args))
        replies = _rows(conn.execute(
            "SELECT * FROM auto_replies WHERE conv_key = ?" + scope +
            " ORDER BY id DESC LIMIT 50", scope_args))
    if not conv and not msgs:
        return None
    return {"conversation": conv, "messages": msgs, "quotes": quotes,
            "phrase_sends": sends, "auto_replies": replies}


def messages(limit: int = 200, offset: int = 0, conv_key: str | None = None,
             direction: str | None = None, keyword: str | None = None) -> dict:
    if not config.IM_DB.exists():
        return {"items": [], "total": 0}
    where, args = ["1=1"], []
    if conv_key:
        where.append("conv_key = ?")
        args.append(conv_key)
    if direction in ("in", "out"):
        where.append("direction = ?")
        args.append(direction)
    if keyword:
        where.append("text LIKE ?")
        args.append(f"%{keyword}%")
    clause = " AND ".join(where)
    with connect_im() as conn:
        total = _one(conn.execute(f"SELECT COUNT(*) c FROM messages WHERE {clause}", args))["c"]
        items = _rows(conn.execute(
            f"SELECT * FROM messages WHERE {clause} "
            f"ORDER BY COALESCE(msg_epoch, captured_at) DESC LIMIT ? OFFSET ?",
            args + [int(limit), int(offset)],
        ))
    return {"items": items, "total": total, "limit": limit, "offset": offset}


def quotes(limit: int = 200, campaign_id: int | None = None) -> list[dict]:
    if not config.IM_DB.exists():
        return []
    sql = "SELECT * FROM supplier_quotes WHERE COALESCE(quote_source,'') <> 'blocked'"
    args: list[Any] = []
    if campaign_id is not None:
        sql += " AND campaign_id = ?"
        args.append(campaign_id)
    sql += " ORDER BY id DESC LIMIT ?"
    args.append(int(limit))
    with connect_im() as conn:
        return _rows(conn.execute(sql, args))


def offer_prices(image_id: str | None = None, campaign_id: int | None = None,
                 limit: int = 200) -> list[dict]:
    if not config.IM_DB.exists():
        return []
    where, args = ["1=1"], []
    if image_id:
        where.append("image_id = ?")
        args.append(image_id)
    if campaign_id is not None:
        where.append("campaign_id = ?")
        args.append(campaign_id)
    sql = (f"SELECT * FROM offer_prices WHERE {' AND '.join(where)} "
           f"ORDER BY page_price_num ASC LIMIT ?")
    args.append(int(limit))
    with connect_im() as conn:
        return _rows(conn.execute(sql, args))


def image_searches(limit: int = 50) -> list[dict]:
    if not config.IM_DB.exists():
        return []
    with connect_im() as conn:
        if not table_exists(conn, "image_searches"):
            return []
        return _rows(conn.execute("SELECT * FROM image_searches ORDER BY id DESC LIMIT ?", (int(limit),)))


def image_contacts(limit: int = 200) -> list[dict]:
    if not config.IM_DB.exists():
        return []
    with connect_im() as conn:
        return _rows(conn.execute("SELECT * FROM image_contacts ORDER BY id DESC LIMIT ?", (int(limit),)))


def actual_contact_count() -> int:
    """实际联系过的唯一商家数（全局）。

    image_contacts 一行不等于一家商家：同一家店的多张商品卡片会落多行，
    黑名单/放弃名单还会写 status='dropped' 的排除行。全局上限必须按
    「唯一商家」算，否则重复记录会把上限提前占满。

    这里用 chat_uid → seller_nick → shop_name → offer_id 的优先顺序分组；
    Node 侧的联系前预筛用的是同一套身份字段。
    """
    if not config.IM_DB.exists():
        return 0
    with connect_im() as conn:
        row = conn.execute("""
            SELECT COUNT(*) AS n FROM (
                SELECT COALESCE(NULLIF(chat_uid,''), NULLIF(seller_nick,''),
                                NULLIF(shop_name,''), offer_id) AS merchant_key
                  FROM image_contacts
                 WHERE COALESCE(status,'') NOT IN
                       ('dropped','failed','no-link','duplicate','skipped-duplicate',
                        'blocked','excluded')
                 GROUP BY merchant_key
            )
        """).fetchone()
        return int((row or {"n": 0})["n"])


def phrase_sends(limit: int = 200) -> list[dict]:
    if not config.IM_DB.exists():
        return []
    with connect_im() as conn:
        return _rows(conn.execute("SELECT * FROM phrase_sends ORDER BY id DESC LIMIT ?", (int(limit),)))


def auto_replies(limit: int = 100) -> list[dict]:
    if not config.IM_DB.exists():
        return []
    with connect_im() as conn:
        return _rows(conn.execute("SELECT * FROM auto_replies ORDER BY id DESC LIMIT ?", (int(limit),)))


def image_library() -> list[dict]:
    if not config.IM_DB.exists():
        return []
    with connect_im() as conn:
        if not table_exists(conn, "image_library"):
            return []
        return _rows(conn.execute("SELECT * FROM image_library ORDER BY id DESC"))


def phrase_library_db() -> list[dict]:
    if not config.IM_DB.exists():
        return []
    with connect_im() as conn:
        if not table_exists(conn, "phrase_library"):
            return []
        return _rows(conn.execute("SELECT * FROM phrase_library ORDER BY phrase_id"))


def all_conv_keys() -> list[str]:
    if not config.IM_DB.exists():
        return []
    with connect_im() as conn:
        return [r["conv_key"] for r in conn.execute("SELECT conv_key FROM conversations").fetchall()]


def conv_names(keys: list[str]) -> dict[str, str]:
    if not keys or not config.IM_DB.exists():
        return {}
    marks = ",".join("?" for _ in keys)
    with connect_im() as conn:
        rows = conn.execute(
            f"SELECT conv_key, name FROM conversations WHERE conv_key IN ({marks})", keys).fetchall()
    return {r["conv_key"]: r["name"] for r in rows}


COMPARE_DETAIL_HEADERS = [
    "供应商", "会话", "任务", "产品图片", "询价话术", "页面价", "回复原文",
    "报价口径", "可比单价", "差价", "差价%", "结论", "起订量", "运费",
    "打样工期", "大货工期", "打样费是否可退", "大货不退含打样费单价",
    "次品率", "保密协议", "备注", "更新时间",
]

COMPARE_SUMMARY_HEADERS = [
    "供应商", "所属任务", "可比单价", "结论", "起订量", "运费", "打样工期",
    "大货工期", "打样费可退", "大货不退含样费价", "次品率", "保密协议",
]


def compare_export_rows(rows: list[dict[str, Any]], concise: bool = False):
    if concise:
        data = []
        for row in rows:
            summary = row.get("summary_fields") or compare_summary_fields(row)
            data.append([
                row.get("supplier_wangwang"), row.get("campaign_name"),
                row.get("unit_price_final"), row.get("verdict"),
                summary.get("moq"), summary.get("freight"),
                summary.get("sample_lead_time"), summary.get("bulk_lead_time"),
                summary.get("sample_fee_refundable"), summary.get("price_incl_sample_fee"),
                summary.get("defect_rate"), summary.get("nda"),
            ])
        return COMPARE_SUMMARY_HEADERS, data
    data = [[
        r.get("supplier_wangwang"), r.get("conv_key"), r.get("campaign_name"),
        r.get("product_image"), r.get("phrase"), r.get("page_price_num"),
        r.get("raw_text"), r.get("price_basis"), r.get("unit_price_final"),
        r.get("diff"), r.get("diff_pct"), r.get("verdict"),
        r.get("moq"), r.get("freight"), r.get("sample_lead_time"), r.get("bulk_lead_time"),
        r.get("sample_fee_refundable"), r.get("price_incl_sample_fee"), r.get("defect_rate"),
        r.get("nda"), r.get("remark"), _fmt_ts(r.get("updated_at")),
    ] for r in rows]
    return COMPARE_DETAIL_HEADERS, data


def csv_rows(kind: str, **kw) -> tuple[list[str], list[list[Any]]]:
    """导出用：返回 (表头, 数据行)。"""
    if kind == "compare":
        concise = str(kw.pop("mode", "detail")) == "concise"
        include_dropped = bool(kw.pop("include_dropped", False))
        only_priced = bool(kw.pop("only_priced", False))
        rows = compare(include_dropped=include_dropped, only_priced=only_priced, **kw)
        return compare_export_rows(rows, concise=concise)
    if kind == "customers":
        rows = customers(**kw)
        headers = ["会话", "名称", "消息数", "对方消息", "我方消息", "报价数",
                   "最低可比单价", "最近单价", "最近消息", "最近时间"]
        data = [[
            r.get("conv_key"), r.get("name"), r.get("msg_count"), r.get("in_count"),
            r.get("out_count"), r.get("quote_count"), r.get("best_price"), r.get("last_price"),
            (r.get("last_text") or "")[:120], _fmt_ts(r.get("last_at")),
        ] for r in rows]
        return headers, data
    if kind == "quotes":
        rows = quotes(**kw)
        headers = ["ID", "供应商", "单价", "起订量", "运费", "打样工期", "大货工期",
                   "打样费是否可退", "大货不退含打样费单价", "次品率", "保密协议",
                   "备注", "页面价", "口径", "可比单价", "任务", "更新时间"]
        data = [[
            r.get("id"), r.get("supplier_wangwang"), r.get("unit_price"), r.get("moq"),
            r.get("freight"), r.get("sample_lead_time"), r.get("bulk_lead_time"),
            r.get("sample_fee_refundable"), r.get("price_incl_sample_fee"), r.get("defect_rate"),
            r.get("nda"), r.get("remark"), r.get("page_price"), r.get("price_basis"),
            r.get("unit_price_final"), r.get("campaign_id"), _fmt_ts(r.get("updated_at")),
        ] for r in rows]
        return headers, data
    raise ValueError("未知导出类型：" + kind)


def _fmt_ts(ms: Any) -> str:
    try:
        n = float(ms)
    except (TypeError, ValueError):
        return ""
    if n > 1e11:
        n = n / 1000.0
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(n))
