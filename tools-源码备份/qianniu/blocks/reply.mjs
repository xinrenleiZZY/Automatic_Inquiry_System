/* =====================================================================
 * 区块：回复（Reply）—— 发送主体 + 条件插槽 + 风控护栏
 * [功能区块 · v0.1 · 状态：待集成到系统 —— 条件规则待补充，见 INTEGRATION.md]
 *
 * 发送通道（都是已验证的真实操作，不是伪造请求）：
 *   ① 文本直发：可信输入事件(Input.insertText) + 真实鼠标点击发送按钮
 *   ② 快捷短语：点按钮 → 选短语 → 发送
 *
 * 条件规则：留成可插拔的 rules，先支持关键词/正则/any，
 *          复杂条件（议价区间、比价结果、客户等级等）在 match.custom 处扩展。
 *
 * 风控护栏（默认全部生效）：
 *   dryRun            默认 true —— 只走流程不真发
 *   draftOnly         只把话术填进输入框，等人工点发送
 *   minIntervalMs     同一会话两次发送的最小间隔
 *   maxPerHour        全局每小时发送上限
 *   maxPerConvPerHour 单会话每小时上限
 *   dedupeWindowMs    同一条来消息不重复回复
 *   quietHours        免打扰时段（例如 [22, 8] 表示 22:00–08:00 不自动发）
 *
 * 每一条回复（含被拦截的）都会落库到 replies 表，便于审计。
 * ===================================================================== */

import fs from 'node:fs';
import * as store from './db.mjs';
import { withSession } from './session.mjs';
import * as input from './input.mjs';
import * as phrases from './phrases.mjs';

export const DEFAULT_GUARDS = {
  dryRun: true,
  draftOnly: false,
  minIntervalMs: 8000,
  maxPerHour: 30,
  maxPerConvPerHour: 10,
  dedupeWindowMs: 3600 * 1000,
  quietHours: null,          // 例如 [22, 8]
  maxLength: 500             // 输入框上限 0/500
};

/* ---------------- 话术模板 ---------------- */

export function renderTemplate(tpl, ctx = {}) {
  return String(tpl || '').replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = ctx[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

/* ---------------- 规则 ---------------- */

export function loadRules(file) {
  if (!file) return [];
  return loadRulesFile(file).rules;
}

function validateRules(list) {
  return list.map((r, i) => {
    if (!r.name) throw new Error(`第 ${i + 1} 条规则缺少 name 字段`);
    if (!r.match) throw new Error(`规则「${r.name}」缺少 match 字段`);
    if (!r.reply) throw new Error(`规则「${r.name}」缺少 reply 字段（text 或 phraseIndex）`);
    return r;
  });
}

/* 规则文件可以两种写法：
   [{...}, {...}]                      只写规则
   { "guards": {...}, "rules": [...] }  规则 + 护栏一起写（推荐） */
export function loadRulesFile(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    rules: validateRules(Array.isArray(data) ? data : (data.rules || [])),
    guards: Array.isArray(data) ? {} : (data.guards || {})
  };
}

/* 目前支持的条件写法（后续在这里扩展议价/比价等复杂条件）：
     "match": { "any": true }                          命中所有
     "match": { "keywordsAny": ["价格","多少钱"] }       命中任一关键词
     "match": { "keywordsAll": ["起批","价格"] }         同时包含
     "match": { "regex": "\\d+\\s*元" }                 正则
   复杂条件预留：给 match.custom 赋一个字符串键名，
   后续在 CUSTOM_MATCHERS 里注册对应函数即可（例如接你的比价结果）。
*/
export const CUSTOM_MATCHERS = {
  // 示例（先留空，等你的条件）：
  // offLinePrice: (text, ctx) => ctx.price && ctx.price < ctx.threshold,
};

export function ruleMatches(rule, text, ctx = {}) {
  const m = rule.match || {};
  if (m.any) return true;
  if (Array.isArray(m.keywordsAny) && m.keywordsAny.some((k) => text.includes(k))) return true;
  if (Array.isArray(m.keywordsAll) && m.keywordsAll.length && m.keywordsAll.every((k) => text.includes(k))) return true;
  if (m.regex) {
    try { if (new RegExp(m.regex, m.flags || '').test(text)) return true; } catch { /* 规则写错就跳过 */ }
  }
  if (m.custom && typeof CUSTOM_MATCHERS[m.custom] === 'function') {
    try { if (CUSTOM_MATCHERS[m.custom](text, ctx)) return true; } catch { /* ignore */ }
  }
  return false;
}

export function matchRule(text, rules, ctx = {}) {
  for (const r of rules) {
    if (r.enabled === false) continue;
    if (ruleMatches(r, text, ctx)) return r;
  }
  return null;
}

/* ---------------- 回复引擎 ---------------- */

export class ReplyEngine {
  constructor(opts = {}) {
    this.rules = opts.rules || [];
    this.guards = { ...DEFAULT_GUARDS, ...(opts.guards || {}) };
    this.dbFile = opts.db === false ? null : (opts.dbFile || store.DB_PATH);
    this.db = opts.db === false ? null : (opts.db || null);
    this.ownDb = false;
    this.log = opts.log || ((...a) => console.log(...a));
    this.lastSentAt = new Map();     // convKey -> epoch
    this.sentPerConv = new Map();    // convKey -> [epoch]
    this.sentAll = [];               // [epoch]
    this.replied = new Map();        // convKey|text -> epoch
    this.stats = { matched: 0, sent: 0, drafted: 0, dryRun: 0, skipped: 0, failed: 0 };
  }

  ensureDb() {
    if (this.db) return this.db;
    if (!this.dbFile) return null;
    this.db = store.openDb(this.dbFile);
    this.ownDb = true;
    return this.db;
  }

  close() {
    if (this.db && this.ownDb) { try { this.db.close(); } catch { /* ignore */ } }
    this.db = null;
    this.ownDb = false;
  }

  record(rec) {
    const db = this.ensureDb();
    if (db) store.saveReply(db, rec);
  }

  /* 护栏检查：返回 { ok, reason } */
  check(convKey, inboundText) {
    const g = this.guards;
    const now = Date.now();

    if (g.quietHours) {
      const h = new Date().getHours();
      const [from, to] = g.quietHours;
      const quiet = from <= to ? (h >= from && h < to) : (h >= from || h < to);
      if (quiet) return { ok: false, reason: `免打扰时段（${from}:00–${to}:00）` };
    }

    const key = convKey + '|' + (inboundText || '');
    const lastSame = this.replied.get(key);
    if (lastSame && now - lastSame < g.dedupeWindowMs) {
      return { ok: false, reason: '该条消息已回复过（去重窗口内）' };
    }

    const last = this.lastSentAt.get(convKey) || 0;
    if (now - last < g.minIntervalMs) {
      return { ok: false, reason: `距上次发送仅 ${((now - last) / 1000).toFixed(1)}s（下限 ${g.minIntervalMs / 1000}s）` };
    }

    this.sentAll = this.sentAll.filter((t) => now - t < 3600 * 1000);
    if (this.sentAll.length >= g.maxPerHour) {
      return { ok: false, reason: `全局已达每小时上限 ${g.maxPerHour} 条` };
    }

    const convList = (this.sentPerConv.get(convKey) || []).filter((t) => now - t < 3600 * 1000);
    if (convList.length >= g.maxPerConvPerHour) {
      return { ok: false, reason: `该会话已达每小时上限 ${g.maxPerConvPerHour} 条` };
    }
    return { ok: true };
  }

  /* 真正执行发送（需要打开一个会话） */
  async sendNow({ text, phraseIndex }) {
    return withSession(async (s) => {
      if (phraseIndex !== undefined && phraseIndex !== null) {
        const picked = await phrases.pickOn(s, phraseIndex);
        const sent = await input.sendOn(s);
        return { content: picked.draft || picked.text, sent };
      }
      const r = await input.sendTextOn(s, text);
      return { content: text, sent: r };
    });
  }

  /* 只填草稿，不点发送（人工复核模式） */
  async draftNow({ text, phraseIndex }) {
    return withSession(async (s) => {
      if (phraseIndex !== undefined && phraseIndex !== null) {
        const picked = await phrases.pickOn(s, phraseIndex);
        return { content: picked.draft || picked.text };
      }
      const draft = await input.draftOn(s, text);
      return { content: draft };
    });
  }

  /* 主入口：来一条消息 -> 判断条件 -> 发送 */
  async handleInbound({ convKey, convName, text, peer, ctx = {}, force = false }) {
    const base = { convKey, convName, inboundText: text, peer };
    const rule = matchRule(text || '', this.rules, { ...ctx, convKey, convName, peer });
    if (!rule) {
      this.stats.skipped++;
      this.record({ ...base, epoch: Date.now(), ruleName: '', action: '', content: '',
                    status: 'skipped', detail: '没有命中的规则' });
      return { status: 'skipped', reason: '没有命中的规则' };
    }
    this.stats.matched++;

    const content = rule.reply.text
      ? renderTemplate(rule.reply.text, { contact: convName, text, time: new Date().toLocaleString('zh-CN'), ...ctx })
      : '';
    const action = rule.reply.phraseIndex !== undefined ? `phrase:${rule.reply.phraseIndex}` : 'text';

    if (content.length > this.guards.maxLength) {
      this.stats.skipped++;
      const detail = `正文 ${content.length} 字超上限 ${this.guards.maxLength}`;
      this.record({ ...base, epoch: Date.now(), ruleName: rule.name, action, content, status: 'skipped', detail });
      return { status: 'skipped', reason: detail };
    }

    const gate = force ? { ok: true } : this.check(convKey, text);
    if (!gate.ok) {
      this.stats.skipped++;
      this.record({ ...base, epoch: Date.now(), ruleName: rule.name, action, content,
                    status: 'skipped', detail: gate.reason });
      this.log(`⏭️  跳过回复（${rule.name}）：${gate.reason}`);
      return { status: 'skipped', reason: gate.reason };
    }

    /* 演练 / 只填草稿 */
    if (this.guards.dryRun || this.guards.draftOnly) {
      const status = this.guards.dryRun ? 'dry-run' : 'draft';
      let drafted = null;
      if (this.guards.draftOnly) {
        try { drafted = await this.draftNow({ text: content, phraseIndex: rule.reply.phraseIndex }); }
        catch (e) { this.log('⚠️  填草稿失败：' + e.message); }
      }
      this.stats[this.guards.dryRun ? 'dryRun' : 'drafted']++;
      this.record({ ...base, epoch: Date.now(), ruleName: rule.name, action,
                    content: drafted ? drafted.content : content, status,
                    detail: this.guards.dryRun ? '演练模式，未发送' : '已填入输入框待人工发送' });
      this.log(`🧪 ${this.guards.dryRun ? '演练' : '仅填草稿'}（${rule.name}）：${content || action}`);
      return { status, content, rule: rule.name };
    }

    /* 真发 */
    try {
      const out = await this.sendNow({ text: content, phraseIndex: rule.reply.phraseIndex });
      const ok = out.sent && out.sent.ok;
      this.stats[ok ? 'sent' : 'failed']++;
      if (ok) {
        const now = Date.now();
        this.lastSentAt.set(convKey, now);
        this.sentAll.push(now);
        const list = this.sentPerConv.get(convKey) || [];
        list.push(now);
        this.sentPerConv.set(convKey, list);
        this.replied.set(convKey + '|' + text, now);
      }
      this.record({ ...base, epoch: Date.now(), ruleName: rule.name, action,
                    content: out.content, status: ok ? 'sent' : 'failed',
                    detail: ok ? '' : JSON.stringify(out.sent) });
      this.log(ok ? `✅ 已回复（${rule.name}）：${out.content}`
                  : `❌ 发送校验未通过（${rule.name}）：${JSON.stringify(out.sent)}`);
      return { status: ok ? 'sent' : 'failed', content: out.content, sent: out.sent };
    } catch (e) {
      this.stats.failed++;
      this.record({ ...base, epoch: Date.now(), ruleName: rule.name, action,
                    content, status: 'failed', detail: e.message });
      this.log(`❌ 发送异常（${rule.name}）：${e.message}`);
      return { status: 'failed', reason: e.message };
    }
  }
}
