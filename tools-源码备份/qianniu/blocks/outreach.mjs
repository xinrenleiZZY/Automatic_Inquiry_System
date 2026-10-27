/* =====================================================================
 * 区块：逐个联系商家（Outreach）
 * [功能区块 · v0.1 · 状态：待集成到系统 —— 见 INTEGRATION.md]
 *
 *   在"以图搜图"结果页上，点每张卡片的「联系卖家」按钮，
 *   打开 1688 旺旺聊天窗口，并把「图片 ↔ 商家」的对应关系落库。
 *
 * 用户给的选择器（首张卡片，作为参考）：
 *   #offer-list-content > div > div.colFeeds--cDXP1T0K > div > div:nth-child(1)
 *     > div.offerShopRow--GrxWF5ev > div.colRight--CxHK5xFZ > span > a
 * 但 nth-child(1) 写死了第一张卡，所以实际按「每张卡片内部」查找：
 *   [class*="offerShopRow"] a[href*="def_cbu_web_im"]   （兜底 a.ww-link）
 *
 * 要点：
 *   - 点击用 CDP 真实鼠标事件（先 hover 卡片，再点链接）；
 *   - 点完等新标签出现；没出现就退化为直接打开链接；
 *   - 只保留 1 个聊天窗口：新开之后关掉其余的（keep 可调）；
 *   - 数量可调（limit，默认 10）。
 * ===================================================================== */

import { browserSession } from '../cdp-lib.mjs';
import { withSession, evaluate, sleep } from './session.mjs';
import * as store from './db.mjs';
import { RESULTS_MATCH, waitForCards } from './image-search.mjs';
import * as phraseSend from './phrase-send.mjs';
import { enforceSingleTabs } from './tabs.mjs';
import { withBrowserLock } from './lock.mjs';

export const DEFAULT_LIMIT = 10;
export const CHAT_PATH_MARK = '/def_cbu_web_im/';

/* 每张卡片内部找联系链接（含兜底选择器） */
const LINK_FINDER = `
  const link = card.querySelector('[class*="offerShopRow"] a[href*="def_cbu_web_im"]')
            || card.querySelector('a.ww-link')
            || card.querySelector('[class*="colRight"] a[href*="def_cbu_web_im"]');
`;

/* 读出前 N 张卡片的商家信息（不点击，纯读） */
export async function listTopSellers(limit = DEFAULT_LIMIT, opts = {}) {
  return withSession(async (session) => {
    /* 结果页异步渲染：不等卡片出来就会读到 0 条（刚搜完立刻读，实测踩过） */
    await waitForCards(session, Number(opts.waitRenderMs) || 20000);
    return evaluate(session, `(() => {
    const limit = ${Number(limit)};
    const cards = Array.from(document.querySelectorAll('#offer-list-content [class*="searchOfferWrapper"]'));
    /* 顺手把当前结果页的 imageId 带出来："图片 ↔ 商家"要靠它对应 */
    const imageId = (location.search.match(/imageId=(\\d+)/) || [])[1] || '';
    const out = [];
    for (let i = 0; i < cards.length && out.length < limit; i++) {
      const card = cards[i];
      ${LINK_FINDER}
      const renderKey = card.getAttribute('data-renderkey') || '';
      const offerId = (renderKey.match(/(\\d{9,})$/) || [])[1] || '';
      const shopRow = card.querySelector('[class*="offerShopRow"]');
      const shopText = shopRow ? (shopRow.innerText || '').replace(/\\s+/g, ' ').trim() : '';
      const shopName = shopText.replace(/^入驻\\d+年\\s*/, '').replace(/^\\d+年\\s*/, '').slice(0, 40);
      const ww = card.querySelector('[data-nick]');
      let sellerNick = '';
      if (ww) { try { sellerNick = decodeURIComponent(ww.getAttribute('data-nick') || ''); } catch { sellerNick = ww.getAttribute('data-nick') || ''; } }
      const uid = link ? ((link.getAttribute('href') || '').match(/uid=([^&]+)/) || [])[1] || '' : '';
      out.push({
        index: i,
        rank: out.length + 1,
        offerId,
        shopName,
        sellerNick,
        chatUid: uid ? (() => { try { return decodeURIComponent(uid); } catch { return uid; } })() : '',
        href: link ? link.href : '',
        hasLink: !!link
      });
    }
    return { total: cards.length, imageId, url: location.href, sellers: out };
  })()`);
  }, { match: opts.match || RESULTS_MATCH, allowTitle: false });
}

/* 点"某个 offerId"对应的卡片的联系按钮。
   为什么按 offerId 而不是下标：每点一次卡片列表都会重排/重渲染，
   用下标会错位（实测 10 个里偶数位全部"卡片不存在"）。 */
async function clickContact(session, offerId, index) {
  /* 优先用 JS 直接点：链接是 <a target="_blank">，
     link.click() 稳定打开新窗口且 URL 带 touid（会话能正常加载）。
     之前用模拟鼠标坐标，实测经常点不动 → 退化成 createTarget 打开，
     那种窗口不加载会话，导致随后发消息全部失败（一次 10/10 全挂）。 */
  const tryClick = `(() => {
    const cards = Array.from(document.querySelectorAll('#offer-list-content [class*="searchOfferWrapper"]'));
    if (!cards.length) return { retry: true, reason: '卡片列表为空（正在重渲染）' };
    const byOffer = cards.find((c) => (c.getAttribute('data-renderkey') || '').endsWith(${JSON.stringify(String(offerId))}));
    const card = byOffer || cards[${index}];
    if (!card) return null;
    card.scrollIntoView({ block: 'center' });
    const link = card.querySelector('[class*="offerShopRow"] a[href*="def_cbu_web_im"]')
              || card.querySelector('a.ww-link');
    if (!link) return null;
    const href = link.href;
    link.click();
    return { href, target: link.getAttribute('target') || '', via: 'js-click',
             matchedBy: byOffer ? 'offerId' : 'index' };
  })()`;

  /* 联系动作会让结果页重渲染（卡片列表短暂为空），所以这里轮询等待，
     直到卡片回来再点——不做重试的话会有一半左右的点击落空（实测偶数位全挂）。 */
  for (let attempt = 1; attempt <= 12; attempt++) {
    const r = await evaluate(session, tryClick);
    if (r && r.href) return r;
    await sleep(900);
  }

  /* 兜底：老的坐标点击 */
  const hover = await evaluate(session, `(() => {
    const card = document.querySelectorAll('#offer-list-content [class*="searchOfferWrapper"]')[${index}];
    if (!card) return null;
    card.scrollIntoView({ block: 'center' });
    const r = card.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + Math.min(80, r.height / 2) };
  })()`);
  if (!hover) throw new Error(`第 ${index + 1} 张卡片不存在`);

  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hover.x, y: hover.y });
  await sleep(400);

  const box = await evaluate(session, `(() => {
    const card = document.querySelectorAll('#offer-list-content [class*="searchOfferWrapper"]')[${index}];
    if (!card) return null;
    ${LINK_FINDER}
    if (!link) return null;
    const r = link.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, href: link.href };
  })()`);
  if (!box) throw new Error(`第 ${index + 1} 张卡片找不到联系链接`);

  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await sleep(150);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await session.send('Input.dispatchMouseEvent', {
      type, x: box.x, y: box.y, button: 'left', clickCount: 1,
      buttons: type === 'mousePressed' ? 1 : 0
    });
  }
  return box;
}

/* 等一个"新的聊天窗口"出现（返回 targetId）；没有就返回 null */
async function waitNewChatTarget(browser, beforeIds, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { targetInfos } = await browser.send('Target.getTargets');
    const chat = targetInfos.filter((t) => t.type === 'page' && (t.url || '').includes(CHAT_PATH_MARK));
    const fresh = chat.find((t) => !beforeIds.has(t.targetId));
    if (fresh) return fresh;
    await sleep(400);
  }
  return null;
}

async function chatTargets(browser) {
  const { targetInfos } = await browser.send('Target.getTargets');
  return targetInfos.filter((t) => t.type === 'page' && (t.url || '').includes(CHAT_PATH_MARK));
}

/* 等聊天窗口加载到能用（输入区就绪） */
async function waitChatReady(session, timeoutMs = 35000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      /* 必须连"贴图 input"也出现才算就绪：
         实测刚加载完时文字编辑器已可用，但贴图组件还没挂好，
         此时发图片会静默失败（第一次发得出去，后续/新窗口就不行）。 */
      const state = await evaluate(session, `(() => {
        const d = __QN.core();
        if (!d || !__QN.input()) return null;
        const pic = d.querySelector(${JSON.stringify(
          'div.editor-tool div.ybdd-im-picupload input[type="file"][accept="image/*"]'
        )});
        /* 关键：还必须有"已激活的会话"，否则窗口虽开着但会话没加载，
           消息区只有"暂无更多消息"，发文字和图片都会失败（实测 msg:1→1）。 */
        const active = __QN.activeConvId();
        return { ready: !!pic && !!active, hasPic: !!pic, active: active || '', loadState: document.readyState };
      })()`);
      if (state && state.ready) {
        await sleep(1500);        // 再给它一点时间挂事件
        return true;
      }
    } catch (e) { /* 页面还在跳 */ }
    await sleep(600);
  }
  return false;
}

/* 主流程：逐个联系 TOP N 商家，并落库 */
export async function contactTopSellers(opts = {}) {
  return withBrowserLock(() => contactTopSellersInner(opts),
    { what: 'outreach', waitMs: opts.waitMs });
}

async function contactTopSellersInner(opts = {}) {
  const limit = Number(opts.limit) || DEFAULT_LIMIT;
  const keep = opts.keep === undefined ? 1 : Number(opts.keep);   // 保留几个聊天窗口
  const match = opts.match || RESULTS_MATCH;
  const gapMs = Number(opts.gapMs) || 1200;

  const listed = await listTopSellers(limit, { match });
  let { sellers } = listed;
  const total = listed.total;

  /* --skip-sent：跳过已经"图文都发成功过"的商家，避免重复打扰 */
  if (opts.skipSent) {
    const db0 = store.openDb(opts.dbFile || store.DB_PATH);
    try {
      /* 多任务时必须**按任务**判断，否则任务B会跳过任务A联系过的商家。
         有 campaignId → 只看本任务已联系的商家（image_contacts）；没有 → 退回全局已发送记录。 */
      const done = opts.campaignId
        ? db0.prepare(`SELECT offer_id, shop_name AS conv_name FROM image_contacts WHERE campaign_id = ?`).all(opts.campaignId)
        : db0.prepare(`SELECT offer_id, conv_name FROM phrase_sends WHERE image_status='sent' AND text_status='sent'`).all();
      const norm = (s) => String(s || '').replace(/公司|厂|店|商行|有限公司|有限责任公司/g, '').trim();
      const okOffers = new Set(done.map((d) => d.offer_id).filter(Boolean));
      const okNames = new Set(done.map((d) => norm(d.conv_name)).filter(Boolean));
      const before = sellers.length;
      sellers = sellers.filter((s) => !okOffers.has(s.offerId) && !okNames.has(norm(s.shopName)));
      const skipped = before - sellers.length;
      if (skipped) console.log(`   ⏭️  跳过已发送成功的商家 ${skipped} 个（--skip-sent）`);
      if (!sellers.length) {
        console.log('   （TOP 列表里的商家都已发送过，无需重复发送）');
        return { total, tried: 0, opened: 0, failed: 0, results: [] };
      }
    } finally { db0.close(); }
  }
  if (!sellers.length) {
    throw new Error('当前匹配到的页面里没有商品卡片（可能没打开结果页）。' +
      '先跑 image-search 或 image-replay 打开结果页，再用 --image <imageId> 指定。');
  }
  /* 没显式给 imageId 就用结果页自带的 */
  const imageId = opts.imageId || listed.imageId || '';
  const imageFile = opts.imageFile || '';
  if (imageId) console.log(`  关联 imageId=${imageId}`);
  else console.log('  ⚠️ 没拿到 imageId，落库的"图片↔商家"对应会缺图片标识');
  const results = [];
  const browser = await browserSession();
  try {
    const before0 = await chatTargets(browser);
    const preexisting = new Set(before0.map((t) => t.targetId));
    if (preexisting.size) console.log(`（开始时已有 ${preexisting.size} 个聊天窗口）`);

    let keepId = null;
    for (const s of sellers) {
      if (!s.hasLink) {
        results.push({ ...s, status: 'no-link', detail: '卡片里没有联系链接' });
        continue;
      }
      const beforeIds = new Set((await chatTargets(browser)).map((t) => t.targetId));
      let newTarget = null, detail = '';
      try {
        const href = await withSession(async (sess) => {
          const box = await clickContact(sess, s.offerId, s.index);
          return box.href;
        }, { match });
        s.href = href || s.href;
      } catch (e) {
        detail = '点击失败：' + e.message;
      }

      /* 等新窗口（点击常常不弹新标签，4 秒没等到就直接开链接，更快也更稳） */
      newTarget = await waitNewChatTarget(browser, beforeIds, 4000);
      if (!newTarget && s.href) {
        /* 兜底：直接打开链接 */
        try {
          const r = await browser.send('Target.createTarget', { url: s.href });
          newTarget = { targetId: r.targetId, url: s.href };
          detail = detail ? detail + '；改用直接打开链接' : '未检测到新窗口，改用直接打开链接';
        } catch (e) {
          detail = (detail ? detail + '；' : '') + '打开链接失败：' + e.message;
        }
      }

      const status = newTarget ? 'opened' : 'failed';
      const rec = {
        ...s, status, detail,
        chatUrl: newTarget ? (newTarget.url || '') : '',
        targetId: newTarget ? newTarget.targetId : ''
      };

      /* 开了聊天窗口 + 指定了短语 → 顺手把图文短语发出去 */
      if (newTarget && opts.phrase) {
        try {
          const sent = await withSession(async (sess) => {
          const ready = await waitChatReady(sess);
            if (!ready) throw new Error('聊天窗口 35 秒内没加载完（未出现已激活会话）');
            return phraseSend.sendPhraseOn(sess, opts.phrase, { order: opts.order, baseDir: opts.baseDir });
          }, { targetId: newTarget.targetId });
          rec.phraseId = opts.phrase.id;
          rec.phraseStatus = sent.ok ? 'sent' : 'partial';
          rec.phraseImageOk = sent.imageResult ? !!sent.imageResult.ok : null;
          rec.phraseTextOk = sent.textResult ? !!sent.textResult.ok : null;
          rec.phraseImageFile = sent.imageResult ? sent.imageResult.file : '';
          rec.phraseDetail = JSON.stringify({
            text: sent.textResult ? sent.textResult.ok : null,
            image: sent.imageResult ? sent.imageResult.ok : null,
            retried: sent.imageResult ? !!sent.imageResult.retried : false,
            msg: sent.imageResult ? (sent.imageResult.msgBefore + '→' + sent.imageResult.msgAfter) : ''
          });
          if (!sent.ok) rec.detail = (rec.detail ? rec.detail + '；' : '') + '短语发送未完全成功';
        } catch (e) {
          rec.phraseStatus = 'failed';
          rec.phraseImageOk = null;
          rec.phraseTextOk = null;
          rec.phraseDetail = e.message;
          rec.detail = (rec.detail ? rec.detail + '；' : '') + '短语发送异常：' + e.message;
        }
      }

      results.push(rec);

      /* 只保留 keep 个聊天窗口 */
      if (newTarget && keep >= 0) {
        keepId = newTarget.targetId;
        const all = await chatTargets(browser);
        const keepSet = new Set([keepId]);
        /* 若要保留更多，就把最近打开的也留下 */
        const opened = results.filter((r) => r.status === 'opened').map((r) => r.targetId);
        for (let i = opened.length - 1; i >= 0 && keepSet.size < Math.max(1, keep); i--) keepSet.add(opened[i]);

        for (const t of all) {
          if (keepSet.has(t.targetId)) continue;
          try {
            await browser.send('Target.closeTarget', { targetId: t.targetId });
            console.log(`   🧹 关闭多余聊天窗口 ${t.targetId.slice(0, 8)}…`);
          } catch (e) {
            console.log(`   ⚠️ 关闭失败 ${t.targetId.slice(0, 8)}…：${e.message}`);
          }
        }
      }

      console.log(`[${s.rank}/${sellers.length}] ${s.shopName || s.sellerNick} → ${status}` +
                  (rec.phraseStatus ? ` ｜ 短语:${rec.phraseStatus}` : '') +
                  (detail ? `（${detail}）` : ''));
      await sleep(gapMs);
    }
  } finally {
    browser.close();
  }

  /* 收尾：搜索页/结果页/聊天各只留一个（聊天窗口在循环里已经控制过，
     这里主要清掉多余的结果页） */
  try {
    const t = await enforceSingleTabs({ keepImageId: imageId });
    const extra = t.closed.filter((c) => c.kind !== 'chat');
    if (extra.length) console.log(`   🧹 收尾清理重复标签 ${extra.length} 个`);
  } catch (e) { /* 忽略 */ }

  /* 落库：图片 ↔ 商家 */
  const db = store.openDb(opts.dbFile || store.DB_PATH);
  try {
    const now = Date.now();
    for (const r of results) {
      store.saveImageContact(db, {
        epoch: now,
        campaignId: opts.campaignId || null,
        imageId,
        imageFile,
        offerId: r.offerId, shopName: r.shopName, sellerNick: r.sellerNick,
        chatUid: r.chatUid, chatUrl: r.chatUrl || r.href || '',
        rank: r.rank, status: r.status,
        detail: [r.detail, r.phraseStatus ? `短语:${r.phraseStatus}` : '', r.phraseDetail || '']
          .filter(Boolean).join(' | ').slice(0, 400)
      });
      /* 短语发送也单独留痕（图/文分别记），便于统计与排错 */
      if (opts.phrase && r.phraseStatus) {
        store.savePhraseSend(db, {
          epoch: now,
          campaignId: opts.campaignId || null,
          phraseId: opts.phrase.id,
          phraseText: opts.phrase.text || '',
          imagePath: r.phraseImageFile || '',
          convKey: r.chatUid || r.targetId || '',
          convName: r.shopName || r.sellerNick || '',
          offerId: r.offerId || '',
          imageStatus: r.phraseImageOk === null ? 'skipped' : (r.phraseImageOk ? 'sent' : 'failed'),
          textStatus: r.phraseTextOk === null ? 'skipped' : (r.phraseTextOk ? 'sent' : 'failed'),
          detail: (r.phraseDetail || r.detail || '').slice(0, 300)
        });
      }
    }
  } finally { db.close(); }

  return {
    total: total,
    tried: sellers.length,
    opened: results.filter((r) => r.status === 'opened').length,
    failed: results.filter((r) => r.status !== 'opened').length,
    results
  };
}
