/* =====================================================================
 * 区块：数据落库（SQLite，零依赖）
 * [功能区块 · v0.1 · 状态：待集成到系统 —— 见 INTEGRATION.md]
 *
 * 用 Node 内置的 node:sqlite，单文件库：tools/qianniu/data/im.db
 *
 * 四张表，分层清晰：
 *   conversations  联系人档案（按会话 id 唯一，重名也不会混）
 *   messages       消息明细（去重，可查询/导出）
 *   events         原始事件流水（与 logs/im-events.jsonl 对齐）
 *   heartbeats     监听心跳（用于判断采集是否中断）
 *
 * 对外接口：
 *   openDb(file?)            打开（自动建表）
 *   saveConversations(...)   落联系人快照
 *   saveMessages(...)        落消息（INSERT OR IGNORE 去重）
 *   saveEvent(...)           落单条事件
 *   saveHeartbeat(...)       落心跳
 *   listContacts / recentMessages / stats / exportCsv / syncFromJsonl
 * ===================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(__dirname, '..', 'data');
export const DB_PATH = process.env.IM_DB || path.join(DATA_DIR, 'im.db');
export const JSONL_PATH = path.resolve(__dirname, '..', 'logs', 'im-events.jsonl');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 8000;

CREATE TABLE IF NOT EXISTS conversations (
  conv_key    TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  peer        TEXT,
  is_self     INTEGER DEFAULT 0,
  cid_type    TEXT,
  site        TEXT,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  last_desc   TEXT,
  ui_time     TEXT,
  unread      TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_key    TEXT NOT NULL,
  conv_name   TEXT,
  direction   TEXT NOT NULL,
  sender      TEXT,
  ui_time     TEXT,
  msg_epoch   INTEGER,
  text        TEXT,
  fingerprint TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  source      TEXT,
  UNIQUE(conv_key, fingerprint)
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  epoch       INTEGER NOT NULL,
  iso         TEXT,
  type        TEXT NOT NULL,
  conv_key    TEXT,
  conv        TEXT,
  peer        TEXT,
  sender      TEXT,
  ui_time     TEXT,
  text        TEXT,
  descr       TEXT,
  unread      TEXT,
  target      TEXT,
  UNIQUE(epoch, type, conv_key, text)
);

CREATE TABLE IF NOT EXISTS heartbeats (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  epoch       INTEGER NOT NULL,
  ticks       INTEGER,
  sessions    INTEGER,
  inbound     INTEGER,
  outbound    INTEGER,
  conv_alerts INTEGER,
  errors      INTEGER,
  reconnects  INTEGER
);

/* 回复记录：每一条自动/半自动回复都留痕，便于审计与排错 */
CREATE TABLE IF NOT EXISTS replies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  epoch        INTEGER NOT NULL,
  conv_key     TEXT,
  conv_name    TEXT,
  inbound_text TEXT,
  rule_name    TEXT,
  action       TEXT,
  content      TEXT,
  status       TEXT,
  detail       TEXT
);

/* 以图搜图记录：本地图片 -> imageId -> 结果，便于回溯与重放 */
CREATE TABLE IF NOT EXISTS image_searches (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  epoch      INTEGER NOT NULL,
  image_file TEXT,
  image_id   TEXT,
  method     TEXT,
  card_count INTEGER,
  top_offer  TEXT,
  top_price  TEXT,
  result_url TEXT
);

/* 图片 ↔ 商家：每次以图搜图后联系了哪些商家（后续接"图片库"用） */
CREATE TABLE IF NOT EXISTS image_contacts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  epoch       INTEGER NOT NULL,
  image_id    TEXT,
  image_file  TEXT,
  rank        INTEGER,
  offer_id    TEXT,
  shop_name   TEXT,
  seller_nick TEXT,
  chat_uid    TEXT,
  chat_url    TEXT,
  status      TEXT,
  detail      TEXT
);

/* 快捷短语库（JSON 为准，这里存一份可直接查询的镜像） */
CREATE TABLE IF NOT EXISTS phrase_library (
  phrase_id  TEXT PRIMARY KEY,
  name       TEXT,
  text       TEXT,
  image_path TEXT,
  image_name TEXT,
  tags       TEXT,
  enabled    INTEGER,
  updated_at INTEGER
);

/* 短语发送留痕：发给了谁、图/文各自成功没有 */
CREATE TABLE IF NOT EXISTS phrase_sends (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  epoch        INTEGER NOT NULL,
  phrase_id    TEXT,
  phrase_text  TEXT,
  image_path   TEXT,
  conv_key     TEXT,
  conv_name    TEXT,
  image_status TEXT,
  text_status  TEXT,
  detail       TEXT
);

/* 供应商报价台账：自动回复要收集的字段（严格按业务给定的列） */
CREATE TABLE IF NOT EXISTS supplier_quotes (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  phrase                  TEXT,     -- 快捷短语（触发这次询价的话术）
  product_image           TEXT,     -- 产品图片地址
  supplier_wangwang       TEXT,     -- 供应商旺旺账号
  unit_price              TEXT,     -- 单价
  moq                     TEXT,     -- 起订量
  freight                 TEXT,     -- 运费
  sample_lead_time        TEXT,     -- 打样工期
  bulk_lead_time          TEXT,     -- 大货工期
  sample_fee_refundable   TEXT,     -- 打样费（大货是否退）
  price_incl_sample_fee   TEXT,     -- 大货不退含打样费的单价
  remark                  TEXT,     -- 备注
  nda                     TEXT,     -- 保密协议
  defect_rate             TEXT,     -- 次品率
  conv_key                TEXT,     -- 会话 id（关联用）
  offer_id                TEXT,     -- 商品 offerId（关联用）
  status                  TEXT,     -- asking(待补全) / quoted(已齐) / dropped(不做此产品)
  raw_text                TEXT,     -- 最近一次原始回复（留痕）
  updated_at              INTEGER
);

/* 自动回复留痕（多会话自动回复的每一次"打算回复/已解析"） */
CREATE TABLE IF NOT EXISTS auto_replies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  epoch        INTEGER NOT NULL,
  conv_key     TEXT,
  conv_name    TEXT,
  inbound_text TEXT,
  ai_relevant  INTEGER,            -- AI 判断：商家是否做该产品
  ai_action    TEXT,               -- ask(继续问) / done(信息齐) / drop(放弃客户) / ignore
  ai_reply     TEXT,               -- AI 拟好的回复内容
  missing      TEXT,               -- 还缺哪些字段
  sent         INTEGER DEFAULT 0,  -- 是否真的发出（本阶段恒为 0 = 演练）
  detail       TEXT
);

/* 图片库：本地图片来源 + 处理状态（图片库对接的落点） */
CREATE TABLE IF NOT EXISTS image_library (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT UNIQUE,     -- 图片路径（绝对）
  file_name   TEXT,            -- 文件名
  size        INTEGER,         -- 字节
  hash        TEXT,            -- 内容哈希（识别改名/移动的同一张图）
  phrase_id   TEXT,            -- 配哪条快捷短语
  status      TEXT,            -- pending / done / failed
  image_id    TEXT,            -- 搜图得到的 imageId
  last_run_at INTEGER,
  note        TEXT
);

/* 页面价：以图搜图结果卡片上的价格（比价的基准之一）
   商家常回"页面价格+0.1"，需要拿这里的页面价去换算真实单价 */
CREATE TABLE IF NOT EXISTS offer_prices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id       TEXT,
  offer_id       TEXT,
  title          TEXT,
  shop_name      TEXT,
  seller_nick    TEXT,
  page_price_raw TEXT,        -- 原样文本（如 "￥0.74"）
  page_price_num REAL,        -- 数值化（0.74）
  moq            TEXT,
  captured_at    INTEGER,
  UNIQUE(image_id, offer_id)
);

/* 比价任务（Campaign）：把「商品图片 + 询价短语」绑成一个任务，
   本次搜图/联系/询价/回复/解析/报价 全部挂在同一个任务下 —— 这是并行隔离的单位。
   多个任务同时跑不会串，因为每一条下游数据都带 campaign_id。 */
CREATE TABLE IF NOT EXISTS campaigns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT,            -- 商品名（默认取图片文件名）
  image_file  TEXT,            -- 商品图片路径
  image_id    TEXT,            -- 该任务搜图得到的 imageId
  phrase_id   TEXT,            -- 绑定的快捷短语
  phrase_text TEXT,            -- 短语文字（快照，短语库改了也不影响历史）
  status      TEXT,            -- running / collecting / done / failed
  stage       TEXT,            -- 当前阶段：created / searched / contacted / sending / collecting
  created_at  INTEGER,
  updated_at  INTEGER,
  note        TEXT
);

CREATE INDEX IF NOT EXISTS idx_msg_conv  ON messages(conv_key, captured_at);
CREATE INDEX IF NOT EXISTS idx_msg_epoch ON messages(msg_epoch);
CREATE INDEX IF NOT EXISTS idx_evt_epoch ON events(epoch);
CREATE INDEX IF NOT EXISTS idx_reply_epoch ON replies(epoch);
CREATE INDEX IF NOT EXISTS idx_img_epoch ON image_searches(epoch);
CREATE INDEX IF NOT EXISTS idx_img_id ON image_searches(image_id);
CREATE INDEX IF NOT EXISTS idx_contact_img ON image_contacts(image_id, epoch);
CREATE INDEX IF NOT EXISTS idx_contact_shop ON image_contacts(shop_name);
CREATE INDEX IF NOT EXISTS idx_send_epoch ON phrase_sends(epoch);
CREATE INDEX IF NOT EXISTS idx_send_phrase ON phrase_sends(phrase_id);
CREATE INDEX IF NOT EXISTS idx_quote_conv ON supplier_quotes(conv_key);
CREATE INDEX IF NOT EXISTS idx_quote_supplier ON supplier_quotes(supplier_wangwang);
CREATE INDEX IF NOT EXISTS idx_auto_epoch ON auto_replies(epoch);
CREATE INDEX IF NOT EXISTS idx_offerprice_offer ON offer_prices(offer_id);
CREATE INDEX IF NOT EXISTS idx_offerprice_shop ON offer_prices(shop_name);
CREATE INDEX IF NOT EXISTS idx_campaign_created ON campaigns(created_at);
`;

export function openDb(file = DB_PATH) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/* 轻量迁移：给已存在的库补列（新库由 SCHEMA 建好，这里只兜老库）。
   offer_id 用来把"客户 ↔ 短语/图片"关联到精确的 offer，而不是靠店铺名。 */
function migrate(db) {
  const has = (table, col) => {
    try {
      return db.prepare(`PRAGMA table_info(${table})`).all().some((r) => r.name === col);
    } catch { return true; }
  };
  const add = (table, col, type) => {
    if (has(table, col)) return;
    try {
      db.exec(`PRAGMA busy_timeout = 8000`);
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    } catch (e) {
      /* 不静默吞错：之前因为吞了 SQLITE_BUSY，导致迁移悄悄没生效 */
      console.warn(`⚠️ 数据库迁移失败（${table}.${col}）：${e.message}`);
    }
  };
  add('phrase_sends', 'offer_id', 'TEXT');
  add('phrase_library', 'image_name', 'TEXT');
  add('auto_replies', 'msg_key', 'TEXT');   // 去重：同一条来消息只处理一次
  /* 比价相关：页面价 + 价格口径 + 可比单价 */
  add('supplier_quotes', 'page_price', 'TEXT');      // 该供应商对应 offer 的页面价（原样）
  add('supplier_quotes', 'price_basis', 'TEXT');     // absolute / page_plus / page_minus / unknown
  add('supplier_quotes', 'unit_price_final', 'REAL'); // 可比单价（数值，元）
  /* 任务归属：让"同时跑多个比价任务"互相隔离 */
  for (const t of ['image_contacts', 'supplier_quotes', 'phrase_sends', 'auto_replies', 'offer_prices']) {
    add(t, 'campaign_id', 'INTEGER');
  }
}

/* 把界面上的时间字符串尽量转成 epoch（便于做时间序列分析）
   - "2026-09-21 18:52:23" → 精确
   - "10:29:32"            → 补上今天日期（有跨天误差，仅作近似） */
export function parseUiTime(uiTime) {
  if (!uiTime) return null;
  const full = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(uiTime.trim());
  if (full) {
    return new Date(+full[1], +full[2] - 1, +full[3], +full[4], +full[5], +full[6]).getTime();
  }
  const hm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(uiTime.trim());
  if (hm) {
    const d = new Date();
    d.setHours(+hm[1], +hm[2], +(hm[3] || 0), 0);
    /* 若算出来的时刻比现在晚很多，说明是昨天的时间 */
    if (d.getTime() - Date.now() > 12 * 3600 * 1000) d.setDate(d.getDate() - 1);
    return d.getTime();
  }
  return null;
}

export function saveConversations(db, convs, now = Date.now()) {
  const stmt = db.prepare(`
    INSERT INTO conversations (conv_key,name,peer,is_self,cid_type,site,first_seen,last_seen,last_desc,ui_time,unread)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(conv_key) DO UPDATE SET
      name=excluded.name, peer=excluded.peer, is_self=excluded.is_self,
      cid_type=excluded.cid_type, site=excluded.site,
      last_seen=excluded.last_seen, last_desc=excluded.last_desc,
      ui_time=excluded.ui_time, unread=excluded.unread
  `);
  let n = 0;
  for (const c of convs) {
    const key = c.key || c.id || ('name:' + c.name);
    stmt.run(key, c.name || '', c.peer || '', c.isSelf ? 1 : 0,
             c.cidType || '', c.site || '', now, now,
             c.desc || '', c.time || '', c.unread || '');
    n++;
  }
  return n;
}

export function saveMessages(db, { convKey, convName, msgs, source, now = Date.now() }) {
  /* 拿不到真实会话 id 时不要落消息，否则会写出一批挂在
     "(未知会话)" 名下的脏数据。 */
  if (!convKey || convKey.startsWith('name:') || convKey.indexOf('未知') >= 0) return 0;
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO messages
      (conv_key,conv_name,direction,sender,ui_time,msg_epoch,text,fingerprint,captured_at,source)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `);
  let n = 0;
  for (const m of msgs) {
    if (m.kind !== 'msg') continue;             // 模板消息不入消息表
    const fp = (m.mine ? 'O' : 'I') + '|' + (m.time || '') + '|' + (m.text || '');
    const info = stmt.run(convKey, convName || '', m.mine ? 'out' : 'in',
                          m.sender || '', m.time || '', parseUiTime(m.time),
                          m.text || '', fp, now, source || '');
    if (info.changes) n++;
  }
  return n;
}

export function saveEvent(db, ev) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO events
      (epoch,iso,type,conv_key,conv,peer,sender,ui_time,text,descr,unread,target)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const info = stmt.run(
    ev.epoch || Date.now(), ev.iso || new Date(ev.epoch || Date.now()).toISOString(),
    ev.type || 'unknown', ev.convId || '', ev.conv || '', ev.peer || '',
    ev.sender || '', ev.msgTime || '', ev.text || '', ev.desc || '',
    ev.unread || '', ev.target || ''
  );
  return info.changes > 0;
}

export function saveHeartbeat(db, epoch, stats, sessions) {
  db.prepare(`
    INSERT INTO heartbeats (epoch,ticks,sessions,inbound,outbound,conv_alerts,errors,reconnects)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(epoch, stats.ticks || 0, sessions || 0, stats.inbound || 0,
         stats.outbound || 0, stats.convAlerts || 0, stats.errors || 0, stats.reconnects || 0);
}

export function saveReply(db, rec) {
  db.prepare(`
    INSERT INTO replies (epoch,conv_key,conv_name,inbound_text,rule_name,action,content,status,detail)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    rec.epoch || Date.now(), rec.convKey || '', rec.convName || '',
    rec.inboundText || '', rec.ruleName || '', rec.action || '',
    rec.content || '', rec.status || '', rec.detail || ''
  );
  return true;
}

export function listReplies(db, limit = 30) {
  return db.prepare(`
    SELECT * FROM replies ORDER BY epoch DESC, id DESC LIMIT ?
  `).all(limit);
}

export function saveImageSearch(db, rec) {
  db.prepare(`
    INSERT INTO image_searches (epoch,image_file,image_id,method,card_count,top_offer,top_price,result_url)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(
    rec.epoch || Date.now(), rec.imageFile || '', rec.imageId || '', rec.method || '',
    rec.cardCount || 0, rec.topOffer || '', rec.topPrice || '', rec.resultUrl || ''
  );
  return true;
}

export function listImageSearches(db, limit = 20) {
  return db.prepare(`
    SELECT * FROM image_searches ORDER BY epoch DESC, id DESC LIMIT ?
  `).all(limit);
}

export function saveImageContact(db, rec) {
  db.prepare(`
    INSERT INTO image_contacts
      (epoch,image_id,image_file,rank,offer_id,shop_name,seller_nick,chat_uid,chat_url,status,detail,campaign_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    rec.epoch || Date.now(), rec.imageId || '', rec.imageFile || '', rec.rank || 0,
    rec.offerId || '', rec.shopName || '', rec.sellerNick || '', rec.chatUid || '',
    rec.chatUrl || '', rec.status || '', rec.detail || '',
    rec.campaignId || null
  );
  return true;
}

export function listImageContacts(db, limit = 50) {
  return db.prepare(`
    SELECT * FROM image_contacts ORDER BY epoch DESC, id DESC LIMIT ?
  `).all(limit);
}

/* 某张图片联系过哪些商家（图片库对接用） */
export function contactsByImage(db, imageId) {
  return db.prepare(`
    SELECT * FROM image_contacts WHERE image_id = ? ORDER BY rank ASC
  `).all(imageId);
}

/* ---- 短语库镜像 ---- */
export function savePhrase(db, p, now = Date.now()) {
  db.prepare(`
    INSERT INTO phrase_library (phrase_id,name,text,image_path,image_name,tags,enabled,updated_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(phrase_id) DO UPDATE SET
      name=excluded.name, text=excluded.text, image_path=excluded.image_path,
      image_name=excluded.image_name, tags=excluded.tags,
      enabled=excluded.enabled, updated_at=excluded.updated_at
  `).run(
    p.id, p.name || '', p.text || '', p.image || '',
    p.image ? String(p.image).split(/[\\/]/).pop() : '',
    Array.isArray(p.tags) ? p.tags.join(',') : (p.tags || ''),
    p.enabled === false ? 0 : 1, now
  );
  return true;
}

export function listPhrases(db) {
  return db.prepare(`SELECT * FROM phrase_library ORDER BY phrase_id`).all();
}

/* ---- 短语发送留痕 ---- */
export function savePhraseSend(db, rec) {
  db.prepare(`
    INSERT INTO phrase_sends
      (epoch,phrase_id,phrase_text,image_path,conv_key,conv_name,offer_id,image_status,text_status,detail,campaign_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    rec.epoch || Date.now(), rec.phraseId || '', rec.phraseText || '', rec.imagePath || '',
    rec.convKey || '', rec.convName || '', rec.offerId || '',
    rec.imageStatus || '', rec.textStatus || '',
    rec.detail || '', rec.campaignId || null
  );
  return true;
}

export function listPhraseSends(db, limit = 30) {
  return db.prepare(`SELECT * FROM phrase_sends ORDER BY epoch DESC, id DESC LIMIT ?`).all(limit);
}

/* ---- 供应商报价台账 ---- */
export const QUOTE_FIELDS = [
  'unit_price', 'moq', 'freight', 'sample_lead_time', 'bulk_lead_time',
  'sample_fee_refundable', 'price_incl_sample_fee', 'remark', 'nda', 'defect_rate'
];

const QUOTE_CN = {
  unit_price: '单价', moq: '起订量', freight: '运费',
  sample_lead_time: '打样工期', bulk_lead_time: '大货工期',
  sample_fee_refundable: '打样费（大货是否退）', price_incl_sample_fee: '大货不退含打样费的单价',
  remark: '备注', nda: '保密协议', defect_rate: '次品率'
};
export const quoteFieldCN = (k) => QUOTE_CN[k] || k;

/* 按会话 upsert；只覆盖传进来的非空字段，其余保留 */
export function upsertQuote(db, rec, now = Date.now()) {
  const key = rec.conv_key || '';
  const cur = key ? db.prepare(`SELECT * FROM supplier_quotes WHERE conv_key = ? ORDER BY id DESC LIMIT 1`).get(key) : null;
  const merged = { ...(cur || {}) };
  for (const [k, v] of Object.entries(rec)) {
    if (v === undefined || v === null || v === '') continue;
    merged[k] = v;
  }
  merged.updated_at = now;

  if (cur) {
    db.prepare(`
      UPDATE supplier_quotes SET
        phrase=?, product_image=?, supplier_wangwang=?, unit_price=?, moq=?, freight=?,
        sample_lead_time=?, bulk_lead_time=?, sample_fee_refundable=?, price_incl_sample_fee=?,
        remark=?, nda=?, defect_rate=?, offer_id=?, status=?, raw_text=?, updated_at=?,
        page_price=?, price_basis=?, unit_price_final=?, campaign_id=COALESCE(?, campaign_id)
      WHERE id=?
    `).run(
      merged.phrase || '', merged.product_image || '', merged.supplier_wangwang || '',
      merged.unit_price || '', merged.moq || '', merged.freight || '',
      merged.sample_lead_time || '', merged.bulk_lead_time || '',
      merged.sample_fee_refundable || '', merged.price_incl_sample_fee || '',
      merged.remark || '', merged.nda || '', merged.defect_rate || '',
      merged.offer_id || '', merged.status || '', merged.raw_text || '', now,
      merged.page_price || '', merged.price_basis || '', merged.unit_price_final ?? null,
      merged.campaign_id || null, cur.id
    );
    return cur.id;
  }

  const r = db.prepare(`
    INSERT INTO supplier_quotes
      (phrase,product_image,supplier_wangwang,unit_price,moq,freight,sample_lead_time,bulk_lead_time,
       sample_fee_refundable,price_incl_sample_fee,remark,nda,defect_rate,conv_key,offer_id,status,raw_text,updated_at,
       page_price,price_basis,unit_price_final,campaign_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    merged.phrase || '', merged.product_image || '', merged.supplier_wangwang || '',
    merged.unit_price || '', merged.moq || '', merged.freight || '',
    merged.sample_lead_time || '', merged.bulk_lead_time || '',
    merged.sample_fee_refundable || '', merged.price_incl_sample_fee || '',
    merged.remark || '', merged.nda || '', merged.defect_rate || '',
    key, merged.offer_id || '', merged.status || 'asking', merged.raw_text || '', now,
    merged.page_price || '', merged.price_basis || '', merged.unit_price_final ?? null,
    merged.campaign_id || null
  );
  return r.lastInsertRowid;
}

export function listQuotes(db, limit = 50) {
  return db.prepare(`SELECT * FROM supplier_quotes ORDER BY updated_at DESC LIMIT ?`).all(limit);
}

/* 还缺哪些字段（用于决定下一句问什么） */
export function missingQuoteFields(row) {
  return QUOTE_FIELDS.filter((f) => !row || !String(row[f] || '').trim());
}

/* ---- 自动回复留痕 ---- */
export function saveAutoReply(db, rec) {
  const r = db.prepare(`
    INSERT INTO auto_replies
      (epoch,conv_key,conv_name,inbound_text,ai_relevant,ai_action,ai_reply,missing,sent,detail,msg_key,campaign_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    rec.epoch || Date.now(), rec.convKey || '', rec.convName || '', rec.inboundText || '',
    rec.aiRelevant === undefined || rec.aiRelevant === null ? null : (rec.aiRelevant ? 1 : 0),
    rec.aiAction || '', rec.aiReply || '', rec.missing || '', rec.sent ? 1 : 0,
    rec.detail || '', rec.msgKey || '', rec.campaignId || null
  );
  return r.lastInsertRowid;     // 返回 id，便于后续回填"实际发送结果"
}

/* 回填一条自动回复的实际执行结果（发送成功/失败/仅填草稿/被护栏拦截） */
export function setAutoReplyResult(db, id, { action, sent, detail }) {
  if (!id) return false;
  db.prepare(`UPDATE auto_replies SET ai_action=?, sent=?, detail=? WHERE id=?`)
    .run(action || '', sent ? 1 : 0, detail || '', id);
  return true;
}

export function processedMsgKeys(db) {
  const rows = db.prepare(`SELECT msg_key FROM auto_replies WHERE COALESCE(msg_key,'') <> ''`).all();
  return new Set(rows.map((r) => r.msg_key));
}

export function listAutoReplies(db, limit = 30) {
  return db.prepare(`SELECT * FROM auto_replies ORDER BY epoch DESC, id DESC LIMIT ?`).all(limit);
}

/* ---- 图片库 ---- */

/* ---- 比价任务（Campaign）---- */
export function createCampaign(db, rec, now = Date.now()) {
  const r = db.prepare(`
    INSERT INTO campaigns (name,image_file,image_id,phrase_id,phrase_text,status,stage,created_at,updated_at,note)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    rec.name || '', rec.imageFile || '', rec.imageId || '', rec.phraseId || '', rec.phraseText || '',
    rec.status || 'running', rec.stage || 'created', now, now, rec.note || ''
  );
  return r.lastInsertRowid;
}

export function getCampaign(db, id) {
  return db.prepare(`SELECT * FROM campaigns WHERE id = ?`).get(id) || null;
}

export function listCampaigns(db, limit = 20) {
  return db.prepare(`SELECT * FROM campaigns ORDER BY created_at DESC LIMIT ?`).all(limit);
}

export function updateCampaign(db, id, patch = {}, now = Date.now()) {
  const cur = getCampaign(db, id);
  if (!cur) return false;
  const merged = { ...cur, ...patch };
  db.prepare(`
    UPDATE campaigns SET name=?, image_file=?, image_id=?, phrase_id=?, phrase_text=?,
      status=?, stage=?, updated_at=?, note=? WHERE id=?
  `).run(
    merged.name || '', merged.image_file || '', merged.image_id || '', merged.phrase_id || '',
    merged.phrase_text || '', merged.status || '', merged.stage || '', now, merged.note || '', id
  );
  return true;
}

/* 按「任务 / 时间区间 / 商品」查报价 —— 比价报表的查询入口。
   时间区间用 created_at/updated_at 的 epoch（毫秒）。 */
export function quotesFor(db, { campaignId, from, to, product, onlyPriced } = {}) {
  const where = [];
  const args = [];
  if (campaignId) { where.push('q.campaign_id = ?'); args.push(Number(campaignId)); }
  if (from) { where.push('q.updated_at >= ?'); args.push(Number(from)); }
  if (to) { where.push('q.updated_at <= ?'); args.push(Number(to)); }
  if (product) { where.push('(q.phrase LIKE ? OR c.name LIKE ?)'); args.push('%' + product + '%', '%' + product + '%'); }
  if (onlyPriced) where.push('q.unit_price_final IS NOT NULL');
  const sql = `
    SELECT q.*, c.name AS campaign_name, c.image_file AS campaign_image, c.image_id AS campaign_image_id
    FROM supplier_quotes q
    LEFT JOIN campaigns c ON c.id = q.campaign_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY q.unit_price_final IS NULL, q.unit_price_final ASC, q.updated_at DESC
    LIMIT 500
  `;
  return db.prepare(sql).all(...args);
}

/* 某任务下的商家清单 */
export function campaignContacts(db, campaignId) {
  return db.prepare(`
    SELECT * FROM image_contacts WHERE campaign_id = ? ORDER BY rank ASC
  `).all(Number(campaignId));
}

export function upsertLibraryImage(db, rec, now = Date.now()) {
  db.prepare(`
    INSERT INTO image_library (path,file_name,size,hash,phrase_id,status,last_run_at,note)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(path) DO UPDATE SET
      file_name=excluded.file_name, size=excluded.size, hash=excluded.hash,
      phrase_id=COALESCE(NULLIF(excluded.phrase_id,''), image_library.phrase_id)
  `).run(
    rec.path, rec.fileName || '', rec.size || 0, rec.hash || '',
    rec.phraseId || '', rec.status || 'pending', rec.lastRunAt || null, rec.note || ''
  );
  return true;
}

export function listLibraryImages(db) {
  return db.prepare(`SELECT * FROM image_library ORDER BY file_name`).all();
}

export function markLibraryImage(db, path, patch = {}, now = Date.now()) {
  const cur = db.prepare(`SELECT * FROM image_library WHERE path = ?`).get(path);
  if (!cur) return false;
  db.prepare(`
    UPDATE image_library SET status=?, image_id=?, phrase_id=?, last_run_at=?, note=?
    WHERE path=?
  `).run(
    patch.status || cur.status, patch.imageId || cur.image_id || '',
    patch.phraseId || cur.phrase_id || '', now, patch.note || cur.note || '', path
  );
  return true;
}

/* ---- 页面价 ---- */
export function saveOfferPrice(db, rec, now = Date.now()) {
  const num = toPriceNumber(rec.pagePriceRaw);
  db.prepare(`
    INSERT INTO offer_prices
      (image_id,offer_id,title,shop_name,seller_nick,page_price_raw,page_price_num,moq,captured_at,campaign_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(image_id,offer_id) DO UPDATE SET
      title=excluded.title, shop_name=excluded.shop_name, seller_nick=excluded.seller_nick,
      page_price_raw=excluded.page_price_raw, page_price_num=excluded.page_price_num,
      moq=excluded.moq, captured_at=excluded.captured_at,
      campaign_id=COALESCE(excluded.campaign_id, campaign_id)
  `).run(
    rec.imageId || '', rec.offerId || '', rec.title || '', rec.shopName || '', rec.sellerNick || '',
    rec.pagePriceRaw || '', num, rec.moq || '', now, rec.campaignId || null
  );
  return num;
}

/* 从任意文本里抠出价格数字："￥0.74" → 0.74；"页面价格 +0.1" → 0.1（只用于相对量） */
export function toPriceNumber(text) {
  const m = String(text || '').replace(/\s+/g, '').match(/[￥¥]?\s*(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

export function listOfferPrices(db, imageId) {
  return imageId
    ? db.prepare(`SELECT * FROM offer_prices WHERE image_id = ? ORDER BY page_price_num ASC`).all(imageId)
    : db.prepare(`SELECT * FROM offer_prices ORDER BY captured_at DESC LIMIT 200`).all();
}

/* 按 offerId 或店铺名找页面价（比价换算用） */
export function findOfferPrice(db, { offerId, shopName }) {
  if (offerId) {
    const r = db.prepare(`SELECT * FROM offer_prices WHERE offer_id = ? ORDER BY captured_at DESC LIMIT 1`).get(offerId);
    if (r) return r;
  }
  const norm = (s) => String(s || '').replace(/公司|厂|店|商行|有限公司|有限责任公司/g, '').trim();
  const key = norm(shopName);
  if (!key) return null;
  const rows = db.prepare(`SELECT * FROM offer_prices ORDER BY captured_at DESC LIMIT 200`).all();
  return rows.find((r) => norm(r.shop_name) === key)
      || rows.find((r) => norm(r.shop_name).includes(key) || key.includes(norm(r.shop_name)))
      || null;
}

/* ---------------- 查询 ---------------- */

export function listContacts(db) {
  return db.prepare(`
    SELECT c.conv_key, c.name, c.peer, c.is_self, c.last_desc, c.ui_time, c.unread,
           c.first_seen, c.last_seen,
           (SELECT COUNT(*) FROM messages m WHERE m.conv_key = c.conv_key)              AS msg_total,
           (SELECT COUNT(*) FROM messages m WHERE m.conv_key = c.conv_key AND direction='in')  AS msg_in,
           (SELECT COUNT(*) FROM messages m WHERE m.conv_key = c.conv_key AND direction='out') AS msg_out
    FROM conversations c
    ORDER BY c.last_seen DESC
  `).all();
}

export function recentMessages(db, limit = 30) {
  return db.prepare(`
    SELECT id, conv_key, conv_name, direction, sender, ui_time, text, captured_at
    FROM messages ORDER BY captured_at DESC, id DESC LIMIT ?
  `).all(limit);
}

export function stats(db) {
  const one = (sql) => db.prepare(sql).get();
  return {
    contacts: one('SELECT COUNT(*) AS n FROM conversations').n,
    selfContacts: one('SELECT COUNT(*) AS n FROM conversations WHERE is_self=1').n,
    messages: one('SELECT COUNT(*) AS n FROM messages').n,
    messagesIn: one("SELECT COUNT(*) AS n FROM messages WHERE direction='in'").n,
    messagesOut: one("SELECT COUNT(*) AS n FROM messages WHERE direction='out'").n,
    events: one('SELECT COUNT(*) AS n FROM events').n,
    heartbeats: one('SELECT COUNT(*) AS n FROM heartbeats').n,
    replies: one('SELECT COUNT(*) AS n FROM replies').n,
    repliesSent: one("SELECT COUNT(*) AS n FROM replies WHERE status='sent'").n,
    imageSearches: one('SELECT COUNT(*) AS n FROM image_searches').n,
    imageContacts: one('SELECT COUNT(*) AS n FROM image_contacts').n,
    phrases: one('SELECT COUNT(*) AS n FROM phrase_library').n,
    phraseSends: one('SELECT COUNT(*) AS n FROM phrase_sends').n,
    quotes: one('SELECT COUNT(*) AS n FROM supplier_quotes').n,
    autoReplies: one('SELECT COUNT(*) AS n FROM auto_replies').n,
    firstCaptured: one('SELECT MIN(captured_at) AS t FROM messages').t,
    lastCaptured: one('SELECT MAX(captured_at) AS t FROM messages').t,
    lastHeartbeat: one('SELECT MAX(epoch) AS t FROM heartbeats').t
  };
}

export function exportCsv(db, outFile, limit = 100000) {
  const rows = db.prepare(`
    SELECT m.captured_at, c.name AS contact, c.peer, c.is_self, m.direction,
           m.sender, m.ui_time, m.msg_epoch, m.text
    FROM messages m LEFT JOIN conversations c ON c.conv_key = m.conv_key
    ORDER BY m.captured_at ASC, m.id ASC LIMIT ?
  `).all(limit);
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""').replace(/\r?\n/g, ' ');
    return /[",]/.test(s) ? `"${s}"` : s;
  };
  const head = ['captured_at','captured_local','contact','peer','is_self','direction','sender','ui_time','msg_epoch','text'];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([
      r.captured_at, new Date(r.captured_at).toLocaleString('zh-CN'),
      r.contact, r.peer, r.is_self ? '本账号自己' : '',
      r.direction === 'in' ? '对方' : '我方',
      r.sender, r.ui_time, r.msg_epoch, r.text
    ].map(esc).join(','));
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, '\uFEFF' + lines.join('\n'), 'utf8');   // BOM 让 Excel 正确识别中文
  return rows.length;
}

/* 把已有的 JSONL 事件流水补录进库（升级/迁移用） */
export function syncFromJsonl(db, file = JSONL_PATH) {
  if (!fs.existsSync(file)) return { read: 0, inserted: 0 };
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let inserted = 0;
  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (saveEvent(db, ev)) inserted++;
  }
  return { read: lines.length, inserted };
}
