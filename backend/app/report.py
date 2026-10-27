"""该任务的「比价表总结」+「比价表文件」。

总结用一份数据渲染两种形态：
  - text：纯文本（Webhook 模式 / 日志 / 页面展示）
  - card：飞书交互卡片（应用机器人发这个更好看）
文件就是比价表 CSV（和「比价表」页面导出的那份同源，都用 repo.csv_rows）。
"""

import csv
import io
import time
from pathlib import Path

from . import config, repo, store
from .feishu import notifier

_BASIS_CN = {
    "absolute": "直接报价", "page_plus": "页面价加价",
    "page_minus": "页面价减价", "page_same": "与页面价相同", "unknown": "口径未知",
}
_STATUS_CN = {
    "quoted": "已报价", "asking": "已追问", "dropped": "不做此产品",
    "need_human": "需人工联系", "give_up": "信息止步",
    "pending": "待跟进", "new": "新会话",
}


def _handoff_text(row: dict) -> str:
    """把"转交联系人"洗成人看的一行：联系人：肖经理 18679666373（原话：…）"""
    s = str(row.get("handoff_contact") or "").strip()
    return s.replace("【转交】", "")


def _fmt_price(v) -> str:
    if v is None or v == "":
        return "-"
    try:
        n = float(v)
    except (TypeError, ValueError):
        return str(v)
    return f"{n:.2f}".rstrip("0").rstrip(".")


def _shop(row: dict) -> str:
    return str(row.get("offer_shop_name") or row.get("supplier_wangwang") or "-").split(":")[0]


def build_price_report(campaign_id: int, top: int = 10) -> dict:
    """汇总该任务的比价表：数字概览 + 明细 + 两种形态的总结文本。"""
    campaign = repo.get_campaign(campaign_id) or {}
    name = campaign.get("name") or f"任务{campaign_id}"
    # 预期单价取"本任务生效值"（任务覆盖 → 全局默认），达标判定才有意义
    try:
        _ov, eff = store.effective_campaign_params(campaign_id)
    except Exception:  # noqa: BLE001
        eff = {}
    expected_setting = eff.get("expected_price")
    rows = repo.compare(
        campaign_id=campaign_id, limit=1000,
        # 总结要能看到"不做此款/需人工联系"两类，所以这里连 dropped 一起取，
        # 排序与明细里再把它们排除出去（导出的 CSV 仍然默认隐藏不做此款，见 repo.csv_rows）
        include_dropped=True,
        expected_price=float(expected_setting) if expected_setting not in (None, "") else None,
    )
    try:
        contacted = len(repo.campaign_contacts(campaign_id))
    except Exception:  # noqa: BLE001
        contacted = 0

    priced = [r for r in rows if r.get("unit_price_final") is not None]
    prices = [float(r["unit_price_final"]) for r in priced]
    expected = expected_setting
    met = [r for r in priced if r.get("meets_target") is True]
    not_matching = [r for r in rows if r.get("is_dropped")]        # 不做此款
    need_human = [r for r in rows if r.get("is_need_human")]       # 需人工联系（也计入已询价）
    give_up = [r for r in rows if r.get("is_give_up")]             # 追问到顶仍无价
    unquoted = [r for r in rows if r.get("unit_price_final") is None and not r.get("is_dropped")]

    cheapest = min(priced, key=lambda r: float(r["unit_price_final"]), default=None)
    summary = {
        "campaign_id": campaign_id,
        "campaign_name": name,
        "contacted": contacted,
        "total": len(rows),
        "quoted_or_contacted": len(rows) - len(not_matching),   # 已询价家数（含需人工联系）
        "priced": len(priced),
        "unquoted": len(unquoted),
        "not_matching": len(not_matching),
        "need_human": len(need_human),
        "give_up": len(give_up),
        "min_price": min(prices) if prices else None,
        "max_price": max(prices) if prices else None,
        "avg_price": round(sum(prices) / len(prices), 4) if prices else None,
        "expected_price": expected,
        "meets_target": len(met) if expected is not None else None,
        "cheapest": _shop(cheapest) if cheapest else "",
        "cheapest_price": float(cheapest["unit_price_final"]) if cheapest else None,
        "generated_at": int(time.time() * 1000),
    }

    detail = sorted(priced, key=lambda r: float(r["unit_price_final"]))[:top]
    lines = [
        f"【{name}】比价表总结 · {time.strftime('%Y-%m-%d %H:%M')}",
        "-" * 16,
        f"已联系 {contacted} 家 ｜ 已询价 {summary['quoted_or_contacted']} 家"
        f"（有回复；含需人工联系 {summary['need_human']} 家）",
        f"已报出单价 {summary['priced']} 家 ｜ 未报价 {summary['unquoted']} 家"
        + (f" ｜ 不做此款 {summary['not_matching']} 家" if summary["not_matching"] else ""),
        f"最低 ¥{_fmt_price(summary['min_price'])} ｜ 最高 ¥{_fmt_price(summary['max_price'])}"
        f" ｜ 均价 ¥{_fmt_price(summary['avg_price'])}",
    ]
    if summary["expected_price"] is not None:
        lines.append(f"预期单价 ¥{_fmt_price(summary['expected_price'])} ｜ 达标 {summary['meets_target']} 家")
    if detail:
        lines.append("-" * 16)
        for i, r in enumerate(detail, 1):
            lines.append(
                f"{i}. {_shop(r)[:18]} ｜ ¥{_fmt_price(r.get('unit_price_final'))}"
                f"（页面价 {_fmt_price(r.get('page_price_num'))}）"
                f" ｜ {_BASIS_CN.get(str(r.get('price_basis') or ''), r.get('price_basis') or '-')}"
                f" ｜ {r.get('verdict') or '-'}"
            )
    if unquoted:
        lines.append("-" * 16)
        names = "、".join(_shop(r)[:14] for r in unquoted[:8])
        lines.append(f"还没报价（{len(unquoted)} 家）：{names}" + ("…" if len(unquoted) > 8 else ""))
    if need_human:
        lines.append("-" * 16)
        lines.append(f"📞 需人工联系（{len(need_human)} 家，对方只让找对接人）：")
        for r in need_human[:5]:
            lines.append(f"  · {_shop(r)[:16]} ｜ {_handoff_text(r)[:70] or '（备注里有原话）'}")
    if not_matching:
        lines.append("-" * 16)
        lines.append(f"不做此款 {len(not_matching)} 家（不在比价范围，导出比价表默认隐藏）：" +
                     "、".join(_shop(r)[:14] for r in not_matching[:8]) +
                     ("…" if len(not_matching) > 8 else ""))
    lines.append("-" * 16)
    lines.append(f"完整比价表见附件 CSV ｜ 任务 #{campaign_id}")
    text = "\n".join(lines)

    elements: list[dict] = [{
        "tag": "div",
        "text": {
            "tag": "lark_md",
            "content": (
                f"**📈 总体**\n"
                f"> 已联系：**{contacted}** 家 ｜ 已询价：**{summary['quoted_or_contacted']}** 家"
                f"（有回复，含需人工联系 **{summary['need_human']}** 家）\n"
                f"> 已报出单价：**{summary['priced']}** 家 ｜ 未报价：**{summary['unquoted']}** 家"
                + (f" ｜ 不做此款：**{summary['not_matching']}** 家" if summary["not_matching"] else "")
                + "\n"
                f"> 最低：**¥{_fmt_price(summary['min_price'])}** ｜ 最高：**¥{_fmt_price(summary['max_price'])}**"
                f" ｜ 均价：**¥{_fmt_price(summary['avg_price'])}**\n"
                + (f"> 预期单价：**¥{_fmt_price(summary['expected_price'])}**"
                   f" ｜ 达标：**{summary['meets_target']}** 家\n" if summary["expected_price"] is not None else "")
                + (f"> 最优报价：**{summary['cheapest']}** ¥{_fmt_price(summary['cheapest_price'])}"
                   if summary["cheapest"] else "> 暂无有效报价")
            ),
        },
    }]
    if detail:
        elements.append({"tag": "hr"})
        elements.append({"tag": "div", "text": {"tag": "lark_md", "content": f"**🏷 报价明细（前 {len(detail)} 家，按单价升序）**"}})
        for i, r in enumerate(detail, 1):
            elements.append({
                "tag": "div",
                "text": {
                    "tag": "lark_md",
                    "content": (
                        f"{i}. **{_shop(r)[:20]}**\n"
                        f"   ┣ 可比单价：**¥{_fmt_price(r.get('unit_price_final'))}**"
                        f" ｜ 页面价：{_fmt_price(r.get('page_price_num'))}\n"
                        f"   ┗ 口径：{_BASIS_CN.get(str(r.get('price_basis') or ''), r.get('price_basis') or '-')}"
                        f" ｜ 结论：{r.get('verdict') or '-'}"
                    ),
                },
            })
    if unquoted:
        elements.append({"tag": "hr"})
        elements.append({
            "tag": "div",
            "text": {"tag": "lark_md",
                     "content": f"**⌛ 还没报价（{len(unquoted)} 家）**\n"
                                + "、".join(_shop(r)[:14] for r in unquoted[:10])
                                + ("…" if len(unquoted) > 10 else "")},
        })
    if need_human:
        elements.append({"tag": "hr"})
        elements.append({
            "tag": "div",
            "text": {"tag": "lark_md",
                     "content": f"**📞 需人工联系（{len(need_human)} 家，对方只让找对接人）**\n"
                                + "\n".join(
                                    f"· {_shop(r)[:16]}：{_handoff_text(r)[:70] or '（备注里有原话）'}"
                                    for r in need_human[:5])},
        })
    if not_matching:
        elements.append({"tag": "hr"})
        elements.append({
            "tag": "div",
            "text": {"tag": "lark_md",
                     "content": f"**🚫 不做此款（{len(not_matching)} 家，不在比价范围，导出时隐藏）**\n"
                                + "、".join(_shop(r)[:14] for r in not_matching[:10])
                                + ("…" if len(not_matching) > 10 else "")},
        })
    elements.append({"tag": "hr"})
    elements.append({
        "tag": "div",
        "text": {"tag": "lark_md",
                 "content": f"📎 完整比价表见附件 CSV ｜ 任务 #{campaign_id} · 自动询价系统"},
    })
    card = {
        "config": {"wide_screen_mode": True},
        "header": {
            "template": "blue",
            "title": {"tag": "plain_text", "content": f"📊 比价表 · {name}"},
        },
        "elements": elements,
    }

    return {
        "campaign": campaign,
        "summary": summary,
        "rows": rows,
        "text": text,
        "card": card,
        "csv_name": f"比价表-{campaign_id}-{time.strftime('%Y%m%d-%H%M%S')}.csv",
    }


def price_report_csv_bytes(campaign_id: int) -> bytes:
    """比价表 CSV（带 BOM，Excel 直接打开不乱码）—— 与「比价表」页面导出同源。"""
    headers, rows = repo.csv_rows("compare", campaign_id=campaign_id)
    buf = io.StringIO()
    buf.write("\ufeff")
    writer = csv.writer(buf)
    writer.writerow(headers)
    writer.writerows(rows)
    return buf.getvalue().encode("utf-8")


def write_price_report_csv(campaign_id: int, report: dict | None = None) -> Path:
    """把比价表 CSV 落盘到 data/exports/，返回路径（既发飞书，也留档）。"""
    out_dir = config.DATA_DIR / "exports"
    out_dir.mkdir(parents=True, exist_ok=True)
    name = (report or {}).get("csv_name") or f"比价表-{campaign_id}-{time.strftime('%Y%m%d-%H%M%S')}.csv"
    path = out_dir / name
    path.write_bytes(price_report_csv_bytes(campaign_id))
    return path


async def push_price_report_to_feishu(campaign_id: int, chat_id: str = "",
                                      send_file: bool = True) -> dict:
    """把该任务的比价表推到飞书：先发总结卡片，再发比价表 CSV 文件。

    没配飞书时不会抛异常，只在返回里说明缺什么配置。
    """
    rep = build_price_report(campaign_id)
    path = write_price_report_csv(campaign_id, rep) if send_file else None
    out = await notifier.send_price_report(rep["card"], file_path=path, chat_id=chat_id or None)
    out["summary"] = rep["summary"]
    out["file"] = str(path) if path else ""
    return out
