#!/usr/bin/env node
/* =====================================================================
 * 1688 网页版旺旺 · CLI（薄壳）
 *
 * 这里只做「参数解析 + 打印」，所有能力都在 blocks/ 的功能区块里。
 * 将来组合成系统时，直接 import blocks/index.mjs，不要依赖本文件的 CLI。
 *
 * 子命令：
 *   read                    读取当前会话消息（带方向）
 *   convs                   读取会话列表
 *   draft "文本"            只填输入框，不发送
 *   send  "文本" --yes      发送
 *   clear                   清空输入框
 *   phrases                 点开快捷短语弹窗并列出内容
 *   quick <序号|文本> --yes  选短语填入（加 --yes 则发送）
 *   watch [秒] [间隔ms]     前台实时监听
 *   monitor [--interval n]  常驻监听（--once 单次巡检 / --duration 秒）
 *   log [条数] / stats      查看日志与统计
 *   selftest                逐区块自测
 * ===================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { messages, conversations, input, phrases, monitor, logstore, session, db as dbBlock, reply as replyBlock, imageSearch, outreach, library, phraseSend, tabs, ai, autoReply, imageLibrary, sweep, campaign as campaignBlock, scheduler as schedulerBlock } from './blocks/index.mjs';
import { runSelfTest } from './selftest.mjs';

/* =====================================================================
 * scheduler：一个终端同时推进多个比价任务
 *   node im.mjs scheduler [--round 180] [--slice 2] [--per-task 10]
 *                         [--dry] [--draft|--send] [--once] [--duration 秒]
 * ===================================================================== */
async function cmdScheduler() {
  await schedulerBlock.runScheduler({
    roundMs: Number(flag('round', 180)) * 1000,
    slice: Number(flag('slice', 2)),
    perTask: Number(flag('per-task', 10)),
    gapMs: Number(flag('gap', 3000)),
    mode: has('send') ? 'send' : (has('draft') ? 'draft' : 'dry'),
    dry: has('dry'),
    once: has('once'),
    duration: Number(flag('duration', 0)),
    dbFile: flag('file', dbBlock.DB_PATH)
  });
}

/* =====================================================================
 * campaign：比价任务（图片+短语绑定，串起整条链路，多个任务并行不冲突）
 *   node im.mjs campaign new --image <图片> --phrase <短语id> [--name 商品名]
 *   node im.mjs campaign list
 *   node im.mjs campaign launch <id> [--limit 10] [--yes]   搜图→联系→发询价
 *   node im.mjs campaign collect <id> [--draft|--send]      收回复→AI解析→追问（只本任务的商家）
 *   node im.mjs campaign report <id> [--from 2026-09-01] [--to 2026-09-30]
 * ===================================================================== */
const ts = (v) => {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 1e11) return n;                 // 已是 epoch
  const d = new Date(String(v).replace(/\//g, '-'));            // 支持 2026-09-01
  return Number.isNaN(d.getTime()) ? null : d.getTime();
};

async function cmdCampaign(sub, arg) {
  const d = dbBlock.openDb(flag('file', dbBlock.DB_PATH));
  try {
    switch (sub) {
      case undefined:
      case 'list': {
        const rows = dbBlock.listCampaigns(d, Number(flag('limit', 20)) || 20);
        console.log(`比价任务 ${rows.length} 个：`);
        if (!rows.length) { console.log('（空。用 campaign new 建一个）'); return; }
        console.table(rows.map((c) => ({
          id: c.id, 商品: (c.name || '').slice(0, 20),
          图片: (c.image_file || '').split(/[\\/]/).pop(),
          短语: c.phrase_id || '-', imageId: c.image_id || '-',
          阶段: c.stage, 状态: c.status,
          创建: new Date(c.created_at).toLocaleString('zh-CN')
        })));
        return;
      }
      case 'new': {
        const image = flag('image', '');
        const phraseId = flag('phrase', '');
        if (!image) { console.log('用法: node im.mjs campaign new --image <图片> [--phrase <短语id>] [--name 商品名]'); return; }
        const c = campaignBlock.createCampaign(d, {
          image, phraseId, name: flag('name', ''), note: flag('note', '')
        });
        console.log('✅ 已创建比价任务：');
        console.log(JSON.stringify({
          id: c.id, 商品: c.name, 图片: c.image_file, 短语: c.phrase_id || '(未指定)',
          短语文字: c.phrase_text || '', 阶段: c.stage
        }, null, 2));
        console.log(`\n下一步： node im.mjs campaign launch ${c.id} --limit 10 [--yes]`);
        return;
      }
      case 'launch': {
        const c = dbBlock.getCampaign(d, Number(arg));
        if (!c) { console.log('找不到任务：' + arg); return; }
        const r = await campaignBlock.launchCampaign(d, c, {
          limit: Number(flag('limit', 10)), yes: has('yes'),
          gapMs: Number(flag('gap', 3000)), order: flag('order', 'text-first')
        });
        console.log(`任务 ${c.id} 阶段①完成：imageId=${r.imageId} ｜ 已联系 ${r.contacted} 家`);
        return;
      }
      case 'collect': {
        const c = dbBlock.getCampaign(d, Number(arg));
        if (!c) { console.log('找不到任务：' + arg); return; }
        const mode = has('send') ? 'send' : (has('draft') ? 'draft' : 'dry');
        const r = await campaignBlock.collectCampaign(d, c, { mode, dbFile: flag('file', dbBlock.DB_PATH) });
        console.log(`任务 ${c.id} 阶段②完成：处理 ${r.processed} 个会话 ｜ 追问 ${r.asked || 0} ｜ 放弃 ${r.dropped || 0}` +
                    (mode === 'dry' ? '（演练未发送）' : ` ｜ 已发送 ${r.sent || 0} / 已填草稿 ${r.drafted || 0}`));
        return;
      }
      case 'report': {
        const c = dbBlock.getCampaign(d, Number(arg));
        if (!c) { console.log('找不到任务：' + arg); return; }
        const from = ts(flag('from', '')), to = ts(flag('to', ''));
        const rows = campaignBlock.reportRows(d, c.id, { from, to });
        console.log(`=== 任务 ${c.id} ｜ ${c.name} 比价表 ===`);
        console.log(`图片 ${(c.image_file || '').split(/[\\/]/).pop()} ｜ 短语 ${c.phrase_id || '-'} ｜ imageId ${c.image_id || '-'}`);
        if (from || to) console.log(`时间区间：${from ? new Date(from).toLocaleString('zh-CN') : '(不限)'} → ${to ? new Date(to).toLocaleString('zh-CN') : '(不限)'}`);
        if (!rows.length) { console.log('（该任务还没有报价数据）'); return; }
        console.table(rows);
        const priced = rows.filter((x) => typeof x.可比单价 === 'number');
        if (priced.length) {
          console.log(`\n结论：${priced.length} 家有可比价 ｜ 最低 ${priced[0].可比单价}（${priced[0].供应商}）` +
                      ` ｜ 最高 ${priced[priced.length - 1].可比单价}（${priced[priced.length - 1].供应商}）` +
                      ` ｜ 价差 ${(priced[priced.length - 1].可比单价 - priced[0].可比单价).toFixed(4)}`);
        }
        return;
      }
      default:
        console.log('用法: node im.mjs campaign <new|list|launch|collect|report> [参数]');
    }
  } finally { d.close(); }
}

/* =====================================================================
 * sweep / lib-images：全量抓历史 + 图片库对接
 *   node im.mjs sweep [--limit 50] [--scroll 3]     逐个会话抓历史入库
 *   node im.mjs lib-images list|sync|pending|bind   图片库管理
 *   node im.mjs run-pending [--limit 3] [--yes]     把待处理图片逐张跑完整流程
 * ===================================================================== */
async function cmdSweep() {
  const r = await sweep.sweep({
    limit: Number(flag('limit', 50)),
    scroll: Number(flag('scroll', 0)),
    interval: Number(flag('interval', 1500)),
    dbFile: flag('file', dbBlock.DB_PATH)
  });
  console.log(`\n汇总：访问 ${r.visited}/${r.conversations} 个会话 ｜ 跳过 ${r.skipped} ｜ 新入库消息 ${r.saved} 条`);
  if (r.results.length) {
    console.table(r.results.map((x) => ({
      会话: x.conv.slice(0, 18), 读到: x.read, 对方: x.inbound, 新入库: x.saved, 上滚轮数: x.rounds
    })));
  }
}

async function cmdLibImages(sub, arg) {
  const dir = flag('dir', imageLibrary.DEFAULT_IMAGE_DIR);
  const db = dbBlock.openDb(flag('file', dbBlock.DB_PATH));
  try {
    const images = imageLibrary.listImages({ dir });
    if (!sub || sub === 'list') {
      imageLibrary.syncLibrary(db, images);
      const rows = dbBlock.listLibraryImages(db);
      console.log(`图片库目录：${dir}`);
      console.log(`共 ${rows.length} 张：`);
      console.table(rows.map((r) => ({
        文件: r.file_name, 大小KB: Math.round((r.size || 0) / 1024),
        配对短语: r.phrase_id || '(未指定)', 状态: r.status,
        搜图imageId: r.image_id || '-',
        上次处理: r.last_run_at ? new Date(r.last_run_at).toLocaleString('zh-CN') : '-'
      })));
      return;
    }
    if (sub === 'sync') {
      const r = imageLibrary.syncLibrary(db, images);
      console.log(`✅ 同步完成：目录里 ${r.total} 张，新入库 ${r.added} 张`);
      return;
    }
    if (sub === 'pending') {
      const pend = imageLibrary.pendingImages(db, images);
      console.log(`待处理 ${pend.length} 张（未处理或状态不是 done）：`);
      console.table(pend.map((p) => ({ 文件: p.fileName, 路径: p.path.slice(-40) })));
      return;
    }
    if (sub === 'bind') {
      const file = arg;                       // 文件名或路径
      const phraseId = flag('phrase', '');
      if (!file || !phraseId) { console.log('用法: node im.mjs lib-images bind <文件名> --phrase <短语id>'); return; }
      const img = images.find((i) => i.fileName === file || i.path === file || i.base === file);
      if (!img) { console.log('目录里找不到这张图：' + file); return; }
      imageLibrary.bindPhrase(db, img.path, phraseId);
      console.log(`✅ 已配对：${img.fileName} → 短语 ${phraseId}`);
      return;
    }
    console.log('用法: node im.mjs lib-images <list|sync|pending|bind> [参数]');
  } finally { db.close(); }
}

/* 把图片库里"待处理"的图片逐张跑完整流程（搜图 → 联系 TOP N → 发图文短语） */
async function cmdRunPending() {
  const db = dbBlock.openDb(flag('file', dbBlock.DB_PATH));
  let pend;
  try {
    const images = imageLibrary.listImages({ dir: flag('dir', imageLibrary.DEFAULT_IMAGE_DIR) });
    imageLibrary.syncLibrary(db, images);
    pend = imageLibrary.pendingImages(db, images);
  } finally { db.close(); }

  const limit = Number(flag('limit', 3));
  const perImage = Number(flag('per-image', 10));
  const batch = pend.slice(0, limit);
  if (!batch.length) { console.log('没有待处理的图片。'); return; }
  console.log(`待处理 ${pend.length} 张，本次处理 ${batch.length} 张：`);
  console.table(batch.map((b) => ({ 文件: b.fileName })));

  for (const img of batch) {
    console.log(`\n===== 处理：${img.fileName} =====`);
    /* 该图配的短语：库里指定优先，否则用命令行给的那条 */
    const d = dbBlock.openDb(flag('file', dbBlock.DB_PATH));
    let row;
    try { row = d.prepare(`SELECT * FROM image_library WHERE path = ?`).get(img.path); }
    finally { d.close(); }
    const phraseId = (row && row.phrase_id) || flag('phrase', '');
    const phrase = phraseId ? library.getPhrase(flag('lib', library.DEFAULT_LIBRARY), phraseId) : null;
    if (phraseId && !phrase) { console.log('⚠️ 短语库里找不到 ' + phraseId + '，跳过'); continue; }

    const r = await imageSearch.searchByImage(img.path, { method: 'file', wait: 2500 });
    console.log(`  搜图完成 imageId=${r.imageId}`);

    if (has('yes')) {
      const c = await outreach.contactTopSellers({
        limit: perImage, keep: Number(flag('keep', 1)), match: r.imageId,
        imageId: r.imageId, imageFile: img.path,
        phrase, order: flag('order', 'text-first'), baseDir: library.BASE_DIR,
        skipSent: has('skip-sent')
      });
      console.log(`  联系 ${c.opened}/${c.tried} ｜ 短语完整成功 ${c.results.filter((x) => x.phraseStatus === 'sent').length}`);
    } else {
      const sellers = await outreach.listTopSellers(perImage, { match: r.imageId });
      console.log(`  （演练）待联系 ${sellers.sellers.length} 个商家，加 --yes 才会真联系真发送`);
    }

    /* 标记该图已处理 */
    const d2 = dbBlock.openDb(flag('file', dbBlock.DB_PATH));
    try {
      dbBlock.markLibraryImage(d2, img.path, { status: 'done', imageId: r.imageId, phraseId });
    } finally { d2.close(); }
  }
  console.log('\n全部处理完成。');
}

/* =====================================================================
 * AI 与自动回复
 *   node im.mjs ai-test                     验证 DeepSeek 是否可用
 *   node im.mjs ai-parse "供应商回复原文"     单条解析演示
 *   node im.mjs quotes [n]                  看供应商报价台账
 *   node im.mjs auto-reply [--limit 10]     多会话自动回复（默认演练，不发消息）
 * ===================================================================== */
async function cmdAiTest() {
  const cfg = ai.resolveConfig();
  console.log(`配置：${cfg.baseUrl} ｜ 模型 ${cfg.model} ｜ key ${cfg.apiKey ? cfg.apiKey.slice(0, 8) + '****' : '(无)'}`);
  if (!cfg.apiKey) { console.log('❌ 没有 key：可在 tools/qianniu/ai-config.json 里填 apiKey，或设环境变量 DEEPSEEK_API_KEY'); return; }

  const sample = '可以做，涤纶的。宽132*高45是12元/条含运不含税，起订量300条。打样3天，打样费200块大货可退，大货工期15天左右，次品率1%以内。';
  console.log('\n测试解析：\n  ' + sample);
  const parsed = await ai.parseSupplierReply({
    inquiry: '金色羽毛笔,黑色笔芯,0.5针管,要400支,每支装opp袋,算下价格',
    replyText: sample,
    product: '定制窗帘/笔类打样'
  });
  console.log('\n解析结果：');
  const show = {};
  for (const f of dbBlock.QUOTE_FIELDS) show[dbBlock.quoteFieldCN(f)] = parsed[f] || '';
  show['是否做该产品'] = parsed.is_relevant === null ? '(无法判断)' : (parsed.is_relevant ? '是' : '否');
  show['解析来源'] = parsed._source + (parsed._model ? '(' + parsed._model + ')' : '');
  console.log(JSON.stringify(show, null, 2));
  if (parsed._aiError) console.log('⚠️ AI 调用失败，已用规则兜底：' + parsed._aiError);

  const missing = dbBlock.QUOTE_FIELDS.filter((f) => !parsed[f]);
  const com = await ai.composeReply({ known: parsed, missing, product: '定制窗帘', order_moq: '400支' });
  console.log('\n拟追问（缺 ' + missing.length + ' 项）：' + com.reply);
}

async function cmdAiParse(text) {
  if (!text) { console.log('用法: node im.mjs ai-parse "供应商回复原文"'); return; }
  const parsed = await ai.parseSupplierReply({ inquiry: flag('inquiry', ''), replyText: text, product: flag('product', '') });
  console.log(JSON.stringify(parsed, null, 2));
}

async function cmdQuotes(n) {
  const d = dbBlock.openDb(flag('file', dbBlock.DB_PATH));
  try {
    const rows = dbBlock.listQuotes(d, Number(n) || 30);
    console.log(`供应商报价台账 ${rows.length} 条：`);
    if (!rows.length) { console.log('（空。先跑 auto-reply 或 ai-parse 写数据）'); return; }
    console.table(rows.map((r) => ({
      供应商: (r.supplier_wangwang || '').slice(0, 16),
      单价: r.unit_price || '-', 起订量: r.moq || '-', 运费: r.freight || '-',
      打样工期: r.sample_lead_time || '-', 大货工期: r.bulk_lead_time || '-',
      打样费: r.sample_fee_refundable || '-', 次品率: r.defect_rate || '-',
      状态: r.status, 更新: new Date(r.updated_at).toLocaleString('zh-CN')
    })));
  } finally { d.close(); }
}

async function cmdAutoReply() {
  /* 模式：默认演练；--draft 只填草稿等人工点发送；--send 真发（会过护栏） */
  const mode = has('send') ? 'send' : (has('draft') ? 'draft' : 'dry');
  const r = await autoReply.runAutoReply({
    limit: Number(flag('limit', 20)),
    product: flag('product', ''),
    inquiry: flag('inquiry', ''),
    orderMoq: flag('order-moq', ''),
    productImage: flag('product-image', ''),
    dry: mode === 'dry',
    mode,
    minIntervalMs: Number(flag('min-interval', 20000)),
    maxPerHour: Number(flag('max-per-hour', 30)),
    dbFile: flag('file', dbBlock.DB_PATH)
  });
  console.log(`\n汇总：扫描 ${r.conversations} 个会话 ｜ 对方消息 ${r.scanned} 条 ｜ 解析 ${r.parsed} 条`);
  console.log(`追问 ${r.asked} ｜ 信息已齐 ${r.done} ｜ 放弃客户 ${r.dropped} ｜ 跳过 ${r.skipped}`);
  console.log(`执行（模式 ${mode}）：已发送 ${r.sentCount} ｜ 已填草稿 ${r.drafted} ｜ 被护栏拦截 ${r.blocked}`);
  if (r.results.length) {
    console.table(r.results.map((x) => ({
      客户: x.conv.slice(0, 18), 动作: x.action, 缺项: x.missing,
      拟回复: x.reply, 来源: x.source === 'ai' ? 'AI' : '规则', 执行: x.exec || ''
    })));
  }
  if (mode === 'dry') console.log('（演练模式：没有任何消息被发送，留痕见 auto_replies 表）');
  else if (mode === 'draft') console.log('（草稿模式：只把话术填进输入框，需要你人工点发送）');
  else console.log('（发送模式：已过护栏的消息才真正发出，全部留痕在 auto_replies 表）');
}

/* =====================================================================
 * tabs / run：标签治理 与 一条命令跑完整流程
 *   node im.mjs tabs                       看看现在开了哪些页面
 *   node im.mjs tabs clean                 搜索页/结果页/聊天 各只留一个
 *   node im.mjs run --phrase <id> [--image 图片] [--limit 5] [--yes]
 *
 *   run 的流程：选短语 → 用短语的图（可用 --image 覆盖）搜图
 *              → 联系 TOP N 商家 → 逐家发送「短语文字 + 图片」
 *              不加 --yes 时只到"列出待联系商家"为止，不点不发送。
 * ===================================================================== */
async function cmdTabs(sub) {
  if (sub === 'clean') {
    const r = await tabs.enforceSingleTabs({});
    console.log(`清理完成：关掉 ${r.closed.length} 个，保留 ${r.kept.length} 个`);
    if (r.closed.length) {
      console.table(r.closed.map((c) => ({ 类别: tabs.KIND[c.kind] || c.kind, 标签: c.targetId.slice(0, 8) })));
    }
    const list = await tabs.listTabs();
    console.log('当前：' + tabs.summarizeTabs(list));
    return;
  }
  const list = await tabs.listTabs();
  console.log('当前标签页：' + tabs.summarizeTabs(list));
  console.table(list.map((t) => ({
    类别: tabs.KIND[t.kind] || t.kind,
    标题: (t.title || '').slice(0, 16),
    imageId: t.imageId || '', 聊天对象: t.chatUid || '',
    targetId: t.targetId.slice(0, 8)
  })));
}

async function cmdRun() {
  const confirmed = has('yes');
  const phraseId = flag('phrase', '');
  let phrase = null;
  if (phraseId) {
    phrase = library.getPhrase(flag('lib', library.DEFAULT_LIBRARY), phraseId);
    if (!phrase) throw new Error('短语库里找不到：' + phraseId);
  }

  /* 图片：--image 优先；没给就用短语自带的图 */
  const imageArg = flag('image', '') || (phrase ? phrase.image : '');
  if (!imageArg) throw new Error('没有可用图片：用 --phrase <id> 选一条带图的短语，或用 --image <路径> 指定');
  const imageAbs = library.resolveImage(imageArg);

  const limit = Number(flag('limit', outreach.DEFAULT_LIMIT));
  const order = flag('order', 'text-first');

  console.log('=== 一条命令跑完整流程 ===');
  console.log(`短语：${phrase ? `${phrase.name}（${phrase.id}）` : '(未选，只搜图)'}`);
  console.log(`图片：${imageAbs}${flag('image', '') ? '（--image 指定）' : '（取自短语库）'}`);
  console.log(`联系数量：${limit} ｜ 发送顺序：${order} ｜ ${confirmed ? '★ 会真实发送 ★' : '演练（只搜图+列商家）'}`);

  const r = await imageSearch.searchByImage(imageAbs, { method: 'file', wait: 2500 });
  console.log(`\n搜图完成：imageId=${r.imageId}`);

  const sellers = await outreach.listTopSellers(limit, { match: r.imageId });
  console.log(`\n待联系商家（前 ${sellers.sellers.length} / 共 ${sellers.total} 张卡片）：`);
  console.table(sellers.sellers.map((s) => ({
    序号: s.rank, 商家: (s.shopName || '').slice(0, 22), 旺旺: (s.sellerNick || '').slice(0, 12),
    offerId: s.offerId, 可点: s.hasLink ? '✓' : '✗'
  })));

  if (!confirmed) {
    console.log('\n未加 --yes：只做到这里（没有联系、没有发送）。');
    console.log(`确认执行： node im.mjs run --phrase ${phraseId || '<id>'} --limit ${limit} --yes`);
    return;
  }

  if (!phrase) throw new Error('要发送就必须选一条短语：--phrase <id>');

  const c = await outreach.contactTopSellers({
    limit, keep: Number(flag('keep', 1)), match: r.imageId,
    imageId: r.imageId, imageFile: imageAbs,
    phrase, order, baseDir: library.BASE_DIR,
    skipSent: has('skip-sent'),
    gapMs: Number(flag('gap', 3000))
  });
  console.log(`\n联系结果：成功 ${c.opened} / 失败 ${c.failed}（共 ${c.tried} 个）`);
  const sent = c.results.filter((x) => x.phraseStatus === 'sent').length;
  console.log(`短语发送：完整成功 ${sent} 个`);
}

/* =====================================================================
 * lib / phrase-send：快捷短语库与图文发送
 *   node im.mjs lib list                    列出短语库
 *   node im.mjs lib sync                    JSON → 数据库同步
 *   node im.mjs lib add --id x --text "..." --image path --name "名字"
 *   node im.mjs phrase-send <id|名称> [--yes] [--order text-first|image-first]
 *                                           发给当前会话（不加 --yes 只填文字草稿）
 * ===================================================================== */
async function cmdLib(sub, arg) {
  const file = flag('lib', library.DEFAULT_LIBRARY);
  switch (sub) {
    case undefined:
    case 'list': {
      const list = library.listPhrases(file);
      console.log(`短语库 ${file}`);
      console.log(`共 ${list.length} 条：`);
      console.table(list.map((p) => ({
        id: p.id, 名称: p.name, 文字: (p.text || '').slice(0, 24),
        图片: p.image ? (p.image.split(/[\\/]/).pop()) : '(无)',
        标签: Array.isArray(p.tags) ? p.tags.join(',') : '',
        启用: p.enabled ? '是' : '否'
      })));
      return;
    }
    case 'sync': {
      const list = library.listPhrases(file);
      const d = dbBlock.openDb(flag('file', dbBlock.DB_PATH));
      try {
        const n = library.syncToDb(d, list);
        console.log(`✅ 已同步 ${n} 条短语 → phrase_library 表`);
        console.table(dbBlock.listPhrases(d).map((p) => ({
          phrase_id: p.phrase_id, 名称: p.name, 文字: (p.text || '').slice(0, 20),
          图片: p.image_name || '(无)', 启用: p.enabled ? '是' : '否'
        })));
      } finally { d.close(); }
      return;
    }
    case 'add': {
      const rec = library.addPhrase(file, {
        id: flag('id', ''),
        name: flag('name', ''),
        text: flag('text', ''),
        image: flag('image', ''),
        tags: (flag('tags', '') || '').split(',').filter(Boolean)
      });
      console.log('✅ 已加入短语库：', JSON.stringify(rec, null, 2));
      console.log('记得同步进库： node im.mjs lib sync');
      return;
    }
    default:
      console.log('用法: node im.mjs lib <list|sync|add> [参数]');
  }
}

async function cmdPhraseSend(idOrName, confirmed) {
  if (!idOrName) {
    console.log('用法: node im.mjs phrase-send <id|名称> [--yes] [--order text-first|image-first]');
    return;
  }
  const phrase = library.getPhrase(flag('lib', library.DEFAULT_LIBRARY), idOrName);
  if (!phrase) throw new Error('短语库里找不到：' + idOrName);

  const imageAbs = library.resolveImage(phrase.image);
  console.log(`短语：${phrase.name}（${phrase.id}）`);
  console.log(`  文字：${phrase.text || '(无)'}`);
  console.log(`  图片：${imageAbs || '(无)'}`);
  console.log(`  顺序：${flag('order', 'text-first')}`);

  if (!confirmed) {
    /* 不加 --yes：只把文字填进草稿，不贴图不发（贴图是"点了就发"，不能预演） */
    if (phrase.text) {
      const draft = await input.draft(phrase.text);
      console.log(`\n⚠️  未加 --yes：只填了文字草稿（${JSON.stringify(draft)}），没贴图也没发送。`);
      console.log('   注意：贴图按钮是"点了就发"，无法预演，所以图片只能真发。');
      console.log(`   确认发送： node im.mjs phrase-send ${idOrName} --yes`);
    } else {
      console.log('\n⚠️  该短语只有图片，未加 --yes 时不执行（贴图即发送）。');
    }
    return;
  }

  /* 先取当前会话，用于留痕"发给了谁" */
  const convs = await conversations.readConversations();
  const currentConv = convs.find((c) => c.active) || null;

  const r = await phraseSend.sendPhrase(phrase, {
    order: flag('order', 'text-first'),
    dbFile: flag('file', dbBlock.DB_PATH),
    /* 记下"发给了谁"：否则留痕里客户是空的（之前确实出现过） */
    convKey: currentConv ? (currentConv.key || currentConv.id || '') : '',
    convName: currentConv ? currentConv.name : ''
  });
  console.log('\n发送结果：');
  console.log(JSON.stringify({
    文字: r.textResult ? (r.textResult.ok ? '✅ 已发送' : '❌ 失败') : '(无)',
    图片: r.imageResult ? (r.imageResult.ok ? '✅ 已发送' : '❌ 失败') : '(无)',
    消息数: r.textResult ? `${r.textResult.countBefore} → ${r.textResult.countAfter}` : '-',
    图片消息数: r.imageResult ? `${r.imageResult.msgBefore} → ${r.imageResult.msgAfter}` : '-'
  }, null, 2));
  console.log(r.ok ? '✅ 短语发送完成' : '⚠️ 有部分未成功，请核对界面');
}

/* =====================================================================
 * image-search：以图搜图
 *   node im.mjs image-search "图片路径" [--method file|paste] [--wait 2000]
 *   node im.mjs image-results [条数]        读取当前结果页的商品卡
 *   node im.mjs open-search                 打开搜索页
 * ===================================================================== */
async function cmdImageSearch(file, opts = {}) {
  if (!file) {
    console.log('用法: node im.mjs image-search "图片路径" [--method file|paste] [--wait 2000]');
    console.log('  默认 method=file（走页面上传通道，不碰剪贴板）');
    console.log('  --method paste 会覆盖你的系统剪贴板，然后 Ctrl+V 粘贴');
    return;
  }
  const method = flag('method', 'file');
  const wait = Number(flag('wait', 2000));
  console.log(`以图搜图：${file}`);
  console.log(`通道：${method === 'paste' ? '剪贴板 + Ctrl+V' : '页面上传通道'} | 等待 ${wait}ms`);

  const r = await imageSearch.searchByImage(file, { method, wait });
  console.log(JSON.stringify(r, null, 2));
  if (r.imageId) console.log('imageId（服务端生成）=' + r.imageId + '　可重放： node im.mjs image-replay ' + r.imageId);

  /* 落库：本地图片 -> imageId -> 结果，便于回溯与重放 */
  try {
    /* 只读本次那次搜索的结果页（用 imageId 定位），避免读到别的标签里的旧结果 */
    const cards = await imageSearch.readResults({
      limit: 60,                       // 全部读下来：页面价是比价的基准
      match: r.imageId ? r.imageId : undefined
    });
    const top = cards.cards[0] || {};
    const d = dbBlock.openDb(flag('file', dbBlock.DB_PATH));
    try {
      dbBlock.saveImageSearch(d, {
        imageFile: r.file, imageId: r.imageId, method: r.method,
        cardCount: cards.total, topOffer: top.offerId || '', topPrice: top.price || '',
        resultUrl: r.urlAfter
      });
      /* 把这批商品的**页面价**落库（比价时用来换算"页面价格+0.1"这类相对报价） */
      let savedPrice = 0;
      for (const c of cards.cards) {
        if (!c.offerId) continue;
        dbBlock.saveOfferPrice(d, {
          imageId: r.imageId, offerId: c.offerId, title: c.title,
          shopName: c.sellerNick || '', sellerNick: c.sellerNick || '',
          pagePriceRaw: c.price ? ('￥' + c.price) : '', moq: c.moq || ''
        });
        savedPrice++;
      }
      console.log(`   页面价已入库 ${savedPrice} 条（imageId=${r.imageId}）`);
    } finally { d.close(); }
    if (top.title) console.log('首个结果：' + top.title.slice(0, 40) + ' ￥' + (top.price || '-'));
  } catch (e) {
    console.log('（结果落库失败：' + e.message + '）');
  }

  /* --contact N：搜完直接逐个联系 TOP N 商家（把 imageId/图片一起带上） */
  const contactN = Number(flag('contact', 0));
  if (contactN > 0 && r.imageId && r.navigated) {
    console.log(`\n自动联系 TOP ${contactN} 商家…`);
    const phraseId = flag('phrase', '');
    const phrase = phraseId ? library.getPhrase(flag('lib', library.DEFAULT_LIBRARY), phraseId) : null;
    if (phraseId && !phrase) throw new Error('短语库里找不到：' + phraseId);
    if (phrase) {
      console.log(`  携带短语：${phrase.name} → 文字「${(phrase.text || '').slice(0, 18)}」+ 图片「${(phrase.image || '').split(/[\\/]/).pop() || '无'}」`);
    }
    const c = await outreach.contactTopSellers({
      limit: contactN,
      keep: Number(flag('keep', 1)),
      match: r.imageId,
      imageId: r.imageId,
      imageFile: r.file,
      /* 短语也要传下去，否则"搜图+联系+发送"这条链会漏掉发送这一步 */
      phrase,
      order: flag('order', 'text-first'),
      baseDir: library.BASE_DIR,
      skipSent: has('skip-sent')
    });
    console.log(`联系结果：成功 ${c.opened} / 失败 ${c.failed}（共 ${c.tried} 个）`);
  }

  if (!r.navigated) {
    console.log('⚠️  URL 未变化，可能没进结果页；把这张图人工拖进搜索框试试，或改用 --method paste');
  } else {
    console.log('✅ 已进入结果页');
  }
}

async function cmdImageReplay(idOrUrl) {
  if (!idOrUrl) {
    console.log('用法: node im.mjs image-replay <imageId 或 结果页URL>');
    console.log('imageId 来自 image-search 的输出，或 db 里 image_searches.image_id');
    return;
  }
  const r = await imageSearch.replaySearch(idOrUrl);
  console.log(r.reused ? '结果页已开着：' + r.url : '✅ 已用 imageId 重放结果页：' + r.url);
}

async function cmdImageRecent(n) {
  const d = dbBlock.openDb(flag('file', dbBlock.DB_PATH));
  try {
    const rows = dbBlock.listImageSearches(d, Number(n) || 10);
    console.log(`以图搜图记录 ${rows.length} 条：`);
    console.table(rows.map((r) => ({
      时间: new Date(r.epoch).toLocaleString('zh-CN'),
      图片: (r.image_file || '').split('\\').pop(),
      通道: r.method, imageId: r.image_id, 卡片数: r.card_count,
      首个offerId: r.top_offer, 首个价格: r.top_price
    })));
  } finally { d.close(); }
}

async function cmdImageResults(n) {
  const r = await imageSearch.readResults({ limit: Number(n) || 20 });
  console.log('结果页:', r.title, '|', r.url.slice(0, 90));
  if (!r.cards.length) { console.log('没解析到商品卡（页面结构可能不同，跑 probe-search.js 看看）'); return; }
  console.log(`商品卡 ${r.cards.length} 个：`);
  console.table(r.cards.map((c, i) => ({
    序号: i, 标题: c.title.slice(0, 30), 价格: c.price,
    起批: c.moq || '-', 卖家: (c.sellerNick || '').slice(0, 12),
    offerId: c.offerId || '-'
  })));
  const first = r.cards.find((c) => c.href);
  if (first) console.log('商品链接示例：' + first.href);
}

async function cmdOpenSearch() {
  const r = await imageSearch.openSearchPage();
  console.log(r.opened ? '✅ 已打开搜索页：' + r.url : '搜索页已经开着：' + r.url);
}

/* =====================================================================
 * image-contact：逐个联系 TOP N 商家（打开旺旺聊天 + 落库）
 *   node im.mjs image-contact [--limit 10] [--keep 1] [--image <imageId>]
 *   node im.mjs image-sellers [--limit 10]   只看不点（列出待联系的商家）
 *   node im.mjs image-contacts [n]           查看"图片↔商家"记录
 * ===================================================================== */
async function cmdImageContact() {
  const limit = Number(flag('limit', outreach.DEFAULT_LIMIT));
  const keep = Number(flag('keep', 1));
  const imageId = flag('image', '');
  const imageFile = flag('file-image', '');

  /* --phrase <id>：每联系一个商家，就顺手把这条图文短语发出去 */
  const phraseId = flag('phrase', '');
  let phrase = null;
  if (phraseId) {
    phrase = library.getPhrase(flag('lib', library.DEFAULT_LIBRARY), phraseId);
    if (!phrase) throw new Error('短语库里找不到：' + phraseId);
    console.log(`  携带短语：${phrase.name} → 文字「${(phrase.text || '').slice(0, 20)}」+ 图片「${(phrase.image || '').split(/[\\/]/).pop() || '无'}」`);
    console.log('  （贴图是"点了就发"，所以图文会是两条消息）');
  }

  console.log(`逐个联系商家：TOP ${limit} 个（聊天窗口保留 ${keep} 个）`);
  if (imageId) console.log(`  限定结果页 imageId=${imageId}`);

  const r = await outreach.contactTopSellers({
    limit, keep,
    match: imageId || undefined,
    imageId, imageFile,
    phrase,
    order: flag('order', 'text-first'),
    baseDir: library.BASE_DIR,
    skipSent: has('skip-sent'),
    gapMs: Number(flag('gap', 1200))
  });

  console.log(`\n结果：共 ${r.total} 张卡片，尝试联系 ${r.tried} 个，成功 ${r.opened} 个，失败 ${r.failed} 个`);
  console.table(r.results.map((x) => ({
    序号: x.rank, 商家: (x.shopName || x.sellerNick || '').slice(0, 20),
    offerId: x.offerId || '-', 状态: x.status, 说明: (x.detail || '').slice(0, 24)
  })));
}

async function cmdImageSellers(limit) {
  const r = await outreach.listTopSellers(Number(limit) || outreach.DEFAULT_LIMIT);
  console.log(`结果页共 ${r.total} 张卡片，取前 ${r.sellers.length} 个商家（未点击）：`);
  console.table(r.sellers.map((s) => ({
    序号: s.rank, 商家: (s.shopName || '').slice(0, 22), 旺旺昵称: (s.sellerNick || '').slice(0, 14),
    offerId: s.offerId, 有联系链接: s.hasLink ? '✓' : '✗'
  })));
}

async function cmdImageContacts(n) {
  const d = dbBlock.openDb(flag('file', dbBlock.DB_PATH));
  try {
    const rows = dbBlock.listImageContacts(d, Number(n) || 30);
    console.log(`图片↔商家 记录 ${rows.length} 条：`);
    console.table(rows.map((r) => ({
      时间: new Date(r.epoch).toLocaleString('zh-CN'),
      imageId: r.image_id || '-', 序号: r.rank, 商家: (r.shop_name || '').slice(0, 20),
      offerId: r.offer_id || '-', 状态: r.status
    })));
  } finally { d.close(); }
}

/* =====================================================================
 * reply / rules / replies：发送与回复
 *   node im.mjs reply "文本" [--yes]        给当前会话发文本（不加 --yes 只填草稿）
 *   node im.mjs reply --phrase 0 [--yes]    用第 0 条快捷短语回复
 *   node im.mjs rules [文件]                校验并列出规则
 *   node im.mjs replies [条数]              查看回复留痕
 * ===================================================================== */
async function cmdReply(text, confirmed) {
  const phraseIdx = flag('phrase', undefined);
  let result;

  if (phraseIdx !== undefined) {
    const r = await phrases.use(Number(phraseIdx), { send: confirmed });
    result = { content: r.draft || r.text, sent: r.sent, action: 'phrase:' + phraseIdx };
    console.log('快捷短语:', JSON.stringify(r.text));
    console.log(confirmed ? '发送校验: ' + JSON.stringify(r.sent)
                          : '未加 --yes，只填入不发送。当前输入框: ' + JSON.stringify(r.draft));
  } else {
    if (!text) throw new Error('用法: reply "文本" [--yes]  或  reply --phrase <序号> [--yes]');
    if (!confirmed) {
      const draft = await input.draft(text);
      /* 注意：这里不能提前 return，否则会跳过下面的留痕落库 */
      result = { content: draft, sent: null, action: 'text' };
      console.log('未加 --yes，只填草稿。当前输入框:', JSON.stringify(draft));
    } else {
      const r = await input.sendText(text);
      result = { content: text, sent: r, action: 'text' };
      console.log('发送校验:', JSON.stringify(r));
      console.log(r.ok ? '✅ 发送成功' : '⚠️ 校验未通过，请人工核对');
    }
  }

  /* 手工回复也留痕，方便和自动回复一起审计 */
  const d = dbBlock.openDb(flag('file', dbBlock.DB_PATH));
  try {
    const convs = await conversations.readConversations();
    const active = convs.find((c) => c.active);
    const ok = result.sent ? result.sent.ok : false;
    dbBlock.saveReply(d, {
      epoch: Date.now(),
      convKey: active ? conversations.convId(active) : '',
      convName: active ? active.name : '',
      inboundText: '',
      ruleName: 'manual',
      action: result.action,
      content: result.content || '',
      status: confirmed ? (ok ? 'sent' : 'failed') : 'draft',
      detail: result.sent ? JSON.stringify(result.sent) : '未发送（缺 --yes）'
    });
  } finally { d.close(); }
}

async function cmdRules(file) {
  const f = file || flag('rules', null);
  if (!f) {
    console.log('用法: node im.mjs rules <规则文件>        校验并列出规则');
    console.log('示例文件: tools/qianniu/rules.example.json');
    return;
  }
  const { rules, guards } = replyBlock.loadRulesFile(f);
  console.log(`规则文件：${f}`);
  console.log('护栏：', JSON.stringify({ ...replyBlock.DEFAULT_GUARDS, ...guards }, null, 2));
  console.table(rules.map((r, i) => ({
    序号: i, 名称: r.name, 启用: r.enabled === false ? '否' : '是',
    条件: JSON.stringify(r.match).slice(0, 46),
    动作: r.reply.phraseIndex !== undefined ? '短语 ' + r.reply.phraseIndex : '文本',
    内容: (r.reply.text || '').slice(0, 30)
  })));
}

async function cmdReplies(n) {
  const d = dbBlock.openDb(flag('file', dbBlock.DB_PATH));
  try {
    const rows = dbBlock.listReplies(d, Number(n) || 30);
    console.log(`回复留痕 ${rows.length} 条：`);
    console.table(rows.map((r) => ({
      时间: new Date(r.epoch).toLocaleString('zh-CN'),
      联系人: r.conv_name || '-',
      规则: r.rule_name || '-',
      动作: r.action || '-',
      状态: r.status,
      内容: (r.content || '').slice(0, 34),
      说明: (r.detail || '').slice(0, 24)
    })));
  } finally { d.close(); }
}

/* =====================================================================
 * db：信息落库（SQLite）
 *   node im.mjs db init            建库并打印统计
 *   node im.mjs db stats           统计总览
 *   node im.mjs db contacts        联系人台账（含各自消息数）
 *   node im.mjs db messages [n]    最近 n 条消息明细
 *   node im.mjs db export [文件]   导出 CSV（带 BOM，Excel 直接打开）
 *   node im.mjs db sync            把 logs/im-events.jsonl 补录进库
 *   加 --file <路径> 可操作指定库文件
 * ===================================================================== */
async function cmdDb(sub, arg) {
  const file = flag('file', dbBlock.DB_PATH);
  const d = dbBlock.openDb(file);
  try {
    switch (sub) {
      case undefined:
      case 'init': {
        const s = dbBlock.stats(d);
        console.log('✅ 数据库已就绪：' + file);
        console.log(JSON.stringify({
          联系人: s.contacts, 其中本账号自己: s.selfContacts,
          消息: s.messages, 对方消息: s.messagesIn, 我方消息: s.messagesOut,
          事件: s.events, 心跳: s.heartbeats,
          最早消息: s.firstCaptured && new Date(s.firstCaptured).toLocaleString('zh-CN'),
          最新消息: s.lastCaptured && new Date(s.lastCaptured).toLocaleString('zh-CN')
        }, null, 2));
        return;
      }
      case 'stats': {
        const s = dbBlock.stats(d);
        console.log('数据库：' + file);
        console.log(JSON.stringify(s, null, 2));
        const rows = dbBlock.listContacts(d);
        if (rows.length) {
          console.table(rows.map((r) => ({
            联系人: r.name,
            对方账号: r.is_self ? '(本账号自己)' : (r.peer || '-'),
            消息数: r.msg_total, 对方: r.msg_in, 我方: r.msg_out,
            最后一条: (r.last_desc || '').slice(0, 24),
            最后活跃: r.last_seen ? new Date(r.last_seen).toLocaleString('zh-CN') : ''
          })));
        }
        return;
      }
      case 'contacts': {
        const rows = dbBlock.listContacts(d);
        console.log(`联系人 ${rows.length} 个：`);
        console.table(rows.map((r) => ({
          联系人: r.name,
          对方账号: r.is_self ? '(本账号自己)' : (r.peer || '-'),
          消息总数: r.msg_total, 对方消息: r.msg_in, 我方消息: r.msg_out,
          未读: r.unread || '-',
          最后一条: (r.last_desc || '').slice(0, 30),
          最后活跃: r.last_seen ? new Date(r.last_seen).toLocaleString('zh-CN') : ''
        })));
        return;
      }
      case 'messages': {
        const rows = dbBlock.recentMessages(d, Number(arg) || 30);
        console.log(`最近 ${rows.length} 条消息：`);
        console.table(rows.map((r) => ({
          时间: new Date(r.captured_at).toLocaleString('zh-CN'),
          联系人: r.conv_name,
          方向: r.direction === 'in' ? '➡️ 对方' : '⬅️ 我方',
          发送者: (r.sender || '-').slice(0, 16),
          界面时间: r.ui_time || '-',
          内容: (r.text || '').slice(0, 40)
        })));
        return;
      }
      case 'export': {
        const out = arg || path.join(dbBlock.DATA_DIR, 'messages.csv');
        const n = dbBlock.exportCsv(d, out);
        console.log(`✅ 已导出 ${n} 行 → ${out}`);
        return;
      }
      case 'sync': {
        const r = dbBlock.syncFromJsonl(d);
        console.log(`JSONL 读取 ${r.read} 行，新入库 ${r.inserted} 条事件`);
        return;
      }
      default:
        console.log('用法: node im.mjs db <init|stats|contacts|messages|export|sync> [参数]');
    }
  } finally {
    d.close();
  }
}

/* =====================================================================
 * dashboard：把「监控进度」一次性汇总出来
 *   监听进程 / 联系人数量 / 当前会话消息量 / 事件日志统计
 * ===================================================================== */
async function cmdDashboard() {
  const line = (t) => console.log('\n' + '─'.repeat(60) + '\n' + t);

  /* ---- 1) 监听进程 ---- */
  line('① 监听进程');
  let monAlive = false;
  try {
    const pid = Number(fs.readFileSync(logstore.PATHS.pid, 'utf8').trim());
    process.kill(pid, 0);
    monAlive = true;
    const st = fs.statSync(logstore.PATHS.pid);
    const upMin = ((Date.now() - st.mtimeMs) / 60000).toFixed(1);
    console.log(`✅ 运行中：PID ${pid}`);
    console.log(`   启动于 ${st.mtime.toLocaleString('zh-CN')}（已运行 ${upMin} 分钟）`);
  } catch {
    console.log('❌ 未运行（启动： .\\start-im.ps1）');
  }

  /* ---- 2) 联系人 ---- */
  const convs = await conversations.readConversations();
  line(`② 联系人（会话）：共 ${convs.length} 个`);
  console.table(convs.map((c) => ({
    当前: c.active ? '▶' : '',
    联系人: c.name,
    对方账号: c.isSelf ? '(本账号自己)' : (c.peer || '-'),
    最后一条: (c.desc || '(无)').slice(0, 30),
    时间: c.time || '-',
    未读: c.unread || '-'
  })));

  /* ---- 3) 当前打开的会话 ---- */
  const msgs = await messages.readMessages();
  const sum = messages.summarize(msgs);
  line(`③ 当前会话消息：共 ${sum.total} 条（对方 ${sum.inbound} / 我方 ${sum.outbound} / 模板 ${sum.system}）`);
  console.log('   （完整历史只有"当前打开的这个会话"能读；其它联系人需要逐个打开才能读全文）');
  if (msgs.length) {
    console.table(msgs.slice(-5).map((m) => ({
      方向: m.kind === 'system' ? '⚙️ 模板' : (m.mine ? '⬅️ 我方' : '➡️ 对方'),
      发送者: (m.sender || '-').slice(0, 18),
      时间: (m.time || '-').slice(-8),
      内容: m.text.slice(0, 40)
    })));
  }

  /* ---- 4) 事件日志 ---- */
  const rows = logstore.readEvents(100000);
  const s = logstore.summarizeEvents(rows);
  line(`④ 累计捕获事件：${s.total} 条（对方消息 ${s.inbound} / 我方消息 ${s.outbound} / 其他会话提醒 ${s.convUpdates}）`);
  if (rows.length) {
    console.log(`   时间跨度：${new Date(s.first.epoch).toLocaleString('zh-CN')} → ${new Date(s.last.epoch).toLocaleString('zh-CN')}`);
    if (s.byConv.length) console.table(s.byConv.map((x) => ({ 会话: x.conversation, 对方消息数: x.inbound })));
  } else {
    console.log('   （监听已启动但还没等到新消息；事件只记录"新发生"的消息，不含历史）');
  }
  console.log(`\n   事件日志：${logstore.PATHS.events}`);
  console.log(`   运行日志：${logstore.PATHS.monitorOut}`);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const POS = argv.slice(1).filter((a) => !a.startsWith('--'));
const has = (n) => argv.includes('--' + n);
const flag = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

async function cmdRead() {
  const msgs = await messages.readMessages();
  const sum = messages.summarize(msgs);
  console.log('输入框:', JSON.stringify(await input.readDraft()));
  console.log(`共 ${sum.total} 条 = 对方 ${sum.inbound} + 我方 ${sum.outbound} + 模板 ${sum.system}`);
  console.table(msgs.map((m) => ({
    方向: m.kind === 'system' ? '⚙️ 模板' : (m.mine ? '⬅️ 我方' : '➡️ 对方'),
    发送者: m.sender || '-', 时间: m.time || '-', 内容: m.text.slice(0, 64)
  })));
}

async function cmdConvs() {
  const convs = await conversations.readConversations();
  console.log(`会话列表 ${convs.length} 条：`);
  console.table(convs.map((c) => ({
    当前: c.active ? '▶' : '', 会话: c.name,
    对方账号: c.isSelf ? '(本账号自己)' : (c.peer || '-'),
    时间: c.time, 未读: c.unread || '', 最后一条: c.desc.slice(0, 34)
  })));
}

async function cmdDraft(text) {
  if (!text) throw new Error('用法: draft "要填入的文本"');
  console.log('✅ 已填入（未发送）:', JSON.stringify(await input.draft(text)));
}

async function cmdSend(text, confirmed) {
  if (!text) throw new Error('用法: send "要发送的文本" --yes');
  if (!confirmed) {
    console.log('⚠️  没加 --yes，只填草稿。当前输入框:', JSON.stringify(await input.draft(text)));
    return;
  }
  const r = await input.sendText(text);
  console.log(JSON.stringify(r, null, 2));
  console.log(r.ok ? '✅ 发送成功（消息数增加且输入框已清空）' : '⚠️ 校验未通过，请人工核对');
}

async function cmdClear() {
  console.log('输入框已清空，当前内容:', JSON.stringify(await input.clear()));
}

async function cmdPhrases() {
  const items = await phrases.list();
  if (!items || !items.length) throw new Error('没能打开快捷短语弹窗，或弹窗里没有短语');
  console.log(`快捷短语 ${items.length} 条：`);
  console.table(items.map((it, i) => ({ 序号: i, 内容: it.text, x: it.x, y: it.y })));
  console.log('提示: node im.mjs quick <序号> 可选中并填入');
}

async function cmdQuick(sel, confirmed) {
  if (sel === undefined) throw new Error('用法: quick <序号|包含的文本> [--yes]');
  const r = await phrases.use(sel, { send: confirmed });
  console.log('选中的短语:', JSON.stringify(r.text));
  console.log('输入框现在:', JSON.stringify(r.draft));
  console.log('弹窗还开着吗:', r.dialogOpen ? '是' : '否（已自动关闭）');
  if (!confirmed) {
    console.log(`\n未加 --yes，只填入不发送。确认发送： node im.mjs quick ${sel} --yes`);
    return;
  }
  console.log('发送校验:', JSON.stringify(r.sent));
  console.log(r.sent.ok ? '✅ 发送成功' : '⚠️ 校验未通过，请人工核对');
}

async function cmdWatch(seconds, intervalMs) {
  const total = Number(seconds) || 60;
  const gap = Number(intervalMs) || 2000;
  console.log(`开始监听 ${total} 秒，每 ${gap}ms 轮询。`);
  const stat = await session.withSession(async (s) => {
    const seen = new Set();
    messages.prime(seen, await messages.readMessagesOn(s));
    let lastIn = 0, pending = 0, beat = Date.now();
    const st = { inbound: 0, outbound: 0, maxGapMs: 0, responses: [] };
    const t0 = Date.now();
    while (Date.now() - t0 < total * 1000) {
      await session.sleep(gap);
      const msgs = await messages.readMessagesOn(s);
      const { fresh, bulk } = messages.diff(seen, msgs);
      if (bulk) {
        console.log(`[${stamp()}] ℹ️ 批量刷新 ${fresh.length} 条（切换会话/重载），重置基线`);
        messages.prime(seen, msgs);
        lastIn = 0; pending = 0;
        continue;
      }
      for (const m of fresh) {
        seen.add(messages.msgKey(m));
        if (m.mine) {
          st.outbound++;
          const rt = pending ? ((Date.now() - pending) / 1000).toFixed(1) + 's' : null;
          if (pending) { st.responses.push(Date.now() - pending); pending = 0; }
          console.log(`[${stamp()}] ⬅️ 我方发出${rt ? '（距对方 ' + rt + '）' : ''}: ${m.text.slice(0, 60)}`);
        } else {
          st.inbound++;
          const g = lastIn ? ((Date.now() - lastIn) / 1000).toFixed(1) + 's' : null;
          if (lastIn) st.maxGapMs = Math.max(st.maxGapMs, Date.now() - lastIn);
          console.log(`[${stamp()}] ➡️ 对方来消息${g ? '（距上一条 ' + g + '）' : ''}: ${m.sender} — ${m.text.slice(0, 60)}`);
          lastIn = Date.now();
          if (!pending) pending = Date.now();
        }
      }
      if (Date.now() - beat > 30000) {
        beat = Date.now();
        console.log(`… 心跳 ${Math.round((Date.now() - t0) / 1000)}s，累计收 ${st.inbound} / 发 ${st.outbound}`);
      }
    }
    return st;
  });
  const avg = stat.responses.length
    ? (stat.responses.reduce((a, b) => a + b, 0) / stat.responses.length / 1000).toFixed(1) + 's'
    : '(无样本)';
  console.log('\n统计：', JSON.stringify({
    对方消息数: stat.inbound, 我方消息数: stat.outbound,
    平均响应时长: avg, 对方最大间隔: (stat.maxGapMs / 1000).toFixed(1) + 's'
  }, null, 2));
}

async function cmdMonitor() {
  await monitor.runMonitor({
    interval: Number(flag('interval', 15000)),
    out: flag('out', logstore.PATHS.events),
    quiet: has('quiet'),
    once: has('once'),
    duration: Number(flag('duration', 0)),
    heartbeatMs: Number(flag('heartbeat', 300000)),
    tickTimeoutMs: Number(flag('tick-timeout', 30000)),
    refreshMin: Number(flag('refresh-min', 0)),
    db: has('no-db') ? false : undefined,
    dbFile: flag('db-file', undefined),
    rulesFile: flag('rules', undefined),
    replyMode: flag('reply-mode', undefined)
  });
}

async function cmdLog(n) {
  const rows = logstore.readEvents(Number(n) || 30);
  console.log(`日志：${logstore.PATHS.events}（最近 ${rows.length} 条）`);
  console.table(rows.map((r) => ({
    时间: new Date(r.epoch).toLocaleString('zh-CN'),
    类型: r.type, 会话: r.conv || '-', 发送者: r.sender || '-',
    内容: (r.text || r.desc || '').slice(0, 50)
  })));
}

async function cmdStats() {
  const rows = logstore.readEvents(100000);
  if (!rows.length) { console.log('还没有日志数据。'); return; }
  const s = logstore.summarizeEvents(rows);
  console.log(`日志：${logstore.PATHS.events}`);
  console.log(JSON.stringify({
    事件总数: s.total, 对方消息: s.inbound, 我方消息: s.outbound,
    其他会话提醒: s.convUpdates, 涉及会话数: s.conversations,
    最早: s.first && new Date(s.first.epoch).toLocaleString('zh-CN'),
    最新: s.last && new Date(s.last.epoch).toLocaleString('zh-CN')
  }, null, 2));
  if (s.byConv.length) console.table(s.byConv.map((x) => ({ 会话: x.conversation, 对方消息数: x.inbound })));
}

const RUN = {
  read: cmdRead,
  convs: cmdConvs,
  draft: () => cmdDraft(POS[0]),
  send: () => cmdSend(POS[0], has('yes')),
  clear: cmdClear,
  phrases: cmdPhrases,
  quick: () => cmdQuick(POS[0], has('yes')),
  watch: () => cmdWatch(POS[0], POS[1]),
  monitor: cmdMonitor,
  log: () => cmdLog(POS[0]),
  stats: cmdStats,
  dashboard: cmdDashboard,
  progress: cmdDashboard,
  db: () => cmdDb(POS[0], POS[1]),
  reply: () => cmdReply(POS[0], has('yes')),
  rules: () => cmdRules(POS[0]),
  replies: () => cmdReplies(POS[0]),
  'image-search': () => cmdImageSearch(POS[0]),
  'image-results': () => cmdImageResults(POS[0]),
  'image-replay': () => cmdImageReplay(POS[0]),
  'image-recent': () => cmdImageRecent(POS[0]),
  'image-contact': cmdImageContact,
  'image-sellers': () => cmdImageSellers(POS[0]),
  'image-contacts': () => cmdImageContacts(POS[0]),
  lib: () => cmdLib(POS[0], POS[1]),
  'phrase-send': () => cmdPhraseSend(POS[0], has('yes')),
  tabs: () => cmdTabs(POS[0]),
  run: cmdRun,
  customers: () => cmdCustomers(POS[0]),
  'ai-test': cmdAiTest,
  sweep: cmdSweep,
  'lib-images': () => cmdLibImages(POS[0], POS[1]),
  'run-pending': cmdRunPending,
  'ai-parse': () => cmdAiParse(POS[0]),
  quotes: () => cmdQuotes(POS[0]),
  compare: cmdCompare,
  reparse: cmdReparse,
  campaign: () => cmdCampaign(POS[0], POS[1]),
  scheduler: cmdScheduler,
  'auto-reply': cmdAutoReply,
  chat: () => cmdChat(POS[0], flag('limit', 200)),
  'open-search': cmdOpenSearch,
  selftest: runSelfTest
};

if (!cmd || !RUN[cmd]) {
  console.log('用法：node im.mjs <run|customers|chat|auto-reply|ai-test|ai-parse|quotes|dashboard|read|convs|draft|send|clear|phrases|quick|reply|rules|replies|lib|phrase-send|tabs|image-search|image-results|image-replay|image-recent|image-contact|image-sellers|image-contacts|open-search|watch|monitor|log|stats|db|selftest> [参数]');
  process.exit(cmd ? 1 : 0);
}

RUN[cmd]().catch((e) => {
  console.error('❌ ' + e.message);
  process.exit(1);
});
/* =====================================================================
 * customers：客户台账（把 客户 / 图片↔商家 / 短语发送 三张表联起来）
 *   node im.mjs customers [--limit 30]
 * 回答两个问题：现在有多少客户？每个客户对应哪张图、哪条短语？
 * ===================================================================== */
async function cmdCustomers(limit) {
  const n = Number(limit) || 30;
  const d = dbBlock.openDb(flag('file', dbBlock.DB_PATH));
  try {
    /* ① 客户总数 */
    const conv = d.prepare(`SELECT COUNT(*) n FROM conversations`).get().n;
    const convSelf = d.prepare(`SELECT COUNT(*) n FROM conversations WHERE is_self=1`).get().n;

    /* ② 图片库：imageId -> 本地图片 */
    const imgs = d.prepare(`SELECT image_id, image_file, MIN(epoch) t FROM image_searches
                            WHERE image_id IS NOT NULL AND image_id<>'' GROUP BY image_id`).all();
    const imgMap = new Map(imgs.map((r) => [r.image_id, r.image_file]));

    /* ③ 有往来的商家（图片↔商家表） */
    const contacts = d.prepare(`SELECT * FROM image_contacts ORDER BY epoch DESC, rank ASC`).all();

    /* ④ 短语发送留痕（谁 / 哪条短语 / 哪张图 / 图与文各自状态） */
    const sends = d.prepare(`SELECT * FROM phrase_sends ORDER BY epoch DESC`).all();

    /* ⑤ 按商家聚合：一个客户可能被多次联系/发送 */
    const byShop = new Map();
    const keyOf = (name) => String(name || '').replace(/公司|厂|店|商行|有限公司/g, '').trim();
    for (const c of contacts) {
      const k = keyOf(c.shop_name);
      if (!byShop.has(k)) byShop.set(k, { shop: c.shop_name, offers: [], images: new Set(), sends: [], last: c.epoch });
      const rec = byShop.get(k);
      rec.offers.push(c.offer_id);
      if (c.image_id) rec.images.add(c.image_id);
      rec.last = Math.max(rec.last, c.epoch);
    }
    for (const s of sends) {
      const k = keyOf(s.conv_name);
      if (!byShop.has(k)) byShop.set(k, { shop: s.conv_name, offers: [], images: new Set(), sends: [], last: s.epoch });
      byShop.get(k).sends.push(s);
      byShop.get(k).last = Math.max(byShop.get(k).last, s.epoch);
    }

    console.log('=== 客户台账 ===\n');
    console.log(`客户总数：${conv} 个（其中本账号自己 ${convSelf} 个，真实客户 ${conv - convSelf} 个）`);
    console.log(`图片库：${imgMap.size} 张图（imageId ↔ 本地图片）`);
    console.log(`图片↔商家记录：${contacts.length} 条 ｜ 短语发送记录：${sends.length} 条`);
    console.log(`去重后的商家：${byShop.size} 个`);
    const noName = sends.filter((s) => !s.conv_name).length;
    const okSends = sends.filter((s) => s.image_status === 'sent' && s.text_status === 'sent').length;
    console.log(`短语发送：图文完整成功 ${okSends} 条${noName ? `（另有 ${noName} 条留痕缺客户名，建议重跑时留意）` : ''}\n`);

    console.log('【图片库】');
    console.table(imgs.slice(0, 10).map((r) => ({
      imageId: r.image_id, 本地图片: (r.image_file || '').split(/[\\/]/).pop() || '-',
      首次使用: new Date(r.t).toLocaleString('zh-CN')
    })));

    const rows = [...byShop.values()].sort((a, b) => b.last - a.last).slice(0, n);
    /* offerId → 短语/图片：优先用精确的 offerId 关联，没有才退回店铺名 */
    const sendByOffer = new Map();
    const sendByName = new Map();
    for (const s of sends) {
      if (s.offer_id) sendByOffer.set(s.offer_id, s);
      if (s.conv_name) sendByName.set(keyOf(s.conv_name), s);
    }
    console.log('【每个客户 ↔ 图片 ↔ 短语】');
    console.table(rows.map((r) => {
      const offer = r.offers.filter(Boolean)[0] || '';
      const s = (offer && sendByOffer.get(offer)) || sendByName.get(keyOf(r.shop)) || r.sends[r.sends.length - 1];
      const imgIds = [...r.images];
      const localImg = s && s.image_path ? s.image_path.split(/[\\/]/).pop()
                     : (imgIds[0] ? (imgMap.get(imgIds[0]) || '').split(/[\\/]/).pop() : '');
      return {
        客户: (r.shop || '').slice(0, 20),
        offerId: offer || '-',
        来源图片: localImg || '-',
        短语: s ? (s.phrase_text || s.phrase_id || '').slice(0, 14) : '(未发送)',
        图片状态: s ? s.image_status : '-',
        文字状态: s ? s.text_status : '-',
        最近时间: new Date(r.last).toLocaleString('zh-CN')
      };
    }));

    /* ⑥ 说明对应关系的可靠程度 */
    const withPhrase = rows.filter((r) => r.sends.length).length;
    const withImg = rows.filter((r) => r.images.size || r.sends.some((s) => s.image_path)).length;
    console.log(`\n对应关系覆盖：有图片记录的 ${withImg}/${rows.length} 个；有短语发送记录的 ${withPhrase}/${rows.length} 个`);
    console.log('注：客户↔短语/图片 目前按"店铺名"关联（同名的不同店铺会合并），offerId 已单独列出可精确区分。');
  } finally { d.close(); }
}
/* =====================================================================
 * chat：调出单个客户的完整往来
 *   node im.mjs chat <客户名|对方账号|offerId|会话id> [--limit 200]
 * 输出：客户档案 + 来源图片 + 发过的短语 + 按时间排序的完整聊天记录
 * ===================================================================== */
async function cmdChat(who, limit) {
  if (!who) {
    console.log('用法: node im.mjs chat <客户名|对方账号|offerId> [--limit 200]');
    console.log('提示: 先用 node im.mjs db contacts 看有哪些客户');
    return;
  }
  const n = Number(limit) || 200;
  const d = dbBlock.openDb(flag('file', dbBlock.DB_PATH));
  const norm = (s) => String(s || '').replace(/公司|厂|店|商行|有限公司|有限责任公司/g, '').trim();
  try {
    const convs = d.prepare(`SELECT * FROM conversations`).all();
    let target = convs.find((c) => c.conv_key === who)
              || convs.find((c) => c.peer === who)
              || convs.find((c) => c.name === who)
              || convs.find((c) => norm(c.name) === norm(who))
              || convs.find((c) => String(c.name).includes(who));

    /* 也支持用 offerId 查 */
    if (!target) {
      const ic = d.prepare(`SELECT shop_name FROM image_contacts WHERE offer_id = ? LIMIT 1`).get(who);
      const shop = ic && ic.shop_name ? norm(ic.shop_name) : '';
      if (shop) {
        target = convs.find((c) => norm(c.name) === shop)
              || convs.find((c) => String(c.name).includes(shop))
              || convs.find((c) => shop.includes(norm(c.name)));
      }
    }
    if (!target) {
      console.log(`没找到客户「${who}」。现有客户（部分）：`);
      console.table(convs.filter((c) => !c.is_self).slice(0, 20).map((c) => ({
        客户: c.name, 对方账号: c.peer, 会话id: c.conv_key.slice(0, 34)
      })));
      return;
    }

    const msgs = d.prepare(`
      SELECT * FROM messages WHERE conv_key = ?
      ORDER BY COALESCE(msg_epoch, captured_at) ASC, id ASC LIMIT ?
    `).all(target.conv_key, n);

    const like = '%' + norm(target.name) + '%';
    const imgs = d.prepare(`
      SELECT ic.*, s.image_file FROM image_contacts ic
      LEFT JOIN image_searches s ON s.image_id = ic.image_id
      WHERE ic.shop_name LIKE ? ORDER BY ic.epoch DESC LIMIT 5
    `).all(like);
    const sends = d.prepare(`
      SELECT * FROM phrase_sends WHERE conv_name LIKE ? ORDER BY epoch DESC LIMIT 5
    `).all(like);

    console.log('=== 客户：' + target.name + ' ===\n');
    console.log('客户档案');
    console.log(JSON.stringify({
      对方账号: target.peer || '',
      会话id: target.conv_key,
      本账号自己: !!target.is_self,
      未读: target.unread || '',
      消息总数: msgs.length,
      首次入库: new Date(target.first_seen).toLocaleString('zh-CN'),
      最后更新: new Date(target.last_seen).toLocaleString('zh-CN')
    }, null, 2));

    if (imgs.length) {
      console.log('\n来源图片（以图搜图带来的）');
      console.table(imgs.map((r) => ({
        时间: new Date(r.epoch).toLocaleString('zh-CN'),
        imageId: r.image_id, 本地图片: (r.image_file || '').split(/[\\/]/).pop() || '-',
        排名: r.rank, offerId: r.offer_id
      })));
    }
    if (sends.length) {
      console.log('\n发过的短语');
      console.table(sends.map((r) => ({
        时间: new Date(r.epoch).toLocaleString('zh-CN'),
        短语: r.phrase_text || r.phrase_id, 图片: (r.image_path || '').split(/[\\/]/).pop() || '-',
        图: r.image_status, 文: r.text_status
      })));
    }

    console.log(`\n聊天记录（${msgs.length} 条，按时间正序）`);
    if (!msgs.length) { console.log('（没有抓到消息；可能该会话从未打开过，或只有模板消息）'); return; }

    /* 我方主体前缀：从"我方"消息的发送者里取（例如 playworld152:it → playworld152）。
       同一主体下的其它子账号（同事）会被单独标出来，而不是笼统算"对方"——
       实测同事的子账号和供应商客服会出现在同一个会话线程里。 */
    const outSenders = msgs.filter((m) => m.direction === 'out').map((m) => m.sender || '');
    const prefix = outSenders.length
      ? (outSenders[0].includes(':') ? outSenders[0].split(':')[0] : outSenders[0])
      : '';
    const isColleague = (m) => m.direction === 'in' && prefix &&
      String(m.sender || '').startsWith(prefix + ':');

    console.table(msgs.map((m) => ({
      时间: m.msg_epoch ? new Date(m.msg_epoch).toLocaleString('zh-CN') : (m.ui_time || '-'),
      方向: m.direction === 'out' ? '⬅️ 我方'
           : (isColleague(m) ? '🔁 内部同事' : '➡️ 对方'),
      发送者: (m.sender || '').slice(0, 16),
      内容: (m.text || '').slice(0, 60)
    })));
    const inCnt = msgs.filter((m) => m.direction === 'in').length;
    const colCnt = msgs.filter(isColleague).length;
    console.log(`\n小结：我方 ${msgs.length - inCnt} 条 ｜ 内部同事 ${colCnt} 条 ｜ 外部对方 ${inCnt - colCnt} 条`);
    if (colCnt) console.log('（"内部同事"= 同一主体下的其它子账号，判定依据是发送者前缀相同）');
  } finally { d.close(); }
}
/* =====================================================================
 * compare：比价（页面价 vs 商家回复价）
 *   node im.mjs compare [--image <imageId>] [--limit 30]
 * 商家可能回"页面价格+0.1"这类相对价，这里会和页面价换算成可比单价再排序。
 * ===================================================================== */
async function cmdCompare() {
  const d = dbBlock.openDb(flag('file', dbBlock.DB_PATH));
  try {
    const rows = dbBlock.listQuotes(d, Number(flag('limit', 50)) || 50);
    if (!rows.length) { console.log('报价台账为空。先跑 auto-reply（或 ai-test）写数据。'); return; }

    let fixed = 0;
    const out = rows.map((q) => {
      const p = dbBlock.findOfferPrice(d, { offerId: q.offer_id, shopName: q.supplier_wangwang });
      const page = p ? p.page_price_num : null;
      let basis = q.price_basis || '';
      let final = (q.unit_price_final !== undefined && q.unit_price_final !== null)
        ? Number(q.unit_price_final)
        : null;

      /* 历史数据：没口径/没算出的，用原始回复重新解析一遍并回写库
         （早期版本没存口径，会把"页面价格+0.1"误当成绝对价 0.1） */
      if ((!basis || final === null) && q.raw_text) {
        const rp = ai.ruleParse(q.raw_text);
        const c = ai.computeFinalPrice({
          basis: rp.price_basis, delta: rp.price_delta, unitPriceRaw: rp.unit_price, pagePrice: page
        });
        if (rp.price_basis) basis = rp.price_basis;
        if (c.final !== null) final = c.final;

        /* 再兜一层：原始回复里没有可比对的价（比如只是商品卡），
           但 AI 已经抽出了"0.74元/支"这种单价 → 按绝对价处理 */
        if (final === null && (q.unit_price || '')) {
          const n = ai.computeFinalPrice({ basis: 'absolute', unitPriceRaw: q.unit_price, pagePrice: page });
          if (n.final !== null) { basis = basis || 'absolute'; final = n.final; }
        }
        d.prepare(`UPDATE supplier_quotes SET price_basis=?, unit_price_final=?, page_price=?, unit_price=COALESCE(NULLIF(unit_price,''), ?) WHERE id=?`)
          .run(basis, final, p ? p.page_price_raw : '', rp.unit_price || '', q.id);
        fixed++;
      }
      return {
        供应商: (q.supplier_wangwang || '-').slice(0, 18),
        页面价: page === null ? '-' : page,
        回复价原文: q.unit_price || '-',
        口径: basis || '-',
        可比单价: final === null ? '-' : final,
        与页面价差: (final !== null && page !== null) ? +(final - page).toFixed(4) : '-',
        offerId: q.offer_id || '-',
        状态: q.status
      };
    });

    /* 比价只在"确实做这款产品"的商家里进行：
       dropped = AI 判定不做该产品（可能是完全不同的商品，价格不可比）。 */
    const comparable = out.filter((x) => x.状态 !== 'dropped');
    comparable.sort((a, b) => {
      const av = typeof a.可比单价 === 'number' ? a.可比单价 : Infinity;
      const bv = typeof b.可比单价 === 'number' ? b.可比单价 : Infinity;
      return av - bv;
    });
    const dropped = out.filter((x) => x.状态 === 'dropped');
    out.length = 0;
    out.push(...comparable, ...dropped);

    console.log('=== 比价表（可比单价升序）===');
    console.table(out);
    if (fixed) console.log(`（其中 ${fixed} 条历史报价用原始回复补算了价格口径，已回写库）`);

    const priced = comparable.filter((x) => typeof x.可比单价 === 'number');
    if (priced.length) {
      console.log(`\n结论：${priced.length} 家有可比价 ｜ 最低 ${priced[0].可比单价} 元（${priced[0].供应商}）` +
                  ` ｜ 最高 ${priced[priced.length - 1].可比单价} 元（${priced[priced.length - 1].供应商}）` +
                  ` ｜ 价差 ${(priced[priced.length - 1].可比单价 - priced[0].可比单价).toFixed(4)} 元`);
      const rel = out.filter((x) => /page_/.test(x.口径));
      if (rel.length) console.log(`其中 ${rel.length} 家是按"页面价 ±"报的，已用页面价换算成可比单价。`);
    }
    const noPrice = comparable.filter((x) => typeof x.可比单价 !== 'number');
    if (noPrice.length) console.log(`另有 ${noPrice.length} 家还没给出可解析的价格（等回复或信息不全）。`);
    if (dropped.length) {
      console.log(`\n⚠️ 已排除 ${dropped.length} 家（AI 判定不做这款产品，价格不可比）：` +
                  dropped.map((x) => x.供应商).join('、'));
    }
  } finally { d.close(); }
}
/* =====================================================================
 * reparse：用 AI 把历史报价重新解析一遍（覆盖正则的局限）
 *   node im.mjs reparse [--limit 30] [--all]
 * 原则：既然在调 DeepSeek，就把**原始回复 + 页面价 + 已拿到的信息**都交给它分析，
 *       正则只作为"没 key 时的离线兜底"。
 * ===================================================================== */
async function cmdReparse() {
  const d = dbBlock.openDb(flag('file', dbBlock.DB_PATH));
  try {
    const all = dbBlock.listQuotes(d, Number(flag('limit', 50)) || 50);
    const rows = has('all') ? all : all.filter((q) => !q.unit_price_final || !q.price_basis);
    if (!rows.length) { console.log('没有需要重新解析的记录（都有可比单价了）。加 --all 可强制全部重解析。'); return; }
    if (!ai.hasApiKey()) { console.log('⚠️ 没有 DeepSeek key，无法用 AI 重解析（会退回规则）。'); }

    console.log(`用 AI 重新解析 ${rows.length} 条报价…\n`);
    let fixed = 0, stillEmpty = 0;
    for (const q of rows) {
      const p = dbBlock.findOfferPrice(d, { offerId: q.offer_id, shopName: q.supplier_wangwang });
      /* 关键：把**该会话的历史消息**也一起给 AI。
         只给最后一条会漏信息——实测"页面价格+0.1"出现在更早的消息里，
         只喂最后一句"拍吧"时 AI 就判成了"与页面价相同"。 */
      const hist = q.conv_key
        ? d.prepare(`SELECT direction, sender, text FROM messages WHERE conv_key = ? ORDER BY COALESCE(msg_epoch, captured_at) DESC LIMIT 12`).all(q.conv_key).reverse()
        : [];
      const context = hist.map((m) => (m.direction === 'out' ? '我方' : '对方') + ': ' + (m.text || '')).join('\n');

      const parsed = await ai.parseSupplierReply({
        inquiry: q.phrase || '',
        replyText: q.raw_text || q.unit_price || '',
        product: flag('product', ''),
        context,
        known: q,
        opts: { pagePrice: p ? p.page_price_num : null }
      });
      const fields = {};
      for (const f of dbBlock.QUOTE_FIELDS) if (parsed[f]) fields[f] = parsed[f];

      const final = (parsed.unit_price_final === undefined || parsed.unit_price_final === null)
        ? null : parsed.unit_price_final;
      /* 只收"像价格"的 unit_price：AI 有时把评述写进去（"0.49元（红包价，实为…）"），
         那会把原来干净的价挤掉。短的、含价格特征的才收。 */
      const priceLike = (v) => {
        const s = String(v || '').trim();
        return s.length > 0 && s.length <= 24 && /[￥¥元]|\d/.test(s);
      };
      dbBlock.upsertQuote(d, {
        conv_key: q.conv_key,
        page_price: p ? p.page_price_raw : (q.page_price || ''),
        price_basis: parsed.price_basis || '',
        unit_price_final: final,
        ...fields,
        ...(priceLike(fields.unit_price) ? { unit_price: fields.unit_price } : {})
      });

      /* 连带重判"这家是不是做这款产品"：老数据里可能混着别的产品的报价
         （实测有家窗帘供应商的 12 元/条被当成羽毛笔的价参与比价）。 */
      if (parsed.is_relevant === false) {
        dbBlock.upsertQuote(d, { conv_key: q.conv_key, status: 'dropped' });
      }

      const ok = final !== null;
      if (ok) fixed++; else stillEmpty++;
      console.log(`  ${ok ? '✅' : '—'} ${String(q.supplier_wangwang || '-').slice(0, 18).padEnd(20)}` +
                  ` 口径 ${String(parsed.price_basis || 'unknown').padEnd(11)}` +
                  ` 可比单价 ${ok ? final : '(仍算不出)'}` +
                  `${p ? '（页面价 ' + p.page_price_num + '）' : ''}` +
                  `${parsed.is_relevant === false ? ' 🚫不做该产品→已排除' : ''}` +
                  ` ｜ 来源 ${parsed._source === 'ai' ? 'AI' : '规则'}`);
      await new Promise((r) => setTimeout(r, 400));   // 轻微限速，避免触发接口限制
    }
    console.log(`\n完成：解析出可比单价 ${fixed} 条 ｜ 仍算不出 ${stillEmpty} 条`);
  } finally { d.close(); }
}
