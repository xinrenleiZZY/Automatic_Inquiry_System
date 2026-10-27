/* 探聊天输入区的"贴图"入口与附件落点
   node tools/qianniu/cdp.mjs eval def_cbu_web_im tools/qianniu/probe-chat-upload.js
*/
(function () {
  'use strict';

  const USER_IMG = '#ice-container > div > div > div.ww_box > div.ww_input > div > div > div > div.biz-expression-editor.text-area > div.title > div:nth-child(2) > div > div:nth-child(1) > div > div > img';

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

  const core = docs.find((d) => d.querySelector('div.input-area') || d.querySelector('.message-list'));
  if (!core) return { error: '找不到核心聊天文档' };

  const cssPath = (el, maxDepth) => {
    maxDepth = maxDepth || 7;
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

  const root = core.querySelector('#ice-container') || core;
  const out = {
    coreHasIceContainer: !!core.querySelector('#ice-container'),
    topHasUserSelector: !!document.querySelector(USER_IMG),
    coreHasUserSelector: !!core.querySelector(USER_IMG),
    fileInputs: [],
    inputAreaClasses: [],
    attachmentCandidates: []
  };

  /* 所有 file input */
  [['TOP', document], ['CORE', core]].forEach(([label, d]) => {
    d.querySelectorAll('input[type="file"]').forEach((el) => {
      out.fileInputs.push({
        where: label,
        path: cssPath(el),
        accept: el.getAttribute('accept') || '',
        name: el.getAttribute('name') || '',
        cls: String(el.className || '').slice(0, 50),
        hidden: el.offsetParent === null
      });
    });
  });

  /* 输入区里与"附件/图片"有关的容器 */
  const area = core.querySelector('div.input-area') || root;
  area.querySelectorAll('*').forEach((el) => {
    const cls = typeof el.className === 'string' ? el.className : '';
    if (!/upload|pic|image|attach|file|thumb|expression|editor-tool|biz-/i.test(cls)) return;
    if (out.attachmentCandidates.length >= 18) return;
    const r = el.getBoundingClientRect();
    out.attachmentCandidates.push({
      path: cssPath(el),
      tag: el.tagName.toLowerCase(),
      cls: cls.slice(0, 56),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    });
  });

  /* 用户给的 img 元素本身 */
  const img = core.querySelector(USER_IMG);
  if (img) {
    const r = img.getBoundingClientRect();
    out.userImg = {
      src: (img.getAttribute('src') || '').slice(0, 90),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      parentHtml: (img.parentElement ? img.parentElement.outerHTML : '').replace(/\s+/g, ' ').slice(0, 300)
    };
  }

  return out;
})();
