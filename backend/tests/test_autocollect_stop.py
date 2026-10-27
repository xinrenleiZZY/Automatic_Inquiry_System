"""自动采集「人工客服式问答」回归测试（不碰浏览器、不发真实消息）。

覆盖：
  1) 每个客户独立计时，超时最多主动追问 2 次；
  2) 第 2 次后静默等待，不再主动打扰；
  3) 静默客户一旦回复，立即恢复问答并重置追问额度；
  4) 回复与超时同时发生时，不误发通用追问。
"""

import asyncio
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import handlers          # noqa: E402
from app.bridge import bridge     # noqa: E402

FAILED: list[str] = []


def case(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'OK ' if ok else 'NG '} {name}" + (f" | {detail}" if detail else ""))
    if not ok:
        FAILED.append(name)


class Harness:
    def __init__(self, rows, timeout=60, reply_on_collect=None, fail_nudges=0,
                 event_once=None, ui_reply_after_collect=None):
        self.now = 1_800_000.0
        self.rows = {r["convKey"]: dict(r) for r in rows}
        self.timeout = timeout
        self.reply_on_collect = reply_on_collect or {}
        self.event_once = list(event_once or [])
        self.ui_reply_after_collect = set(ui_reply_after_collect or [])
        self.ui_visible = set()
        self.ui_msgs = []
        self.fail_nudges = fail_nudges
        self.calls = []
        self.nudge_times = []
        self.reply_ids = 0

    def tick(self, seconds):
        self.now += seconds

    async def fake_sleep(self, seconds, job_id):
        self.tick(seconds)
        return False

    async def call(self, cmd, args=None, timeout=None):
        args = args or {}
        self.calls.append(cmd)
        if cmd == "campaign.applyBlocked":
            return {"campaignId": args.get("campaignId"), "keys": 0}
        if cmd == "campaign.roundStates":
            return {"campaign": 1, "items": [dict(r) for r in self.rows.values()]}
        if cmd == "campaign.roundPatch":
            row = self.rows[args["convKey"]]
            for src, dst in (
                ("state", "state"), ("decision", "decision"),
                ("attempts", "attempts"), ("lastSentAt", "lastSentAt"),
                ("lastInboundAt", "lastInboundAt"),
                ("nextActionAt", "nextActionAt"),
                ("terminalReason", "terminalReason"),
            ):
                if src in args:
                    row[dst] = args[src]
                    if src == "attempts":
                        row["taskAttempts"] = args[src]
            return row
        if cmd == "events.tick":
            if self.event_once:
                key = self.event_once.pop(0)
                return {"items": [{
                    "eventId": 1, "campaignId": 1, "convKey": key,
                    "eventType": "inbound", "epoch": int(self.now * 1000),
                }]}
            return {"items": []}
        if cmd == "events.ack":
            return {"ok": True}
        if cmd == "campaign.collect":
            key = (args.get("onlyConvKeys") or [""])[0]
            if key in self.reply_on_collect and (
                key not in self.ui_reply_after_collect or key in self.ui_visible
            ):
                self.reply_ids += 1
                self.rows[key]["lastInboundAt"] = int(self.now * 1000)
            if key in self.ui_reply_after_collect:
                self.ui_reply_after_collect.remove(key)
                self.ui_visible.add(key)
                self.ui_msgs = [{
                    "kind": "msg", "mine": False, "text": "客户刚回复",
                    "time": datetime.fromtimestamp(self.now).strftime("%Y-%m-%d %H:%M:%S"),
                }]
            return {"processed": 1, "opened": 1, "asked": 0, "sent": 0, "dropped": 0}
        if cmd == "messages.read":
            return self.ui_msgs
        if cmd == "campaign.replies":
            key = next((k for k in self.reply_on_collect
                        if self.rows[k]["lastInboundAt"] >= int(args.get("since") or 0)), "")
            if key:
                return [{
                    "id": self.reply_ids, "conv_key": key,
                    "inbound_text": "客户回复", "ai_action": "ask", "sent": 0,
                }]
            return []
        if cmd == "campaign.nudge":
            target = (args.get("targets") or [{}])[0]
            key = target.get("convKey", "")
            self.nudge_times.append((key, int(self.now * 1000)))
            if self.fail_nudges > 0:
                self.fail_nudges -= 1
                return {"total": 1, "sent": 0, "failed": 1, "blocked": 0,
                        "results": [{"ok": False, "why": "测试失败"}]}
            row = self.rows[key]
            row["taskAttempts"] = int(row.get("taskAttempts") or 0) + 1
            row["lastSentAt"] = int(self.now * 1000)
            row["nextActionAt"] = 0
            return {"total": 1, "sent": 1, "failed": 0, "blocked": 0,
                    "results": [{"ok": True, "convKey": key}]}
        if cmd == "campaign.auditReplies":
            return {"checked": 0, "dropped": 0}
        if cmd == "campaign.completeness":
            return {"complete": 0, "total": len(self.rows), "pending": 0,
                    "dropped": 0, "all_complete": False, "items": []}
        raise AssertionError("未预期的桥接调用：" + cmd)

    def run(self, **payload):
        old_call = bridge.call
        old_sleep = handlers._sleep_watch
        old_time = handlers.time.time
        bridge.call = self.call                  # type: ignore[assignment]
        handlers._sleep_watch = self.fake_sleep  # type: ignore[assignment]
        handlers.time.time = lambda: self.now    # type: ignore[assignment]
        try:
            return asyncio.run(handlers._campaign_autocollect(payload))
        finally:
            bridge.call = old_call                  # type: ignore[assignment]
            handlers._sleep_watch = old_sleep       # type: ignore[assignment]
            handlers.time.time = old_time           # type: ignore[assignment]


def row(key: str, sent_ago: int):
    return {
        "convKey": key, "name": key, "sellerNick": key, "offerId": "o-" + key,
        "contactStatus": "opened", "state": "waiting", "decision": "",
        "attempts": 0, "followupRound": 0, "nextActionAt": 0,
        "taskAttempts": 0,
        "lastSentAt": 1_800_000_000 - sent_ago * 1000,
        "lastInboundAt": 0, "quoteStatus": "asking", "terminal": False,
        "terminalReason": "", "phraseSent": True,
    }


# --- 1) 两客户各自到期，各问 2 次后静默 ------------------------------------
h = Harness([row("A", 50), row("B", 70)])
res = h.run(id=1, mode="send", duration_sec=160, max_followups=2,
            reply_timeout_sec=60, ensure_sent=False)
case("每个客户最多追问 2 次", len(h.nudge_times) == 4, str(h.nudge_times))
case("先到期客户 B 先追问", h.nudge_times and h.nudge_times[0][0] == "B",
     str(h.nudge_times[:2]))
case("A、B 使用各自截止时间", h.nudge_times[1][1] - h.nudge_times[0][1] >= 9_000,
     str(h.nudge_times[:2]))
case("两次后进入静默等待",
     all(x["state"] == "silent_wait" and x["followups"] == 2 for x in res["customers"]),
     str(res["customers"]))

# --- 2) 失败追问不消耗次数，冷却后重试 -------------------------------------
h2 = Harness([row("A", 70)], fail_nudges=1)
res2 = h2.run(id=1, mode="send", duration_sec=160, max_followups=2,
              reply_timeout_sec=60, ensure_sent=False)
case("失败后重试，仅成功两次计次", len(h2.nudge_times) == 3,
     str(h2.nudge_times))
case("最终静默且只计 2 次", res2["customers"][0]["followups"] == 2,
     str(res2["customers"][0]))

# --- 3) 客户回复立即解析并重置追问额度 ------------------------------------
h3 = Harness([row("A", 10)], reply_on_collect={"A"}, event_once=["A"])
res3 = h3.run(id=1, mode="send", duration_sec=30, max_followups=2,
              reply_timeout_sec=60, ensure_sent=False)
case("回复触发 AI 采集", "campaign.collect" in h3.calls, "、".join(h3.calls))
case("回复后追问额度归零", len(h3.nudge_times) == 0 and
     res3["customers"][0]["rounds_done"] == 1,
     f"{h3.nudge_times} / {res3['customers'][0]}")

# --- 4) 超时边界客户回复，必须二次采集而不是发通用追问 -------------------
h4 = Harness([row("A", 70)], reply_on_collect={"A"},
             ui_reply_after_collect={"A"})
res4 = h4.run(id=1, mode="send", duration_sec=5, max_followups=2,
              reply_timeout_sec=60, ensure_sent=False)
case("超时边界新消息触发二次采集", h4.calls.count("campaign.collect") == 2,
     "、".join(h4.calls))
case("超时边界不误发通用追问",
     len(h4.nudge_times) == 0 and res4["customers"][0]["rounds_done"] == 1,
     f"{h4.nudge_times} / {res4['customers'][0]}")

# --- 5) 已经静默的客户回复后立即恢复处理 ----------------------------------
silent = row("A", 300)
silent["taskAttempts"] = 2
silent["state"] = "waiting_silent"
h5 = Harness([silent], reply_on_collect={"A"}, event_once=["A"])
res5 = h5.run(id=1, mode="send", duration_sec=5, max_followups=2,
              reply_timeout_sec=60, ensure_sent=False)
case("静默客户回复仍立即入队处理",
     "campaign.collect" in h5.calls and res5["customers"][0]["rounds_done"] == 1,
     "、".join(h5.calls))

# --- 5b) 即使事件丢失，消息表游标晚于最后处理时间也必须强制采集 ----------
silent_unseen = row("A", 300)
silent_unseen["taskAttempts"] = 2
silent_unseen["state"] = "waiting_silent"
silent_unseen["lastInboundAt"] = int(1_800_000 * 1000) - 120_000
silent_unseen["latestInboundAt"] = int(1_800_000 * 1000) - 10_000
h5b = Harness([silent_unseen], reply_on_collect={"A"})
res5b = h5b.run(id=1, mode="send", duration_sec=5, max_followups=2,
                reply_timeout_sec=60, ensure_sent=False)
case("静默客户有未处理消息时无需事件也强制采集",
     "campaign.collect" in h5b.calls and res5b["customers"][0]["rounds_done"] == 1,
     "、".join(h5b.calls))

# --- 6) 旧回复晚于旧截止时间时，不应把重启当成“立刻超时” ----------------
replied = row("A", 300)
replied["lastInboundAt"] = int(1_800_000 * 1000) - 10_000
replied["nextActionAt"] = int(1_800_000 * 1000) - 300_000
h6 = Harness([replied])
res6 = h6.run(id=1, mode="send", duration_sec=30, max_followups=2,
              reply_timeout_sec=60, ensure_sent=False)
case("老回复后的旧截止时间自动顺延",
     len(h6.nudge_times) == 0 and res6["customers"][0]["state"] == "waiting",
     f"{h6.nudge_times} / {res6['customers'][0]}")

print()
if FAILED:
    print(f"共 {len(FAILED)} 项失败：" + "、".join(FAILED))
    sys.exit(1)
print("全部通过：两次超时追问、静默等待和来消息恢复逻辑正常")
