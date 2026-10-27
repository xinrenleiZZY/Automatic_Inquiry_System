/* =====================================================================
 * 输入区工具栏 dump —— 精确定位「快捷短语」按钮
 *
 *   node tools/qianniu/cdp.mjs eval def_cbu_web_im tools/qianniu/probe-tools.js
 *
 * 输出 div.editor-tool 的每个子项：类名、内层 HTML、图标 img 的 src，
 * 以便不靠 nth-of-type 这种脆弱定位。
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

  const core = docs.find((d) => d.querySelector('div.input-area') || d.querySelector('.message-list'));
  if (!core) return { error: '找不到核心聊天文档' };

  const tool = core.querySelector('div.editor-tool');
  if (!tool) return { error: '找不到 div.editor-tool' };

  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };

  const out = {
    toolRect: rectOf(tool),
    childCount: tool.children.length,
    children: [],
    outer: (tool.outerHTML || '').replace(/\s+/g, ' ').slice(0, 2200)
  };

  Array.prototype.forEach.call(tool.children, (el, i) => {
    const imgs = Array.prototype.map.call(el.querySelectorAll('img'), (im) => ({
      src: (im.getAttribute('src') || '').slice(0, 140),
      cls: String(im.className || ''),
      rect: rectOf(im)
    }));
    out.children.push({
      idx: i,
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || '').slice(0, 70),
      rect: rectOf(el),
      imgs,
      html: (el.innerHTML || '').replace(/\s+/g, ' ').slice(0, 300)
    });
  });

  return out;
})();
