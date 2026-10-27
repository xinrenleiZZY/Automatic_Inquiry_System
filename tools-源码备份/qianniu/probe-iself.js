/* =====================================================================
 * 自检：为什么「本账号自己」判定失效
 *
 *   node tools/qianniu/cdp.mjs eval def_cbu_web_im tools/qianniu/probe-iself.js
 *
 * 分别用「顶层 document.cookie」和「核心 frame 的 cookie」各算一遍 selfIds，
 * 看是哪一步取不到，并逐个会话列出判定结果。
 * ===================================================================== */
(function () {
  'use strict';

  const docs = [];
  (function walk(win, depth) {
    if (!win || depth > 4) return;
    let d;
    try { d = win.document; } catch (e) { return; }
    if (!d || !d.body) return;
    docs.push(d);
    Array.prototype.forEach.call(d.querySelectorAll('iframe'), (f) => {
      try { if (f.contentWindow) walk(f.contentWindow, depth + 1); } catch (e) { /* 跨域 */ }
    });
  })(window, 0);

  const core = docs.find((d) => d.querySelector('.conversation-item') || d.querySelector('div.input-area'));
  if (!core) return { error: '找不到核心聊天文档' };

  const selfIdsFrom = (ck) => {
    const ids = {};
    const re = /(?:^|;\s*)(?:aui|unb|cnaui)=(\d+)/g;
    let m;
    while ((m = re.exec(ck))) ids[m[1]] = 1;
    const mid = ck.match(/c_mid=b2b-(\d+)/);
    if (mid) ids[mid[1]] = 1;
    return Object.keys(ids);
  };

  const topCookie = document.cookie || '';
  const coreCookie = core.cookie || '';

  const strip = (s) => String(s).split('.')[0];
  const parse = (id) => {
    const m = /^(.+?)-(.+?)#(\d+)@(\w+)$/.exec(id || '');
    return m ? { a: strip(m[1]), b: strip(m[2]) } : null;
  };

  const topIds = selfIdsFrom(topCookie);
  const coreIds = selfIdsFrom(coreCookie);

  const rows = [];
  Array.prototype.forEach.call(core.querySelectorAll('.conversation-item'), (el, i) => {
    const p = parse(el.id || '');
    const t = p ? (topIds.includes(p.a) && topIds.includes(p.b)) : null;
    const c = p ? (coreIds.includes(p.a) && coreIds.includes(p.b)) : null;
    rows.push({
      idx: i,
      name: (el.querySelector('.name') || {}).textContent || '',
      id: el.id,
      a: p && p.a, b: p && p.b,
      isSelf_topCookie: t,
      isSelf_coreCookie: c
    });
  });

  return {
    topCookieLen: topCookie.length,
    coreCookieLen: coreCookie.length,
    selfIds_top: topIds,
    selfIds_core: coreIds,
    rows
  };
})();
