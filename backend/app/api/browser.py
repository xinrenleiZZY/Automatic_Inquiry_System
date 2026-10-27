"""状态监控：1688 浏览器 / 登录态体检 + 一键启停。

这一层只做三件事：
  1. 把几路状态拼成一份「检测项清单」交给前端渲染（前端不写判定逻辑）；
  2. 一键启动 / 一键停止（浏览器 + 常驻监听 + 串行队列 一起管）；
  3. 把"打开一个页面看看"这类会动浏览器的动作丢进队列（单写者原则）。

判定口径在 app/browserprobe.py，进程控制在 app/chromectl.py，CDP 取数在 bridge.mjs。
"""

import os

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import browserprobe, chromectl, config, store
from ..bridge import BridgeError, bridge
from ..queue import queue as job_queue
from ..security import get_current_user, require_admin_or_gm
from .flows import start_monitor, stop_monitor
from .system import monitor_info

router = APIRouter(prefix="/api/browser", tags=["browser"])


async def _snapshot(refresh: bool = False, probe: bool = False) -> dict:
    """体检快照：CDP/页面/登录态（桥接）+ 进程（PowerShell）+ 监听/队列（本进程）。"""
    status = await (browserprobe.raw_probe() if probe else browserprobe.raw_status(refresh=refresh))
    chrome = await chromectl.state(refresh=refresh)
    chrome_path = await chromectl.chrome_info(state_data=chrome)
    mon = monitor_info()
    q = job_queue.status()
    checks = browserprobe.compose_checks(status, chrome, mon, q, chromectl.cdp_port())
    return {
        "at": status.get("at"),
        "overall": browserprobe.overall_of(checks),
        "checks": checks,
        "cdp": status.get("cdp") or {},
        "login": status.get("login") or {},
        "verdict": status.get("verdict") or {},
        "pages": status.get("pages") or [],
        "counts": status.get("counts") or {},
        "chat": status.get("chat"),
        "chat_note": status.get("chat_note"),
        # 登录页当前状态（正在过滑块/短信验证码时，前端据此说明"卡在哪一步"）
        "login_page": status.get("login_page"),
        "probe_error": status.get("error"),
        "chrome": chrome,
        "chrome_path": chrome_path,
        "monitor": mon,
        "queue": q,
        "target": {
            "cdp_base": config.CDP_BASE,
            "cdp_port": chromectl.cdp_port(),
            "profile_dir": str(config.CHROME_PROFILE_DIR),
            "start_url": config.BROWSER_START_URL,
            "control_script": str(config.BROWSER_CONTROL_SCRIPT),
            "control_script_exists": config.BROWSER_CONTROL_SCRIPT.exists(),
            "chrome_exe": chrome_path.get("resolved") or "",
        },
    }


@router.get("/status")
async def status(refresh: bool = False, user: dict = Depends(get_current_user)) -> dict:
    """状态监控页面的主数据（轻量：不读聊天页内容）。"""
    return await _snapshot(refresh=refresh)


@router.post("/probe")
async def probe(user: dict = Depends(get_current_user)) -> dict:
    """立即体检：额外读一次聊天页（会话列表 / 登录框），验证登录态真能用。"""
    data = await _snapshot(refresh=True, probe=True)
    verdict = data.get("verdict") or {}
    store.add_log("info", "browser", f"{user.get('username', '')} 体检：{verdict.get('label') or '未知'}｜{verdict.get('reason') or ''}")
    return data


class StartBody(BaseModel):
    chrome: bool = True
    monitor: bool = True
    queue: bool = True
    # 浏览器这一步要不要"先清干净再起"：端口被占用/实例僵死时自动清；true = 无条件清（干净重启）
    force: bool = False


class StopBody(BaseModel):
    chrome: bool = True
    monitor: bool = True
    force: bool = False


_PS_NOTE_CN = {
    "cdp already reachable, launch skipped": "调试端口已就绪，未重复拉起",
    "no chrome process with this profile dir; everyday Chrome untouched":
        "没有找到该 profile 的 Chrome 进程（日常浏览器未受影响）",
    "nothing listening on the CDP port and no chrome process with this profile dir":
        "端口没人监听，也没有该 profile 的 Chrome 进程",
}


def _chrome_step_detail(chrome: dict) -> str:
    """把脚本的英文 note/error 翻成人话，并把"拉不起来"的病因说清楚。"""
    note = str(chrome.get("note") or "")
    err = str(chrome.get("error") or "")
    killed = chrome.get("killed") or []
    if err:
        if "is held by" in err:
            detail = "端口被非 Chrome 进程占用：" + err.split("held by", 1)[-1].strip() \
                     + "；请先处理它，或把 CDP_BASE 换到别的端口"
        elif "still responds after killing" in err:
            detail = "清掉了占用进程，但端口仍然被占用（可能有权限更高的进程）"
        elif "configured chrome path does not exist" in err:
            detail = "配置的 Chrome 路径不存在，请到下面「Chrome 路径设置」里改"
        else:
            detail = "拉起失败（调试端口一直没就绪）"
    elif note:
        detail = _PS_NOTE_CN.get(note, note)
    else:
        detail = "已拉起调试实例" if chrome.get("launched") else "调试端口已就绪"
    if killed:
        detail = f"先清掉 {len(killed)} 个占用进程（含僵死实例）→ " + detail
    warns = chrome.get("warnings") or []
    if warns:
        detail += f"（另有 {len(warns)} 个进程在清点后已自行退出，属正常）"
    if not chrome.get("ok") and chrome.get("launched"):
        # 脚本说"拉起了"但端口始终不通：几乎都是 API 进程没有桌面权限
        detail += "；病因判断：当前 API 进程没有桌面权限（从受限会话 / 服务方式启动的），" \
                  "请在你自己的 PowerShell 里用 deploy\\start-native.ps1 重启一次 API"
    return detail


@router.post("/start")
async def start_all(body: StartBody | None = None,
                    user: dict = Depends(require_admin_or_gm)) -> dict:
    """一键启动：浏览器（CDP 未通则拉起）→ 常驻监听 → 串行队列。"""
    body = body or StartBody()
    name = user.get("username", "")
    steps: list[dict] = []

    if body.chrome:
        chrome = await chromectl.start(force=body.force)
        steps.append({"step": "chrome", "ok": bool(chrome.get("ok")),
                      "detail": _chrome_step_detail(chrome)})
    if body.monitor:
        try:
            mon = await start_monitor(user_name=name)
            steps.append({"step": "monitor", "ok": True,
                          "detail": "监听已在运行" if mon.get("already_running") else "监听已启动"})
        except HTTPException as exc:
            steps.append({"step": "monitor", "ok": False, "detail": str(exc.detail)})
    if body.queue:
        await job_queue.start()
        steps.append({"step": "queue", "ok": True, "detail": "串行队列已启动"})

    # 审计记**每一步的真实结果**：以前无论成败都写 "ok"，
    # 于是"点了启动、Chrome 没起来"在审计里完全看不出来（2026-10-15 踩过）。
    store.add_audit(name, "browser.start", body.model_dump(),
                    " ".join(f"{s['step']}={'ok' if s['ok'] else 'fail'}" for s in steps))
    browserprobe.invalidate()
    chromectl.invalidate()
    return {"steps": steps, "snapshot": await _snapshot(refresh=True)}


@router.post("/stop")
async def stop_all(body: StopBody | None = None,
                   user: dict = Depends(require_admin_or_gm)) -> dict:
    """一键停止：常驻监听 → 浏览器（只关调试实例）。

    有作业正在执行时默认拒绝关浏览器 —— 半路把窗口杀掉会留下不一致的中间状态，
    确实要关就带 force=true（界面上会二次确认）。
    """
    body = body or StopBody()
    name = user.get("username", "")
    current = job_queue.status().get("current")
    if body.chrome and current and not body.force:
        raise HTTPException(
            status_code=409,
            detail=f"有作业正在执行（{current.get('type')}），先等它跑完或到日志中心取消，"
                   f"确实要强制关闭请带 force=true",
        )

    steps: list[dict] = []
    if body.monitor:
        try:
            await stop_monitor(user_name=name)
            steps.append({"step": "monitor", "ok": True, "detail": "常驻监听已停止"})
        except HTTPException as exc:
            steps.append({"step": "monitor", "ok": False, "detail": str(exc.detail)})

    if body.chrome:
        closed = False
        detail = ""
        try:
            r = await bridge.call("browser.close", {}, timeout=30)
            closed = bool(r.get("closed"))
            detail = "已通过 CDP 关闭调试实例" if closed else f"CDP 未确认关闭：{r}"
        except BridgeError as exc:
            detail = f"CDP 关闭不可用（{exc}）"
        if not closed:
            # 端口不通 / 实例僵死时的兜底：按命令行里的 profile 关进程
            fallback = await chromectl.stop_processes()
            killed = fallback.get("killed") or []
            steps.append({
                "step": "chrome", "ok": bool(killed) or not fallback.get("debugChrome", {}).get("count"),
                "detail": (f"{detail}；兜底关闭 {len(killed)} 个进程" if killed
                           else f"{detail}；没找到该 profile 的 Chrome 进程"),
            })
        else:
            steps.append({"step": "chrome", "ok": True, "detail": detail})

    store.add_audit(name, "browser.stop", body.model_dump(),
                    " ".join(f"{s['step']}={'ok' if s['ok'] else 'fail'}" for s in steps))
    browserprobe.invalidate()
    chromectl.invalidate()
    return {"steps": steps, "snapshot": await _snapshot(refresh=True)}


@router.post("/chrome/start")
async def chrome_start(force: bool = False, user: dict = Depends(require_admin_or_gm)) -> dict:
    """只拉起浏览器（不动监听/队列）。

    force=true：先把占用 6901 的进程和该 profile 的残留 Chrome 清掉，再起一个干净的
    —— 页面上的「强制重启浏览器」走的是这里。默认（false）只在"端口被占用但 CDP 不响应
    / 或存在同 profile 残留实例"时自动清，健康实例不打断。
    """
    result = await chromectl.start(force=force)
    store.add_audit(user.get("username", ""), "browser.chrome.start",
                    {"force": force, "killed": result.get("killed") or []},
                    "ok" if result.get("ok") else f"fail: {result.get('error')}")
    browserprobe.invalidate()
    return {"result": result, "snapshot": await _snapshot(refresh=True)}


@router.post("/chrome/stop")
async def chrome_stop(force: bool = False, user: dict = Depends(require_admin_or_gm)) -> dict:
    """只关浏览器（只关调试实例，日常 Chrome 不受影响）。"""
    current = job_queue.status().get("current")
    if current and not force:
        raise HTTPException(status_code=409,
                            detail=f"有作业正在执行（{current.get('type')}），要强制关闭请带 force=true")
    closed = False
    via = "cdp"
    try:
        r = await bridge.call("browser.close", {}, timeout=30)
        closed = bool(r.get("closed"))
    except BridgeError:
        closed = False
    if not closed:
        via = "process"
        fb = await chromectl.stop_processes()
        closed = bool(fb.get("killed")) or not (fb.get("debugChrome") or {}).get("count")
    store.add_audit(user.get("username", ""), "browser.chrome.stop", {"force": force}, str(closed))
    browserprobe.invalidate()
    chromectl.invalidate()
    return {"closed": closed, "via": via, "snapshot": await _snapshot(refresh=True)}


class OpenBody(BaseModel):
    target: str = "chat"      # chat（旺旺聊天页）| workbench（1688 工作台）| url
    url: str = ""
    waitMs: int = 6000


@router.post("/open")
async def open_page(body: OpenBody | None = None,
                    user: dict = Depends(require_admin_or_gm)) -> dict:
    """打开聊天页 / 工作台。会动浏览器 → 走队列，避免和其它任务抢窗口。"""
    body = body or OpenBody()
    target = (body.target or "chat").strip()
    if target not in ("chat", "workbench", "url"):
        raise HTTPException(status_code=422, detail="target 只能是 chat / workbench / url")
    if target == "url" and not body.url:
        raise HTTPException(status_code=422, detail="target=url 时必须给 url")
    job = await job_queue.submit("browser.open",
                                 {"target": target, "url": body.url, "waitMs": body.waitMs},
                                 user.get("username", ""))
    store.add_audit(user.get("username", ""), "browser.open", body.model_dump(), job["id"])
    return {"job": job}


@router.get("/logs")
async def logs(limit: int = 100, user: dict = Depends(get_current_user)) -> dict:
    """体检/启停的历史记录（来源 source='browser'）。"""
    return {"items": store.list_logs(limit, "browser")}


# --------------------------------------------------------------------------
# Chrome 路径（可配置：留空 = 自动检测）
# --------------------------------------------------------------------------
@router.get("/chrome-path")
async def get_chrome_path(refresh: bool = True, user: dict = Depends(get_current_user)) -> dict:
    """当前生效的 chrome.exe 路径 + 来源 + 自动检测到的候选。"""
    if refresh:
        chromectl.invalidate()
    return {"chrome_path": await chromectl.chrome_info(refresh=refresh)}


class ChromePathBody(BaseModel):
    path: str = ""


@router.put("/chrome-path")
async def set_chrome_path(body: ChromePathBody,
                          user: dict = Depends(require_admin_or_gm)) -> dict:
    """设置调试实例用的 chrome.exe 路径；传空字符串 = 恢复自动检测。

    为什么要可配置：Chrome 不一定装在默认的三个位置（绿色版、换盘、多版本并存），
    没有它的话「一键启动」只能报"找不到 Chrome"。
    """
    raw = (body.path or "").strip().strip('"')
    if raw:
        path = os.path.abspath(raw)
        if not path.lower().endswith((".exe", ".bat", ".cmd", ".lnk")):
            raise HTTPException(status_code=400, detail="请填 chrome.exe 的完整路径")
        check = await chromectl.verify_chrome_path(path)
        if not check.get("ok"):
            hint = f"，也可以从自动检测到的候选里选：{'；'.join(check.get('candidates') or [])}" if check.get("candidates") else ""
            raise HTTPException(status_code=400, detail=f"这个路径下没有找到文件：{path}{hint}")
        path = check.get("resolved") or path
    else:
        path = ""
    store.update_settings({"chrome_exe": path})
    store.add_audit(user.get("username", ""), "browser.chrome_path",
                    {"path": path}, "ok" if path else "auto")
    chromectl.invalidate()
    return {"chrome_path": await chromectl.chrome_info(refresh=True)}


# --------------------------------------------------------------------------
# 1688 登录：机器填账号密码、提交并自动拖动一次滑块；短信验证码仍需人工
# --------------------------------------------------------------------------
async def _login_info() -> dict:
    s = store.get_settings()
    return {
        "account": s.get("login_account") or "",
        "has_password": bool(s.get("login_password")),
        "note": "滑块验证会由机器自动拖动一次；若失败或出现短信验证码，"
                "登录页会切到前台，需要人工完成后回本页点「立即体检」确认。",
    }


@router.get("/login-info")
async def login_info(user: dict = Depends(get_current_user)) -> dict:
    """给登录卡片用：账号明文回显，密码只回"有没有存"。"""
    return await _login_info()


class LoginCredBody(BaseModel):
    account: str = ""
    # None = 不改密码，"" = 清空密码
    password: str | None = None


@router.put("/login-credentials")
async def put_login_credentials(body: LoginCredBody,
                                user: dict = Depends(require_admin_or_gm)) -> dict:
    """保存 1688 账号密码（密码存本机 api.db，只用于「一键登录」时填表）。"""
    patch: dict = {"login_account": (body.account or "").strip()}
    if body.password is not None:
        patch["login_password"] = body.password
    try:
        store.update_settings(patch)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    # 审计里绝不落密码，只记"改了哪些字段"
    store.add_audit(user.get("username", ""), "browser.login_credentials",
                    {"account": patch["login_account"],
                     "password_changed": body.password is not None,
                     "password_cleared": body.password == ""}, "ok")
    return await _login_info()


class LoginRunBody(BaseModel):
    """触发一次登录。user 一般留空（用已保存的账号）。"""
    user: str = ""
    keepLogin: bool = True
    waitMs: int = 4000
    # 默认自动拖一次风控滑块；短信验证码不会自动填写。
    autoSolveCaptcha: bool = True
    captchaAttempts: int = 1
    # password = 切密码页签 + 填表 + 提交；qr = 回到二维码视图让人扫码（不碰人机校验）
    mode: str = "password"


@router.post("/login")
async def do_login(body: LoginRunBody | None = None,
                   user: dict = Depends(require_admin_or_gm)) -> dict:
    """一键登录（走队列）。账号密码由处理器在执行时从 settings 取，不进作业参数。"""
    body = body or LoginRunBody()
    if body.mode not in ("password", "qr"):
        raise HTTPException(status_code=422, detail="mode 只能是 password / qr")
    # 不在这里拦"没存密码"：页面上可能已经被 Chrome 填好了，
    # 真填不出来时桥接会返回 stage=need_credentials，那个提示更准确。
    job = await job_queue.submit("browser.login",
                                 {"user": body.user, "keepLogin": body.keepLogin,
                                  "waitMs": max(1000, min(body.waitMs, 20000)),
                                  "autoSolveCaptcha": body.autoSolveCaptcha,
                                  "captchaAttempts": max(1, min(body.captchaAttempts, 3)),
                                  "mode": body.mode},
                                 user.get("username", ""))
    store.add_audit(user.get("username", ""), "browser.login",
                    {"keepLogin": body.keepLogin, "mode": body.mode,
                     "autoSolveCaptcha": body.autoSolveCaptcha,
                     "captchaAttempts": max(1, min(body.captchaAttempts, 3))}, job["id"])
    browserprobe.invalidate()
    return {"job": job}
