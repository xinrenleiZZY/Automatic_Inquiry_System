/* =====================================================================
 * 1688卖家工作台（千牛 / AliWorkbench，CEF 内核）DevTools 探针
 *
 * 作用：只「读取」页面结构，定位 4 个关键对象，不发送、不点击、不改数据。
 *   1) 左侧会话列表   2) 中间消息区   3) 底部输入框   4) 发送按钮
 *
 * 用法：在工作台窗口按 F12 → Console 标签 → 粘贴本文件全文 → 回车。
 *       结果会同时打印到控制台并复制到剪贴板，把剪贴板内容贴回来即可。
 * ===================================================================== */
(function () {
  'use strict';

  var TEXT_MAX = 70;
  var NODE_MAX = 25;

  var clean = function (s) { return (s || '').replace(/\s+/g, ' ').trim(); };
  var cut = function (s, n) { return clean(s).slice(0, n || TEXT_MAX); };

  /* 生成可用于 querySelector 的稳定路径 */
  function cssPath(el, maxDepth) {
    maxDepth = maxDepth || 6;
    if (!el || el.nodeType !== 1) return '';
    var parts = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && parts.length < maxDepth) {
      if (cur.id) { parts.unshift('#' + cur.id); break; }
      var sel = cur.tagName.toLowerCase();
      var cls = typeof cur.className === 'string'
        ? cur.className.trim().split(/\s+/).filter(function (c) { return /^[A-Za-z_-][\w-]*$/.test(c); }).slice(0, 2)
        : [];
      if (cls.length) sel += '.' + cls.join('.');
      var parent = cur.parentElement;
      if (parent) {
        var sib = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === cur.tagName; });
        if (sib.length > 1) sel += ':nth-of-type(' + (sib.indexOf(cur) + 1) + ')';
      }
      parts.unshift(sel);
      cur = parent;
    }
    return parts.join(' > ');
  }

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0 };
  }

  function describe(el) {
    var ds = [];
    for (var k in el.dataset) { if (ds.length < 6) ds.push(k + '=' + cut(el.dataset[k], 24)); }
    return {
      path: cssPath(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      cls: typeof el.className === 'string' ? cut(el.className, 100) : '',
      role: el.getAttribute('role') || '',
      type: el.getAttribute('type') || '',
      placeholder: el.getAttribute('placeholder') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      contentEditable: el.isContentEditable ? 'true' : '',
      dataAttrs: ds.join(' '),
      text: cut(el.innerText || el.textContent),
      rect: rectOf(el)
    };
  }

  /* 收集单个文档（含同源 iframe）内的候选元素 */
  function scanDoc(doc, frameLabel, acc) {
    var nodes;
    try { nodes = doc.querySelectorAll('*'); } catch (e) { return; }

    var inputs = [];
    var buttons = [];
    var scrollers = [];
    var bigLists = [];

    Array.prototype.forEach.call(nodes, function (el) {
      var tag = el.tagName.toLowerCase();
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      var isEditable = el.isContentEditable === true || tag === 'textarea' || (tag === 'input' && type !== 'hidden');

      if (isEditable) inputs.push(el);

      var label = cut(el.innerText || '', 20);
      if (tag === 'button' || el.getAttribute('role') === 'button' || /发送|回复|关闭|转交|快捷|请稍等/.test(label)) {
        if (clean(el.innerText).length <= 12 || tag === 'button') buttons.push(el);
      }

      var st = doc.defaultView.getComputedStyle(el);
      if (st && /auto|scroll/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 40) scrollers.push(el);

      if (el.children.length >= 8) {
        var kids = Array.prototype.slice.call(el.children, 0, 12).map(function (c) {
          var cn = typeof c.className === 'string' ? c.className.split(/\s+/)[0] : '';
          return c.tagName + '.' + cn;
        });
        var uniq = {};
        kids.forEach(function (k) { uniq[k] = 1; });
        if (Object.keys(uniq).length <= 3) bigLists.push({ el: el, sig: Object.keys(uniq).join(' | ') });
      }
    });

    acc.frames.push({
      frame: frameLabel,
      url: doc.location ? doc.location.href : '',
      title: doc.title || '',
      nodeCount: nodes.length
    });

    var tag1 = function (arr, e) { return Object.assign(describe(e), { frame: frameLabel }); };
    acc.inputs.push.apply(acc.inputs, inputs.slice(0, NODE_MAX).map(function (e) { return tag1(null, e); }));
    acc.buttons.push.apply(acc.buttons, buttons.slice(0, NODE_MAX).map(function (e) { return tag1(null, e); }));
    acc.scrollers.push.apply(acc.scrollers, scrollers.slice(0, 12).map(function (e) {
      return Object.assign(describe(e), { frame: frameLabel, scrollHeight: e.scrollHeight });
    }));
    acc.lists.push.apply(acc.lists, bigLists.slice(0, 12).map(function (o) {
      return Object.assign(describe(o.el), { frame: frameLabel, childCount: o.el.children.length, repeatedSig: cut(o.sig, 90) });
    }));
  }

  var acc = { inputs: [], buttons: [], scrollers: [], lists: [], frames: [] };
  scanDoc(document, 'TOP', acc);

  // 同源 iframe 继续下钻；跨域会抛错，已 try/catch
  var frameNo = 0;
  Array.prototype.forEach.call(document.querySelectorAll('iframe'), function (f) {
    frameNo++;
    try {
      if (f.contentDocument && f.contentDocument.body) {
        scanDoc(f.contentDocument, 'IFRAME#' + frameNo + ':' + (f.src || '(srcdoc)').slice(0, 60), acc);
      } else {
        acc.frames.push({ frame: 'IFRAME#' + frameNo, url: f.src || '', title: '(无法读取内容)', nodeCount: -1 });
      }
    } catch (e) {
      acc.frames.push({ frame: 'IFRAME#' + frameNo, url: f.src || '', title: '(跨域: ' + e.name + ')', nodeCount: -1 });
    }
  });

  var appEl = document.querySelector('#app');
  var report = {
    generatedAt: new Date().toLocaleString('zh-CN'),
    url: location.href,
    title: document.title,
    frameworks: {
      hasVue2Root: !!(appEl && appEl.__vue__),
      hasReactRoot: !!(document.querySelector('#root') && Object.keys(document.querySelector('#root')).some(function (k) { return /^__react/i.test(k); })),
      hasVueDevtoolsHook: !!(window.__VUE__ || window.__VUE_DEVTOOLS_GLOBAL_HOOK__),
      hasJQuery: !!window.jQuery,
      jqVersion: window.jQuery ? window.jQuery.fn.jquery : ''
    },
    frameCount: document.querySelectorAll('iframe, webview').length,
    frames: acc.frames,
    inputs: acc.inputs,
    sendButtonCandidates: acc.buttons,
    scrollContainers: acc.scrollers,
    repeatedLists: acc.lists
  };

  console.log('%c=== 千牛探针报告 ===', 'color:#7c3aed;font-weight:bold;font-size:14px');
  console.log('页面:', report.title, '|', report.url);
  console.log('框架线索:', report.frameworks);
  console.log('frame 数:', report.frameCount);
  console.table(report.frames);
  console.log('%c【输入框候选】', 'color:#0a7;font-weight:bold'); console.table(report.inputs);
  console.log('%c【发送/按钮候选】', 'color:#0a7;font-weight:bold'); console.table(report.sendButtonCandidates);
  console.log('%c【可滚动容器（消息区候选）】', 'color:#0a7;font-weight:bold'); console.table(report.scrollContainers);
  console.log('%c【重复子节点列表（会话/消息列表候选）】', 'color:#0a7;font-weight:bold'); console.table(report.repeatedLists);

  try {
    copy(JSON.stringify(report, null, 2));
    console.log('%c✅ 完整报告已复制到剪贴板，直接粘贴发回即可。', 'color:#0a7;font-weight:bold');
  } catch (e) {
    console.log('（剪贴板不可用，请手动展开上面的对象）', e.message);
  }

  window.__qnLastReport = report;
})();
