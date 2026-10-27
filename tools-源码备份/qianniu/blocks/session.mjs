/* =====================================================================
 * 区块：会话通道（Session）
 * [功能区块 · v0.1 · 状态：待集成到系统 —— 见 INTEGRATION.md]
 *
 * 职责：连接 CDP、定位聊天页面、向页面注入 __QN.* 工具函数。
 *       其它区块都通过它拿到「可用会话」，自己不碰 CDP 细节。
 *
 * 对外接口：
 *   withSession(fn, opts)  -> 打开会话 → 注入工具 → 执行 fn(session) → 关闭
 *   ensureHelpers(session) -> 页面跳转后重新注入
 *   evaluate(session, js)  -> 在页面里求值（快捷方式）
 *   PAGE_MATCH / sleep
 * ===================================================================== */

import { pickPage, attach, evaluate as rawEvaluate, sleep } from '../cdp-lib.mjs';

/* =====================================================================
 * 聊天页身份（重要，别改错）
 *
 * 聊天窗口就是一个普通 Chrome 页面 target，地址固定是：
 *   https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html#/
 *   （带参数时形如 ...index.html?touid=xxx&offerId=xxx#/）
 *
 * 它只是外壳，真正的聊天界面在同源 iframe 里：
 *   .../def_cbu_web_im_core/index.html     ← 输入框/消息区/会话列表都在这一层
 * 再往里还有一层（AI 助手）：
 *   .../kapp/1688-pc-front/ww-bulk-inquiry-modal/assistant
 * ===================================================================== */
export const CHAT_PAGE_URL =
  'https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html';
export const CORE_FRAME_MARK = 'def_cbu_web_im_core';
export const PAGE_MATCH = process.env.IM_MATCH || 'def_cbu_web_im';

/* 校验一个 target 是不是聊天页（宁可报错也不要操作错页面） */
export function isChatPage(url) {
  return typeof url === 'string' && url.includes('/def_cbu_web_im/index.html');
}
export { sleep };

/* =====================================================================
 * 注入到聊天页顶层 window 的工具集（__QN.*）
 * 说明：这段字符串会被送进页面执行，正则里的反斜杠要写两遍。
 * ===================================================================== */
export const HELPERS = `
window.__QN = window.__QN || {};
/* 递归收集所有同源文档 —— 聊天页可能嵌多层 iframe */
window.__QN.docs = function () {
  var list = [];
  (function walk(win, depth) {
    if (!win || depth > 4) return;
    var d;
    try { d = win.document; } catch (e) { return; }
    if (!d || !d.body) return;
    list.push(d);
    var fs;
    try { fs = d.querySelectorAll('iframe'); } catch (e) { return; }
    Array.prototype.forEach.call(fs, function (f) {
      try { if (f.contentWindow) walk(f.contentWindow, depth + 1); } catch (e) { /* 跨域 */ }
    });
  })(window, 0);
  return list;
};
/* 核心聊天文档 = 含输入区 / 消息区 / 会话列表的那个 */
window.__QN.core = function () {
  var docs = window.__QN.docs();
  for (var i = 0; i < docs.length; i++) {
    var d = docs[i];
    if (d.querySelector('div.input-area') || d.querySelector('.message-list') || d.querySelector('.conversation-item')) return d;
  }
  return null;
};
/* 元素坐标换算到顶层视口（逐层累加 iframe 偏移），CDP 真实鼠标事件才能点准 */
window.__QN.toTopBox = function (el) {
  if (!el) return null;
  var d = el.ownerDocument;
  var br = el.getBoundingClientRect();
  var x = br.x, y = br.y, w = br.width, h = br.height;
  var win = d.defaultView, guard = 0;
  while (win && win !== window && guard++ < 5) {
    var parent = win.parent;
    var pdoc;
    try { pdoc = parent.document; } catch (e) { break; }
    var ifr = null;
    Array.prototype.some.call(pdoc.querySelectorAll('iframe'), function (f) {
      if (f.contentWindow === win) { ifr = f; return true; }
      return false;
    });
    if (!ifr) break;
    var fr = ifr.getBoundingClientRect();
    x += fr.x; y += fr.y;
    win = parent;
  }
  return { x: x + w / 2, y: y + h / 2, w: w, h: h };
};
window.__QN.boxOf = function (sel) {
  var d = window.__QN.core(); if (!d) return null;
  var el = d.querySelector(sel); if (!el) return null;
  var b = window.__QN.toTopBox(el);
  if (!b) return null;
  b.text = (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
  return b;
};
/* ---- 输入区 ---- */
window.__QN.input = function () {
  var d = window.__QN.core(); if (!d) return null;
  return d.querySelector('div.input-area .text-panel pre.edit')
      || d.querySelector('pre.edit')
      || d.querySelector('.biz-expression-editor [contenteditable="true"]');
};
window.__QN.sendBtn = function () {
  var d = window.__QN.core(); if (!d) return null;
  return d.querySelector('button.send-btn');
};
window.__QN.readDraft = function () {
  var el = window.__QN.input();
  return el ? (el.innerText || '').replace(/\\s+/g, ' ').trim() : null;
};
/* ---- 消息区 ---- */
window.__QN.msgView = function () {
  var d = window.__QN.core(); if (!d) return null;
  return d.querySelector('.message-list .rc-scrollbars-view') || d.querySelector('.message-list');
};
window.__QN.msgItems = function () {
  var v = window.__QN.msgView(); if (!v) return [];
  return Array.prototype.slice.call(v.children);
};
/* 我方消息带 self 类，对方没有 —— 方向判断的确定性依据 */
window.__QN.parse = function () {
  return window.__QN.msgItems().map(function (row) {
    var mi = row.querySelector('.message-item');
    if (!mi) {
      var t = (row.innerText || '').replace(/\\s+/g, ' ').trim();
      return t ? { kind: 'system', mine: false, sender: '', time: '', text: t.slice(0, 300) } : null;
    }
    var nickEl = mi.querySelector('.nick');
    var timeEl = mi.querySelector('.time');
    var contentEl = mi.querySelector('.content');
    return {
      kind: 'msg',
      mine: mi.classList.contains('self'),
      sender: nickEl ? (nickEl.textContent || '').trim() : '',
      time: timeEl ? (timeEl.textContent || '').trim() : '',
      text: contentEl ? (contentEl.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300) : ''
    };
  }).filter(Boolean);
};
/* ---- 会话身份：自己的账号 id（同一个人的 mid 与 uid 都在 cookie 里） ---- */
window.__QN.selfIds = function () {
  var c = document.cookie || '';
  var ids = {};
    /* 注意：这是被 template literal 包住的字符串，
       反斜杠必须写两遍，否则 \d 会退化成字面量 d（踩过一次）。 */
    var re = /(?:^|;\\s*)(?:aui|unb|cnaui)=(\\d+)/g, m;
    while ((m = re.exec(c))) ids[m[1]] = 1;
    var mid = c.match(/c_mid=b2b-(\\d+)/);
  if (mid) ids[mid[1]] = 1;
  return Object.keys(ids);
};
/* 会话 id 形如 3159769358.1-2212374827980.1#11152@cntaobao
   = {一侧账号}.{版本}-{另一侧账号}.{版本}#{会话类型}@{站点}
   注意两侧顺序不固定（有时我方在左、有时在右），要靠 selfIds 分辨。 */
window.__QN.parseConvId = function (id) {
  var m = /^(.+?)-(.+?)#(\\d+)@(\\w+)$/.exec(id || '');
  if (!m) return null;
  var strip = function (s) { return String(s).split('.')[0]; };
  return { a: strip(m[1]), b: strip(m[2]), cidType: m[3], site: m[4] };
};
/* ---- 会话列表（主键用 id，不用显示名：显示名会重名） ---- */
window.__QN.convs = function () {
  var d = window.__QN.core(); if (!d) return [];
  var self = window.__QN.selfIds();
  return Array.prototype.map.call(d.querySelectorAll('.conversation-item'), function (el) {
    var q = function (sel) {
      var e = el.querySelector(sel);
      return e ? (e.innerText || e.textContent || '').replace(/\\s+/g, ' ').trim() : '';
    };
    var u = el.querySelector('[class*="unread"],[class*="badge"],[class*="count"]');
    var id = el.id || '';
    var p = window.__QN.parseConvId(id);
    var peer = '', isSelf = false, aMine = false, bMine = false;
    if (p) {
      aMine = self.indexOf(p.a) >= 0;
      bMine = self.indexOf(p.b) >= 0;
      isSelf = aMine && bMine;                 // 两侧都是自己 = 自己给自己
      peer = isSelf ? '' : (aMine ? p.b : (bMine ? p.a : p.a));
    }
    return {
      key: id || ('name:' + q('.name')),       // 稳定唯一主键
      id: id,
      peer: peer,                              // 对方账号 id
      isSelf: isSelf,                          // 是否本账号自己
      cidType: p ? p.cidType : '',
      site: p ? p.site : '',
      name: q('.name'),
      time: q('.time'),
      desc: q('.desc'),
      unread: u ? (u.textContent || '').trim() : '',
      active: el.classList.contains('active')
    };
  }).filter(function (c) { return c.name; });
};
/* 当前打开的会话 id */
window.__QN.activeConvId = function () {
  var d = window.__QN.core();
  var el = d && d.querySelector('.conversation-item.active');
  return el ? (el.id || '') : '';
};
/* 会话列表有三个标签页：全部 / AI询 / 联系人。
   停在"AI询"或"联系人"时会看不到普通会话（显示"暂无AI询盘会话"），
   所以操作会话列表前先切回"全部"。返回 'already' | 'clicked' | 'no-tab' */
window.__QN.ensureAllTab = function () {
  var d = window.__QN.core(); if (!d) return 'no-core';
  var tabs = Array.prototype.slice.call(d.querySelectorAll('.conversation-list .tab .item'));
  var all = tabs.filter(function (t) {
    return ((t.getAttribute('title') || t.textContent || '').trim() === '全部');
  })[0];
  if (!all) return 'no-tab';
  if (all.classList.contains('active')) return 'already';
  try { all.click(); } catch (e) { return 'click-failed'; }
  return 'clicked';
};
/* ---- 快照 ---- */
window.__QN.snapshot = function () {
  var d = window.__QN.core();
  if (!d) return null;
  return {
    title: document.title,
    href: location.href,
    activeId: window.__QN.activeConvId(),
    convs: window.__QN.convs(),
    msgs: window.__QN.parse()
  };
};
/* ---- 快捷短语 ---- */
window.__QN.phraseBtnSel = 'div.editor-tool img[src*="O1CN01ef7kpc20oQQ0LVt4m"]';
window.__QN.phraseDialog = function () {
  var d = window.__QN.core(); if (!d) return null;
  var cands = d.querySelectorAll('div, section, ul');
  for (var i = 0; i < cands.length; i++) {
    var el = cands[i];
    if ((el.innerText || '').indexOf('选择快捷回复短语') < 0) continue;
    var r = el.getBoundingClientRect();
    if (r.width < 150 || r.height < 80 || el.children.length > 40) continue;
    return el;
  }
  return null;
};
window.__QN.phraseItems = function () {
  var dlg = window.__QN.phraseDialog(); if (!dlg) return [];
  var out = [], seen = {};
  Array.prototype.forEach.call(dlg.querySelectorAll('div, li, span, p'), function (d) {
    var t = (d.innerText || '').trim();
    if (!t || t.indexOf('\\n') >= 0 || t.length > 40) return;
    if (d.children.length > 2) return;
    if (t.indexOf('选择快捷回复短语') >= 0) return;
    var r = d.getBoundingClientRect();
    if (r.width < 30 || r.height < 8 || r.height > 60) return;
    var b = window.__QN.toTopBox(d);
    if (!b) return;
    var key = t + '@' + Math.round(b.y);
    if (seen[key]) return;
    seen[key] = 1;
    out.push({ text: t, x: b.x, y: b.y, w: b.w, h: b.h });
  });
  return out;
};
'qn-helpers-ready';
`;

export async function evaluate(session, expression) {
  return rawEvaluate(session, expression);
}

export async function ensureHelpers(session) {
  return evaluate(session, HELPERS);
}

/* 打开一个会话：注入工具后交给 fn；fn 返回后自动断开 */
export async function withSession(fn, opts = {}) {
  const match = opts.match || PAGE_MATCH;
  let page;
  if (opts.targetId) {
    /* 指定具体的标签页（例如"刚点开的那一个聊天窗口"） */
    const { listPages } = await import('../cdp-lib.mjs');
    page = (await listPages()).find((p) => p.id === opts.targetId);
    if (!page) throw new Error('找不到指定的标签页：' + opts.targetId);
  } else {
    page = await pickPage(match, { allowTitle: opts.allowTitle });
  }
  const session = await attach(page);
  try {
    await ensureHelpers(session);
    return await fn(session, page);
  } finally {
    session.close();
  }
}

/* 真实鼠标点击（自动补偿 iframe 偏移） */
export async function clickAt(session, box) {
  if (!box) throw new Error('点击目标不存在（坐标为空）');
  if (box.w < 2 || box.h < 2) throw new Error(`点击目标不可见（${box.w}x${box.h}）`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await session.send('Input.dispatchMouseEvent', {
      type, x: box.x, y: box.y, button: 'left', clickCount: 1,
      buttons: type === 'mousePressed' ? 1 : 0
    });
  }
}

/* 按选择器真实点击核心文档里的元素 */
export async function clickSelector(session, selector) {
  const box = await evaluate(session, `(() => __QN.boxOf(${JSON.stringify(selector)}))()`);
  if (!box) throw new Error('找不到元素：' + selector);
  await clickAt(session, box);
  return box;
}

/* ---- 键盘：发真实按键事件（可选修饰键，2 = Ctrl） ---- */
const VK = { Backspace: 8, Delete: 46, Enter: 13, Tab: 9, Escape: 27, a: 65, A: 65 };

export async function pressKey(session, key, modifiers = 0) {
  const vk = VK[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  const code = key.length === 1 ? 'Key' + key.toUpperCase() : key;
  for (const type of ['rawKeyDown', 'keyUp']) {
    await session.send('Input.dispatchKeyEvent', {
      type, key, code,
      windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers
    });
  }
}

/* 编辑器里「全选」必须用真实 Ctrl+A；
   document.execCommand('selectAll'/'delete') 对这个编辑器是空操作（实测）。 */
export async function selectAll(session) {
  await pressKey(session, 'a', 2);
}

/* ---- 给 <input type=file> 塞文件（frame 感知） ----
   为什么不用 DOM.querySelector：它只搜顶层文档，而聊天输入区在核心 iframe 里。
   这里用 Runtime.evaluate 取到元素对象，再按 objectId 塞文件，跨 frame 也可用。
   opts.inCore = true 时从 __QN.core()（核心聊天文档）里找。 */
export async function setFileInput(session, selector, file, opts = {}) {
  const abs = (await import('node:path')).resolve(file);
  const { existsSync } = await import('node:fs');
  if (!existsSync(abs)) throw new Error('文件不存在：' + abs);

  const expr = opts.inCore
    ? `(() => { const d = window.__QN && __QN.core(); return d ? d.querySelector(${JSON.stringify(selector)}) : null; })()`
    : `(() => document.querySelector(${JSON.stringify(selector)}))()`;

  const r = await session.send('Runtime.evaluate', {
    expression: expr, returnByValue: false, userGesture: true
  });
  if (r.exceptionDetails) {
    throw new Error('取元素失败：' + (r.exceptionDetails.text || r.exceptionDetails.exception?.description || ''));
  }
  const objectId = r.result && r.result.objectId;
  if (!objectId) throw new Error('找不到文件输入框：' + selector);

  /* 先清空再塞：input 里如果已经是同名文件，直接再塞一次不会触发 change，
     页面也就不会上传（实测踩过：第一次能发，之后再发就没反应）。 */
  await session.send('DOM.setFileInputFiles', { files: [], objectId });
  await session.send('DOM.setFileInputFiles', { files: [abs], objectId });
  return { file: abs, objectId };
}
