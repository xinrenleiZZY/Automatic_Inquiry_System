/* =====================================================================
 * 区块：多会话自动回复（Auto Reply）
 * [功能区块 · v0.1 · 状态：待集成到系统 —— 见 INTEGRATION.md]
 *
 * 做什么：依次打开每个会话 → 读消息 → **AI 解析** → 写入报价台账
 *         → 判断该问什么 → 生成回复。**本阶段只演练，绝不真发。**
 *
 * 决策规则（可配）：
 *   - AI 判断"商家不做这款产品" → 放弃该客户（台账 status=dropped，不再回复）
 *   - 还有缺失字段               → 生成追问话术（action=ask）
 *   - 字段已齐                   → action=done（不再打扰）
 *
 * 去重：同一条来消息只处理一次（按 conv_key+时间+内容 指纹记在 auto_replies.msg_key）
 * ===================================================================== */

import { withSession, evaluate, sleep } from './session.mjs';
import * as store from './db.mjs';
import * as ai from './ai.mjs';
import * as input from './input.mjs';
import { enforceSingleTabs } from './tabs.mjs';
import { withBrowserLock } from './lock.mjs';

/* 打开指定会话（在会话列表里点它）。优先按会话 id 精确匹配，其次按名字。 */
export async function openConversation(session, { convKey, convName }) {
  /* 先把会话列表切回"全部"标签：停在 AI询/联系人 时会看不到普通会话 */
  const tab = await evaluate(session, `(() => __QN.ensureAllTab())()`);
  if (tab === 'clicked') await sleep(1200);

  /* 用 JS click 切换会话：CDP 模拟坐标点击实测**换不了会话**
     （点完 activeConvId 仍是上一个），JS click 稳定生效。 */
  const clicked = await evaluate(session, `(() => {
    const d = __QN.core(); if (!d) return null;
    const items = Array.from(d.querySelectorAll('.conversation-item'));
    const byId = ${JSON.stringify(convKey || '')} ? items.find((e) => e.id === ${JSON.stringify(convKey || '')}) : null;
    const nm = (e) => ((e.querySelector('.name') || {}).textContent || '').trim();
    const target = byId
      || (${JSON.stringify(convName || '')} ? items.find((e) => nm(e) === ${JSON.stringify(convName || '')}) : null)
      || (${JSON.stringify(convName || '')} ? items.find((e) => nm(e).includes(${JSON.stringify(convName || '')})) : null);
    if (!target) return null;
    target.scrollIntoView({ block: 'center' });
    const inner = target.querySelector('.conversation') || target;
    inner.click();
    return { id: target.id, name: nm(target), via: 'js-click' };
  })()`);
  await sleep(1500);
  return clicked;
}

/* 等"切换完成"：必须等到当前激活会话 == 目标会话 id。
   之前只判断"有 active 或消息>1"，上一个会话还开着就立刻满足了，
   结果读到的是上一个会话的消息 → 客户与会话整体错位一格（实测踩过）。 */
export async function waitConversationLoaded(session, convKey, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await evaluate(session, `(() => ({
      active: __QN.activeConvId(), msgs: __QN.msgItems().length
    }))()`);
    if (convKey ? st.active === convKey : (st.active || st.msgs > 1)) return st;
    await sleep(600);
  }
  return await evaluate(session, `(() => ({ active: __QN.activeConvId(), msgs: __QN.msgItems().length }))()`);
}

/* 主流程：逐个会话跑一遍解析与回复编排（不发消息） */
/* 发送护栏：把"机器自动回"限制在安全范围内。
   返回 { ok, why }；被拦时不会发送，但会留痕。 */
export function guardCheck(db, opts, convKey, now = Date.now()) {
  const maxPerHour = Number(opts.maxPerHour) || 30;
  const minIntervalMs = opts.minIntervalMs === undefined ? 20000 : Number(opts.minIntervalMs);

  const sentRecent = db.prepare(
    `SELECT COUNT(*) n FROM auto_replies WHERE sent = 1 AND epoch > ?`
  ).get(now - 3600000).n;
  if (sentRecent >= maxPerHour) return { ok: false, why: `全局已达每小时上限 ${maxPerHour} 条` };

  if (minIntervalMs > 0) {
    const last = db.prepare(
      `SELECT MAX(epoch) t FROM auto_replies WHERE sent = 1 AND conv_key = ?`
    ).get(convKey).t;
    if (last && now - last < minIntervalMs) {
      return { ok: false, why: `距上次给该客户发送仅 ${((now - last) / 1000).toFixed(0)}s（下限 ${minIntervalMs / 1000}s）` };
    }
  }

  if (opts.quietHours) {
    const h = new Date().getHours();
    const [from, to] = opts.quietHours;
    const quiet = from <= to ? (h >= from && h < to) : (h >= from || h < to);
    if (quiet) return { ok: false, why: `免打扰时段（${from}:00–${to}:00）` };
  }
  return { ok: true };
}

export async function runAutoReply(opts = {}) {
  return withBrowserLock(() => runAutoReplyInner(opts),
    { what: 'auto-reply' + (opts.campaignId ? ' #' + opts.campaignId : ''), waitMs: opts.waitMs });
}

async function runAutoReplyInner(opts = {}) {
  const limit = Number(opts.limit) || 20;
  const product = opts.product || '';
  const inquiry = opts.inquiry || '';
  const orderMoq = opts.orderMoq || '';
  const dry = opts.dry !== false;          // 默认就是演练
  /* 动作模式：dry(只解析) / draft(只填草稿待人工点发) / send(真实发送) */
  const mode = opts.mode || (dry ? 'dry' : 'send');
  const dbFile = opts.dbFile || store.DB_PATH;

  const db = store.openDb(dbFile);
  const processed = store.processedMsgKeys(db);
  const report = {
    conversations: 0, scanned: 0, parsed: 0, asked: 0, done: 0, dropped: 0, skipped: 0,
    blocked: 0, drafted: 0, sentCount: 0, results: []
  };

  /* 我方主体前缀（识别内部同事会话用）：取一条"我方"消息的发送者前缀 */
  const outRow = db.prepare(`SELECT sender FROM messages WHERE direction='out' AND sender LIKE '%:%' LIMIT 1`).get();
  const ourPrefix = outRow ? String(outRow.sender).split(':')[0] : '';

  /* 固定用同一个聊天窗口（标签已收敛为 1 个），否则发送可能落到别的窗口 */
  let chatTarget = '';
  try { chatTarget = await withSession(async (s, page) => page.id); } catch { /* ignore */ }

  try {
  const convs = await withSession((s) => evaluate(s, `(() => __QN.convs())()`));
    /* onlyConvKeys：只处理指定会话（比价任务用它做隔离 —— 一次任务只管自己联系过的商家） */
    const only = Array.isArray(opts.onlyConvKeys) && opts.onlyConvKeys.length
      ? new Set(opts.onlyConvKeys) : null;
    const targets = convs
      .filter((c) => !c.isSelf)
      .filter((c) => !only || only.has(c.key || c.id) || only.has(c.name))
      .slice(0, limit);
    report.conversations = targets.length;
    console.log(`扫描 ${targets.length} 个会话（产品：${product || '未指定'}）｜ 模式：${dry ? '演练（不发消息）' : '★真实发送★'}`);

    for (const c of targets) {
      const convKey = c.key || c.id || '';
      console.log(`\n── ${c.name} ──`);

      /* 跳过"内部同事"会话：同一主体下的子账号（如 playworld152:lqy，
         会话显示名常就是我们主体名）会出现在会话列表里，但它们不是供应商，
         不该发询价话术。判定依据是我方主体前缀。 */
      if (ourPrefix && String(c.name || '').trim().startsWith(ourPrefix)) {
        console.log(`   跳过：内部同事会话（${c.name}）`);
        report.skipped++;
        continue;
      }

      const opened = await withSession(async (s) => {
        const r = await openConversation(s, { convKey, convName: c.name });
        if (!r) return null;
        const st = await waitConversationLoaded(s, convKey, 15000);
        const msgs = await evaluate(s, `(() => __QN.parse())()`);
        return { st, msgs };
      });
      if (!opened) { console.log('   跳过：会话列表里找不到这一项'); report.skipped++; continue; }
      if (opened.st.active !== convKey) {
        console.log(`   跳过：会话没切换成功（当前=${(opened.st.active || '(空)').slice(0, 30)}）`);
        report.skipped++;
        continue;
      }

      const msgs = opened.msgs || [];
      const inbound = msgs.filter((m) => m.kind === 'msg' && !m.mine);
      report.scanned += inbound.length;

      /* 只看最后一条对方消息（真实场景就是"最新来消息"） */
      const last = inbound[inbound.length - 1];
      if (!last) { console.log('   没有对方消息，跳过'); report.skipped++; continue; }

      const msgKey = convKey + '|' + (last.time || '') + '|' + (last.text || '');
      if (processed.has(msgKey)) { console.log('   这条已处理过，跳过'); report.skipped++; continue; }

      /* 该客户是否已判"不做" → 不再打扰 */
      const q = db.prepare(`SELECT * FROM supplier_quotes WHERE conv_key = ? ORDER BY id DESC LIMIT 1`).get(convKey);
      if (q && q.status === 'dropped') { console.log('   该客户已标记"不做此产品"，跳过'); report.skipped++; continue; }

      console.log(`   来消息：${(last.text || '').slice(0, 50)}`);

      /* AI 解析 */
      /* 这个客户对应的商品页面价（商家可能按"页面价格+0.1"报价，需要基准） */
      const offerRow = store.findOfferPrice(db, { offerId: q ? q.offer_id : '', shopName: c.name });
      /* 把"最近的完整聊天上下文 + 已拿到的信息"一起交给 AI：
         价格/起订量/工期常分散在几条消息里，只看最后一句会漏。 */
      const ctx = msgs.slice(-8).map((m) => (m.mine ? '我方' : '对方') + ': ' + (m.text || '')).join('\n');
      const parsed = await ai.parseSupplierReply({
        inquiry, replyText: last.text, product,
        context: ctx, known: q || {},
        opts: { ...opts, pagePrice: offerRow ? offerRow.page_price_num : null }
      });
      report.parsed++;
      const fields = {};
      for (const f of store.QUOTE_FIELDS) if (parsed[f]) fields[f] = parsed[f];

      /* 供应商旺旺账号：取"对方"里**不属于我方主体**的最近一个发送者。
         同一主体下的同事子账号（如 playworld152:lqy）也会出现在会话里，
         不排除的话会把同事误记成供应商（实测踩过）。 */
      const outSenders = msgs.filter((m) => m.mine && m.sender).map((m) => m.sender);
      const senderPrefix = outSenders.length      // 注意：别再用 ourPrefix 这个名字，
        ? (outSenders[0].includes(':') ? outSenders[0].split(':')[0] : outSenders[0])
        : '';                                     // 会遮蔽外层的同名常量，触发 TDZ 报错
      const supplierMsg = [...inbound].reverse()
        .find((m) => m.sender && !(senderPrefix && m.sender.startsWith(senderPrefix + ':')));
      const supplier = (supplierMsg || {}).sender || c.name;
      const quoteId = store.upsertQuote(db, {
        conv_key: convKey,
        campaign_id: opts.campaignId || null,
        phrase: inquiry,
        product_image: opts.productImage || '',
        supplier_wangwang: supplier,
        offer_id: (q && q.offer_id) || (offerRow && offerRow.offer_id) || '',
        raw_text: last.text,
        page_price: offerRow ? (offerRow.page_price_raw || '') : '',
        price_basis: parsed.price_basis || '',
        unit_price_final: (parsed.unit_price_final === undefined || parsed.unit_price_final === null)
          ? null : parsed.unit_price_final,
        ...fields
      });

      /* 决策 */
      const row = db.prepare(`SELECT * FROM supplier_quotes WHERE id = ?`).get(quoteId);
      let action = 'ignore', reply = '', missing = [];

      if (parsed.is_relevant === false) {
        action = 'drop';
        store.upsertQuote(db, { conv_key: convKey, status: 'dropped' });
        reply = '（该商家不做这款产品，放弃该客户，不再回复）';
        report.dropped++;
        console.log('   🚫 AI 判断：不做这款产品 → 放弃该客户');
      } else {
        missing = store.missingQuoteFields(row);
        if (missing.length) {
          action = 'ask';
          const c2 = await ai.composeReply({ known: row, missing, product, order_moq: orderMoq, opts });
          reply = c2.reply;
          report.asked++;
          console.log(`   ❓ 还缺 ${missing.length} 项 → 拟回复：${reply}`);
        } else {
          action = 'done';
          store.upsertQuote(db, { conv_key: convKey, status: 'quoted' });
          reply = '（信息已齐，不再追问）';
          report.done++;
          console.log('   ✅ 信息已齐，不再追问');
        }
      }

      console.log(`   解析来源：${parsed._source === 'ai' ? 'AI(' + (parsed._model || '') + ')' : '规则兜底'}｜ 解析到字段：${Object.keys(fields).join(', ') || '无'}`);
      if (parsed.unit_price_final || parsed._priceNote) {
        console.log(`   价格口径：${parsed.price_basis || '未知'}` +
          (parsed.unit_price_final ? ` → 可比单价 ${parsed.unit_price_final} 元` : '') +
          (offerRow ? `（页面价 ${offerRow.page_price_num}）` : '') +
          (parsed._priceNote ? ` ｜ ${parsed._priceNote}` : ''));
      }

      const arId = store.saveAutoReply(db, {
        convKey, convName: c.name, inboundText: last.text,
        campaignId: opts.campaignId || null,
        aiRelevant: parsed.is_relevant, aiAction: action, aiReply: reply,
        missing: missing.map(store.quoteFieldCN).join('、'),
        sent: 0,                      // 演练：一律记 0
        msgKey,
        detail: JSON.stringify({ parsed, url: c.url || '' }).slice(0, 400)
      });

      /* ── 动作阶段：draft=只填草稿 / send=真发；两者都要先过护栏；dry=只解析 ── */
      let execNote = mode === 'dry' ? '演练未发送' : '';
      if (action === 'ask' && reply && mode !== 'dry') {
        const gate = guardCheck(db, opts, convKey);
        if (!gate.ok) {
          console.log(`   ⛔ 护栏拦截：${gate.why}`);
          store.setAutoReplyResult(db, arId, { action: 'blocked', sent: false, detail: '护栏拦截：' + gate.why });
          report.blocked++;
          execNote = '被护栏拦截';
        } else {
          const r = await withSession(async (s) => {
            const clicked = await openConversation(s, { convKey, convName: c.name });
            if (!clicked) return { ok: false, why: '切换会话失败' };
            const st = await waitConversationLoaded(s, convKey, 15000);
            if (st.active !== convKey) return { ok: false, why: '会话未激活' };
            if (mode === 'draft') {
              const d = await input.draftOn(s, reply);
              return { ok: true, draft: d };
            }
            const r2 = await input.sendTextOn(s, reply);
            return { ok: !!r2.ok, detail: r2 };
          }, chatTarget ? { targetId: chatTarget } : undefined);

          if (mode === 'draft') {
            console.log(`   📝 已填入草稿（待人工确认发送）：${String(r.draft || '').slice(0, 40)}`);
            store.setAutoReplyResult(db, arId, { action: 'drafted', sent: false, detail: JSON.stringify(r).slice(0, 300) });
            report.drafted++;
            execNote = '已填草稿';
          } else {
            console.log(r.ok ? `   ✅ 已发送：${reply.slice(0, 40)}` : `   ❌ 发送失败：${JSON.stringify(r).slice(0, 120)}`);
            store.setAutoReplyResult(db, arId, { action: r.ok ? 'sent' : 'send_failed', sent: !!r.ok, detail: JSON.stringify(r).slice(0, 300) });
            if (r.ok) report.sentCount++;
            execNote = r.ok ? '已发送' : '发送失败';
          }
        }
      }

      report.results.push({
        conv: c.name, action, missing: missing.length, reply: reply.slice(0, 60),
        source: parsed._source, exec: execNote
      });
    }
  } finally {
    db.close();
    try { await enforceSingleTabs({}); } catch { /* ignore */ }
  }

  return report;
}
