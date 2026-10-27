"""认证路由：门户 SSO（一次性 code → 服务端换 token）+ 本地调试登录。

完全按《JWT接入开发指南》实现：
  GET  /api/auth/sso-redirect   302 跳门户登录页
  GET  /api/auth/sso/callback   回跳：code 换 token → 写 HttpOnly cookie → 回业务页
  GET  /api/auth/me             当前用户
  POST /api/auth/logout         清除 cookie
"""

import urllib.parse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from .. import config, hostcontrol, security

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _safe_path(path: str | None) -> str:
    """只允许站内相对路径，避免开放重定向。"""
    if not path or not path.startswith("/") or path.startswith("//"):
        return "/"
    return path


@router.get("/config")
async def auth_config() -> dict:
    """前端登录页用：门户地址 / 回调地址 / 是否允许本地调试登录。"""
    return {
        "sso_login_url": config.SSO_LOGIN_URL,
        "sso_callback_url": config.SSO_CALLBACK_URL,
        "portal_api_base_url": config.PORTAL_API_BASE_URL,
        "portal_logout_url": config.PORTAL_LOGOUT_URL,
        "allow_dev_login": config.ALLOW_DEV_LOGIN,
        # 侧边栏底部用
        "developer_url": config.DEVELOPER_URL,
        "developer_name": config.DEVELOPER_NAME,
        "copyright": config.COPYRIGHT,
    }


@router.get("/sso-redirect")
async def sso_redirect(path: str = "/") -> RedirectResponse:
    target = _safe_path(path)
    callback = config.SSO_CALLBACK_URL + "?path=" + urllib.parse.quote(target, safe="")
    login_url = config.SSO_LOGIN_URL + "?redirect=" + urllib.parse.quote(callback, safe="")
    return RedirectResponse(login_url, status_code=302)


@router.get("/sso/callback")
async def sso_callback(code: str = "", path: str = "/") -> RedirectResponse:
    target = _safe_path(path)
    if not code:
        return RedirectResponse("/api/auth/sso-redirect?path=" + urllib.parse.quote(target, safe=""),
                                status_code=302)
    try:
        if config.HOST_AGENT_REMOTE:
            exchange = await hostcontrol.host_agent.portal_exchange(code)
            status_code = int(exchange.get("status") or 0)
            payload = exchange.get("data") or {}
        else:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(
                    config.PORTAL_API_BASE_URL.rstrip("/") + "/api/auth/sso-exchange",
                    json={"code": code},
                )
            status_code = resp.status_code
            payload = resp.json() if resp.status_code == 200 else {}
    except (httpx.HTTPError, hostcontrol.HostAgentError, ValueError):
        return RedirectResponse("/api/auth/sso-redirect?path=" + urllib.parse.quote(target, safe=""),
                                status_code=302)
    if status_code != 200:
        return RedirectResponse("/api/auth/sso-redirect?path=" + urllib.parse.quote(target, safe=""),
                                status_code=302)
    token = (payload or {}).get("access_token")
    if not token:
        return RedirectResponse("/api/auth/sso-redirect?path=" + urllib.parse.quote(target, safe=""),
                                status_code=302)
    response = RedirectResponse(target, status_code=302)
    response.set_cookie(
        key=config.SSO_TOKEN_COOKIE_NAME,
        value=token,
        httponly=True,
        secure=config.SSO_COOKIE_SECURE,
        samesite="lax",
        path="/",
        max_age=config.SSO_COOKIE_MAX_AGE,
    )
    return response


@router.get("/me")
async def me(user: dict = Depends(security.get_current_user)) -> dict:
    return {
        "id": user.get("id"),
        "username": user.get("username"),
        "display_name": user.get("display_name"),
        "avatar_url": user.get("avatar_url"),
        "roles": user.get("roles") or [],
    }


@router.post("/logout")
async def logout(response: Response) -> dict:
    response.delete_cookie(config.SSO_TOKEN_COOKIE_NAME, path="/")
    return {"status": "ok"}


class DevLoginBody(BaseModel):
    username: str
    password: str


@router.post("/dev-login")
async def dev_login(body: DevLoginBody, response: Response, request: Request) -> dict:
    """本地调试登录（门户未就绪时用）。

    生产环境请把 ALLOW_DEV_LOGIN 设为 false 关闭。
    """
    if not config.ALLOW_DEV_LOGIN:
        raise HTTPException(status_code=403, detail="本地调试登录已关闭，请使用企业门户登录")
    for i, u in enumerate(config.DEV_USERS):
        if u["username"] == body.username and u["password"] == body.password:
            token = security.issue_token(u["username"], i + 1, u["roles"], u["display_name"])
            response.set_cookie(
                key=config.SSO_TOKEN_COOKIE_NAME,
                value=token,
                httponly=True,
                secure=config.SSO_COOKIE_SECURE,
                samesite="lax",
                path="/",
                max_age=config.SSO_COOKIE_MAX_AGE,
            )
            return {
                "access_token": token,
                "token_type": "bearer",
                "expires_in": config.SSO_COOKIE_MAX_AGE,
                "user": {"id": i + 1, "username": u["username"],
                         "display_name": u["display_name"], "roles": u["roles"]},
            }
    raise HTTPException(status_code=401, detail="用户名或密码错误")
