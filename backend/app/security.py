"""JWT 验签与角色守卫。

与门户共用 JWT_SECRET（HS256），payload 结构见门户《JWT接入开发指南》：
    { "sub": "admin", "user_id": 1, "roles": ["admin","user"], "exp": 1696118400 }

取 token 的顺序：Authorization: Bearer  →  HttpOnly cookie（jwt_token）
"""

from typing import Any

import jwt
from fastapi import Depends, HTTPException, Request, status

from . import config


def verify_token(token: str) -> dict[str, Any]:
    """验签 JWT，返回 payload；失败抛 401。"""
    try:
        return jwt.decode(token, config.JWT_SECRET, algorithms=[config.JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="令牌已过期")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="令牌无效")


def extract_token(request: Request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        token = auth[7:].strip()
        if token:
            return token
    return request.cookies.get(config.SSO_TOKEN_COOKIE_NAME)


def normalize_user(payload: dict[str, Any], request: Request | None = None) -> dict[str, Any]:
    roles = payload.get("roles") or []
    if isinstance(roles, str):
        roles = [roles]
    return {
        "id": payload.get("user_id"),
        "username": payload.get("sub"),
        "display_name": payload.get("display_name") or payload.get("sub"),
        "avatar_url": payload.get("avatar_url"),
        "roles": [str(r) for r in roles],
        "exp": payload.get("exp"),
    }


async def get_current_user(request: Request) -> dict[str, Any]:
    """FastAPI 依赖：优先 Authorization 头，兜底 cookie。"""
    token = extract_token(request)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="未登录或登录已过期")
    return normalize_user(verify_token(token), request)


async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if "admin" not in (user.get("roles") or []):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="需要管理员权限")
    return user


async def require_admin_or_gm(user: dict = Depends(get_current_user)) -> dict:
    roles = user.get("roles") or []
    if "admin" not in roles and "gm" not in roles:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="需要管理员或GM权限")
    return user


def is_admin_or_gm(user: dict) -> bool:
    roles = user.get("roles") or []
    return "admin" in roles or "gm" in roles


def issue_token(username: str, user_id: int, roles: list[str], display_name: str = "",
                extra: dict | None = None) -> str:
    """调试登录用：按门户同款 payload 结构签发 token。"""
    import time

    now = int(time.time())
    payload = {
        "sub": username,
        "user_id": user_id,
        "roles": roles,
        "display_name": display_name or username,
        "iat": now,
        "exp": now + config.SSO_COOKIE_MAX_AGE,
    }
    if extra:
        payload.update(extra)
    return jwt.encode(payload, config.JWT_SECRET, algorithm=config.JWT_ALGORITHM)
