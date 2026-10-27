/* =====================================================================
 * 会话唯一标识探针
 *
 *   node tools/qianniu/cdp.mjs eval def_cbu_web_im tools/qianniu/probe-conv-id.js
 *
 * 背景：显示名会重名（例如 playworld152:it 本账号 与 playworld152:cqy 同事），
 *       所以必须找到「账号级」的稳定标识，不能用 .name 当主键。
 *
 * 输出：每个 .conversation-item 的所有属性、关键子元素的属性、
 *       以及整段 HTML 里出现的账号形态字符串。
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

  const items = Array.prototype.slice.call(core.querySelectorAll('.conversation-item'));

  const attrMap = (el) => {
    const o = {};
    Array.prototype.forEach.call(el.attributes || [], (a) => {
      if (a.name === 'class' || a.name === 'style') return;
      o[a.name] = String(a.value).slice(0, 80);
    });
    return o;
  };

  const ACCOUNT_RE = /(cnalichn|cntaobao|enaliint|playworld\d+|tb\d{6,}|[a-z0-9_]+:(it|cqy|wx|hr)[a-z0-9]*)/gi;

  const out = { count: items.length, items: [] };

  items.forEach((el, i) => {
    const html = (el.outerHTML || '').replace(/\s+/g, ' ');
    const hits = [...new Set(html.match(ACCOUNT_RE) || [])].slice(0, 12);

    /* 关键子元素：name / avatar / 任何带 title|href|data-* 的 */
    const kids = [];
    Array.prototype.forEach.call(el.querySelectorAll('*'), (d) => {
      const cls = typeof d.className === 'string' ? d.className : '';
      const attrs = attrMap(d);
      const hasData = Object.keys(attrs).some((k) => k.indexOf('data-') === 0);
      if (!/name|avatar|conversation/i.test(cls) && !hasData && !attrs.title && !attrs.href) return;
      kids.push({
        tag: d.tagName.toLowerCase(),
        cls: cls.slice(0, 44),
        attrs,
        text: (d.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30)
      });
    });

    out.items.push({
      idx: i,
      itemAttrs: attrMap(el),
      name: (el.querySelector('.name') || {}).textContent || '',
      time: (el.querySelector('.time') || {}).textContent || '',
      desc: (el.querySelector('.desc') || {}).textContent || '',
      accountHits: hits,
      keyKids: kids.slice(0, 8),
      htmlHead: html.slice(0, 420)
    });
  });

  return out;
})();
