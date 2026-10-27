/* =====================================================================
 * 千牛 / 1688卖家工作台 —— 聊天子应用定位探针（第二版）
 *
 * 背景：千牛是微前端架构（React + AntD5 + icestark），
 *       「快捷短语」「聊天接待」「消息记录」是各自独立的子应用页面，
 *       所以必须先确认当前 DevTools 上下文是不是聊天那个，
 *       否则拿到的选择器（比如"搜索快捷短语"输入框）完全没法用。
 *
 * 本探针会：
 *   1) 递归列出所有「同源可达」的 window/document（含 iframe 下钻）
 *   2) 给每个文档打「像不像聊天区」的分，排出最可能的聊天子应用
 *   3) 在得分最高的文档里，深挖 消息区 / 单条消息 / 输入框 / 发送按钮
 *
 * 用法：F12 → Console → 粘贴全文 → 回车。结果自动复制到剪贴板。
 *       全程只读，不点击、不发送、不改数据。
 * ===================================================================== */
(function () {
  'use strict';

  var TEXT_MAX = 60;

  function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
  function cut(s, n) { return clean(s).slice(0, n || TEXT_MAX); }

  /* ---------- 1. 递归遍历所有可达文档 ---------- */
  function collect(win, path, out, depth, visited) {
    if (!win || depth > 4) return;
    var doc;
    try { doc = win.document; } catch (e) {
      out.push({ path: path, accessible: false, note: '跨域(' + e.name + ')' });
      return;
    }
    if (!doc || !doc.body) { out.push({ path: path, accessible: false, note: '空文档' }); return; }
    if (visited.indexOf(doc) >= 0) return;
    visited.push(doc);

    out.push({
      path: path,
      accessible: true,
      win: win,
      doc: doc,
      url: doc.location ? doc.location.href : '',
      title: doc.title || '',
      isTop: (function () { try { return win === win.top; } catch (e) { return false; } })()
    });

    var ifr;
    try { ifr = doc.querySelectorAll('iframe, frame'); } catch (e) { return; }
    Array.prototype.forEach.call(ifr, function (f, i) {
      var child = null;
      try { child = f.contentWindow; } catch (e) { /* ignore */ }
      if (child) collect(child, path + ' > f' + i, out, depth + 1, visited);
    });
  }

  var roots = [];
  try { if (window.top) roots.push(window.top); } catch (e) { /* 跨域 */ }
  if (roots.indexOf(window) < 0) roots.push(window);

  var found = [];
  var seen = [];
  roots.forEach(function (w) { collect(w, 'ROOT', found, 0, seen); });

  /* ---------- 2. 给每个文档的「聊天相似度」打分 ---------- */
  function countMatches(doc, re) {
    var n = 0;
    try {
      Array.prototype.forEach.call(doc.querySelectorAll('*'), function (el) {
        if (el.children.length === 0 && re.test(el.textContent || '')) n++;
      });
    } catch (e) { /* ignore */ }
    return n;
  }

  function scoreDoc(rec) {
    var doc = rec.doc, ev = [], score = 0;

    var sendBtn = null;
    try {
      Array.prototype.forEach.call(doc.querySelectorAll('button, [role="button"], a, span, div'), function (el) {
        if (sendBtn) return;
        if (clean(el.textContent) === '发送') sendBtn = el;
      });
    } catch (e) { /* ignore */ }
    if (sendBtn) { score += 4; ev.push('有「发送」按钮'); rec.sendBtn = sendBtn; }

    var editables = [];
    try {
      Array.prototype.forEach.call(doc.querySelectorAll('[contenteditable="true"], textarea, input'), function (el) {
        if (el.tagName === 'INPUT' && (el.getAttribute('type') || 'text').toLowerCase() === 'hidden') return;
        var ph = el.getAttribute('placeholder') || '';
        if (/搜索|search/i.test(ph) && el.tagName === 'INPUT') return;   // 排除搜索框
        editables.push(el);
      });
    } catch (e) { /* ignore */ }
    if (editables.length) { score += 3; ev.push('可输入元素 x' + editables.length); rec.editables = editables; }

    var timeHits = countMatches(doc, /^\d{1,2}:\d{2}(:\d{2})?$/);
    if (timeHits >= 3) { score += 2; ev.push('时间戳 x' + timeHits); }

    var unread = countMatches(doc, /^未读$/);
    if (unread >= 1) { score += 1; ev.push('未读标记 x' + unread); }

    if (/chat|message|reception|im\b|trade/i.test(rec.url)) { score += 2; ev.push('URL像聊天模块'); }
    if (/接待|聊天|消息|客服/.test(rec.title)) { score += 2; ev.push('标题像聊天模块'); }
    if (/quickPhrase|shortcutPhrase/i.test(rec.url)) { score -= 5; ev.push('★这是快捷短语面板，非聊天'); }
    if (doc.querySelector('.ant-table, .ant-tabs')) { score += 1; ev.push('AntD 容器'); }

    rec.score = score;
    rec.evidence = ev.join('；');
    return score;
  }

  var ranked = found.filter(function (r) { return r.accessible; })
    .map(function (r) { scoreDoc(r); return r; })
    .sort(function (a, b) { return b.score - a.score; });

  /* ---------- 3. 在最佳文档里深挖选择器 ---------- */
  function cssPath(el, maxDepth) {
    maxDepth = maxDepth || 6;
    if (!el || el.nodeType !== 1) return '';
    var parts = [], cur = el;
    while (cur && cur.nodeType === 1 && parts.length < maxDepth) {
      if (cur.id) { parts.unshift('#' + cur.id); break; }
      var sel = cur.tagName.toLowerCase();
      var cls = typeof cur.className === 'string'
        ? cur.className.trim().split(/\s+/).filter(function (c) { return /^[A-Za-z_-][\w-]*$/.test(c); }).slice(0, 2)
        : [];
      if (cls.length) sel += '.' + cls.join('.');
      var p = cur.parentElement;
      if (p) {
        var sib = Array.prototype.filter.call(p.children, function (c) { return c.tagName === cur.tagName; });
        if (sib.length > 1) sel += ':nth-of-type(' + (sib.indexOf(cur) + 1) + ')';
      }
      parts.unshift(sel);
      cur = p;
    }
    return parts.join(' > ');
  }

  function deepDive(rec) {
    var doc = rec.doc;
    var out = { url: rec.url, title: rec.title, score: rec.score, evidence: rec.evidence };

    out.inputs = (rec.editables || []).slice(0, 15).map(function (el) {
      var r = el.getBoundingClientRect();
      return {
        path: cssPath(el),
        tag: el.tagName.toLowerCase(),
        placeholder: el.getAttribute('placeholder') || '',
        contentEditable: el.isContentEditable ? 'true' : '',
        cls: cut(typeof el.className === 'string' ? el.className : '', 80),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      };
    });

    out.sendButton = rec.sendBtn ? {
      path: cssPath(rec.sendBtn),
      tag: rec.sendBtn.tagName.toLowerCase(),
      cls: cut(typeof rec.sendBtn.className === 'string' ? rec.sendBtn.className : '', 80),
      parentPath: cssPath(rec.sendBtn.parentElement)
    } : null;

    /* 找「重复子节点」容器：消息列表、会话列表通常都是这种结构 */
    var lists = [];
    try {
      Array.prototype.forEach.call(doc.querySelectorAll('div, ul, section'), function (el) {
        if (el.children.length < 4) return;
        var kids = Array.prototype.slice.call(el.children, 0, 10);
        var sigs = kids.map(function (c) {
          return c.tagName + '.' + (typeof c.className === 'string' ? c.className.split(/\s+/).slice(0, 2).join('.') : '');
        });
        var uniq = {}, n = 0;
        sigs.forEach(function (s) { if (!uniq[s]) { uniq[s] = 1; n++; } });
        if (n > 2) return;                       // 子节点太杂，不是列表
        var r = el.getBoundingClientRect();
        if (r.width < 80 || r.height < 80) return;
        lists.push({
          path: cssPath(el),
          childCount: el.children.length,
          repeatedSig: cut(sigs[0], 70),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          scrollable: el.scrollHeight > el.clientHeight + 20,
          sampleTexts: kids.slice(0, 3).map(function (c) { return cut(c.innerText, 50); })
        });
      });
    } catch (e) { /* ignore */ }
    out.listCandidates = lists.sort(function (a, b) { return b.childCount - a.childCount; }).slice(0, 10);

    return out;
  }

  var report = {
    generatedAt: new Date().toLocaleString('zh-CN'),
    probeLocation: { url: location.href, title: document.title, isTopWindow: (function () { try { return window === window.top; } catch (e) { return false; } })() },
    reachableDocs: found.map(function (r) {
      return { path: r.path, accessible: r.accessible, isTop: r.isTop || false, score: r.score, title: r.title, url: r.url, evidence: r.evidence || r.note || '' };
    }),
    best: ranked.length ? deepDive(ranked[0]) : null
  };

  /* ---------- 输出 ---------- */
  console.log('%c=== 千牛聊天子应用定位报告 ===', 'color:#7c3aed;font-weight:bold;font-size:14px');
  console.log('当前探针所在：', report.probeLocation);
  console.log('%c【所有可达文档（按聊天相似度排序）】', 'color:#0a7;font-weight:bold');
  console.table(report.reachableDocs.map(function (d) {
    return { 路径: d.path, 分数: d.score, 标题: cut(d.title, 16), 依据: cut(d.evidence, 46), URL: cut(d.url, 52) };
  }));

  if (report.best && report.best.score >= 4) {
    console.log('%c✅ 判定为聊天子应用：', 'color:#0a7;font-weight:bold', report.best.title, report.best.url);
    console.log('%c【输入框】', 'color:#0a7;font-weight:bold'); console.table(report.best.inputs);
    console.log('%c【发送按钮】', 'color:#0a7;font-weight:bold'); console.log(report.best.sendButton);
    console.log('%c【列表容器候选（消息区/会话列表）】', 'color:#0a7;font-weight:bold'); console.table(report.best.listCandidates);
  } else {
    console.warn('%c⚠️ 没找到聊天子应用，说明当前这个 DevTools 绑定的是别的面板。',
                 'color:#c00;font-weight:bold');
    console.warn('请先点一下中间的聊天输入区，再按 F12（或右键消息区 → 检查），然后重跑本探针。');
  }

  try {
    copy(JSON.stringify(report, null, 2));
    console.log('%c✅ 完整报告已复制到剪贴板。', 'color:#0a7;font-weight:bold');
  } catch (e) { console.log('（剪贴板不可用，请展开上面对象手动复制）'); }

  window.__qnChatReport = report;
})();
