/* =====================================================================
 * 区块：AI 解析与回复编写（DeepSeek）
 * [功能区块 · v0.1 · 状态：待集成到系统 —— 见 INTEGRATION.md]
 *
 * 两件事：
 *   ① parseSupplierReply(文本) —— 把供应商的回复解析成结构化字段
 *      （单价/起订量/运费/打样工期/大货工期/打样费是否可退/含打样费单价/备注/保密协议/次品率）
 *      并判断"商家是否做这款产品"（不做就放弃该客户）
 *   ② composeReply({已知, 缺失, 产品}) —— 生成下一句要问的话，把缺失信息补齐
 *
 * Key 来源（按顺序找）：
 *   1) 环境变量 DEEPSEEK_API_KEY
 *   2) tools/qianniu/ai-config.json  { "apiKey": "...", "model": "deepseek-flash" }
 *   3) ~/.codex/config.toml 里 [model_providers.deepseek] 的 experimental_bearer_token
 *
 * 没有 key 或调用失败时，自动退回**规则解析**（正则），保证离线也能跑。
 * ===================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { QUOTE_FIELDS, quoteFieldCN } from './db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.resolve(__dirname, '..');
export const AI_CONFIG_FILE = path.join(BASE_DIR, 'ai-config.json');

export const DEFAULT_CONFIG = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',          // DeepSeek-V4.1-Flash
  timeoutMs: 60000
};

export function resolveConfig(overrides = {}) {
  let cfg = { ...DEFAULT_CONFIG };

  /* 2) 本地配置文件 */
  if (fs.existsSync(AI_CONFIG_FILE)) {
    try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(AI_CONFIG_FILE, 'utf8')) }; } catch { /* ignore */ }
  }

  /* 1) 环境变量 */
  if (process.env.DEEPSEEK_API_KEY) cfg.apiKey = process.env.DEEPSEEK_API_KEY;
  if (process.env.DEEPSEEK_MODEL) cfg.model = process.env.DEEPSEEK_MODEL;

  /* 3) ~/.codex/config.toml 里的 deepseek 配置 */
  if (!cfg.apiKey) {
    const toml = path.join(os.homedir(), '.codex', 'config.toml');
    if (fs.existsSync(toml)) {
      try {
        const text = fs.readFileSync(toml, 'utf8');
        const m = text.match(/experimental_bearer_token\s*=\s*"([^"]+)"/);
        if (m) cfg.apiKey = m[1];
      } catch { /* ignore */ }
    }
  }
  return { ...cfg, ...overrides };
}

export function hasApiKey(overrides = {}) {
  return !!resolveConfig(overrides).apiKey;
}

/* ---------------- 底层调用 ---------------- */

export async function chat(messages, opts = {}) {
  const cfg = resolveConfig(opts);
  if (!cfg.apiKey) throw new Error('没有可用的 DEEPSEEK_API_KEY（见 ai-config.json 说明）');

  const body = {
    model: cfg.model,
    messages,
    temperature: opts.temperature === undefined ? 0.2 : opts.temperature,
    max_tokens: opts.maxTokens || 2048
  };
  if (opts.json) body.response_format = { type: 'json_object' };

  /* 失败自动重试一次（限流/网络抖动时很常见；实测连续调用会偶发失败） */
  let lastErr = null;
  for (let attempt = 1; attempt <= (opts.retries === undefined ? 2 : opts.retries + 1); attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`API ${res.status}: ${text.slice(0, 160)}`);
      const json = JSON.parse(text);
      const content = json.choices && json.choices[0] && json.choices[0].message
        ? json.choices[0].message.content : '';
      return { content, usage: json.usage || null, model: cfg.model, attempts: attempt };
    } catch (e) {
      lastErr = e;
      if (attempt <= 1) await new Promise((r) => setTimeout(r, 1500));
    } finally { clearTimeout(timer); }
  }
  throw lastErr || new Error('AI 调用失败');
}

/* ---------------- 规则兜底解析 ---------------- */

export function ruleParse(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const out = {};
  const grab = (re) => { const m = t.match(re); return m ? m[0].trim() : ''; };

  out.unit_price = grab(/[¥￥]?\s*\d+(?:\.\d+)?\s*(?:元|块)\s*(?:\/|每)?\s*(?:条|个|支|件|只)?/);
  out.moq = grab(/\d+\s*(?:件|个|支|条|只|套)?\s*起(?:批|订|定)/);
  out.freight = grab(/(?:含运|不含运|运费[^\s，。;]*|包邮)/);
  out.sample_lead_time = grab(/打样[^\s，。;]{0,8}(?:天|周|个工作日)/);
  out.bulk_lead_time = grab(/(?:大货|批量|交货|工期)[^\s，。;]{0,10}(?:天|周|个工作日)/);
  out.sample_fee_refundable = grab(/打样费[^\s，。;]{0,12}(?:退|不退|可退|返还)/);
  out.defect_rate = grab(/(?:次品率|不良率)[^\s，。;]{0,8}(?:\d+%|‰)/);
  out.nda = grab(/(?:保密协议|NDA)[^\s，。;]{0,8}(?:可以|不行|可签|不签)?/i);

  /* 价格口径：商家常回"页面价格 +0.1"这种**相对**表述，
     必须和页面价结合才能算出真实单价（老板明确提过这个场景）。 */
  const rel = t.match(/(?:页面价|页面价格|标价|链接价)[^0-9]{0,8}?([+＋\-－]|加|高|上浮|多|减|低|下浮|少)\s*(\d+(?:\.\d+)?)/);
  const mentionsPage = /页面价|页面价格|标价|链接价/.test(t);
  const hasAbsPrice = /\d+(?:\.\d+)?\s*(?:元|块)/.test(t);
  if (rel) {
    out.price_basis = (/^[+＋]$|加|高|上浮|多/.test(rel[1])) ? 'page_plus' : 'page_minus';
    out.price_delta = Number(rel[2]);
    out.unit_price = rel[0].trim();
  } else if (mentionsPage && !hasAbsPrice) {
    out.price_basis = 'page_same';
    out.price_delta = 0;
    out.unit_price = '页面价';
  } else if (hasAbsPrice) {
    out.price_basis = 'absolute';
    out.price_delta = null;
  }

  /* 明显"不做这款"的信号 */
  const noMatch = /(不做|不生产|没有这(?:款|种)|不经营|不接(?:这|该)|不是我们(?:的|做)|找(?:别|其他)家)/.test(t);
  const yesMatch = /(可以做|能做|可以定制|支持定制|可以做货|没问题)/.test(t);

  out.is_relevant = noMatch ? false : (yesMatch ? true : null);
  const clean = {};
  for (const k of QUOTE_FIELDS) if (out[k]) clean[k] = out[k];
  if (out.price_basis) { clean.price_basis = out.price_basis; clean.price_delta = out.price_delta; }
  return { ...clean, is_relevant: out.is_relevant, _source: 'rule' };
}

/* 结合页面价算出"可比单价"。
   basis: absolute=回复里就是绝对价；page_plus/page_minus=相对页面价；page_same=与页面价相同 */
export function computeFinalPrice({ basis, delta, unitPriceRaw, pagePrice }) {
  const num = (v) => { const m = String(v == null ? '' : v).replace(/\s+/g, '').match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };
  const page = typeof pagePrice === 'number' ? pagePrice : num(pagePrice);

  if (basis === 'absolute' || (!basis && unitPriceRaw)) {
    const v = num(unitPriceRaw);
    if (v !== null) return { final: +v.toFixed(4), basis: 'absolute', note: '回复里是绝对价' };
  }
  if (basis === 'page_plus' || basis === 'page_minus') {
    if (page === null) return { final: null, basis, note: '是相对页面价，但没拿到页面价，无法换算' };
    const d = Number(delta || 0);
    const v = basis === 'page_plus' ? page + d : page - d;
    return { final: +v.toFixed(4), basis, note: `页面价 ${page} ${basis === 'page_plus' ? '+' : '-'} ${d}` };
  }
  if (basis === 'page_same') {
    if (page === null) return { final: null, basis, note: '与页面价相同，但没拿到页面价' };
    return { final: +page.toFixed(4), basis, note: '与页面价相同' };
  }
  return { final: null, basis: basis || 'unknown', note: '未能确定价格口径' };
}

/* ---------------- ① 解析供应商回复 ---------------- */

export const FIELD_DESC = QUOTE_FIELDS.map((f) => `${f}（${quoteFieldCN(f)}）`).join('、');

const PARSE_SYSTEM = `你是采购询价助手。用户会给你：我们要采购的产品、我们发出的询价、
该商品在搜索页上的页面价、**最近的完整聊天上下文**、以及供应商的回复原文。
请综合分析**所有给出的信息**——不要只看最后一句：价格/起订量/工期等信息可能分散在几条消息里，
也可能在"之前那条"里说过。只输出 JSON，不要解释：
{
  "is_relevant": true/false/null,   // 该供应商是否做我们要采购的这类产品；明确说"不做/不生产"就 false；能接就 true；无法判断给 null
  "is_meaningful": true/false,      // 这条回复是否包含实质信息（空话/表情/自动欢迎语给 false）
  "unit_price": "单价（保留原文单位，如 12元/条）",
  "price_basis": "价格口径：absolute=回复里就是绝对价；page_plus=在页面价基础上加；page_minus=在页面价基础上减；page_same=就是页面价；unknown",
  "price_delta": 0.1,               // 相对口径时填增量数字（page_plus/page_minus 才有），否则 null
  "unit_price_final": 12.5,         // 换算后的**可比单价**（元，数字）。给了页面价就自己算好；算不出填 null
  "moq": "起订量",
  "freight": "运费（含运/不含运/具体金额）",
  "sample_lead_time": "打样工期",
  "bulk_lead_time": "大货工期",
  "sample_fee_refundable": "打样费以及大货是否退",
  "price_incl_sample_fee": "大货不退时含打样费的单价（换算得出就填，否则空）",
  "remark": "其它重要信息（材质/工艺/规格等）",
  "nda": "保密协议态度",
  "defect_rate": "次品率/不良率",
  "missing_fields": ["上面哪些字段**至今仍没拿到**，用英文字段名"],
  "evidence": "每个字段的依据，简短（如 unit_price: 第2条回复说'12元/条'）"
}

判断价格口径的要点：
- "页面价格+0.1" = page_plus，delta=0.1 → **unit_price_final 必须算出来**（页面价 + 0.1）
- "按页面价""就是页面价" = page_same
- 直接给绝对值（"1.15元一支"）= absolute
- 如果上下文里之前报过价、这次只是补充别的信息，把之前的价一起带出来`;

export async function parseSupplierReply({ inquiry, replyText, product, context, known, opts = {} }) {
  const pagePrice = opts.pagePrice;
  /* 规则兜底/交叉校验都扫这份"合并文本"：只看最后一条会漏信息
     （实测"页面价格+0.1"在更早的消息里，最后一条只是"拍吧"） */
  const combined = [replyText, context || '', JSON.stringify(known || {})].join('\n');
  const user = [
    product ? `我们要采购的产品：${product}` : '',
    inquiry ? `我们发出的询价：${inquiry}` : '',
    pagePrice !== undefined && pagePrice !== null && pagePrice !== ''
      ? `该商品在搜索页上的**页面价**：${pagePrice} 元（商家可能说"页面价格+0.1"这类相对价，请据此换算出可比单价）`
      : '（没有页面价信息，若商家说的是相对页面价就把 unit_price_final 留 null）',
    context ? `最近的完整聊天上下文（按时间正序，"我方"是我们，"对方"是供应商）：\n${context}` : '',
    known && Object.keys(known).length
      ? `之前已经拿到的信息（这次回复若没提到就沿用）：${JSON.stringify(
          Object.fromEntries(QUOTE_FIELDS.filter((f) => known[f]).map((f) => [f, known[f]]))
        )}`
      : '',
    `供应商回复原文：${replyText}`
  ].filter(Boolean).join('\n');

  if (hasApiKey(opts)) {
    try {
      const r = await chat([
        { role: 'system', content: PARSE_SYSTEM },
        { role: 'user', content: user }
      ], { ...opts, json: true });
      const parsed = JSON.parse(r.content);
      parsed._source = 'ai';
      parsed._model = r.model;
      if (!Array.isArray(parsed.missing_fields)) parsed.missing_fields = [];

      /* 交叉校验：AI 主分析 + 明确模式兜底。
         "页面价格+0.1"这种**相对价**正则能 100% 认准，AI 偶尔会漏（实测漏过一次），
         所以只要原文/上下文里出现明确相对模式，就以正则的 basis/delta 为准。 */
      const scan = ruleParse(combined);
      if (scan.price_basis === 'page_plus' || scan.price_basis === 'page_minus') {
        if (parsed.price_basis !== scan.price_basis || Number(parsed.price_delta) !== Number(scan.price_delta)) {
          parsed.price_basis = scan.price_basis;
          parsed.price_delta = scan.price_delta;
          parsed._priceOverridden = '按原文的明确相对价校正';
        }
      }
      /* 兜底换算：AI 没给 final 就自己算一遍 */
      if (parsed.unit_price_final === undefined || parsed.unit_price_final === null || parsed._priceOverridden) {
        const c = computeFinalPrice({
          basis: parsed.price_basis, delta: parsed.price_delta,
          unitPriceRaw: parsed.unit_price, pagePrice
        });
        if (c.final !== null) parsed.unit_price_final = c.final;
        parsed._priceNote = c.note;
      }
      return parsed;
    } catch (e) {
      const fb = ruleParse(combined);
      const c = computeFinalPrice({ basis: fb.price_basis, delta: fb.price_delta, unitPriceRaw: fb.unit_price, pagePrice });
      if (c.final !== null) fb.unit_price_final = c.final;
      fb._priceNote = c.note;
      fb._aiError = e.message;
      return fb;
    }
  }
  const fb = ruleParse(combined);
  const c = computeFinalPrice({ basis: fb.price_basis, delta: fb.price_delta, unitPriceRaw: fb.unit_price, pagePrice });
  if (c.final !== null) fb.unit_price_final = c.final;
  fb._priceNote = c.note;
  return fb;
}

/* ---------------- ② 编写下一句回复 ---------------- */

const COMPOSE_SYSTEM = `你是采购询价助手，帮买家向供应商追问缺失信息。
要求：
1) 只问"还缺的字段"，已经问到的不要重复问；
2) 中文、口语化、简短（不超过 60 字），像真人聊天，不要分点列编号；
3) 可以顺带确认关键信息，但不要客套废话；
4) 只输出这句话本身，不要任何解释或引号。`;

export async function composeReply({ known = {}, missing = [], product, order_moq, opts = {} }) {
  const need = (missing.length ? missing : QUOTE_FIELDS).map(quoteFieldCN).join('、');
  const knownText = QUOTE_FIELDS
    .filter((f) => known[f])
    .map((f) => `${quoteFieldCN(f)}=${known[f]}`).join('；') || '（暂无）';

  const user = [
    product ? `产品：${product}` : '',
    order_moq ? `我们的需求量：${order_moq}` : '',
    `已经拿到的信息：${knownText}`,
    `还需要问的信息：${need}`,
    '请写一句追问的话。'
  ].filter(Boolean).join('\n');

  if (hasApiKey(opts)) {
    try {
      const r = await chat([
        { role: 'system', content: COMPOSE_SYSTEM },
        { role: 'user', content: user }
      ], { ...opts, temperature: 0.5 });
      const reply = String(r.content || '').trim().replace(/^["'“]|["'”]$/g, '');
      if (reply) return { reply, _source: 'ai', _model: r.model };
    } catch (e) {
      /* 落到规则话术 */
      return { reply: ruleCompose(missing, known, order_moq), _source: 'rule', _aiError: e.message };
    }
  }
  return { reply: ruleCompose(missing, known, order_moq), _source: 'rule' };
}

export function ruleCompose(missing = [], known = {}, order_moq) {
  const q = [];
  const has = (f) => missing.includes(f) && !known[f];
  if (has('unit_price')) q.push('单价多少');
  if (has('moq')) q.push('起订量多少');
  if (has('freight')) q.push('运费怎么算');
  if (has('sample_lead_time')) q.push('打样要几天');
  if (has('bulk_lead_time')) q.push('大货交期多久');
  if (has('sample_fee_refundable')) q.push('打样费多少、大货能不能退');
  if (has('nda')) q.push('能不能签保密协议');
  if (has('defect_rate')) q.push('一般次品率多少');
  if (has('remark')) q.push('还有什么要注意的');
  if (!q.length) return '好的，那就按这个来，我先确认下再回复您。';
  return '麻烦再确认下：' + q.slice(0, 4).join('，') + (order_moq ? `，我这边量是${order_moq}` : '') + '？';
}
