/* =====================================================================
 * 1688 搜索页「以图搜图」结构探针
 *
 *   node tools/qianniu/cdp.mjs eval offer_search tools/qianniu/probe-search.js
 *
 * 目标：
 *   1) 验证用户给的搜索按钮选择器是否成立
 *   2) 找「粘贴区」容器（Ctrl+V 的落点）
 *   3) 找隐藏的 <input type=file>（有的话可以直接塞文件，不必走剪贴板）
 *   4) 找搜索输入框
 * ===================================================================== */
(function () {
  'use strict';

  const USER_SELECTOR = '#pc-home2024-search-tab > div > div.image-input-button > div > div.copy-image-container > div.search-btn';

  const docs = [];
  (function walk(win, depth) {
    if (!win || depth > 3) return;
    let d;
    try { d = win.document; } catch (e) { return; }
    if (!d || !d.body) return;
    docs.push(d);
    Array.prototype.forEach.call(d.querySelectorAll('iframe'), (f) => {
      try { if (f.contentWindow) walk(f.contentWindow, depth + 1); } catch (e) { /* 跨域 */ }
    });
  })(window, 0);

  const cssPath = (el, maxDepth) => {
    maxDepth = maxDepth || 6;
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < maxDepth) {
      if (cur.id) { parts.unshift('#' + cur.id); break; }
      let sel = cur.tagName.toLowerCase();
      const cls = typeof cur.className === 'string'
        ? cur.className.trim().split(/\s+/).filter((c) => /^[A-Za-z_-][\w-]*$/.test(c)).slice(0, 2)
        : [];
      if (cls.length) sel += '.' + cls.join('.');
      const p = cur.parentElement;
      if (p) {
        const sib = Array.prototype.filter.call(p.children, (c) => c.tagName === cur.tagName);
        if (sib.length > 1) sel += ':nth-of-type(' + (sib.indexOf(cur) + 1) + ')';
      }
      parts.unshift(sel);
      cur = p;
    }
    return parts.join(' > ');
  };

  const out = { url: location.href, title: document.title, docs: docs.length };

  /* 1) 用户给的按钮选择器 */
  try {
    const btn = document.querySelector(USER_SELECTOR);
    if (btn) {
      const r = btn.getBoundingClientRect();
      out.searchButton = {
        found: true, path: cssPath(btn),
        text: (btn.innerText || '').trim().slice(0, 20),
        cls: String(btn.className || '').slice(0, 60),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        visible: r.width > 2 && r.height > 2
      };
    } else {
      out.searchButton = { found: false };
    }
  } catch (e) { out.searchButton = { found: false, error: e.message }; }

  /* 2) 搜索区容器（粘贴落点候选） */
  out.containers = [];
  docs.forEach((d) => {
    d.querySelectorAll('#pc-home2024-search-tab, [class*="search-tab"], [class*="image-input"], [class*="copy-image"]').forEach((el) => {
      if (out.containers.length > 12) return;
      const r = el.getBoundingClientRect();
      out.containers.push({
        path: cssPath(el), id: el.id || '', cls: String(el.className || '').slice(0, 70),
        tag: el.tagName.toLowerCase(),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        childCount: el.children.length
      });
    });
  });

  /* 3) 隐藏 file input（能直接塞文件就更稳） */
  out.fileInputs = [];
  docs.forEach((d) => {
    d.querySelectorAll('input[type="file"]').forEach((el) => {
      const r = el.getBoundingClientRect();
      out.fileInputs.push({
        path: cssPath(el), accept: el.getAttribute('accept') || '',
        cls: String(el.className || '').slice(0, 50),
        hidden: el.offsetParent === null || getComputedStyle(el).display === 'none',
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      });
    });
  });

  /* 4) 搜索输入框 */
  out.searchInput = null;
  try {
    const si = document.querySelector('#pc-home2024-search-tab input, input[name="keywords"], #alisearch-input, input[type="search"], input.search-input');
    if (si) {
      out.searchInput = {
        path: cssPath(si), placeholder: si.getAttribute('placeholder') || '',
        cls: String(si.className || '').slice(0, 60)
      };
    }
  } catch (e) { /* ignore */ }

  return out;
})();
