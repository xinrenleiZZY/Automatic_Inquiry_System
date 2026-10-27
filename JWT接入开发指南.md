# JWT 接入开发指南

> 让你的外部应用接入汇挚鑫企业应用门户的统一认证体系，实现单点登录（SSO）。
> 用户只需在门户登录一次，访问外部应用时自动携带身份，无需二次登录。

## 一、前置条件

| 条件 | 说明 |
|------|------|
| 门户已运行 | portal-api (:6681) + portal-web (:6680) 正常运行 |
| 网络可达 | 外部应用后端能访问门户 API `http://<门户IP>:6681` |
| 共享密钥 | 外部应用的 `JWT_SECRET` 必须与门户完全一致 |
| 后端框架 | 支持 JWT 验签的语言/框架（Python/Node/Go/Java 均可） |
| 应用已注册 | 本应用访问地址须在门户「应用管理」中注册（与其 SSO 回调同源），否则回跳将被门户 403 拒绝（详见 [4.4](#44-应用级网关校验方案a)） |

## 二、认证流程（一次性 code → 服务端换 token）

```
浏览器访问外部应用（未登录）
  │
  ▼ ① auth-guard 检测到 401
  │
  ▼ ② 跳转门户登录页
  │   http://<门户IP>:6680/login?redirect=<外部应用回调地址>
  │
  ▼ ③ 用户在门户输入账号密码登录
  │
  ▼ ④ 门户验证密码
  │      └── 【应用级网关校验】按 redirect 目标反查已注册应用，校验当前用户可见性
  │            · 目标未注册 / 已停用 → 403「目标应用未在门户注册或已停用，拒绝签发登录凭据」
  │            · 已注册但当前用户角色不匹配 → 403「您没有访问该应用的权限，请联系管理员」
  │
  ▼ ④' 校验通过 → 签发 JWT → 生成一次性 SSO code（60秒有效）
  │
  ▼ ⑤ 门户跳回外部应用：callback_url?code=xxx
  │
  ▼ ⑥ 外部应用后端用 code 调门户 POST /api/auth/sso-exchange 换取 token
  │   （服务端到服务端，token 不进浏览器 URL）
  │
  ▼ ⑦ 外部应用将 token 写入 HttpOnly cookie → 302 回业务页
  │
  ▼ ⑧ 浏览器自动携带 cookie，后续请求自动鉴权
  │
  ▼ ⑨ 外部应用后端用共享 JWT_SECRET 验签
      ├── 验签通过 → 放行，从 payload 读取用户名和角色
      └── 验签失败 → 401，前端跳回 ②
```

**核心思想**：门户管"验密码 + 验权限"（谁能访问哪个应用），外部应用管"验 token"，两者共用同一个 JWT 密钥。token 交接用一次性 code 完成，避免 JWT 暴露在 URL。

## 三、JWT Payload 结构

```json
{
  "sub": "admin",          // 用户名
  "user_id": 1,            // 用户 ID
  "roles": ["admin", "user"],  // 角色名列表
  "exp": 1696118400        // 过期时间（UTC 时间戳）
}
```

验签算法：**HS256**，密钥：与门户 `.env` 中的 `JWT_SECRET` 完全一致。

## 四、门户侧提供的接口

### 4.1 登录（支持 SSO）

```
POST http://<门户IP>:6681/api/auth/login?redirect=<回调地址>
Content-Type: application/json

请求体：
{
  "username": "admin",
  "password": "admin123"
}

响应（200）：
{
  "access_token": "eyJhbGciOi...",
  "token_type": "bearer",
  "expires_in": 28800,
  "user": {
    "id": 1,
    "username": "admin",
    "display_name": "管理员",
    "roles": ["admin", "user"]
  },
  "sso_code": "MD7hyFKHMb..."   // 仅当带 redirect 参数时返回
}
```

> `redirect` 参数是外部应用的回调地址，如 `http://<外部应用IP>:端口/api/auth/sso/callback?path=/首页`
> 门户登录页前端会自动处理：如果有 sso_code 且 redirect 以 http 开头，则 `location.replace(redirect + "&code=" + sso_code)`

错误（403）：当 `redirect` 指向的应用未注册、已停用，或当前用户无访问权限时，门户**不签发** sso_code：

```json
{
  "detail": "目标应用未在门户注册或已停用，拒绝签发登录凭据"
}
```

```json
{
  "detail": "您没有访问该应用的权限，请联系管理员"
}
```

> 校验规则见 [4.4 应用级网关校验（方案A）](#44-应用级网关校验方案a)。

### 4.2 SSO Code 换 Token（服务端调用）

```
POST http://<门户IP>:6681/api/auth/sso-exchange
Content-Type: application/json

请求体：
{
  "code": "MD7hyFKHMb..."
}

响应（200）：
{
  "access_token": "eyJhbGciOi...",
  "token_type": "bearer",
  "user_id": 1,
  "username": "admin",
  "display_name": "管理员",
  "roles": ["admin", "user"]
}

错误（401）：
{
  "detail": "授权码无效或已过期"
}
```

> code 特性：60 秒有效，用后即焚（一次性），单实例内存存储

### 4.3 获取当前用户信息（可选，用于调试）

```
GET http://<门户IP>:6681/api/auth/me
Authorization: Bearer <token>

响应（200）：
{
  "id": 1,
  "username": "admin",
  "display_name": "管理员",
  "avatar_url": "/static/avatars/xxx.png",
  "roles": ["admin", "user"]
}
```

### 4.4 应用级网关校验（方案A）

门户在签发 sso_code（登录接口 `POST /api/auth/login` 带外部 `redirect` 时）或免密登录（`POST /api/auth/sso-authorize`）之前，会按 `redirect` 目标 URL 反查已注册应用并校验当前用户可见性，通过才签发——防止"登录了门户就能为任意应用换取 token"的越权。

**反查规则**：

1. 解析 `redirect` 目标的 origin（scheme + host + port）与 path；
2. 在门户应用表中筛出**已启用**且 origin 相同的应用；
3. 同一 origin 只有一个应用 → 直接命中（SSO 回调路径通常与应用首页不同，如回调 `/api/auth/sso/callback` vs 应用页 `/developer.html`，不要求路径前缀）；
4. 同一 origin 有多个应用 → 取**路径前缀最长匹配者**（更精确）；
5. 无任何命中 → 视为未注册 → 403。

**可见性判定**：

| 当前用户 | 应用已绑角色 | 结果 |
|---|---|---|
| admin / gm | 任意 | ✅ 可见 |
| 其他角色 | 未绑定任何角色 | ✅ 可见 |
| 其他角色 | 与用户角色有交集 | ✅ 可见 |
| 其他角色 | 与用户角色无交集 | ❌ 403 |
| 任意 | 应用未注册 / 已停用 | ❌ 403 |

**403 响应体**：

```json
{ "detail": "目标应用未在门户注册或已停用，拒绝签发登录凭据" }
```

```json
{ "detail": "您没有访问该应用的权限，请联系管理员" }
```

> **接入规范**：外部应用必须在门户"应用管理"中注册其访问地址，且注册地址与 SSO 回调**同源**（同 scheme + host + port）。否则回跳会因反查不到而 403。

## 五、外部应用需要实现的接口

| 端点 | 方法 | 说明 | 鉴权 |
|------|------|------|------|
| `/api/auth/sso-redirect` | GET | 生成门户跳转地址，302 到门户登录页 | 公开 |
| `/api/auth/sso/callback` | GET | 接收回跳 code → 换 token → 写 cookie → 302 回业务页 | 公开 |
| `/api/auth/me` | GET | 返回当前登录用户信息 | 已登录 |
| `/api/auth/logout` | POST | 清除 cookie | 已登录 |

### 接口说明

**① /api/auth/sso-redirect?path=/index.html**
- 生成回调地址：`http://<本应用IP>:端口/api/auth/sso/callback?path=/index.html`
- 302 跳转到：`http://<门户IP>:6680/login?redirect=<回调地址>`

**② /api/auth/sso/callback?code=xxx&path=/index.html**
- 用 code 调门户 `POST /api/auth/sso-exchange` 换 token
- 将 token 写入 HttpOnly cookie（`jwt_token`，path=/，max_age=28800）
- 302 重定向到 `path`

**③ /api/auth/me**
- 从 cookie 或 Authorization 头读取 token
- 用共享 JWT_SECRET 验签
- 返回 `{id, username, roles}`

**④ /api/auth/logout**
- 清除 `jwt_token` cookie
- 返回 200

## 六、角色映射

| 门户角色 | 定位 | 权限范围 |
|----------|------|----------|
| `admin` | 系统管理员 | 全部页面 + 管理入口 |
| `gm` | 管理经理 | 全部业务页 + 部分管理入口 |
| `user` | 普通用户 | 仅业务功能页 |

判定规则：`roles` 含 `admin` → 全量；否则含 `gm` → 业务+管理；否则（含 `user` 或任意有效 JWT）→ 仅业务。三者均无 → 401。

## 七、各语言实现示例

### 7.1 Python (FastAPI)

#### 安装依赖

```bash
pip install PyJWT httpx
```

#### config.py

```python
import os

# 必须与门户完全一致
JWT_SECRET = os.getenv("JWT_SECRET", "")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")

# 门户地址
PORTAL_API_BASE_URL = os.getenv("PORTAL_API_BASE_URL", "http://192.168.40.194:6681")
SSO_LOGIN_URL = os.getenv("SSO_LOGIN_URL", "http://192.168.40.194:6680/login")
SSO_CALLBACK_URL = os.getenv("SSO_CALLBACK_URL", "http://<本应用IP>:端口/api/auth/sso/callback")
SSO_TOKEN_COOKIE_NAME = os.getenv("SSO_TOKEN_COOKIE_NAME", "jwt_token")
SSO_COOKIE_SECURE = os.getenv("SSO_COOKIE_SECURE", "false").lower() == "true"
```

#### security.py

```python
import jwt
from fastapi import Depends, HTTPException, Request, status
from app.config import JWT_SECRET, JWT_ALGORITHM, SSO_TOKEN_COOKIE_NAME


def verify_token(token: str) -> dict:
    """验签 JWT，返回 payload。失败抛 401。"""
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="令牌已过期")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="令牌无效")


def get_current_user(request: Request) -> dict:
    """FastAPI 依赖：优先读 Authorization 头，兜底读 cookie。"""
    token = None
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]
    if not token:
        token = request.cookies.get(SSO_TOKEN_COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=401, detail="未登录或登录已过期")
    return verify_token(token)


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if "admin" not in user.get("roles", []):
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return user


def require_admin_or_gm(user: dict = Depends(get_current_user)) -> dict:
    roles = user.get("roles", [])
    if "admin" not in roles and "gm" not in roles:
        raise HTTPException(status_code=403, detail="需要管理员或GM权限")
    return user
```

#### api/auth.py

```python
import urllib.parse
import httpx
from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import RedirectResponse
from app.config import *
from app.security import get_current_user

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.get("/sso-redirect")
async def sso_redirect(path: str = "/"):
    """跳转门户登录页。"""
    callback = SSO_CALLBACK_URL + "?path=" + urllib.parse.quote(path, safe="")
    login_url = SSO_LOGIN_URL + "?redirect=" + urllib.parse.quote(callback, safe="")
    return RedirectResponse(login_url, status_code=302)


@router.get("/sso/callback")
async def sso_callback(code: str = "", path: str = "/"):
    """门户登录后回跳：用 code 换 token，写 cookie，回业务页。"""
    if not code:
        return RedirectResponse(f"/api/auth/sso-redirect?path={path}", status_code=302)

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            f"{PORTAL_API_BASE_URL}/api/auth/sso-exchange",
            json={"code": code},
        )
    if resp.status_code != 200:
        return RedirectResponse(f"/api/auth/sso-redirect?path={path}", status_code=302)

    token = resp.json()["access_token"]
    response = RedirectResponse(path, status_code=302)
    response.set_cookie(
        key=SSO_TOKEN_COOKIE_NAME,
        value=token,
        httponly=True,
        secure=SSO_COOKIE_SECURE,
        samesite="lax",
        path="/",
        max_age=28800,  # 8小时
    )
    return response


@router.get("/me")
async def me(user: dict = Depends(get_current_user)):
    return {
        "id": user.get("user_id"),
        "username": user.get("sub"),
        "roles": user.get("roles", []),
    }


@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie(SSO_TOKEN_COOKIE_NAME, path="/")
    return {"status": "ok"}
```

#### main.py（注册路由 + 业务接口加鉴权）

```python
from fastapi import FastAPI, Depends
from app.api import auth as auth_api
from app.security import get_current_user

app = FastAPI()
app.include_router(auth_api.router)  # /api/auth/*

# 业务接口加鉴权：在需要登录的端点加 Depends(get_current_user)
@app.get("/api/data/list")
async def list_data(user: dict = Depends(get_current_user)):
    return {"data": [], "user": user.get("sub")}

# 需要管理员权限的接口
@app.delete("/api/data/{item_id}")
async def delete_data(item_id: int, user: dict = Depends(require_admin)):
    return {"status": "deleted"}
```

#### docker-compose.yml（追加环境变量）

```yaml
services:
  backend:
    environment:
      # JWT / SSO 配置
      JWT_SECRET: ${JWT_SECRET:-change-me-in-production-please-use-random-string}
      JWT_ALGORITHM: HS256
      PORTAL_API_BASE_URL: http://192.168.40.194:6681
      SSO_LOGIN_URL: http://192.168.40.194:6680/login
      SSO_CALLBACK_URL: http://<本应用IP>:端口/api/auth/sso/callback
      SSO_TOKEN_COOKIE_NAME: jwt_token
      SSO_COOKIE_SECURE: false
```

#### .env（追加）

```env
JWT_SECRET=change-me-in-production-please-use-random-string
PORTAL_API_BASE_URL=http://192.168.40.194:6681
SSO_LOGIN_URL=http://192.168.40.194:6680/login
SSO_CALLBACK_URL=http://<本应用IP>:端口/api/auth/sso/callback
```

---

### 7.2 Node.js (Express)

#### 安装依赖

```bash
npm install jsonwebtoken axios
```

#### auth.js

```javascript
const express = require('express');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || '';
const PORTAL_API_BASE_URL = process.env.PORTAL_API_BASE_URL || 'http://192.168.40.194:6681';
const SSO_LOGIN_URL = process.env.SSO_LOGIN_URL || 'http://192.168.40.194:6680/login';
const SSO_CALLBACK_URL = process.env.SSO_CALLBACK_URL || 'http://localhost:3000/api/auth/sso/callback';
const COOKIE_NAME = process.env.SSO_TOKEN_COOKIE_NAME || 'jwt_token';

// 验签中间件
function authRequired(req, res, next) {
  let token = null;
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) token = auth.slice(7);
  if (!token) token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ detail: '未登录或登录已过期' });

  try {
    req.user = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    next();
  } catch (e) {
    return res.status(401).json({ detail: '令牌无效或已过期' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user?.roles?.includes('admin'))
    return res.status(403).json({ detail: '需要管理员权限' });
  next();
}

// 跳转门户登录
router.get('/sso-redirect', (req, res) => {
  const path = req.query.path || '/';
  const callback = `${SSO_CALLBACK_URL}?path=${encodeURIComponent(path)}`;
  res.redirect(`${SSO_LOGIN_URL}?redirect=${encodeURIComponent(callback)}`);
});

// 回调：code 换 token
router.get('/sso/callback', async (req, res) => {
  const { code, path = '/' } = req.query;
  if (!code) return res.redirect('/api/auth/sso-redirect?path=' + encodeURIComponent(path));

  try {
    const resp = await axios.post(`${PORTAL_API_BASE_URL}/api/auth/sso-exchange`, { code });
    const token = resp.data.access_token;
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.SSO_COOKIE_SECURE === 'true',
      sameSite: 'lax',
      maxAge: 28800000,
      path: '/',
    });
    res.redirect(path);
  } catch (e) {
    res.redirect('/api/auth/sso-redirect?path=' + encodeURIComponent(path));
  }
});

router.get('/me', authRequired, (req, res) => {
  res.json({ id: req.user.user_id, username: req.user.sub, roles: req.user.roles || [] });
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ status: 'ok' });
});

module.exports = { router, authRequired, requireAdmin };
```

#### app.js

```javascript
const express = require('express');
const cookieParser = require('cookie-parser');
const { router: authRouter, authRequired, requireAdmin } = require('./auth');

const app = express();
app.use(cookieParser());
app.use('/api/auth', authRouter);

// 需要登录的接口
app.get('/api/data/list', authRequired, (req, res) => {
  res.json({ data: [], user: req.user.sub });
});

// 需要管理员权限
app.delete('/api/data/:id', authRequired, requireAdmin, (req, res) => {
  res.json({ status: 'deleted' });
});

app.listen(3000);
```

#### 前端 fetch 封装

```javascript
async function request(method, url, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',  // 关键：自动携带 cookie
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);

  // 401 拦截：非 auth 接口时跳登录
  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    location.href = '/api/auth/sso-redirect?path=' + encodeURIComponent(location.pathname + location.search);
    throw new Error('未登录或登录已过期');
  }
  if (!res.ok) throw new Error('请求失败 (' + res.status + ')');
  return res.json();
}
```

#### 前端页面守卫

```html
<!-- 在每个页面 </body> 前引入 -->
<script>
async function initAuth() {
  try {
    const me = await fetch('/api/auth/me', { credentials: 'include' }).then(r => r.json());
    // 显示用户名和角色
    document.getElementById('auth-bar').innerHTML =
      `<span>${me.username}</span> <span class="role">${(me.roles||[]).join(',')}</span>
       <button onclick="logout()">登出</button>`;
    // 角色控制：非 admin/gm 隐藏管理入口
    if (!me.roles.includes('admin') && !me.roles.includes('gm')) {
      document.querySelectorAll('[data-requires="admin"]').forEach(el => el.style.display = 'none');
    }
  } catch (e) {
    document.getElementById('auth-bar').innerHTML =
      '<button onclick="location.href=\'/api/auth/sso-redirect?path=\' + encodeURIComponent(location.pathname)">去门户登录</button>';
  }
}
async function logout() {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  location.reload();
}
document.addEventListener('DOMContentLoaded', initAuth);
</script>
<div id="auth-bar" style="position:fixed;top:8px;right:16px;z-index:9999;font-size:13px;"></div>
```

---

### 7.3 Go (Gin)

#### go.mod

```
require (
    github.com/gin-gonic/gin
    github.com/golang-jwt/jwt/v5
)
```

#### auth.go

```go
package main

import (
    "net/http"
    "github.com/gin-gonic/gin"
    "github.com/golang-jwt/jwt/v5"
)

var jwtSecret = []byte(getEnv("JWT_SECRET", ""))
var portalAPIBaseURL = getEnv("PORTAL_API_BASE_URL", "http://192.168.40.194:6681")
var ssoLoginURL = getEnv("SSO_LOGIN_URL", "http://192.168.40.194:6680/login")
var ssoCallbackURL = getEnv("SSO_CALLBACK_URL", "http://localhost:8080/api/auth/sso/callback")

func authRequired() gin.HandlerFunc {
    return func(c *gin.Context) {
        token := ""
        if auth := c.GetHeader("Authorization"); len(auth) > 7 && auth[:7] == "Bearer " {
            token = auth[7:]
        }
        if token == "" {
            token, _ = c.Cookie("jwt_token")
        }
        if token == "" {
            c.AbortWithStatusJSON(401, gin.H{"detail": "未登录"})
            return
        }
        claims := jwt.MapClaims{}
        _, err := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (interface{}, error) {
            return jwtSecret, nil
        })
        if err != nil {
            c.AbortWithStatusJSON(401, gin.H{"detail": "令牌无效"})
            return
        }
        c.Set("user", claims)
        c.Next()
    }
}

func requireAdmin() gin.HandlerFunc {
    return func(c *gin.Context) {
        claims, _ := c.Get("user")
        roles := claims.(jwt.MapClaims)["roles"].([]interface{})
        for _, r := range roles {
            if r.(string) == "admin" {
                c.Next()
                return
            }
        }
        c.AbortWithStatusJSON(403, gin.H{"detail": "需要管理员权限"})
    }
}
```

---

### 7.4 Java (Spring Boot)

#### pom.xml

```xml
<dependency>
    <groupId>io.jsonwebtoken</groupId>
    <artifactId>jjwt-api</artifactId>
    <version>0.12.6</version>
</dependency>
```

#### JwtAuthFilter.java

```java
@Component
public class JwtAuthFilter extends OncePerRequestFilter {

    @Value("${jwt.secret}")
    private String jwtSecret;

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        String token = extractToken(req);
        if (token != null) {
            try {
                Claims claims = Jwts.parser()
                    .verifyWith(jwtSecret.getBytes())
                    .build()
                    .parseSignedClaims(token)
                    .getPayload();
                req.setAttribute("user", claims);
            } catch (Exception e) {
                res.setStatus(401);
                res.getWriter().write("{\"detail\":\"令牌无效\"}");
                return;
            }
        }
        chain.doFilter(req, res);
    }

    private String extractToken(HttpServletRequest req) {
        String auth = req.getHeader("Authorization");
        if (auth != null && auth.startsWith("Bearer "))
            return auth.substring(7);
        if (req.getCookies() != null)
            for (Cookie c : req.getCookies())
                if ("jwt_token".equals(c.getName())) return c.getValue();
        return null;
    }
}
```

## 八、前端接入清单

### 8.1 必须改动的文件

| 文件 | 改动内容 |
|------|----------|
| 公共请求封装（如 common.js / api.ts） | 添加 `credentials: 'include'`；401 时跳 `/api/auth/sso-redirect` |
| 每个页面 HTML | 引入 auth-guard 脚本；添加 `#auth-bar` 容器 |
| auth-guard.js（新建） | 页面加载调 `/api/auth/me`；成功显示用户名+角色+登出；失败显示登录按钮 |

### 8.2 公共请求封装模板

```javascript
async function request(method, url, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',  // ← 关键：让浏览器自动携带 HttpOnly cookie
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);

  // 401 拦截（避免对 /api/auth/* 自身拦截导致死循环）
  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch (e) {}
    location.href = '/api/auth/sso-redirect?path=' + encodeURIComponent(location.pathname + location.search);
    throw new Error('未登录或登录已过期');
  }
  if (!res.ok) throw new Error('请求失败 (' + res.status + ')');
  return res.json();
}
```

### 8.3 auth-guard.js 模板

```javascript
async function initAuthGuard() {
  const bar = document.getElementById('auth-bar');
  try {
    const me = await fetch('/api/auth/me', { credentials: 'include' }).then(r => {
      if (!r.ok) throw new Error('401');
      return r.json();
    });
    // 已登录：显示用户名 + 角色 + 登出
    bar.innerHTML = `<span>${me.username}</span>
      <span class="badge">${(me.roles || []).join(',')}</span>
      <button onclick="doLogout()">登出</button>`;
    // 角色控制：隐藏管理入口
    if (!me.roles.includes('admin') && !me.roles.includes('gm')) {
      document.querySelectorAll('[data-requires-admin]').forEach(el => el.style.display = 'none');
    }
  } catch (e) {
    // 未登录：显示登录按钮
    bar.innerHTML = `<button onclick="goLogin()">去门户登录</button>`;
  }
}

function goLogin() {
  location.href = '/api/auth/sso-redirect?path=' + encodeURIComponent(location.pathname + location.search);
}

async function doLogout() {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  location.reload();
}

document.addEventListener('DOMContentLoaded', initAuthGuard);
```

## 九、部署配置清单

### 9.1 环境变量（必须配置）

```env
# ★ 最关键：必须与门户 .env 中的 JWT_SECRET 完全一致
JWT_SECRET=change-me-in-production-please-use-random-string

# 门户后端 API 地址（用于 code 换 token）
PORTAL_API_BASE_URL=http://192.168.40.194:6681

# 门户登录页地址
SSO_LOGIN_URL=http://192.168.40.194:6680/login

# 本应用的回调地址（浏览器实际访问的地址）
SSO_CALLBACK_URL=http://<本应用IP>:<端口>/api/auth/sso/callback
```

### 9.2 Docker Compose 追加

```yaml
services:
  your-app:
    environment:
      JWT_SECRET: ${JWT_SECRET}
      PORTAL_API_BASE_URL: http://192.168.40.194:6681
      SSO_LOGIN_URL: http://192.168.40.194:6680/login
      SSO_CALLBACK_URL: http://<本应用IP>:<端口>/api/auth/sso/callback
    extra_hosts:
      - "host.docker.internal:host-gateway"  # 如需访问宿主机服务
```

### 9.3 Nginx 反代注意事项

如果你的应用通过 Nginx 反代，确保 `/api/auth/*` 路径正确转发到后端：

```nginx
location /api/ {
    proxy_pass http://backend:端口;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

## 十、接入步骤清单

- [ ] 1. 确认 `JWT_SECRET` 与门户一致
- [ ] 2. 在门户「应用管理」注册本应用访问地址（与 SSO 回调同源），并按需绑定角色
- [ ] 3. 后端安装 JWT 验签库（PyJWT / jsonwebtoken / jjwt）
- [ ] 4. 创建 `security.py`（验签 + get_current_user 依赖）
- [ ] 5. 创建 `api/auth.py`（sso-redirect / sso-callback / me / logout 四个端点）
- [ ] 6. `main.py` 注册 auth 路由
- [ ] 7. 业务接口加 `Depends(get_current_user)` 或对应语言的鉴权中间件
- [ ] 8. 前端请求封装加 `credentials: 'include'` + 401 拦截
- [ ] 9. 前端添加 auth-guard.js + `#auth-bar` 容器
- [ ] 10. 每个页面 HTML 引入 auth-guard.js
- [ ] 11. docker-compose.yml / .env 追加 SSO 环境变量
- [ ] 12. 重建容器
- [ ] 13. 验证：未登录访问 → 跳门户登录 → 自动回跳 → 正常使用；无权限用户回跳应得到 403

## 十一、调试技巧

### 用 curl 模拟 SSO 流程

```bash
# 1. 登录获取 sso_code
curl -s -X POST "http://192.168.40.194:6681/api/auth/login?redirect=http://<本应用>/api/auth/sso/callback?path=/" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}' | jq

# 2. 用 code 换 token
curl -s -X POST "http://192.168.40.194:6681/api/auth/sso-exchange" \
  -H "Content-Type: application/json" \
  -d '{"code":"<上一步的sso_code>"}' | jq

# 3. 带 token 访问业务接口
curl -s "http://<本应用>/api/data/list" \
  -H "Authorization: Bearer <token>" | jq

# 4. 模拟 cookie 访问
curl -s "http://<本应用>/api/data/list" \
  -b "jwt_token=<token>" | jq
```

> **提示**：若第 1 步返回 **403**，说明 `redirect` 指向的应用未在门户注册 / 已停用，或当前用户无该应用权限
> （见 [4.4](#44-应用级网关校验方案a)）。检查门户「应用管理」是否存在与该回调 **同 origin** 的应用记录。

### 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| 登录后不回跳 | redirect 参数未编码 | 确保 URL 编码 |
| 回跳 403「目标应用未在门户注册或已停用」 | redirect 目标 origin 未在门户「应用管理」注册，或应用已停用 | 在门户注册本应用访问地址（与 SSO 回调同源）并启用 |
| 回跳 403「您没有访问该应用的权限」 | 应用已绑角色，但当前用户角色无交集 | 在门户为该用户分配对应角色，或调整应用角色绑定 |
| code 换 token 401 | code 过期(>60s) 或已使用 | 重新走登录流程 |
| 业务接口 401 | cookie 未携带 | 确认 `credentials: 'include'` |
| cookie 不写入 | 跨域限制 | 确保回调和页面同域；或设 `samesite=lax` |
| 验签失败 | JWT_SECRET 不一致 | 检查两端的 `.env` |
| 前端读不到 cookie | HttpOnly 限制 | 正常行为，用 `/api/auth/me` 获取用户信息 |

## 十二、安全注意事项

1. **JWT_SECRET 绝不能进 Git**：用 `.env` 文件 + `.gitignore`
2. **HttpOnly cookie**：防止 XSS 窃取 token
3. **不把 token 放 URL**：用一次性 code 交换
4. **HTTPS 生产环境**：`SSO_COOKIE_SECURE=true`，全链路 HTTPS
5. **定期更换密钥**：更换后所有应用需同步更新
6. **角色双重校验**：前端隐藏入口 + 后端接口校验，不能只靠前端
7. **应用级授权**：门户按 redirect 反查应用并校验用户可见性（方案A），未注册 / 无权限一律 403，杜绝"登录门户即可越权换取任意应用 token"
