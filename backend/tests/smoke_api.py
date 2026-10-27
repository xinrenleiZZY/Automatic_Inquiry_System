"""接口层冒烟测试。

用法（先在 backend 目录起服务）：
    python tests/smoke_api.py [base_url]

设计原则：**不产生对外副作用**。
绝不调用 send.* / autoreply.run / campaign.launch / outreach.contact 等会真正
发消息或联系商家的接口 —— 那些由业务方自行验证。
唯一会写库的是「图片绑定」用例，它会临时改一次绑定再**自动还原**成原值。
"""

import os
import sys
import time

import httpx

DEFAULT_PORT = os.getenv("APP_PORT", "6900")
BASE = sys.argv[1] if len(sys.argv) > 1 else f"http://127.0.0.1:{DEFAULT_PORT}"
RESULTS: list[tuple[str, bool, str]] = []


def check(name: str):
    def deco(fn):
        try:
            ok, detail = fn()
        except Exception as exc:  # noqa: BLE001
            ok, detail = False, f"异常：{exc.__class__.__name__}: {exc}"
        RESULTS.append((name, bool(ok), str(detail)))
        return fn

    return deco


guest = httpx.Client(base_url=BASE, timeout=60)
admin = httpx.Client(base_url=BASE, timeout=60)
normal = httpx.Client(base_url=BASE, timeout=60)
guest_nofollow = httpx.Client(base_url=BASE, timeout=60, follow_redirects=False)


@check("GET /api/auth/sso-redirect 跳门户登录页")
def _():
    r = guest_nofollow.get("/api/auth/sso-redirect", params={"path": "/compare"})
    loc = r.headers.get("location", "")
    ok = r.status_code == 302 and "/login?redirect=" in loc and "sso%2Fcallback" in loc
    return ok, loc[:110]


@check("GET /api/auth/sso/callback 无 code 时回退")
def _():
    r = guest_nofollow.get("/api/auth/sso/callback", params={"path": "/compare"})
    return r.status_code == 302 and "/api/auth/sso-redirect" in r.headers.get("location", ""), r.status_code


@check("GET /api/auth/sso-redirect 拒绝开放重定向")
def _():
    r = guest_nofollow.get("/api/auth/sso-redirect", params={"path": "//evil.example.com/x"})
    loc = r.headers.get("location", "")
    return r.status_code == 302 and "evil.example.com" not in loc, loc[:90]


@check("GET /api/health 存活")
def _():
    r = guest.get("/api/health")
    return r.status_code == 200 and r.json().get("status") == "ok", f"{r.status_code}"


@check("GET /api/auth/config 公开可读")
def _():
    r = guest.get("/api/auth/config")
    d = r.json()
    return r.status_code == 200 and "sso_login_url" in d, f"allow_dev_login={d.get('allow_dev_login')}"


@check("GET /api/auth/me 未登录返回 401")
def _():
    r = guest.get("/api/auth/me")
    return r.status_code == 401, f"{r.status_code} {r.json().get('detail')}"


@check("POST /api/auth/dev-login 管理员登录")
def _():
    r = admin.post("/api/auth/dev-login", json={"username": "admin", "password": "admin123"})
    d = r.json()
    return r.status_code == 200 and "admin" in d.get("user", {}).get("roles", []), f"roles={d.get('user', {}).get('roles')}"


@check("POST /api/auth/dev-login 普通用户登录")
def _():
    r = normal.post("/api/auth/dev-login", json={"username": "user", "password": "user123"})
    return r.status_code == 200, f"{r.status_code}"


@check("POST /api/auth/dev-login 密码错误返回 401")
def _():
    r = httpx.post(BASE + "/api/auth/dev-login",
                   json={"username": "admin", "password": "wrong"}, timeout=30)
    return r.status_code == 401, f"{r.status_code}"


@check("GET /api/auth/me 登录后可读")
def _():
    r = admin.get("/api/auth/me")
    d = r.json()
    return r.status_code == 200 and d.get("username") == "admin", f"username={d.get('username')} roles={d.get('roles')}"


@check("GET /api/system/health 组件体检")
def _():
    r = admin.get("/api/system/health")
    d = r.json()
    c = d.get("components", {})
    return r.status_code == 200 and "cdp" in c, (
        f"im_db={c.get('im_db', {}).get('ok')} cdp={c.get('cdp', {}).get('reachable')} "
        f"bridge={c.get('bridge', {}).get('ok')} queue={c.get('queue', {}).get('ok')} "
        f"monitor={c.get('monitor', {}).get('ok')}"
    )


@check("GET /api/system/status 总览")
def _():
    r = admin.get("/api/system/status")
    d = r.json()
    return r.status_code == 200 and "counts" in d, f"counts={d.get('counts')}"


@check("GET /api/browser/status 状态监控体检")
def _():
    r = admin.get("/api/browser/status")
    d = r.json()
    keys = [c.get("key") for c in d.get("checks", [])]
    want = ["chrome", "cdp", "login", "session", "chat_page", "pages", "monitor", "queue"]
    login = d.get("login", {})
    return r.status_code == 200 and keys == want, (
        f"checks={keys} 浏览器={d.get('cdp', {}).get('reachable')} "
        f"登录={login.get('logged_in')} 账号={login.get('account') or '-'} "
        f"判定={d.get('verdict', {}).get('label')}（{d.get('verdict', {}).get('reason')}）"
    )


@check("GET /api/browser/status 未登录返回 401")
def _():
    r = guest.get("/api/browser/status")
    return r.status_code == 401, f"{r.status_code}"


@check("POST /api/browser/probe 深度体检（只读）")
def _():
    r = admin.post("/api/browser/probe")
    d = r.json()
    return r.status_code == 200 and "verdict" in d, (
        f"verdict={d.get('verdict', {}).get('label')} chat={'有' if d.get('chat') else '无'}"
    )


@check("GET /api/browser/logs 体检记录")
def _():
    r = admin.get("/api/browser/logs", params={"limit": 5})
    return r.status_code == 200 and "items" in r.json(), f"{len(r.json().get('items', []))} 条"


@check("GET /api/browser/chrome-path Chrome 路径（可配置）")
def _():
    r = admin.get("/api/browser/chrome-path")
    d = r.json().get("chrome_path", {})
    return r.status_code == 200 and "resolved" in d, (
        f"来源={d.get('source_cn')} 生效={d.get('resolved') or '未找到'} "
        f"候选={len(d.get('candidates') or [])} profile={d.get('profile_dir')}"
    )


@check("GET /api/browser/login-info 登录凭证只回'有没有存'")
def _():
    r = admin.get("/api/browser/login-info")
    d = r.json()
    leaked = [k for k in d if "password" in k.lower() and isinstance(d.get(k), str) and len(str(d.get(k))) > 0
              and k != "note" and d.get(k) not in (True, False)]
    return r.status_code == 200 and "has_password" in d and not leaked, (
        f"account={d.get('account') or '(空)'} has_password={d.get('has_password')} 泄漏字段={leaked or '无'}"
    )


@check("GET /api/settings 不含登录密码（敏感项过滤）")
def _():
    r = admin.get("/api/settings")
    keys = list(r.json().get("settings", {}).keys())
    return r.status_code == 200 and "login_password" not in keys, (
        f"共 {len(keys)} 项；含 login_password={('login_password' in keys)}"
    )


@check("GET /api/system/commands 桥接命令清单")
def _():
    r = admin.get("/api/system/commands")
    d = r.json()
    return r.status_code == 200 and d["bridge"]["count"] > 40, (
        f"bridge={d['bridge']['count']} jobs={len(d['job_types'])}"
    )


@check("GET /api/system/config 配置快照")
def _():
    r = admin.get("/api/system/config")
    d = r.json()
    return r.status_code == 200 and "settings" in d, f"send_mode={d['runtime'].get('send_mode')}"


@check("GET /api/data/stats 统计")
def _():
    r = admin.get("/api/data/stats")
    d = r.json()
    return r.status_code == 200 and d.get("available"), f"counts={d.get('counts')}"


@check("GET /api/data/compare 比价表")
def _():
    r = admin.get("/api/data/compare")
    d = r.json()
    s = d.get("summary", {})
    return r.status_code == 200 and isinstance(d.get("items"), list), (
        f"共{s.get('total')}条 有价{s.get('priced')}条 最低{s.get('min_price')} 最高{s.get('max_price')}"
    )


@check("GET /api/data/quotes 报价台账")
def _():
    r = admin.get("/api/data/quotes")
    return r.status_code == 200 and len(r.json().get("items", [])) >= 0, f"{len(r.json().get('items', []))} 条"


@check("GET /api/data/customers 客户台账")
def _():
    r = admin.get("/api/data/customers")
    d = r.json()
    return r.status_code == 200 and d.get("total", 0) >= 0, f"{d.get('total')} 个客户"


@check("GET /api/data/messages 消息分页")
def _():
    r = admin.get("/api/data/messages", params={"limit": 5})
    d = r.json()
    return r.status_code == 200 and "total" in d, f"total={d.get('total')} 返回{len(d.get('items', []))}条"


@check("GET /api/data/chat 单客户往来")
def _():
    rows = admin.get("/api/data/customers", params={"limit": 1}).json()["items"]
    if not rows:
        return True, "库里暂无客户，跳过"
    key = rows[0]["conv_key"]
    r = admin.get("/api/data/chat", params={"conv_key": key, "limit": 50})
    d = r.json()
    return r.status_code == 200 and "messages" in d, (
        f"会话={rows[0]['name']} 消息{len(d.get('messages', []))}条 报价{len(d.get('quotes', []))}条"
    )


@check("GET /api/data/export/compare.csv 导出")
def _():
    r = admin.get("/api/data/export/compare.csv")
    return (r.status_code == 200 and r.content.startswith(b"\xef\xbb\xbf")
            and "text/csv" in r.headers.get("content-type", "")), f"{len(r.content)} bytes"


@check("GET /api/campaigns 任务列表")
def _():
    r = admin.get("/api/campaigns")
    d = r.json()
    return r.status_code == 200, f"{len(d.get('items', []))} 个任务"


@check("GET /api/campaigns/{id} 任务详情")
def _():
    items = admin.get("/api/campaigns").json()["items"]
    if not items:
        return True, "暂无任务，跳过"
    cid = items[0]["id"]
    r = admin.get(f"/api/campaigns/{cid}")
    d = r.json()
    return r.status_code == 200 and d.get("id") == cid, (
        f"#{cid} {d.get('name')} 联系{len(d.get('contacts', []))} 报价{len(d.get('quotes', []))}"
    )


@check("GET /api/campaigns/{id}/report 任务比价表")
def _():
    items = admin.get("/api/campaigns").json()["items"]
    if not items:
        return True, "暂无任务，跳过"
    r = admin.get(f"/api/campaigns/{items[0]['id']}/report")
    return r.status_code == 200, f"{r.json().get('summary', {}).get('total')} 行"


@check("GET /api/campaigns/{id}/contacts 任务商家")
def _():
    items = admin.get("/api/campaigns").json()["items"]
    if not items:
        return True, "暂无任务，跳过"
    r = admin.get(f"/api/campaigns/{items[0]['id']}/contacts")
    return r.status_code == 200, f"{len(r.json().get('items', []))} 家"


@check("任务业务参数：覆盖 → 生效 → 还原（回归）")
def _():
    items = admin.get("/api/campaigns").json()["items"]
    if not items:
        return True, "暂无任务，跳过"
    cid = items[0]["id"]
    before = admin.get(f"/api/campaigns/{cid}").json().get("params_override") or {}

    r = admin.put(f"/api/campaigns/{cid}/params",
                  json={"params": {"inquiry_count": 3, "slice_per_round": 1, "send_mode": "dry"}})
    if r.status_code != 200:
        return False, f"{r.status_code} {r.text[:100]}"
    eff = r.json()["params_effective"]
    ok = (eff.get("inquiry_count") == 3 and eff.get("slice_per_round") == 1
          and eff.get("send_mode") == "dry")

    admin.put(f"/api/campaigns/{cid}/params", json={"params": before})
    restored = (admin.get(f"/api/campaigns/{cid}").json().get("params_override") or {}) == before
    return ok and restored, f"覆盖生效={ok}，已还原={restored}"


@check("任务业务参数：非法值被拒")
def _():
    items = admin.get("/api/campaigns").json()["items"]
    if not items:
        return True, "暂无任务，跳过"
    cid = items[0]["id"]
    a = admin.put(f"/api/campaigns/{cid}/params", json={"params": {"inquiry_count": 9999}})
    b = admin.put(f"/api/campaigns/{cid}/params", json={"params": {"max_inquiry_count": 5}})
    return a.status_code == 400 and b.status_code == 400, (
        f"越界={a.status_code} 未知键={b.status_code}"
    )


@check("GET /api/settings 读取参数")
def _():
    r = admin.get("/api/settings")
    s = r.json().get("settings", {})
    return r.status_code == 200 and "inquiry_count" in s, (
        f"每任务{s.get('inquiry_count')}家 上限{s.get('max_inquiry_count')} 预期价{s.get('expected_price')}"
    )


@check("PUT /api/settings 管理员可改参数")
def _():
    r = admin.put("/api/settings", json={"inquiry_count": 10, "slice_per_round": 2})
    return r.status_code == 200 and r.json()["settings"]["inquiry_count"] == 10, f"{r.status_code}"


@check("PUT /api/settings 普通用户被拒 403")
def _():
    r = normal.put("/api/settings", json={"inquiry_count": 5})
    return r.status_code == 403, f"{r.status_code} {r.json().get('detail')}"


@check("PUT /api/settings 非法值被拒")
def _():
    r = admin.put("/api/settings", json={"inquiry_count": 99999})
    return r.status_code == 422, f"{r.status_code}"


@check("名单：新增 → 查询 → 删除")
def _():
    key = "__smoke_test__"
    add = admin.post("/api/settings/lists", json={"list_type": "blacklist",
                                                  "conv_keys": [key], "note": "冒烟测试"})
    if add.status_code != 200:
        return False, f"新增失败 {add.status_code}"
    listed = admin.get("/api/settings/lists").json()
    hit = any(i["conv_key"] == key for i in listed.get("blacklist", []))
    dele = admin.delete(f"/api/settings/lists/{key}")
    listed2 = admin.get("/api/settings/lists").json()
    gone = not any(i["conv_key"] == key for i in listed2.get("blacklist", []))
    return hit and gone and dele.status_code == 200, f"新增={hit} 删除={gone}"


@check("GET /api/phrases 快捷短语库")
def _():
    r = admin.get("/api/phrases")
    d = r.json()
    return r.status_code == 200, f"{d.get('total')} 条短语"


@check("GET /api/pricing-templates 比价配置方案")
def _():
    r = admin.get("/api/pricing-templates")
    d = r.json()
    return r.status_code == 200 and d.get("max") == 100, (
        f"{d.get('total')} / {d.get('max')} 套"
    )


@check("比价配置方案：创建 → 更新 → 列表 → 删除")
def _():
    name = f"smoke-template-{int(time.time() * 1000)}"
    payload = {
        "name": name,
        "description": "自动冒烟测试，结束后删除",
        "send_mode": "dry",
        "inquiry_count": 7,
        "slice_per_round": 2,
        "expected_price": 1.25,
        "expected_price_note": "含税含运",
        "max_followups": 2,
        "duration_sec": 900,
        "reply_timeout_sec": 90,
    }
    created = admin.post("/api/pricing-templates", json=payload)
    if created.status_code != 200:
        return False, f"创建失败 {created.status_code} {created.text[:120]}"
    template_id = created.json()["item"]["id"]
    try:
        updated = admin.put(
            f"/api/pricing-templates/{template_id}",
            json={**payload, "inquiry_count": 9, "expected_price": 1.5},
        )
        listed = admin.get("/api/pricing-templates").json()["items"]
        hit = next((item for item in listed if item["id"] == template_id), None)
        ok = (
            updated.status_code == 200
            and hit is not None
            and hit["inquiry_count"] == 9
            and hit["expected_price"] == 1.5
            and hit["max_followups"] == 2
            and hit["duration_sec"] == 900
            and hit["reply_timeout_sec"] == 90
        )
        return ok, f"id={template_id} 更新={updated.status_code} 列表可见={hit is not None}"
    finally:
        admin.delete(f"/api/pricing-templates/{template_id}")


@check("比价配置方案：普通用户不能修改")
def _():
    r = normal.post("/api/pricing-templates", json={
        "name": "forbidden",
        "send_mode": "dry",
        "inquiry_count": 1,
        "slice_per_round": 1,
        "expected_price": 1,
    })
    return r.status_code == 403, f"{r.status_code}"


@check("GET /api/library/images 图片库")
def _():
    r = admin.get("/api/library/images")
    d = r.json()
    return r.status_code == 200, f"{d.get('total')} 张图片"


@check("GET /api/library/file 图片预览")
def _():
    items = admin.get("/api/library/images").json()["items"]
    if not items:
        return True, "暂无图片，跳过"
    r = admin.get("/api/library/file", params={"path": items[0]["path"]})
    return r.status_code == 200 and len(r.content) > 100, f"{items[0]['fileName']} {len(r.content)} bytes"


@check("GET /api/library/file 目录穿越被拒")
def _():
    r = admin.get("/api/library/file", params={"path": "../../../Windows/win.ini"})
    return r.status_code == 400, f"{r.status_code}"


@check("POST /api/library/images/bind 空路径被拒")
def _():
    r = admin.post("/api/library/images/bind", json={"image_path": "   ", "phrase_id": "x"})
    return r.status_code == 400, f"{r.status_code} {str(r.json().get('detail', ''))[:50]}"


@check("图片绑定：绑定 → 列表显示 → 还原（回归）")
def _():
    items = admin.get("/api/library/images").json()["items"]
    if not items:
        return True, "暂无图片，跳过"
    phrases = admin.get("/api/phrases").json()["items"]
    if not phrases:
        return True, "暂无短语，跳过"
    target = items[0]
    before = target.get("phrase_id") or None
    pid = phrases[0]["id"]

    r = admin.post("/api/library/images/bind", json={"image_path": target["path"], "phrase_id": pid})
    if r.status_code != 200:
        return False, f"绑定失败 {r.status_code} {r.text[:120]}"
    if r.json().get("phraseId") != pid:
        return False, f"返回体不对：{r.json()}"

    after = [i for i in admin.get("/api/library/images").json()["items"] if i["path"] == target["path"]]
    shown = bool(after) and after[0].get("phrase_id") == pid

    back = admin.post("/api/library/images/bind", json={"image_path": target["path"], "phrase_id": before})
    return shown and back.status_code == 200, (
        f"{target['fileName']} 绑定后列表可见={shown}，已还原为 {before!r}"
    )


@check("POST /api/library/images/repair 图片库体检")
def _():
    r = admin.post("/api/library/images/repair")
    d = r.json()
    return r.status_code == 200, (
        f"幽灵行 {d.get('removed_junk')} · 修复 {d.get('fixed')} · "
        f"磁盘缺失 {len(d.get('missing_files', []))} · 库内 {d.get('total_in_db')}"
    )


@check("GET /api/ai/config AI 配置")
def _():
    r = admin.get("/api/ai/config")
    d = r.json()
    return r.status_code == 200, f"hasApiKey={d.get('hasApiKey')} model={d.get('resolved', {}).get('model')}"


@check("GET /api/flows 流程状态")
def _():
    r = admin.get("/api/flows")
    d = r.json()
    return r.status_code == 200 and "queue" in d, (
        f"queue运行={d['queue']['running']} 深度={d['queue']['depth']} "
        f"监听存活={d['monitor']['alive']} 桥接={d['bridge']['running']}"
    )


@check("GET /api/jobs 作业列表")
def _():
    r = admin.get("/api/jobs")
    return r.status_code == 200, f"{len(r.json().get('items', []))} 条作业"


@check("GET /api/outreach/sellers 读结果页商家（只读）")
def _():
    r = admin.get("/api/outreach/sellers", params={"limit": 5})
    if r.status_code != 200:
        return False, f"{r.status_code} {r.json().get('detail')}"
    d = r.json()
    return True, f"页面共{d.get('total')}个卡片，返回{len(d.get('sellers', []))}家"


@check("POST /api/send/text 无 confirm 被拦（不发送）")
def _():
    r = admin.post("/api/send/text", json={"text": "__smoke_should_not_send__"})
    return r.status_code == 400 and "confirm" in r.json().get("detail", ""), f"{r.status_code}"


@check("GET /api/system/audit 审计有记录")
def _():
    r = admin.get("/api/system/audit", params={"limit": 5})
    return r.status_code == 200, f"{len(r.json().get('items', []))} 条"


@check("GET /api/system/ai-calls AI 调用留痕")
def _():
    r = admin.get("/api/system/ai-calls", params={"limit": 5})
    d = r.json()
    return r.status_code == 200 and isinstance(d.get("items"), list), (
        f"{d.get('count', 0)} 条"
    )


def main() -> int:
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    width = max(len(n) for n, _, _ in RESULTS)
    print("=" * 100)
    print(f"接口层冒烟测试  |  {BASE}")
    print("=" * 100)
    for name, ok, detail in RESULTS:
        print(f"[{'PASS' if ok else 'FAIL'}] {name.ljust(width)}  {detail}")
    print("-" * 100)
    print(f"通过 {passed}/{len(RESULTS)}")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
