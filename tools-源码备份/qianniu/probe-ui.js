/* =====================================================================
 * 聊天页 UI 探针（frame 无关版）
 *
 *   node tools/qianniu/cdp.mjs eval def_cbu_web_im tools/qianniu/probe-ui.js
 *
 * 先递归找出「核心聊天文档」，再 dump：
 *   1) 每个同源文档里有哪些关键元素（用于确认结构）
 *   2) 输入区工具栏的所有小图标按钮（找「快捷短语」按钮用）
 *   3) 若快捷短语弹窗已打开，连弹窗和短语列表项一起 dump
 * ===================================================================== */
(function () {
  'use strict';

  /* ---- 递归收集同源文档 ---- */
  const docs = [];
  (function walk(win, path, depth) {
    if (!win || depth > 4) return;
    let d;
    try { d = win.document; } catch (e) { return; }
    if (!d || !d.body) return;
    docs.push({ path, doc: d });
    let fs;
    try { fs = d.querySelectorAll('iframe'); } catch (e) { return; }
    Array.prototype.forEach.call(fs, (f, i) => {
      try { if (f.contentWindow) walk(f.contentWindow, path + ' > iframe[' + i + ']', depth + 1); } catch (e) { /* 跨域 */ }
    });
  })(window, 'TOP', 0);

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

  const out = { frames: [], coreFrame: null, found: {}, toolbar: [], dialogs: [] };

  docs.forEach((item) => {
    const doc = item.doc;
    out.frames.push({
      path: item.path,
      url: (doc.location ? doc.location.href : '').slice(0, 80),
      inputArea: !!doc.querySelector('div.input-area'),
      msgList: !!doc.querySelector('.message-list'),
      convItem: !!doc.querySelector('.conversation-item'),
      sendBtn: !!doc.querySelector('button.send-btn')
    });
  });

  const coreEntry = docs.find((item) => {
    const d = item.doc;
    return d.querySelector('div.input-area') || d.querySelector('.message-list') || d.querySelector('.conversation-item');
  });
  if (!coreEntry) {
    out.error = '所有同源文档里都没找到聊天核心元素';
    return out;
  }
  out.coreFrame = coreEntry.path;
  const core = coreEntry.doc;

  out.found = {
    input: !!core.querySelector('pre.edit'),
    sendBtn: !!core.querySelector('button.send-btn'),
    msgList: !!core.querySelector('.message-list'),
    convItems: core.querySelectorAll('.conversation-item').length,
    editables: core.querySelectorAll('[contenteditable="true"]').length
  };

  /* ---- 输入区工具栏上的小图标 ---- */
  const area = core.querySelector('div.input-area') || core;
  const rows = [];
  area.querySelectorAll('*').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6 || r.width > 90 || r.height > 90) return;
    const tag = el.tagName.toLowerCase();
    const cls = typeof el.className === 'string' ? el.className : '';
    const title = el.getAttribute('title') || '';
    const aria = el.getAttribute('aria-label') || '';
    const hit = tag === 'button' || tag === 'i' || tag === 'svg' ||
      /icon|btn|tool|phrase|quick|emoji|face|img|reply/i.test(cls) || title || aria;
    if (!hit) return;
    rows.push({
      path: cssPath(el), tag, cls: cls.slice(0, 52), title, aria,
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 16),
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)
    });
  });
  out.toolbar = rows.slice(0, 40);

  /* ---- 快捷短语弹窗（若已打开） ---- */
  core.querySelectorAll('div, section, ul').forEach((el) => {
    const t = el.innerText || '';
    if (!/选择快捷回复短语|快捷回复短语/.test(t)) return;
    const r = el.getBoundingClientRect();
    if (r.width < 150 || r.height < 80 || el.children.length > 40) return;
    const rec = {
      path: cssPath(el), cls: String(el.className || '').slice(0, 52),
      x: Math.round(r.x), y: Math.round(r.y),
      head: t.replace(/\s+/g, ' ').trim().slice(0, 50), items: []
    };
    el.querySelectorAll('div, li, span, p').forEach((d) => {
      const dt = (d.innerText || '').trim();
      if (!dt || dt.indexOf('\n') >= 0 || dt.length > 40 || d.children.length > 2) return;
      const dr = d.getBoundingClientRect();
      if (dr.width < 30 || dr.height < 8 || dr.height > 60) return;
      rec.items.push({
        path: cssPath(d), tag: d.tagName.toLowerCase(),
        cls: String(d.className || '').slice(0, 40), text: dt,
        x: Math.round(dr.x), y: Math.round(dr.y)
      });
    });
    rec.items = rec.items.slice(0, 20);
    out.dialogs.push(rec);
  });

  return out;
})();
