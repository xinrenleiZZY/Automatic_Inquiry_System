"""全局配置。

所有路径都可以用环境变量覆盖，便于从「原生 Windows」迁到「容器 + 宿主机」。
"""

import os
from pathlib import Path


def _env_str(name: str, default: str | None = None) -> str | None:
    v = os.getenv(name)
    return v if v not in (None, "") else default


def _env_bool(name: str, default: bool = False) -> bool:
    v = os.getenv(name)
    if v is None or v == "":
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int) -> int:
    v = os.getenv(name)
    try:
        return int(v) if v not in (None, "") else default
    except ValueError:
        return default


# --------------------------------------------------------------------------
# 目录定位
#   backend/app/config.py
#     parents[0] = backend/app
#     parents[1] = backend
#     parents[2] = Automatic_Inquiry_System
#     parents[3] = 项目根（含 tools/qianniu）
# --------------------------------------------------------------------------
APP_DIR = Path(__file__).resolve().parent
BACKEND_DIR = APP_DIR.parent
SYSTEM_DIR = BACKEND_DIR.parent


def _load_dotenv() -> list[str]:
    """极简 .env 加载（不引入 python-dotenv 依赖）。

    查找顺序：Automatic_Inquiry_System/.env → backend/.env。
    **已存在的真实环境变量优先**，所以容器里用 docker-compose 传的 env 不会被文件覆盖。
    """
    loaded: list[str] = []
    for path in (SYSTEM_DIR / ".env", BACKEND_DIR / ".env"):
        if not path.is_file():
            continue
        try:
            raw = path.read_text(encoding="utf-8-sig")
        except OSError:
            continue
        for line in raw.splitlines():
            s = line.strip()
            if not s or s.startswith("#") or "=" not in s:
                continue
            key, _, value = s.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
        loaded.append(str(path))
    return loaded


LOADED_ENV_FILES = _load_dotenv()

PROJECT_ROOT = Path(_env_str("PROJECT_ROOT", str(SYSTEM_DIR.parent)))
QIANNIU_DIR = Path(_env_str("QIANNIU_DIR", str(PROJECT_ROOT / "tools" / "qianniu")))

# 冻结源码的数据库（只读）
IM_DB = Path(_env_str("IM_DB", str(QIANNIU_DIR / "data" / "im.db")))
# 桥接脚本（新增文件，位于 tools/api/）
BRIDGE_SCRIPT = Path(_env_str("BRIDGE_SCRIPT", str(PROJECT_ROOT / "tools" / "api" / "bridge.mjs")))
NODE_BIN = _env_str("NODE_BIN", "node") or "node"
# 图片库根目录（默认 tools/qianniu/image）
IMAGE_DIR = Path(_env_str("IMAGE_DIR", str(QIANNIU_DIR / "image")))
# 快捷短语库 JSON
PHRASE_LIB = Path(_env_str("PHRASE_LIB", str(QIANNIU_DIR / "phrase-library.json")))

# 本系统自己的库：配置 / 名单 / 任务 / 审计（与 im.db 物理隔离）
API_DB = Path(_env_str("API_DB", str(SYSTEM_DIR / "data" / "api.db")))
DATA_DIR = API_DB.parent

# 前端构建产物（由 FastAPI 同源托管，避免 CORS 与 cookie 问题）
FRONTEND_DIST = Path(_env_str("FRONTEND_DIST", str(SYSTEM_DIR / "frontend" / "dist")))

# Chrome 调试端口
CDP_BASE = _env_str("CDP_BASE", "http://127.0.0.1:6901") or "http://127.0.0.1:6901"

# --------------------------------------------------------------------------
# 1688 调试实例（Chrome）——「状态监控」页面的一键启停 / 进程探测
#   URL 端口从 CDP_BASE 解析；profile 必须与 tools/qianniu/start-im.ps1 一致，
#   否则"脚本拉起的实例"和"脚本能关掉的实例"不是同一个。
# --------------------------------------------------------------------------
CHROME_PROFILE_DIR = Path(_env_str(
    "CHROME_PROFILE_DIR",
    str(Path(os.getenv("LOCALAPPDATA") or str(Path.home())) / "1688-cdp-profile"),
))
BROWSER_CONTROL_SCRIPT = Path(_env_str(
    "BROWSER_CONTROL_SCRIPT", str(SYSTEM_DIR / "deploy" / "browser-control.ps1"),
))
# chrome.exe 路径：留空 = 自动检测（Program Files / Program Files(x86) / LOCALAPPDATA）。
# 优先级：页面里保存的设置（api.db）> 这个环境变量 > 自动检测。
CHROME_EXE = _env_str("CHROME_EXE", "") or ""
# 一键启动浏览器时打开的页面（登录入口 + 聊天页都从这里进）
BROWSER_START_URL = _env_str("BROWSER_START_URL", "https://work.1688.com/") or "https://work.1688.com/"

# 监听进程（常驻）相关
MONITOR_PID_FILE = Path(_env_str("MONITOR_PID_FILE", str(QIANNIU_DIR / "logs" / "monitor.pid")))
MONITOR_OUT_LOG = Path(_env_str("MONITOR_OUT_LOG", str(QIANNIU_DIR / "logs" / "monitor.out.log")))
MONITOR_ERR_LOG = Path(_env_str("MONITOR_ERR_LOG", str(QIANNIU_DIR / "logs" / "monitor.err.log")))
START_IM_SCRIPT = Path(_env_str("START_IM_SCRIPT", str(QIANNIU_DIR / "start-im.ps1")))
# 监听启停的实际执行者（纯 ASCII 的新脚本；START_IM_SCRIPT 是冻结源码，
# 里面有中文且无 BOM，powershell.exe 5.1 读它必崩，只留作参考/手动排障）
MONITOR_CONTROL_SCRIPT = Path(_env_str(
    "MONITOR_CONTROL_SCRIPT", str(SYSTEM_DIR / "deploy" / "monitor-control.ps1"),
))
# 监听轮询间隔（秒）与网页刷新间隔（分钟）。刷新 0 = 关闭自刷新，改由本系统队列在空闲点刷新。
MONITOR_INTERVAL_SEC = _env_int("MONITOR_INTERVAL_SEC", 15)
MONITOR_REFRESH_MIN = _env_int("MONITOR_REFRESH_MIN", 0)

# --------------------------------------------------------------------------
# 认证（JWT / 门户 SSO）
# --------------------------------------------------------------------------
JWT_SECRET = _env_str("JWT_SECRET", "change-me-in-production-please-use-random-string")
JWT_ALGORITHM = _env_str("JWT_ALGORITHM", "HS256") or "HS256"

# 门户统一对外入口：6690 是反向代理入口，6680/6681 只是容器内部端口
PORTAL_API_BASE_URL = _env_str("PORTAL_API_BASE_URL", "http://192.168.40.194:6690")
SSO_LOGIN_URL = _env_str("SSO_LOGIN_URL", "http://192.168.40.194:6690/login")
# 本应用对外访问地址（浏览器实际访问的），用于 SSO 回调
SSO_CALLBACK_URL = _env_str("SSO_CALLBACK_URL", "http://127.0.0.1:6900/api/auth/sso/callback")
SSO_TOKEN_COOKIE_NAME = _env_str("SSO_TOKEN_COOKIE_NAME", "jwt_token") or "jwt_token"
SSO_COOKIE_SECURE = _env_bool("SSO_COOKIE_SECURE", False)
SSO_COOKIE_MAX_AGE = _env_int("SSO_COOKIE_MAX_AGE", 28800)
# 门户登出地址：点"退出"时先清本应用会话，再跳这里退掉门户会话，
# 否则再进任何接入的应用都会被门户静默登回来
PORTAL_LOGOUT_URL = _env_str("PORTAL_LOGOUT_URL", "http://192.168.40.194:6690/logout")

# 独立调试登录（门户未就绪时使用；生产建议置 false）
ALLOW_DEV_LOGIN = _env_bool("ALLOW_DEV_LOGIN", True)

# 侧边栏底部的开发者入口与版权（对齐企业门户）
DEVELOPER_URL = _env_str("DEVELOPER_URL", "http://192.168.40.194:6690/developer")
DEVELOPER_NAME = _env_str("DEVELOPER_NAME", "IT · HZX-钟元")
COPYRIGHT = _env_str("COPYRIGHT", "© IT · 汇挚鑫企业应用门户")

DEV_USERS = [
    {
        "username": _env_str("DEV_ADMIN_USER", "admin"),
        "password": _env_str("DEV_ADMIN_PASSWORD", "admin123"),
        "display_name": "系统管理员",
        "roles": ["admin", "gm", "user"],
    },
    {
        "username": _env_str("DEV_GM_USER", "gm"),
        "password": _env_str("DEV_GM_PASSWORD", "gm123"),
        "display_name": "管理经理",
        "roles": ["gm", "user"],
    },
    {
        "username": _env_str("DEV_USER_USER", "user"),
        "password": _env_str("DEV_USER_PASSWORD", "user123"),
        "display_name": "普通用户",
        "roles": ["user"],
    },
]

# --------------------------------------------------------------------------
# 服务
# --------------------------------------------------------------------------
HOST = _env_str("APP_HOST", "0.0.0.0")
APP_PORT = _env_int("APP_PORT", 6900)
APP_TITLE = "自动询价系统 · Automatic Inquiry System"

# --------------------------------------------------------------------------
# Windows 宿主控制代理
#   容器里的 API 不直接控制 Windows 进程，也不直接读宿主 im.db：
#     HOST_AGENT_URL  为空 = 原生模式（当前行为不变）
#     容器中指向 http://host.docker.internal:7400
#   代理进程会用 HOST_AGENT_SERVER_MODE=true 启动，避免远程调用自身。
# --------------------------------------------------------------------------
HOST_AGENT_SERVER_MODE = _env_bool("HOST_AGENT_SERVER_MODE", False)
HOST_AGENT_BIND = _env_str("HOST_AGENT_BIND", "0.0.0.0") or "0.0.0.0"
HOST_AGENT_PORT = _env_int("HOST_AGENT_PORT", 7400)
HOST_AGENT_URL = (_env_str("HOST_AGENT_URL", "") or "").rstrip("/")
HOST_AGENT_TOKEN = _env_str("HOST_AGENT_TOKEN", "") or ""
HOST_AGENT_REMOTE = bool(HOST_AGENT_URL) and not HOST_AGENT_SERVER_MODE
HOST_AGENT_STATUS_INTERVAL_SEC = max(1, _env_int("HOST_AGENT_STATUS_INTERVAL_SEC", 2))
HOST_AGENT_SNAPSHOT_INTERVAL_SEC = max(1, _env_int("HOST_AGENT_SNAPSHOT_INTERVAL_SEC", 2))
HOST_AGENT_TIMEOUT = _env_int("HOST_AGENT_TIMEOUT", 30)

# 发送模式：send=真实发送 / draft=只填草稿 / dry=只解析不发
SEND_MODE = _env_str("SEND_MODE", "send")
# 真实发送的额外保险：请求体必须带 confirm=true 才会真的发出去
REQUIRE_SEND_CONFIRM = _env_bool("REQUIRE_SEND_CONFIRM", True)

# 桥接单次调用默认超时（秒）
BRIDGE_TIMEOUT = _env_int("BRIDGE_TIMEOUT", 600)
# 队列是否随服务自动启动
QUEUE_AUTOSTART = _env_bool("QUEUE_AUTOSTART", True)
# 新消息事件泵：monitor 落到 events 表的 inbound 事件，自动触发单会话采集。
# 收到即入队，由串行队列保证浏览器操作不并发；全自动长作业会自行消费事件。
EVENT_PUMP_ENABLED = _env_bool("EVENT_PUMP_ENABLED", True)
EVENT_PUMP_INTERVAL_SEC = _env_int("EVENT_PUMP_INTERVAL_SEC", 2)
EVENT_PUMP_MAX_AGE_SEC = _env_int("EVENT_PUMP_MAX_AGE_SEC", 1800)

# --------------------------------------------------------------------------
# 飞书（比价表推送：一段总结 + 比价表文件）
#   约定与 feishu_api_tools 一致：应用机器人（FEISHU_APP_ID/SECRET + FEISHU_CHAT_ID），
#   没配应用机器人时退回自定义机器人 Webhook（只能发文本，发不了文件）。
# --------------------------------------------------------------------------
FEISHU_APP_ID = _env_str("FEISHU_APP_ID", "")
FEISHU_APP_SECRET = _env_str("FEISHU_APP_SECRET", "")
FEISHU_CHAT_ID = _env_str("FEISHU_CHAT_ID", "")                    # 默认接收群
FEISHU_GROUP_WHITELIST = _env_str("FEISHU_GROUP_WHITELIST", "")    # 逗号分隔，可多个群
FEISHU_WEBHOOK_URL = _env_str("FEISHU_WEBHOOK_URL", "")
FEISHU_RECEIVE_ID_TYPE = _env_str("FEISHU_RECEIVE_ID_TYPE", "chat_id") or "chat_id"
# 作业失败告警：独立开关 + 独立目标群（留空 = 跟比价表推送用同一个群）
FEISHU_ALERT_ENABLED = _env_bool("FEISHU_ALERT_ENABLED", True)
FEISHU_ALERT_CHAT_ID = _env_str("FEISHU_ALERT_CHAT_ID", "") or FEISHU_CHAT_ID


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "logs").mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "exports").mkdir(parents=True, exist_ok=True)


def summary() -> dict:
    """给 /api/system/config 用的配置快照（不含任何密钥）。"""
    return {
        "env_files": LOADED_ENV_FILES,
        "project_root": str(PROJECT_ROOT),
        "qianniu_dir": str(QIANNIU_DIR),
        "im_db": str(IM_DB),
        "im_db_exists": IM_DB.exists(),
        "api_db": str(API_DB),
        "bridge_script": str(BRIDGE_SCRIPT),
        "bridge_script_exists": BRIDGE_SCRIPT.exists(),
        "node_bin": NODE_BIN,
        "image_dir": str(IMAGE_DIR),
        "phrase_lib": str(PHRASE_LIB),
        "cdp_base": CDP_BASE,
        "chrome_profile_dir": str(CHROME_PROFILE_DIR),
        "browser_control_script": str(BROWSER_CONTROL_SCRIPT),
        "browser_start_url": BROWSER_START_URL,
        "browser_control_ready": BROWSER_CONTROL_SCRIPT.exists(),
        "chrome_exe_env": CHROME_EXE or "（未设置，自动检测）",
        "frontend_dist": str(FRONTEND_DIST),
        "frontend_dist_exists": FRONTEND_DIST.exists(),
        "send_mode": SEND_MODE,
        "require_send_confirm": REQUIRE_SEND_CONFIRM,
        "monitor_interval_sec": MONITOR_INTERVAL_SEC,
        "monitor_refresh_min": MONITOR_REFRESH_MIN,
        "portal_api_base_url": PORTAL_API_BASE_URL,
        "sso_login_url": SSO_LOGIN_URL,
        "sso_callback_url": SSO_CALLBACK_URL,
        "allow_dev_login": ALLOW_DEV_LOGIN,
        "queue_autostart": QUEUE_AUTOSTART,
        "bridge_timeout": BRIDGE_TIMEOUT,
        "app_port": APP_PORT,
        "host_agent_mode": (
            "server" if HOST_AGENT_SERVER_MODE else
            "remote" if HOST_AGENT_REMOTE else
            "native"
        ),
        "host_agent_url": HOST_AGENT_URL,
        "host_agent_token_configured": bool(HOST_AGENT_TOKEN),
        "feishu_enabled": bool(FEISHU_APP_ID and FEISHU_APP_SECRET) or bool(FEISHU_WEBHOOK_URL),
        "feishu_app_configured": bool(FEISHU_APP_ID and FEISHU_APP_SECRET),
        "feishu_chat_configured": bool(FEISHU_CHAT_ID or FEISHU_GROUP_WHITELIST),
        "feishu_alert_enabled": FEISHU_ALERT_ENABLED,
        "feishu_alert_chat_id": FEISHU_ALERT_CHAT_ID,
    }
