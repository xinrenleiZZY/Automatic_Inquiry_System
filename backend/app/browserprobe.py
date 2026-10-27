"""1688 浏览器体检 —— 把 Node 桥接的 browser.status / browser.probe 包成接口层能用的形状。

回答用户最关心的四件事（「状态监控」页面的检测项就是按这四条排的）：
    1. 浏览器开着吗？      → cdp.reachable（+ 进程级信息，见 chromectl）
    2. 1688 账号登录了吗？  → login.logged_in / login.account
    3. 登录态还有效吗？     → login.validity（服务端探测 + 聊天页可读性）
    4. 页面打开了吗？      → pages / counts（聊天页、搜索页、结果页各几个）

判定逻辑全部在 bridge.mjs 里（那里才有 CDP 数据），这里只负责**加缓存**：
仪表盘健康检查每 5 秒轮询一次，不能每次都真去连一遍 CDP。
"""

from __future__ import annotations

import time

from .bridge import BridgeError, bridge

# status 便宜（一次 CDP HTTP + 一次 WS + 一次服务端探测），给 5 秒缓存；
# probe 会在聊天页里跑一段脚本，交给调用方按需触发，不缓存。
_STATUS_TTL = 5.0
_cache: dict = {"status": {"at": 0.0, "data": None}}


def _failed(reason: str) -> dict:
    """桥接本身出问题时的兜底形状：宁可显示"测不到"，也不要假装一切正常。"""
    return {
        "at": int(time.time() * 1000),
        "error": reason,
        "cdp": {"reachable": False, "error": reason},
        "pages": [],
        "counts": {"total": 0, "chat": 0, "search": 0, "results": 0, "other": 0, "login_page": 0},
        "login": {"logged_in": False, "validity": "unknown", "reason": reason},
        "verdict": {"state": "unknown", "ok": False, "label": "检测失败", "reason": reason},
    }


async def _call(cmd: str, args: dict | None = None, timeout: float = 30.0) -> dict:
    try:
        data = await bridge.call(cmd, args or {}, timeout=timeout)
    except BridgeError as exc:
        return _failed(f"桥接调用失败：{exc}")
    except Exception as exc:  # noqa: BLE001
        return _failed(f"体检异常：{exc}")
    return data if isinstance(data, dict) else _failed("桥接返回格式异常")


async def raw_status(ttl: float = _STATUS_TTL, refresh: bool = False) -> dict:
    now = time.time()
    cached = _cache["status"].get("data")
    if not refresh and isinstance(cached, dict) and now - float(_cache["status"].get("at") or 0) < ttl:
        return cached
    data = await _call("browser.status", {"fresh": bool(refresh)})
    _cache["status"] = {"at": now, "data": data}
    return data


async def raw_probe() -> dict:
    """真实体检：会读聊天页（只读，不点任何东西）。"""
    data = await _call("browser.probe", {}, timeout=60.0)
    _cache["status"] = {"at": time.time(), "data": data}
    return data


def invalidate() -> None:
    _cache["status"] = {"at": 0.0, "data": None}


def check(key: str, label: str, ok: bool, detail: str = "", level: str | None = None) -> dict:
    return {
        "key": key,
        "label": label,
        "ok": bool(ok),
        "detail": detail,
        "level": level or ("ok" if ok else "bad"),
    }


def compose_checks(status: dict, chrome: dict | None, monitor: dict | None,
                   queue_status: dict | None, cdp_port: int) -> list[dict]:
    """把几路状态拼成前端直接渲染的「检测项清单」。

    判定口径统一在这里，前端不再自己算，避免两个页面对同一件事给出两种结论。
    """
    cdp = status.get("cdp") or {}
    login = status.get("login") or {}
    counts = status.get("counts") or {}
    verdict = status.get("verdict") or {}
    chrome = chrome or {}
    procs = chrome.get("debugChrome") or {}
    port_owner = chrome.get("cdp") or {}
    mon = monitor or {}
    q = queue_status or {}

    browser_up = bool(cdp.get("reachable"))
    proc_count = int(procs.get("count") or 0)
    chat_n = int(counts.get("chat") or 0)
    login_tabs = int(counts.get("login_page") or 0)

    if browser_up:
        bits = [f"调试端口 {cdp_port} 有响应"]
        if port_owner.get("ownerPid"):
            bits.append(f"{port_owner.get('ownerName') or 'chrome'} PID {port_owner['ownerPid']}"
                        + (f"（{port_owner.get('ownerStartedAt')} 起）" if port_owner.get("ownerStartedAt") else ""))
        if proc_count:
            bits.append(f"同 profile 进程 {proc_count} 个")
        elif chrome.get("ok"):
            bits.append("进程枚举不可用（WMI 权限受限），端口占用已确认")
        proc_detail = "，".join(bits)
    elif proc_count:
        proc_detail = f"有 {proc_count} 个该 profile 的进程，但调试端口 {cdp_port} 不通"
    else:
        proc_detail = chrome.get("error") or f"调试端口 {cdp_port} 不通，也没找到该 profile 的 Chrome 进程"

    account = login.get("account") or login.get("member_id") or ""
    if login.get("logged_in") and account:
        login_detail = f"登录账号：{account}"
        if login.get("nearest_expiry"):
            login_detail += f" · 会员 cookie 到期 {time.strftime('%Y-%m-%d %H:%M', time.localtime(login['nearest_expiry'] / 1000))}"
    else:
        login_detail = login.get("reason") or "未登录"
    if login_tabs and "登录页" not in login_detail:
        login_detail += f" · 有 {login_tabs} 个标签页停在登录页"

    page_detail = (
        f"聊天页 {chat_n} / 搜索页 {counts.get('search', 0)} / 结果页 {counts.get('results', 0)}"
        f" / 其它 {counts.get('other', 0)}"
    )

    checks = [
        check("chrome", "Chrome 浏览器", browser_up or proc_count > 0, proc_detail),
        check("cdp", f"调试端口 {cdp_port}", browser_up,
              (cdp.get("browser") or "") + (f"（{cdp.get('error')}）" if cdp.get("error") else "")),
        check("login", "1688 账号登录", bool(login.get("logged_in")), login_detail),
        check("session", "登录态有效性", bool(verdict.get("ok")),
              verdict.get("reason") or login.get("reason") or "未验证",
              level="ok" if verdict.get("ok") else "bad"),
        check("chat_page", "聊天页已打开", chat_n > 0,
              ("聊天页 " + str(chat_n) + " 个") if chat_n else "没打开旺旺聊天页（def_cbu_web_im），页面可读性验证不了",
              level=None if chat_n > 0 else "warn"),
        check("pages", "页面打开情况", int(counts.get("total") or 0) > 0, page_detail,
              level=None if int(counts.get("total") or 0) > 0 else "warn"),
        check("monitor", "常驻消息监听", bool(mon.get("alive")),
              f"PID {mon.get('pid')}" if mon.get("alive") else "未运行（收不到客户回复）",
              level=None if mon.get("alive") else "bad"),
        check("queue", "串行队列", bool(q.get("running")),
              f"运行中 · 深度 {q.get('depth', 0)}" + ("（已暂停）" if q.get("paused") else "")
              if q.get("running") else "已停止（点了按钮也不会执行）",
              level=None if q.get("running") else "bad"),
    ]
    return checks


def overall_of(checks: list[dict]) -> dict:
    """总开关：能不能干活 = 浏览器在 + 已登录 + 登录态有效 + 队列在 + 监听在。"""
    fatal = [c for c in checks if c["key"] in ("chrome", "cdp", "login", "session", "monitor", "queue") and not c["ok"]]
    warn = [c for c in checks if not c["ok"] and c not in fatal]
    return {
        "ok": not fatal,
        "label": "可正常工作" if not fatal else "需要处理",
        "reason": ("；".join(f"{c['label']}：{c['detail']}" for c in fatal)
                   or ("；".join(f"{c['label']}：{c['detail']}" for c in warn) if warn else "浏览器、登录态、监听、队列都正常")),
        "failed": [c["key"] for c in fatal],
        "warnings": [c["key"] for c in warn],
    }
