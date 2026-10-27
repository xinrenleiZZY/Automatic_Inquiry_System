"""本系统自己的库（api.db）。

与 im.db 物理隔离：im.db 是 Node 侧的事实库（本系统只读），
配置 / 名单 / 任务 / 审计 全部落在这里，互不干扰。
"""

import json
import sqlite3
import threading
import time
import uuid
from typing import Any, Iterable

from . import config

_LOCK = threading.RLock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  INTEGER
);

CREATE TABLE IF NOT EXISTS customer_flags (
    conv_key    TEXT NOT NULL,
    campaign_id INTEGER NOT NULL DEFAULT 0,   -- 0 = 全部（对所有任务生效）；>0 = 只对该任务生效
    conv_name   TEXT,
    list_type   TEXT NOT NULL,                -- whitelist / blacklist / dropped
    note        TEXT,
    updated_at  INTEGER,
    PRIMARY KEY (conv_key, campaign_id)
);

CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,
    payload     TEXT,
    status      TEXT NOT NULL,          -- queued / running / done / failed / canceled
    progress    TEXT,
    result      TEXT,
    error       TEXT,
    created_by  TEXT,
    priority    INTEGER DEFAULT 10,
    created_at  INTEGER,
    started_at  INTEGER,
    finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);

/* 全自动流程：父流程 + 小步骤。每一步都是一个短作业，事件任务可以插队。 */
CREATE TABLE IF NOT EXISTS flow_runs (
    id          TEXT PRIMARY KEY,
    campaign_id INTEGER NOT NULL,
    status      TEXT NOT NULL,          -- running / done / failed / canceled
    payload     TEXT,
    created_at  INTEGER,
    updated_at  INTEGER
);

CREATE TABLE IF NOT EXISTS flow_steps (
    id          TEXT PRIMARY KEY,
    flow_id     TEXT NOT NULL,
    campaign_id INTEGER NOT NULL,
    step_no     INTEGER NOT NULL,
    kind        TEXT NOT NULL,
    payload     TEXT,
    status      TEXT NOT NULL,          -- pending / queued / running / done / failed / canceled
    run_after   INTEGER DEFAULT 0,
    attempts    INTEGER DEFAULT 0,
    error       TEXT,
    created_at  INTEGER,
    updated_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_flow_steps_due ON flow_steps(status, run_after);
CREATE INDEX IF NOT EXISTS idx_flow_steps_flow ON flow_steps(flow_id, step_no);

CREATE TABLE IF NOT EXISTS audit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          INTEGER,
    username    TEXT,
    action      TEXT,
    params      TEXT,
    result      TEXT,
    ip          TEXT
);

CREATE TABLE IF NOT EXISTS logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          INTEGER,
    level       TEXT,
    source      TEXT,
    message     TEXT
);

/* 单个比价任务的业务参数覆盖值。
   只存"用户在新建任务时显式填了"的字段，没填的不存 —— 这样全局默认值改了会自然生效。 */
CREATE TABLE IF NOT EXISTS campaign_params (
    campaign_id INTEGER PRIMARY KEY,
    params      TEXT,
    updated_at  INTEGER
);

/* 可复用的比价业务参数方案。任务创建时可一键套用，最多 100 套。 */
CREATE TABLE IF NOT EXISTS pricing_templates (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    name                 TEXT NOT NULL COLLATE NOCASE,
    description          TEXT DEFAULT '',
    send_mode            TEXT NOT NULL,
    inquiry_count        INTEGER NOT NULL,
    slice_per_round      INTEGER NOT NULL,
    expected_price       REAL,
    expected_price_note  TEXT DEFAULT '',
    max_followups        INTEGER NOT NULL DEFAULT 2,
    duration_sec         INTEGER NOT NULL DEFAULT 0,
    reply_timeout_sec    INTEGER NOT NULL DEFAULT 60,
    created_by           TEXT DEFAULT '',
    created_at           INTEGER,
    updated_at           INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_templates_name
    ON pricing_templates(name COLLATE NOCASE);
"""

MAX_PRICING_TEMPLATES = 100

# 允许按任务覆盖的业务参数（键与全局 settings 同名）
#   最多询价客户数量是"跨任务的安全上限"，故意不开放按任务覆盖，避免语义重叠
CAMPAIGN_PARAM_RULES: dict[str, tuple[str, Any, Any]] = {
    "send_mode": ("enum", ("send", "draft", "dry"), None),
    "inquiry_count": ("int", 0, 500),
    "slice_per_round": ("int", 1, 50),
    "expected_price": ("float", 0.0, None),
    "expected_price_note": ("str", None, None),
    "max_followups": ("int", 0, 2),
    "duration_sec": ("int", 0, 86400),
    "reply_timeout_sec": ("int", 1, 86400),
}

CAMPAIGN_PARAM_LABELS: dict[str, str] = {
    "send_mode": "发送模式",
    "inquiry_count": "询价客户数量",
    "slice_per_round": "同时处理会话数（队列轮转粒度）",
    "expected_price": "预期单价上限",
    "expected_price_note": "预期价格说明",
    "max_followups": "超时后最多主动追问",
    "duration_sec": "任务最长运行时长",
    "reply_timeout_sec": "每客户超时判定",
}


def validate_campaign_params(raw: dict[str, Any]) -> dict[str, Any]:
    """校验并规范化任务级参数覆盖值；非法直接抛 ValueError。"""
    if not isinstance(raw, dict):
        raise ValueError("params 必须是对象")
    out: dict[str, Any] = {}
    for key, value in raw.items():
        if key not in CAMPAIGN_PARAM_RULES:
            raise ValueError(f"不支持的参数：{key}（可用：{'、'.join(CAMPAIGN_PARAM_RULES)}）")
        if value is None or value == "":
            continue  # 留空 = 不覆盖
        kind, low, high = CAMPAIGN_PARAM_RULES[key]
        if kind == "enum":
            if value not in low:
                raise ValueError(f"{CAMPAIGN_PARAM_LABELS[key]} 只能是 {'/'.join(low)}")
            out[key] = value
        elif kind == "int":
            try:
                n = int(value)
            except (TypeError, ValueError):
                raise ValueError(f"{CAMPAIGN_PARAM_LABELS[key]} 必须是整数")
            if low is not None and n < low:
                raise ValueError(f"{CAMPAIGN_PARAM_LABELS[key]} 不能小于 {low}")
            if high is not None and n > high:
                raise ValueError(f"{CAMPAIGN_PARAM_LABELS[key]} 不能大于 {high}")
            out[key] = n
        elif kind == "float":
            try:
                f = float(value)
            except (TypeError, ValueError):
                raise ValueError(f"{CAMPAIGN_PARAM_LABELS[key]} 必须是数字")
            if low is not None and f < low:
                raise ValueError(f"{CAMPAIGN_PARAM_LABELS[key]} 不能小于 {low}")
            out[key] = f
        else:
            out[key] = str(value)
    return out

DEFAULT_SETTINGS: dict[str, Any] = {
    # 业务参数
    "send_mode": "send",                 # send / draft / dry
    "inquiry_count": 10,                 # 每个任务联系几家商家
    "max_inquiry_count": 100,            # 全局最多联系商家数（所有任务合计）
    "expected_price": None,              # 预期价格（达标判定用，null = 不判定）
    "expected_price_note": "",           # 预期价格说明（给业务人员看的备注）
    "slice_per_round": 2,                # 每个队列轮转步同时纳入几个会话（客户）
    # 护栏
    "min_interval_ms": 20000,            # 同一客户两条消息最小间隔
    "max_per_hour": 30,                  # 全局每小时最多发几条
    "quiet_hours_start": None,           # 免打扰开始小时（0-23，null = 不启用）
    "quiet_hours_end": None,             # 免打扰结束小时
    # 运行
    "auto_refresh_min": 30,              # 聊天页刷新间隔（分钟，0 = 不刷新）
    "scheduler_round_sec": 180,          # 队列轮转间隔（秒）
    "chrome_exe": "",                    # 调试实例用的 chrome.exe 路径（"" = 自动检测）
    # 1688 登录（「状态监控」页自动登录用；短信验证码仍需人工）
    "login_account": "",                 # 1688 账号（旺旺号 / 子账号）
    "login_password": "",                # 登录密码（★ 敏感：对外返回一律过滤，见 SECRET_SETTINGS）
}

# 绝不外发的配置项：/api/settings 与 /api/system/config 都要过滤掉，
# 否则任何登录用户（甚至前端表单回传）都能拿到明文密码。
SECRET_SETTINGS = {"login_password"}


def _connect() -> sqlite3.Connection:
    config.ensure_dirs()
    conn = sqlite3.connect(str(config.API_DB), timeout=15, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=15000")
    return conn


def init_db() -> None:
    with _LOCK, _connect() as conn:
        conn.executescript(SCHEMA)
        _migrate_flags(conn)
        _migrate_jobs(conn)
        _migrate_pricing_templates(conn)
        now = int(time.time() * 1000)
        for k, v in DEFAULT_SETTINGS.items():
            row = conn.execute("SELECT key FROM settings WHERE key = ?", (k,)).fetchone()
            if row is None:
                conn.execute(
                    "INSERT INTO settings(key, value, updated_at) VALUES (?,?,?)",
                    (k, json.dumps(v, ensure_ascii=False), now),
                )


def _migrate_flags(conn: sqlite3.Connection) -> None:
    """老库的 customer_flags 只有 conv_key 一个主键（名单没有任务维度）。

    这里原地升级成 (conv_key, campaign_id)：老数据全部落到 campaign_id=0（= 对全部任务生效），
    语义和升级前一致，不会改变现有行为。
    """
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(customer_flags)").fetchall()}
    if "campaign_id" in cols:
        return
    conn.executescript("""
        ALTER TABLE customer_flags RENAME TO customer_flags_old;
        CREATE TABLE customer_flags (
            conv_key    TEXT NOT NULL,
            campaign_id INTEGER NOT NULL DEFAULT 0,
            conv_name   TEXT,
            list_type   TEXT NOT NULL,
            note        TEXT,
            updated_at  INTEGER,
            PRIMARY KEY (conv_key, campaign_id)
        );
        INSERT INTO customer_flags (conv_key, campaign_id, conv_name, list_type, note, updated_at)
            SELECT conv_key, 0, conv_name, list_type, note, updated_at FROM customer_flags_old;
        DROP TABLE customer_flags_old;
    """)


def _migrate_jobs(conn: sqlite3.Connection) -> None:
    """老库补 jobs.priority；0=新消息，10=人工，20=全自动步骤。"""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(jobs)").fetchall()}
    if "priority" not in cols:
        conn.execute("ALTER TABLE jobs ADD COLUMN priority INTEGER DEFAULT 10")


def _migrate_pricing_templates(conn: sqlite3.Connection) -> None:
    """老库补运行节奏字段；不改已有模板业务值。"""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(pricing_templates)").fetchall()}
    additions = {
        "max_followups": "INTEGER NOT NULL DEFAULT 2",
        "duration_sec": "INTEGER NOT NULL DEFAULT 0",
        "reply_timeout_sec": "INTEGER NOT NULL DEFAULT 60",
    }
    for name, definition in additions.items():
        if name not in cols:
            conn.execute(f"ALTER TABLE pricing_templates ADD COLUMN {name} {definition}")


# --------------------------------------------------------------------------
# 配置
# --------------------------------------------------------------------------
def get_settings() -> dict[str, Any]:
    with _LOCK, _connect() as conn:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
    out = dict(DEFAULT_SETTINGS)
    for r in rows:
        try:
            out[r["key"]] = json.loads(r["value"])
        except (TypeError, json.JSONDecodeError):
            out[r["key"]] = r["value"]
    return out


def get_setting(key: str, default: Any = None) -> Any:
    return get_settings().get(key, default)


def public_settings() -> dict[str, Any]:
    """给接口/前端看的配置：剔掉 SECRET_SETTINGS 里的敏感项。"""
    return {k: v for k, v in get_settings().items() if k not in SECRET_SETTINGS}


def update_settings(patch: dict[str, Any]) -> dict[str, Any]:
    now = int(time.time() * 1000)
    unknown = [k for k in patch if k not in DEFAULT_SETTINGS]
    if unknown:
        raise ValueError("未知配置项：" + ", ".join(unknown))
    with _LOCK, _connect() as conn:
        for k, v in patch.items():
            conn.execute(
                "INSERT INTO settings(key, value, updated_at) VALUES (?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                (k, json.dumps(v, ensure_ascii=False), now),
            )
    return get_settings()


# --------------------------------------------------------------------------
# 比价配置方案
# --------------------------------------------------------------------------
def _pricing_template_row(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row else None


def list_pricing_templates() -> list[dict[str, Any]]:
    with _LOCK, _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM pricing_templates ORDER BY updated_at DESC, id DESC"
        ).fetchall()
    return [dict(row) for row in rows]


def get_pricing_template(template_id: int) -> dict[str, Any] | None:
    with _LOCK, _connect() as conn:
        row = conn.execute(
            "SELECT * FROM pricing_templates WHERE id = ?", (int(template_id),)
        ).fetchone()
    return _pricing_template_row(row)


def create_pricing_template(data: dict[str, Any], created_by: str = "") -> dict[str, Any]:
    now = int(time.time() * 1000)
    clean = validate_campaign_params({
        key: data.get(key) for key in CAMPAIGN_PARAM_RULES if key in data
    })
    required = (
        "send_mode", "inquiry_count", "slice_per_round",
        "max_followups", "duration_sec", "reply_timeout_sec",
    )
    missing = [CAMPAIGN_PARAM_LABELS[key] for key in required if key not in clean]
    if missing:
        raise ValueError("缺少必填参数：" + "、".join(missing))
    with _LOCK, _connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        total = int(conn.execute("SELECT COUNT(*) FROM pricing_templates").fetchone()[0])
        if total >= MAX_PRICING_TEMPLATES:
            raise ValueError(f"最多只能保存 {MAX_PRICING_TEMPLATES} 套比价配置方案")
        try:
            conn.execute(
                """
                INSERT INTO pricing_templates(
                    name, description, send_mode, inquiry_count, slice_per_round,
                    expected_price, expected_price_note, max_followups, duration_sec,
                    reply_timeout_sec, created_by, created_at, updated_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    data["name"], data.get("description") or "",
                    clean["send_mode"], clean["inquiry_count"], clean["slice_per_round"],
                    clean.get("expected_price"), clean.get("expected_price_note") or "",
                    clean["max_followups"], clean["duration_sec"], clean["reply_timeout_sec"],
                    created_by, now, now,
                ),
            )
        except sqlite3.IntegrityError as exc:
            raise ValueError("方案名称已存在") from exc
        template_id = int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])
    return get_pricing_template(template_id)  # type: ignore[return-value]


def update_pricing_template(template_id: int, data: dict[str, Any]) -> dict[str, Any]:
    current = get_pricing_template(template_id)
    if not current:
        raise LookupError("配置方案不存在")
    clean = validate_campaign_params({
        key: data.get(key) for key in CAMPAIGN_PARAM_RULES if key in data
    })
    required = (
        "send_mode", "inquiry_count", "slice_per_round",
        "max_followups", "duration_sec", "reply_timeout_sec",
    )
    missing = [CAMPAIGN_PARAM_LABELS[key] for key in required if key not in clean]
    if missing:
        raise ValueError("缺少必填参数：" + "、".join(missing))
    now = int(time.time() * 1000)
    with _LOCK, _connect() as conn:
        try:
            conn.execute(
                """
                UPDATE pricing_templates SET
                    name=?, description=?, send_mode=?, inquiry_count=?,
                    slice_per_round=?, expected_price=?, expected_price_note=?,
                    max_followups=?, duration_sec=?, reply_timeout_sec=?, updated_at=?
                WHERE id=?
                """,
                (
                    data["name"], data.get("description") or "",
                    clean["send_mode"], clean["inquiry_count"], clean["slice_per_round"],
                    clean.get("expected_price"), clean.get("expected_price_note") or "",
                    clean["max_followups"], clean["duration_sec"], clean["reply_timeout_sec"],
                    now, int(template_id),
                ),
            )
        except sqlite3.IntegrityError as exc:
            raise ValueError("方案名称已存在") from exc
    return get_pricing_template(template_id)  # type: ignore[return-value]


def delete_pricing_template(template_id: int) -> bool:
    with _LOCK, _connect() as conn:
        cur = conn.execute(
            "DELETE FROM pricing_templates WHERE id = ?", (int(template_id),)
        )
        return cur.rowcount > 0


def get_guards() -> dict[str, Any]:
    """把配置翻译成 runAutoReply / guardCheck 认识的形式。"""
    s = get_settings()
    start, end = s.get("quiet_hours_start"), s.get("quiet_hours_end")
    quiet = [int(start), int(end)] if start is not None and end is not None else None
    return {
        "minIntervalMs": int(s.get("min_interval_ms") or 0),
        "maxPerHour": int(s.get("max_per_hour") or 30),
        "quietHours": quiet,
    }


# --------------------------------------------------------------------------
# 客户名单 / 终止追踪
# --------------------------------------------------------------------------
def list_flags(list_type: str | None = None, campaign_id: int | None = None) -> list[dict]:
    """名单列表。

    campaign_id=None  → 全部（含各任务维度的行，给客户管理页"全部"视图用）
    campaign_id=0     → 只有全局（所有任务）名单
    campaign_id=N     → 全局名单 + 该任务专属名单（任务维度覆盖全局，见 flags_map）
    """
    sql = "SELECT * FROM customer_flags"
    args: list[Any] = []
    where: list[str] = []
    if list_type:
        where.append("list_type = ?")
        args.append(list_type)
    if campaign_id is not None:
        where.append("(campaign_id = 0 OR campaign_id = ?)")
        args.append(int(campaign_id))
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY campaign_id, updated_at DESC"
    with _LOCK, _connect() as conn:
        return [dict(r) for r in conn.execute(sql, args).fetchall()]


def set_flag(conv_key: str, list_type: str, conv_name: str = "", note: str = "",
             campaign_id: int = 0) -> dict:
    """写名单。campaign_id=0 表示"全部（所有任务）"，>0 表示只针对该任务。"""
    if list_type not in ("whitelist", "blacklist", "dropped"):
        raise ValueError("list_type 只能是 whitelist / blacklist / dropped")
    camp = int(campaign_id or 0)
    now = int(time.time() * 1000)
    with _LOCK, _connect() as conn:
        conn.execute(
            "INSERT INTO customer_flags(conv_key, campaign_id, conv_name, list_type, note, updated_at) "
            "VALUES (?,?,?,?,?,?) "
            "ON CONFLICT(conv_key, campaign_id) DO UPDATE SET conv_name=excluded.conv_name, "
            "list_type=excluded.list_type, note=excluded.note, updated_at=excluded.updated_at",
            (conv_key, camp, conv_name, list_type, note, now),
        )
        row = conn.execute(
            "SELECT * FROM customer_flags WHERE conv_key = ? AND campaign_id = ?",
            (conv_key, camp),
        ).fetchone()
    return dict(row)


def delete_flag(conv_key: str, campaign_id: int = 0) -> bool:
    with _LOCK, _connect() as conn:
        cur = conn.execute(
            "DELETE FROM customer_flags WHERE conv_key = ? AND campaign_id = ?",
            (conv_key, int(campaign_id or 0)),
        )
        return cur.rowcount > 0


def flags_map(campaign_id: int | None = 0) -> dict[str, dict]:
    """按会话取"生效的"名单标记。

    campaign_id 给具体任务时：该任务的专属名单覆盖全局名单（任务能"翻案"全局）；
    None / 0 表示"只看全局"，保持老行为。
    """
    rows = list_flags(campaign_id=int(campaign_id or 0))
    out: dict[str, dict] = {}
    for f in rows:
        prev = out.get(f["conv_key"])
        # 任务专属（campaign_id>0）优先；同维度按更新时间取最新
        if prev is None or int(f["campaign_id"]) > int(prev["campaign_id"]):
            out[f["conv_key"]] = f
    return out


def allowed_conv_keys(all_keys: Iterable[str], campaign_id: int | None = 0) -> list[str]:
    """按白名单/黑名单/放弃名单过滤出「允许继续追踪」的会话（支持任务维度）。"""
    flags = flags_map(campaign_id)
    white = {k for k, v in flags.items() if v["list_type"] == "whitelist"}
    blocked = {k for k, v in flags.items() if v["list_type"] in ("blacklist", "dropped")}
    out = []
    for k in all_keys:
        if k in blocked:
            continue
        if white and k not in white:
            continue
        out.append(k)
    return out


# --------------------------------------------------------------------------
# 任务（作业）
# --------------------------------------------------------------------------
def create_job(job_type: str, payload: dict | None = None, created_by: str = "",
               priority: int = 10) -> dict:
    job_id = "j_" + uuid.uuid4().hex[:12]
    now = int(time.time() * 1000)
    with _LOCK, _connect() as conn:
        conn.execute(
            "INSERT INTO jobs(id, type, payload, status, progress, created_by, priority, created_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (job_id, job_type, json.dumps(payload or {}, ensure_ascii=False), "queued",
             json.dumps({"step": 0, "text": "已入队"}, ensure_ascii=False), created_by,
             int(priority), now),
        )
    return get_job(job_id)  # type: ignore[return-value]


def update_job(job_id: str, **fields: Any) -> None:
    if not fields:
        return
    cols, vals = [], []
    for k, v in fields.items():
        cols.append(f"{k} = ?")
        vals.append(json.dumps(v, ensure_ascii=False) if k in ("payload", "progress", "result") else v)
    vals.append(job_id)
    with _LOCK, _connect() as conn:
        conn.execute(f"UPDATE jobs SET {', '.join(cols)} WHERE id = ?", vals)


def _job_row(row: sqlite3.Row) -> dict:
    d = dict(row)
    for k in ("payload", "progress", "result"):
        if d.get(k):
            try:
                d[k] = json.loads(d[k])
            except (AttributeError, TypeError, json.JSONDecodeError):
                pass
    return d


def get_job(job_id: str) -> dict | None:
    with _LOCK, _connect() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    return _job_row(row) if row else None


def list_jobs(limit: int = 50, status: str | None = None) -> list[dict]:
    sql = "SELECT * FROM jobs"
    args: list[Any] = []
    if status:
        sql += " WHERE status = ?"
        args.append(status)
    sql += " ORDER BY created_at DESC LIMIT ?"
    args.append(int(limit))
    with _LOCK, _connect() as conn:
        return [_job_row(r) for r in conn.execute(sql, args).fetchall()]


def count_jobs(status: str | None = None) -> int:
    with _LOCK, _connect() as conn:
        if status:
            return conn.execute("SELECT COUNT(*) c FROM jobs WHERE status = ?", (status,)).fetchone()["c"]
        return conn.execute("SELECT COUNT(*) c FROM jobs").fetchone()["c"]


def has_running_job(job_type: str) -> bool:
    with _LOCK, _connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM jobs WHERE type = ? AND status IN ('queued','running') LIMIT 1", (job_type,)
        ).fetchone()
    return row is not None


def _flow_row(row: sqlite3.Row) -> dict:
    d = dict(row)
    for k in ("payload",):
        if d.get(k):
            try:
                d[k] = json.loads(d[k])
            except (TypeError, json.JSONDecodeError):
                pass
    return d


def create_flow_run(campaign_id: int, payload: dict | None = None) -> dict:
    flow_id = "fl_" + uuid.uuid4().hex[:12]
    now = int(time.time() * 1000)
    with _LOCK, _connect() as conn:
        conn.execute(
            "INSERT INTO flow_runs(id,campaign_id,status,payload,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?)",
            (flow_id, int(campaign_id), "running",
             json.dumps(payload or {}, ensure_ascii=False), now, now),
        )
    return get_flow_run(flow_id)  # type: ignore[return-value]


def get_flow_run(flow_id: str) -> dict | None:
    with _LOCK, _connect() as conn:
        row = conn.execute("SELECT * FROM flow_runs WHERE id=?", (flow_id,)).fetchone()
    return _flow_row(row) if row else None


def update_flow_run(flow_id: str, **fields: Any) -> None:
    if not fields:
        return
    fields.setdefault("updated_at", int(time.time() * 1000))
    cols, vals = [], []
    for k, v in fields.items():
        cols.append(f"{k}=?")
        vals.append(json.dumps(v, ensure_ascii=False) if k == "payload" else v)
    vals.append(flow_id)
    with _LOCK, _connect() as conn:
        conn.execute(f"UPDATE flow_runs SET {', '.join(cols)} WHERE id=?", vals)


def create_flow_step(flow_id: str, campaign_id: int, step_no: int, kind: str,
                     payload: dict | None = None, run_after: int = 0) -> dict:
    step_id = "fs_" + uuid.uuid4().hex[:12]
    now = int(time.time() * 1000)
    with _LOCK, _connect() as conn:
        conn.execute(
            "INSERT INTO flow_steps(id,flow_id,campaign_id,step_no,kind,payload,status,run_after,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (step_id, flow_id, int(campaign_id), int(step_no), kind,
             json.dumps(payload or {}, ensure_ascii=False),
             "pending", int(run_after or 0), now, now),
        )
    return get_flow_step(step_id)  # type: ignore[return-value]


def get_flow_step(step_id: str) -> dict | None:
    with _LOCK, _connect() as conn:
        row = conn.execute("SELECT * FROM flow_steps WHERE id=?", (step_id,)).fetchone()
    return _flow_row(row) if row else None


def due_flow_steps(now: int | None = None, limit: int = 10) -> list[dict]:
    now = int(now if now is not None else time.time() * 1000)
    with _LOCK, _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM flow_steps WHERE status='pending' AND run_after<=? "
            "ORDER BY run_after ASC, created_at ASC LIMIT ?",
            (now, int(limit)),
        ).fetchall()
    return [_flow_row(r) for r in rows]


def claim_flow_step(step_id: str) -> bool:
    now = int(time.time() * 1000)
    with _LOCK, _connect() as conn:
        info = conn.execute(
            "UPDATE flow_steps SET status='queued', attempts=attempts+1, updated_at=? "
            "WHERE id=? AND status='pending'",
            (now, step_id),
        )
    return info.rowcount > 0


def update_flow_step(step_id: str, **fields: Any) -> None:
    if not fields:
        return
    fields.setdefault("updated_at", int(time.time() * 1000))
    cols, vals = [], []
    for k, v in fields.items():
        cols.append(f"{k}=?")
        vals.append(json.dumps(v, ensure_ascii=False) if k == "payload" else v)
    vals.append(step_id)
    with _LOCK, _connect() as conn:
        conn.execute(f"UPDATE flow_steps SET {', '.join(cols)} WHERE id=?", vals)


def terminate_flow_run(flow_id: str, reason: str = "用户终止任务") -> dict:
    """终止一次流程，并把尚未结束的步骤统一收口。

    只把 flow_run 改成 canceled 还不够：调度器是按 flow_steps.status 取任务的，
    待执行/已入队步骤如果不一起取消，后续仍可能继续被投递执行。
    """
    now = int(time.time() * 1000)
    with _LOCK, _connect() as conn:
        info = conn.execute(
            "UPDATE flow_steps SET status='canceled', "
            "error=CASE WHEN COALESCE(error,'')='' THEN ? ELSE error END, updated_at=? "
            "WHERE flow_id=? AND status IN ('pending','queued','running')",
            (str(reason), now, flow_id),
        )
        conn.execute(
            "UPDATE flow_runs SET status='canceled', updated_at=? "
            "WHERE id=? AND status NOT IN ('done','failed','canceled')",
            (now, flow_id),
        )
    return {"flow_id": flow_id, "canceled_steps": int(info.rowcount)}


def list_flow_runs(campaign_id: int | None = None, limit: int = 50) -> list[dict]:
    sql = """
        SELECT r.*,
               (SELECT COUNT(*) FROM flow_steps s WHERE s.flow_id=r.id) AS total_steps,
               (SELECT COUNT(*) FROM flow_steps s WHERE s.flow_id=r.id AND s.status='done') AS done_steps,
               (SELECT COUNT(*) FROM flow_steps s WHERE s.flow_id=r.id AND s.status='failed') AS failed_steps,
               (SELECT kind FROM flow_steps s WHERE s.flow_id=r.id
                 AND s.status IN ('pending','queued','running')
                ORDER BY s.step_no ASC LIMIT 1) AS current_kind,
               (SELECT step_no FROM flow_steps s WHERE s.flow_id=r.id
                 AND s.status IN ('pending','queued','running')
                ORDER BY s.step_no ASC LIMIT 1) AS current_step_no
          FROM flow_runs r
    """
    args: list[Any] = []
    if campaign_id is not None:
        sql += " WHERE r.campaign_id=?"
        args.append(int(campaign_id))
    sql += " ORDER BY r.created_at DESC LIMIT ?"
    args.append(int(limit))
    with _LOCK, _connect() as conn:
        return [_flow_row(r) for r in conn.execute(sql, args).fetchall()]


def list_flow_steps(flow_id: str) -> list[dict]:
    with _LOCK, _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM flow_steps WHERE flow_id=? ORDER BY step_no ASC, created_at ASC",
            (flow_id,),
        ).fetchall()
    return [_flow_row(r) for r in rows]


def jobs_for_step_ids(step_ids: list[str]) -> dict[str, list[dict]]:
    wanted = {str(x) for x in (step_ids or []) if x}
    if not wanted:
        return {}
    out: dict[str, list[dict]] = {}
    for job in list_jobs(limit=1000):
        payload = job.get("payload") or {}
        sid = str((payload or {}).get("step_id") or "")
        if sid in wanted:
            out.setdefault(sid, []).append(job)
    for rows in out.values():
        rows.sort(key=lambda j: int(j.get("created_at") or 0))
    return out


def reset_stale_flow_steps(older_than_ms: int = 120000) -> int:
    cutoff = int(time.time() * 1000) - int(older_than_ms)
    with _LOCK, _connect() as conn:
        info = conn.execute(
            "UPDATE flow_steps SET status='pending', updated_at=? "
            "WHERE status IN ('queued','running') AND updated_at<?",
            (int(time.time() * 1000), cutoff),
        )
    return info.rowcount


def mark_stale_jobs() -> int:
    """服务重启后，把上次遗留的 running 作业标记为失败，避免前端一直转圈。

    错误信息里带上最后一条进度：重启原因可能各不相同（更新代码 / 机器重启），
    只写“作业中断”会让排查无从下手。全自动作业可据此用
    POST /api/jobs/{id}/resume 从中断的轮次继续。
    """
    now = int(time.time() * 1000)
    with _LOCK, _connect() as conn:
        rows = conn.execute(
            "SELECT id, progress FROM jobs WHERE status = 'running'"
        ).fetchall()
        for row in rows:
            last = ""
            try:
                prog = json.loads(row["progress"] or "{}")
                last = str(prog.get("text") or "").strip()
            except (TypeError, json.JSONDecodeError):
                pass
            error = "服务重启，作业中断"
            if last:
                error += f"（最后进度：{last[:120]}）"
            conn.execute(
                "UPDATE jobs SET status='failed', error=?, finished_at=? "
                "WHERE id=? AND status='running'",
                (error, now, row["id"]),
            )
        return len(rows)


# --------------------------------------------------------------------------
# 审计 / 日志
# --------------------------------------------------------------------------
def add_audit(username: str, action: str, params: Any = None, result: str = "", ip: str = "") -> None:
    with _LOCK, _connect() as conn:
        conn.execute(
            "INSERT INTO audit(at, username, action, params, result, ip) VALUES (?,?,?,?,?,?)",
            (int(time.time() * 1000), username, action,
             json.dumps(params, ensure_ascii=False, default=str)[:4000], str(result)[:1000], ip),
        )


def list_audit(limit: int = 200) -> list[dict]:
    with _LOCK, _connect() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM audit ORDER BY id DESC LIMIT ?", (int(limit),)
        ).fetchall()]


def add_log(level: str, source: str, message: str) -> None:
    with _LOCK, _connect() as conn:
        conn.execute(
            "INSERT INTO logs(at, level, source, message) VALUES (?,?,?,?)",
            (int(time.time() * 1000), level, source, str(message)[:4000]),
        )


def list_logs(limit: int = 200, source: str | None = None) -> list[dict]:
    sql = "SELECT * FROM logs"
    args: list[Any] = []
    if source:
        sql += " WHERE source = ?"
        args.append(source)
    sql += " ORDER BY id DESC LIMIT ?"
    args.append(int(limit))
    with _LOCK, _connect() as conn:
        return [dict(r) for r in conn.execute(sql, args).fetchall()]


def list_logs_for_job(job_id: str, limit: int = 200) -> list[dict]:
    """某个作业的日志（「日志中心」详情窗口用）。

    两类都收：
      · 处理器/队列专门写的 source='job:<id>' 记录；
      · 其它来源里正文提到这个作业号的记录（例如护栏拦截、飞书推送）。
    """
    if not job_id:
        return []
    sql = ("SELECT * FROM logs WHERE source = ? OR message LIKE ? "
           "ORDER BY id DESC LIMIT ?")
    with _LOCK, _connect() as conn:
        return [dict(r) for r in conn.execute(
            sql, (f"job:{job_id}", f"%{job_id}%", int(limit))).fetchall()]


def job_status_counts() -> dict[str, int]:
    """各状态作业数（日志中心的三个分页 tab 上用）。"""
    out = {"queued": 0, "running": 0, "done": 0, "failed": 0, "canceled": 0, "total": 0}
    with _LOCK, _connect() as conn:
        for row in conn.execute("SELECT status, COUNT(*) c FROM jobs GROUP BY status"):
            out[str(row["status"])] = row["c"]
            out["total"] += row["c"]
    return out


# --------------------------------------------------------------------------
# 任务级业务参数覆盖
# --------------------------------------------------------------------------
def get_campaign_params(campaign_id: int) -> dict[str, Any]:
    """取某个任务显式填写的覆盖值（没填过的字段不存在）。"""
    with _LOCK, _connect() as conn:
        row = conn.execute(
            "SELECT params FROM campaign_params WHERE campaign_id = ?", (int(campaign_id),)
        ).fetchone()
    if not row or not row["params"]:
        return {}
    try:
        data = json.loads(row["params"])
    except (TypeError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def set_campaign_params(campaign_id: int, params: dict[str, Any]) -> dict[str, Any]:
    """写入覆盖值；传空对象表示"全部恢复用全局默认"。"""
    clean = validate_campaign_params(params or {})
    now = int(time.time() * 1000)
    with _LOCK, _connect() as conn:
        if clean:
            conn.execute(
                "INSERT INTO campaign_params(campaign_id, params, updated_at) VALUES (?,?,?) "
                "ON CONFLICT(campaign_id) DO UPDATE SET params=excluded.params, updated_at=excluded.updated_at",
                (int(campaign_id), json.dumps(clean, ensure_ascii=False), now),
            )
        else:
            conn.execute("DELETE FROM campaign_params WHERE campaign_id = ?", (int(campaign_id),))
    return clean


def all_campaign_params() -> dict[int, dict[str, Any]]:
    """一次性取出所有任务的覆盖值（列表接口防 N+1 查询）。"""
    out: dict[int, dict[str, Any]] = {}
    with _LOCK, _connect() as conn:
        for row in conn.execute("SELECT campaign_id, params FROM campaign_params").fetchall():
            try:
                data = json.loads(row["params"])
            except (TypeError, json.JSONDecodeError):
                data = {}
            out[int(row["campaign_id"])] = data if isinstance(data, dict) else {}
    return out


def effective_campaign_params(campaign_id: int | None = None) -> tuple[dict, dict]:
    """返回 (覆盖值, 生效值)。生效值 = 全局默认 ← 任务覆盖。"""
    global_settings = get_settings()
    override = get_campaign_params(campaign_id) if campaign_id is not None else {}
    base = {k: global_settings.get(k) for k in CAMPAIGN_PARAM_RULES}
    return override, {**base, **override}
