/* =====================================================================
 * 以图搜图结果页结构探针
 *
 *   node tools/qianniu/cdp.mjs eval pc-image-search tools/qianniu/probe-imageresults.js
 *
 * 找商品卡片的真实结构：重复子节点容器、价格元素、标题元素、链接。
 * ===================================================================== */
(function () {
  'use strict';

  const docs = [];
  (function walk(win, path, depth) {
    if (!win || depth > 3) return;
    let d;
    try { d = win.document; } catch (e) { return; }
    if (!d || !d.body) return;
    docs.push({ path, doc: d });
    Array.prototype.forEach.call(d.querySelectorAll('iframe'), (f, i) => {
      try { if (f.contentWindow) walk(f.contentWindow, path + '>f' + i, depth + 1); } catch (e) { /* 跨域 */ }
    });
  })(window, 'TOP', 0);

  const cssPath = (el, maxDepth) => {
    maxDepth = maxDepth || 5;
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
      parts.unshift(sel);
      cur = cur.parentElement;
    }
    return parts.join('>');
  };

  const out = { url: location.href, title: document.title, frames: [], priceCount: 0, lists: [], samples: [] };

  docs.forEach(({ path, doc }) => {
    out.frames.push({ path, url: (doc.location ? doc.location.href : '').slice(0, 70), nodes: doc.querySelectorAll('*').length });

    /* 价格元素个数 */
    let priceCount = 0;
    doc.querySelectorAll('*').forEach((el) => {
      if (el.children.length === 0 && /[￥¥]\s?\d/.test(el.textContent || '')) priceCount++;
    });
    out.priceCount += priceCount;

    /* 重复子节点容器 = 卡片列表候选 */
    doc.querySelectorAll('div, ul').forEach((el) => {
      if (el.children.length < 4) return;
      const kids = Array.prototype.slice.call(el.children, 0, 8);
      const sigs = kids.map((c) => c.tagName + '.' + (typeof c.className === 'string' ? c.className.split(/\s+/).slice(0, 2).join('.') : ''));
      const uniq = new Set(sigs);
      if (uniq.size > 2) return;
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 100) return;
      out.lists.push({
        frame: path, path: cssPath(el), childCount: el.children.length,
        sig: sigs[0].slice(0, 60),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        sample: kids.slice(0, 2).map((c) => (c.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 70))
      });
    });

    /* 含价格的元素样本（看卡片长什么样） */
    doc.querySelectorAll('*').forEach((el) => {
      if (out.samples.length >= 8) return;
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (!/[￥¥]\s?\d/.test(t)) return;
      if (t.length < 10 || t.length > 120) return;
      if (el.children.length > 6) return;
      out.samples.push({
        frame: path, path: cssPath(el), cls: String(el.className || '').slice(0, 50),
        text: t.slice(0, 90)
      });
    });
  });

  out.lists = out.lists.sort((a, b) => b.childCount - a.childCount).slice(0, 6);
  return out;
})();
