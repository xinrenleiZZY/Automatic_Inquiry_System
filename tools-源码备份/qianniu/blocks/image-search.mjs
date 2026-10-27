/* =====================================================================
 * 区块：以图搜图（Image Search）
 * [功能区块 · v0.1 · 状态：待集成到系统 —— 见 INTEGRATION.md]
 *
 *   node im.mjs image-search "图片路径" [--method file|paste] [--wait 2000]
 *
 * 目标页面（记住这个地址）：
 *   https://s.1688.com/selloffer/offer_search.htm
 *
 * 两条通道：
 *   ① file（推荐）：页面自带 input.image-file-reader-wrapper，
 *      用 CDP DOM.setFileInputFiles 直接塞文件，触发页面自己的上传流程。
 *      —— 不碰剪贴板、不依赖键盘、不受窗口焦点影响。
 *   ② paste（你描述的原始流程）：把图片写进 Windows 剪贴板，
 *      聚焦页面后发 Ctrl+V，等弹层出现，再点搜索按钮。
 *
 * 之后点搜索按钮（选择器见 SEARCH_BTN_SELECTOR），等 waitMs 进结果页。
 * ===================================================================== */

import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { withSession, evaluate, sleep } from './session.mjs';
import { enforceSingleTabs } from './tabs.mjs';
import { withBrowserLock } from './lock.mjs';

/* ---------------- 页面与选择器（实测确认） ---------------- */

export const SEARCH_PAGE_URL = 'https://s.1688.com/selloffer/offer_search.htm';
export const SEARCH_MATCH = 'offer_search';
/* 点完搜索后页面会跳到以图搜图结果页（air.1688.com 的 kapp 子应用） */
export const RESULTS_MATCH = ['pc-image-search', 'offer_search'];

/* 有了 imageId 就能直接拼出结果页，跳过"上传+点搜索"两步 */
export function imageSearchUrl(imageId) {
  return 'https://air.1688.com/kapp/1688-search/pc-image-search/?tab=imageSearch&imageId=' + imageId;
}

/* 用户提供并经实测验证有效的按钮选择器 */
export const SEARCH_BTN_SELECTOR =
  '#pc-home2024-search-tab > div > div.image-input-button > div > div.copy-image-container > div.search-btn';
/* 兼容站点改版：按文本"搜索图片"兜底 */
export const SEARCH_BTN_FALLBACK = 'div.search-btn';

export const IMAGE_FILE_INPUT = 'input.image-file-reader-wrapper';
export const PASTE_CONTAINER = '.copy-image-container';
export const KEYWORD_INPUT = '#alisearch-input';

/* ---------------- 剪贴板（Windows） ---------------- */

/* 把图片写入系统剪贴板（位图格式，网页 paste 事件能拿到）。
   注意：会覆盖你剪贴板里原有的内容。 */
export function setClipboardImage(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error('图片不存在：' + abs);
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    `$img = [System.Drawing.Image]::FromFile('${abs.replace(/'/g, "''")}')`,
    'try { [System.Windows.Forms.Clipboard]::SetImage($img); "ok" } finally { $img.Dispose() }'
  ].join('; ');
  const out = execFileSync('powershell', ['-NoProfile', '-STA', '-Command', ps], { encoding: 'utf8' });
  return out.includes('ok');
}

/* ---------------- 页面定位 ---------------- */

/* 找"以图搜图入口页"（s.1688.com 那个搜索页） */
export async function findSearchEntry() {
  const { listPages } = await import('../cdp-lib.mjs');
  const pages = await listPages();
  return pages.find((p) => (p.url || '').includes(SEARCH_MATCH)) || null;
}

/* 找结果页（点完搜索后的 kapp 子应用） */
export async function findResultsPage() {
  const { listPages } = await import('../cdp-lib.mjs');
  const pages = await listPages();
  return pages.find((p) => (p.url || '').includes('pc-image-search')) || null;
}

/* 兼容旧名：优先入口页，其次结果页 */
export async function findSearchPage() {
  return (await findSearchEntry()) || (await findResultsPage());
}

/* 在调试实例里打开搜索页（已开着就直接复用，不重复开标签） */
export async function openSearchPage() {
  const existing = await findSearchEntry();
  if (existing) return { opened: false, url: existing.url };

  const { httpGetJson, Session } = await import('../cdp-lib.mjs');
  const ver = await httpGetJson('/json/version');
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('浏览器端连接超时')), 10000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('浏览器端连接失败')); };
  });
  const session = new Session(ws);
  try {
    const r = await session.send('Target.createTarget', { url: SEARCH_PAGE_URL });
    return { opened: true, targetId: r.targetId, url: SEARCH_PAGE_URL };
  } finally {
    session.close();
  }
}

async function boxOfTop(session, selector) {
  return evaluate(session, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height,
             text: (el.innerText || '').trim().slice(0, 20) };
  })()`);
}

async function clickTop(session, selector) {
  const box = await boxOfTop(session, selector);
  if (!box) throw new Error('找不到元素：' + selector);
  if (box.w < 2 || box.h < 2) throw new Error(`元素不可见（${box.w}x${box.h}）：` + selector);
  /* 先送一个 mouseMoved：很多弹层 UI 需要先有 hover 才让点击生效 */
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

/* ---------------- 就绪等待（替代固定 sleep） ---------------- */

async function waitUntil(session, expr, { timeoutMs = 15000, intervalMs = 300, what = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { last = await evaluate(session, expr); } catch { last = null; }
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${what}`);
}

/* 等搜索页的上传控件出现 */
export async function waitForUploadInput(session, timeoutMs = 20000) {
  return waitUntil(session, `(() => !!document.querySelector(${JSON.stringify(IMAGE_FILE_INPUT)}))()`,
                   { timeoutMs, what: '搜索页上传控件出现' });
}

/* 等"图片已上传"信号。实测页面会显示「已上传 N 张图片」并出现预览图，
   这两个才是"可以点搜索了"的可靠依据（固定 sleep 不可靠）。 */
export async function waitForUploaded(session, timeoutMs = 20000) {
  return waitUntil(session, `(() => {
    const box = document.querySelector('.copy-image-container');
    if (!box) return null;
    const imgs = box.querySelectorAll('img').length;
    const m = (box.innerText || '').match(/已上传(\\d+)张图片/);
    const uploaded = m ? Number(m[1]) : 0;
    return (uploaded >= 1 || imgs >= 1) ? { uploaded, imgs } : null;
  })()`, { timeoutMs, intervalMs: 300, what: '图片上传完成（"已上传N张图片"）' });
}

/* 等页面跳到结果页 */
export async function waitForResults(session, beforeHref, timeoutMs = 20000) {
  return waitUntil(session, `(() => {
    const h = location.href;
    return (h !== ${JSON.stringify(beforeHref)} && /pc-image-search|offer_search/.test(h)) ? h : null;
  })()`, { timeoutMs, intervalMs: 400, what: '跳转到结果页' });
}

/* 等结果卡片渲染出来（结果页是异步渲染的；刚跳过去就读会得到 0 条） */
export async function waitForCards(session, timeoutMs = 20000) {
  try {
    return await waitUntil(session,
      `(() => document.querySelectorAll('#offer-list-content [class*="searchOfferWrapper"]').length > 0)()`,
      { timeoutMs, intervalMs: 400, what: '结果卡片渲染' });
  } catch {
    return false;   // 超时就按当前状态返回，由调用方决定怎么处理
  }
}

/* ---------------- 通道①：直接塞文件给 file input ---------------- */

export async function uploadByFileInput(session, file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error('图片不存在：' + abs);

  await session.send('DOM.enable');
  const doc = await session.send('DOM.getDocument', { depth: -1 });
  const found = await session.send('DOM.querySelector', {
    nodeId: doc.root.nodeId, selector: IMAGE_FILE_INPUT
  });
  if (!found || !found.nodeId) throw new Error('页面上找不到图片上传 input：' + IMAGE_FILE_INPUT);

  await session.send('DOM.setFileInputFiles', { files: [abs], nodeId: found.nodeId });
  return { ok: true, nodeId: found.nodeId, file: abs };
}

/* ---------------- 通道②：剪贴板 + Ctrl+V ---------------- */

export async function pasteImage(session) {
  /* 先把焦点放到粘贴区上方的图片按钮，保证 paste 事件有落点 */
  await evaluate(session, `(() => {
    const el = document.querySelector('#pc-home2024-search-tab') || document.body;
    const target = el.querySelector('.image-input-button') || el;
    target.scrollIntoView({ block: 'center' });
    const r = target.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y) };
  })()`);

  const box = await boxOfTop(session, '.image-input-button');
  if (box) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await session.send('Input.dispatchMouseEvent', {
        type, x: box.x, y: box.y, button: 'left', clickCount: 1,
        buttons: type === 'mousePressed' ? 1 : 0
      });
    }
    await sleep(300);
  }

  /* Ctrl+V（真实按键事件，Chrome 会走系统粘贴） */
  const v = { key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: 2 };
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...v });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...v });
  return true;
}

/* ---------------- 点搜索 → 等结果 ---------------- */

export async function clickSearchButton(session) {
  try {
    return await clickTop(session, SEARCH_BTN_SELECTOR);
  } catch (e) {
    /* 站点改版兜底：按文本找"搜索图片" */
    const box = await evaluate(session, `(() => {
      const list = Array.from(document.querySelectorAll('div.search-btn, button'));
      const el = list.find((x) => (x.innerText || '').trim() === '搜索图片');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, text: '搜索图片' };
    })()`);
    if (!box) throw e;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await session.send('Input.dispatchMouseEvent', {
        type, x: box.x, y: box.y, button: 'left', clickCount: 1,
        buttons: type === 'mousePressed' ? 1 : 0
      });
    }
    return box;
  }
}

/* ---------------- 主流程 ---------------- */

export async function searchByImage(file, opts = {}) {
  return withBrowserLock(() => searchByImageInner(file, opts),
    { what: 'image-search ' + path.basename(file), waitMs: opts.waitMs });
}

async function searchByImageInner(file, opts = {}) {
  const method = opts.method || 'file';
  const waitMs = Number(opts.wait) || 2000;
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error('图片不存在：' + abs);

  /* 开始前先收敛标签：搜索页/结果页/聊天各留一个，避免越开越多导致卡顿 */
  if (opts.cleanTabs !== false) {
    try {
      const t = await enforceSingleTabs({});
      if (t.closed.length) console.log(`   🧹 清理重复标签 ${t.closed.length} 个`);
    } catch (e) { /* 清理失败不影响主流程 */ }
  }

  /* 搜索页会"用完即走"（点完搜索同一个标签就跳到结果页了），
     所以每次都要确认入口页在；不在就自动补开一个。 */
  let entry = await findSearchEntry();
  if (!entry) {
    const opened = await openSearchPage();
    void opened;
    /* 等上传控件真的出现，而不是固定 sleep（网络慢时会踩空） */
    try {
      await withSession((s) => waitForUploadInput(s, 25000), { match: SEARCH_MATCH });
    } catch (e) {
      throw new Error('搜索页打开了但上传控件一直没出现：' + e.message);
    }
    entry = await findSearchEntry();
  }
  if (!entry) throw new Error('打不开搜索页：' + SEARCH_PAGE_URL);

  const steps = [];
  return withSession(async (session) => {
    const before = await evaluate(session, `location.href`);

    if (method === 'paste') {
      setClipboardImage(abs);                       // 覆盖系统剪贴板
      await pasteImage(session);                    // 真实 Ctrl+V
    } else {
      await uploadByFileInput(session, abs);        // file 通道：CDP 直接塞文件
    }
    steps.push('已提交图片');

    /* 关键：等页面自己确认收到图片，再点搜索 */
    const up = await waitForUploaded(session);
    steps.push(`页面确认已上传 ${up.uploaded || up.imgs} 张`);
    await sleep(600);                       // 让弹层把布局/动画走完，否则坐标会量偏

    /* 点搜索 → 校验是否真跳转；没跳就重新量坐标再点（最多 3 次） */
    let btn = null;
    let after = '';
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      btn = await clickSearchButton(session);
      steps.push(`第 ${attempt} 次点搜索 @(${Math.round(btn.x)},${Math.round(btn.y)})`);
      try {
        after = await waitForResults(session, before, 6000);
        steps.push('已进入结果页');
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        steps.push(`第 ${attempt} 次未跳转，重试…`);
        /* 重试前确认图片还在（弹层可能被点没了） */
        try { await waitForUploaded(session, 5000); } catch { /* 继续重试 */ }
        await sleep(500);
      }
    }
    if (lastErr) {
      after = await evaluate(session, `location.href`);
      steps.push('⚠️ 三次点击仍未跳转：' + lastErr.message);
    }

    const imageId = (after.match(/imageId=(\d+)/) || [])[1] || '';
    return {
      method,
      file: abs,
      imageId,                                     // 服务端在上传时生成的图片标识
      steps,
      searchButton: btn,
      urlBefore: before,
      urlAfter: after,
      navigated: before !== after
    };
  }, { match: SEARCH_MATCH });
}

/* 用已有 imageId 直接重放结果页（不再上传、不再点按钮）。
   注意：imageId 每次上传都会变，所以只能重放"同一次搜索"。 */
export async function replaySearch(imageIdOrUrl) {
  const url = /^https?:/.test(imageIdOrUrl)
    ? imageIdOrUrl
    : imageSearchUrl(String(imageIdOrUrl).replace(/\D/g, ''));
  const existing = await findResultsPage();
  /* 同一个 imageId 已经开着就直接复用，不重复开标签 */
  const wantId = (url.match(/imageId=(\d+)/) || [])[1] || '';
  const haveId = existing ? ((existing.url.match(/imageId=(\d+)/) || [])[1] || '') : '';
  if (existing && wantId && haveId === wantId) return { reused: true, url: existing.url };

  const { httpGetJson, Session } = await import('../cdp-lib.mjs');
  const ver = await httpGetJson('/json/version');
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('浏览器端连接超时')), 10000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('浏览器端连接失败')); };
  });
  const session = new Session(ws);
  try {
    const r = await session.send('Target.createTarget', { url });
    return { reused: false, targetId: r.targetId, url };
  } finally {
    session.close();
  }
}

/* ---------------- 读搜索结果（商品卡） ---------------- */

export async function readResults(opts = {}) {
  const limit = Number(opts.limit) || 20;
  /* match 可指定只读某一次搜索的结果页（一般传 imageId），
     否则会读到别的标签里旧的结果。 */
  const match = opts.match || RESULTS_MATCH;
  return withSession(async (session) => {
    /* 结果卡片是异步渲染的：先等它们出现，否则会读到空结果
       （刚跳过来就读 → 0 条，这是踩过的坑）。 */
    await waitForCards(session, Number(opts.waitRenderMs) || 20000);

    return evaluate(session, `(() => {
    const limit = ${limit};
    const out = { url: location.href, title: document.title,
                  imageId: (location.search.match(/imageId=([\\d]+)/) || [])[1] || '',
                  total: 0, cards: [] };

    /* 卡片容器实测： #offer-list-content 下面 [class*="searchOfferWrapper"] */
    let nodes = Array.from(document.querySelectorAll('#offer-list-content [class*="searchOfferWrapper"]'));
    if (!nodes.length) nodes = Array.from(document.querySelectorAll('[class*="offerListLayoutWrapper"] > div'));

    const seen = new Set();
    for (const el of nodes) {
      if (out.cards.length >= limit) break;
      const raw = (el.innerText || '');
      const flat = raw.replace(/\\s+/g, ' ').trim();
      if (flat.length < 6) continue;

      /* 价格行文本（保留空格！价格会被渲染成 "¥ 1 .5"，去空格会把
         价格和后面的销量粘在一起："¥1.396700件起批"）。 */
      const priceRow = el.querySelector('[class*="offerPriceRow"]');
      const prow = ((priceRow ? priceRow.innerText : flat) || '').replace(/\\s+/g, ' ').trim();
      /* 匹配 "¥ 1 .5" / "¥1.39" / "¥ 16 .56"，再清掉内部空格 */
      const priceNum = prow.match(/[￥¥]\\s*(\\d+(?:\\s*\\.\\s*\\d+)?)/);
      const price = priceNum ? priceNum[1].replace(/\\s+/g, '') : '';

      /* 起批量 / 成交量：抓所有 "N件(起批)?" 片段，带"起批"的是起批量 */
      const tokens = Array.from(prow.matchAll(/(\\d[\\d.]*[万千]?\\+?件(?:起批)?)/g)).map((m) => m[1]);
      const moq = tokens.find((t) => t.endsWith('起批')) || '';
      const sold = tokens.find((t) => !t.endsWith('起批')) || '';

      /* 商品链接：排除旺旺聊天链接（每张卡片都有，且 title 是提示语，
         早期版本误用它当标题，导致 60 张卡片被去重成 1 张）。 */
      const anchors = Array.from(el.querySelectorAll('a[href]'));
      const productLink = anchors.find((a) => /\\/offer\\/|detail\\.1688|dj\\.1688|offerId=/.test(a.href)
                                            && !/ocms-fusion|pc-image-search/.test(a.href))
                       || anchors.find((a) => {
                            const t = a.getAttribute('title') || '';
                            return t.length > 8 && !/点此可以/.test(t);
                          });

      /* 卡片上没有商品 <a>（详情页链接由 React 点击处理），但属性里藏着
         offerId：data-renderkey = "1_1_normal_b2b-<卖家id>_<offerId>" */
      const renderKey = el.getAttribute('data-renderkey') || '';
      const offerId = (renderKey.match(/(\\d{9,})$/ ) || [])[1] || '';
      const detailUrl = offerId ? 'https://detail.1688.com/offer/' + offerId + '.html' : '';

      /* 标题：优先商品链接的 title；否则取卡片正文里价格之前那段并裁掉营销后缀 */
      let title = productLink ? (productLink.getAttribute('title') || productLink.innerText || '') : '';
      if (!title.trim()) {
        title = flat.split(/[￥¥]/)[0]
          .replace(/^找相似/, '')
          .split(/｜|元宝|近90天低价|分享再减|品类店铺|商机组货/)[0]
          .trim();
      }
      title = title.replace(/\\s+/g, ' ').replace(/^找相似/, '').trim().slice(0, 80);

      const href = productLink ? productLink.href : detailUrl;

      /* 卖家昵称：旺旺链接的 data-nick（URL 编码） */
      const ww = el.querySelector('[data-nick]');
      let sellerNick = '';
      if (ww) {
        try { sellerNick = decodeURIComponent(ww.getAttribute('data-nick') || ''); }
        catch { sellerNick = ww.getAttribute('data-nick') || ''; }
      }
      /* 去重键：优先商品链接，其次 标题+价格 */
      const key = href || (title + '|' + price);
      if (seen.has(key)) continue;
      seen.add(key);

      out.cards.push({
        title, price, moq,
        sold: sold && sold !== moq ? sold : '',
        offerId, sellerNick,
        href: (href || '').slice(0, 150),
        text: flat.slice(0, 100)
      });
    }
    out.total = nodes.length;
    return out;
  })()`);
  }, { match });
}
