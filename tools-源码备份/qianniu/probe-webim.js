/* =====================================================================
 * 1688 网页版旺旺（def_cbu_web_im）结构探针
 *
 * 专为 CDP 调用设计：本脚本会「返回」一个 JSON 可序列化对象（不含 DOM 节点），
 * 所以用 cdp.mjs eval 直接把结果打印出来即可。
 *
 *   node tools/qianniu/cdp.mjs eval def_cbu_web_im tools/qianniu/probe-webim.js
 *
 * 它做的事：
 *   1) 递归穿透同源 iframe，列出每个文档
 *   2) 找出 输入框 / 发送按钮 / 消息区 / 会话标题
 *   3) 给每个元素生成稳定选择器路径，供后续自动化直接使用
 *   4) 解析 URL 里的 touid / offerId 等会话参数
 * ===================================================================== */
(function () {
  'use strict';

  const out = {
    url: location.href,
    title: document.title,
    params: {},
    docs: [],
    inputs: [],
    sendButtons: [],
    msgListCandidates: [],
    convTitle: null
  };

  /* ---------- URL 参数（会话上下文） ---------- */
  try {
    const usp = new URLSearchParams(location.search);
    ['touid', 'siteid', 'offerId', 'itemsId', 'status', 'gid', 'portalId'].forEach((k) => {
      if (usp.get(k)) out.params[k] = usp.get(k);
    });
  } catch (e) { /* ignore */ }

  /* ---------- 工具 ---------- */
  const cssPath = (el, maxDepth = 6) => {
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

  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 5 || r.height < 5) return false;
    const st = el.ownerDocument.defaultView.getComputedStyle(el);
    return !(st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0');
  };

  /* ---------- 收集所有同源文档 ---------- */
  const docs = [];
  (function walk(win, path, depth) {
    if (!win || depth > 4) return;
    let doc;
    try { doc = win.document; } catch (e) { return; }
    if (!doc || !doc.body) return;
    docs.push({ path, doc, win });
    let frames;
    try { frames = doc.querySelectorAll('iframe'); } catch (e) { return; }
    Array.prototype.forEach.call(frames, (f, i) => {
      let child = null;
      try { child = f.contentWindow; } catch (e) { /* 跨域 */ }
      if (child) walk(child, path + ' > iframe[' + i + ']', depth + 1);
    });
  })(window, 'TOP', 0);

  /* ---------- 逐文档分析 ---------- */
  docs.forEach(({ path, doc }) => {
    const rec = {
      path,
      url: doc.location ? doc.location.href : '',
      editableCount: 0,
      sendBtnCount: 0
    };

    /* 输入框 */
    let editables = [];
    try {
      editables = Array.prototype.slice.call(
        doc.querySelectorAll('[contenteditable="true"], textarea, input[type="text"], input:not([type])')
      ).filter(visible);
    } catch (e) { /* ignore */ }
    rec.editableCount = editables.length;
    editables.slice(0, 10).forEach((el) => {
      out.inputs.push({
        frame: path,
        path: cssPath(el),
        tag: el.tagName.toLowerCase(),
        contentEditable: !!el.isContentEditable,
        placeholder: el.getAttribute('placeholder') || '',
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60),
        rect: rectOf(el)
      });
    });

    /* 发送按钮 */
    let sends = [];
    try {
      Array.prototype.forEach.call(doc.querySelectorAll('button, a, div, span'), (el) => {
        const t = (el.textContent || '').trim();
        if (t === '发送' && visible(el)) sends.push(el);
      });
    } catch (e) { /* ignore */ }
    rec.sendBtnCount = sends.length;
    sends.slice(0, 5).forEach((el) => {
      out.sendButtons.push({
        frame: path,
        path: cssPath(el),
        tag: el.tagName.toLowerCase(),
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60),
        rect: rectOf(el)
      });
    });

    /* 会话标题：找显示对方昵称的元素 */
    if (!out.convTitle && out.params.touid) {
      const shortName = out.params.touid.replace(/^(cnalichn|cntaobao|enaliint|wangwang)/, '');
      try {
        Array.prototype.forEach.call(doc.querySelectorAll('div, span, h1, h2'), (el) => {
          if (out.convTitle) return;
          const t = (el.textContent || '').trim();
          if (t && t.length < 40 && shortName && t.includes(shortName.slice(0, 6)) && visible(el)) {
            out.convTitle = { frame: path, path: cssPath(el), text: t, rect: rectOf(el) };
          }
        });
      } catch (e) { /* ignore */ }
    }

    /* 消息列表候选：重复子节点 + 可滚动 */
    try {
      Array.prototype.forEach.call(doc.querySelectorAll('div, ul'), (el) => {
        if (el.children.length < 3) return;
        const kids = Array.prototype.slice.call(el.children, 0, 10);
        const sigs = kids.map((c) => c.tagName + '.' + (typeof c.className === 'string' ? c.className.split(/\s+/).slice(0, 2).join('.') : ''));
        const uniq = new Set(sigs);
        if (uniq.size > 2) return;
        const r = el.getBoundingClientRect();
        if (r.width < 120 || r.height < 120) return;
        out.msgListCandidates.push({
          frame: path,
          path: cssPath(el),
          childCount: el.children.length,
          repeatedSig: sigs[0].slice(0, 70),
          scrollable: el.scrollHeight > el.clientHeight + 20,
          rect: rectOf(el),
          samples: kids.slice(0, 3).map((c) => (c.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40))
        });
      });
    } catch (e) { /* ignore */ }

    out.docs.push(rec);
  });

  /* 只保留最有价值的前若干条，避免 JSON 过大 */
  out.msgListCandidates = out.msgListCandidates
    .sort((a, b) => b.childCount - a.childCount)
    .slice(0, 8);

  return out;
})();
