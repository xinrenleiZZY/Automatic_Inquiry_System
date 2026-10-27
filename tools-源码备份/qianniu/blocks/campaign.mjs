/* =====================================================================
 * 区块：比价任务（Campaign）
 * [功能区块 · v0.1 · 状态：待集成到系统 —— 见 INTEGRATION.md]
 *
 * 一个任务 = 一张商品图 + 一条询价短语，串起整条链路：
 *   图片库 → 搜图 → 联系商家 → 发询价 → 收回复 → AI解析 → 自动追问 → 报价台账 → 比价
 *
 * 为什么要有"任务"这一层：**它是并行隔离的单位**。
 *   每个任务的搜图 imageId、联系过的商家、发出的短语、收到的回复、解析出的报价
 *   全部带 campaign_id，所以多个任务同时跑不会串，回复也不会张冠李戴。
 *
 * 对外接口：
 *   createCampaign({image, phraseId, name})    建任务（图片+短语绑定）
 *   launchCampaign(id, {limit, yes})           跑"搜图 → 联系 → 发询价"
 *   collectCampaign(id, {mode})                跑"收回复 → AI解析 → 追问"（只针对本任务的商家）
 *   reportCampaign(id, {from, to})             出该任务的比价表
 * ===================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import * as store from './db.mjs';
import * as library from './library.mjs';
import * as imageSearch from './image-search.mjs';
import * as outreach from './outreach.mjs';
import * as autoReply from './auto-reply.mjs';
import { withSession, evaluate } from './session.mjs';
import { withBrowserLock } from './lock.mjs';

/* 建任务：图片 + 短语绑定。名字默认取图片文件名 */
export function createCampaign(db, { image, phraseId, name, note }) {
  const imgAbs = library.resolveImage(image);
  if (!imgAbs || !fs.existsSync(imgAbs)) throw new Error('图片不存在：' + image);
  const phrase = phraseId ? library.getPhrase(library.DEFAULT_LIBRARY, phraseId) : null;
  if (phraseId && !phrase) throw new Error('短语库里找不到：' + phraseId);
  const id = store.createCampaign(db, {
    name: name || path.basename(imgAbs, path.extname(imgAbs)),
    imageFile: imgAbs,
    phraseId: phrase ? phrase.id : '',
    phraseText: phrase ? (phrase.text || '') : '',
    note: note || ''
  });
  return store.getCampaign(db, id);
}

/* 阶段①：搜图 → 联系 TOP N 商家 → 发询价短语（会真实发送） */
export async function launchCampaign(db, campaign, opts = {}) {
  /* 浏览器操作串行化：两个任务同时跑会互相抢聊天窗口 */
  return withBrowserLock(() => launchCampaignInner(db, campaign, opts),
    { what: `campaign launch #${campaign.id}`, waitMs: opts.waitMs });
}

async function launchCampaignInner(db, campaign, opts = {}) {
  const limit = Number(opts.limit) || outreach.DEFAULT_LIMIT;
  const phrase = campaign.phrase_id ? library.getPhrase(library.DEFAULT_LIBRARY, campaign.phrase_id) : null;
  const phraseForSend = phrase
    ? { ...phrase, image: campaign.image_file }        // 用任务自己的图，而不是短语库里配的那张
    : null;

  console.log(`【任务 ${campaign.id}】${campaign.name} → 搜图`);
  const r = await imageSearch.searchByImage(campaign.image_file, {
    method: 'file', wait: 2500,
    campaignId: campaign.id
  });
  console.log(`   imageId=${r.imageId}`);
  store.updateCampaign(db, campaign.id, { image_id: r.imageId, stage: 'searched' });

  /* 页面价入库（带上任务归属） */
  try {
    const cards = await imageSearch.readResults({ limit: 60, match: r.imageId });
    for (const c of cards.cards) {
      if (!c.offerId) continue;
      store.saveOfferPrice(db, {
        campaignId: campaign.id, imageId: r.imageId, offerId: c.offerId, title: c.title,
        shopName: c.sellerNick || '', sellerNick: c.sellerNick || '',
        pagePriceRaw: c.price ? ('￥' + c.price) : '', moq: c.moq || ''
      });
    }
    console.log(`   页面价入库 ${cards.cards.length} 条`);
  } catch (e) { console.log('   ⚠️ 页面价入库失败：' + e.message); }

  if (!opts.yes) {
    const sellers = await outreach.listTopSellers(limit, { match: r.imageId });
    console.table(sellers.sellers.slice(0, limit).map((s) => ({
      序号: s.rank, 商家: (s.shopName || '').slice(0, 22), offerId: s.offerId
    })));
    console.log('（演练：已搜图并入库页面价，未联系商家。加 --yes 才真联系真发送）');
    return { imageId: r.imageId, contacted: 0 };
  }

  console.log(`   → 联系 TOP ${limit} 商家并发送询价`);
  const c = await outreach.contactTopSellers({
    limit, keep: 1, match: r.imageId,
    imageId: r.imageId, imageFile: campaign.image_file,
    phrase: phraseForSend, order: opts.order || 'text-first', baseDir: library.BASE_DIR,
    campaignId: campaign.id, skipSent: opts.skipSent !== false,
    gapMs: Number(opts.gapMs) || 3000
  });
  store.updateCampaign(db, campaign.id, { stage: 'contacted' });
  console.log(`   联系 ${c.opened}/${c.tried} ｜ 短语完整成功 ${c.results.filter((x) => x.phraseStatus === 'sent').length}`);
  return { imageId: r.imageId, contacted: c.opened };
}

/* 阶段②：只处理本任务联系过的商家 —— 收回复 → AI 解析 → 追问 */
export async function collectCampaign(db, campaign, opts = {}) {
  return withBrowserLock(() => collectCampaignInner(db, campaign, opts),
    { what: `campaign collect #${campaign.id}`, waitMs: opts.waitMs });
}

async function collectCampaignInner(db, campaign, opts = {}) {
  const contacts = store.campaignContacts(db, campaign.id);
  const shopNames = contacts.map((c) => c.shop_name).filter(Boolean);
  if (!shopNames.length) { console.log('该任务还没有联系过任何商家。'); return { processed: 0 }; }

  /* 把"店铺名"对应到的会话找出来（会话列表里比对） */
  const convs = await withSession((s) => evaluate(s, `(() => __QN.convs())()`));
  const norm = (s) => String(s || '').replace(/公司|厂|店|商行|有限公司|有限责任公司/g, '').trim();
  const wanted = new Set(shopNames.map(norm));
  const matched = convs.filter((c) => wanted.has(norm(c.name))
    || [...wanted].some((w) => w && (norm(c.name).includes(w) || w.includes(norm(c.name)))));

  /* slice：一次只处理几个会话（调度器用它把"收集"切成小步，和其他任务轮流推进） */
  const slice = Number(opts.slice) || 0;
  const picked = slice > 0 ? matched.slice(0, slice) : matched;

  console.log(`【任务 ${campaign.id}】${campaign.name} → 本任务商家 ${shopNames.length} 个，匹配到会话 ${matched.length} 个` +
              (slice ? `，本轮处理 ${picked.length} 个` : ''));
  if (!picked.length) return { processed: 0 };

  const r = await autoReply.runAutoReply({
    limit: picked.length,
    onlyConvKeys: picked.map((c) => c.key || c.id),
    campaignId: campaign.id,
    product: campaign.name,
    inquiry: campaign.phrase_text || '',
    productImage: campaign.image_file,
    mode: opts.mode || 'dry',
    dbFile: opts.dbFile
  });
  store.updateCampaign(db, campaign.id, { stage: 'collecting' });
  return { processed: picked.length, matched: matched.length, asked: r.asked, dropped: r.dropped, sent: r.sentCount, drafted: r.drafted };
}

/* 阶段③：出该任务的比价表（可按时间区间过滤） */
export function reportRows(db, campaignId, { from, to } = {}) {
  const rows = store.quotesFor(db, { campaignId, from, to });
  const out = rows.map((q) => {
    const page = q.page_price ? store.toPriceNumber(q.page_price) : null;
    const final = (q.unit_price_final === undefined || q.unit_price_final === null)
      ? null : Number(q.unit_price_final);
    return {
      供应商: (q.supplier_wangwang || '-').slice(0, 18),
      页面价: page === null ? '-' : page,
      回复价原文: q.unit_price || '-',
      口径: q.price_basis || '-',
      可比单价: final === null ? '-' : final,
      与页面价差: (final !== null && page !== null) ? +(final - page).toFixed(4) : '-',
      offerId: q.offer_id || '-',
      状态: q.status,
      更新: new Date(q.updated_at).toLocaleString('zh-CN')
    };
  });
  return out;
}
