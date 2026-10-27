/* =====================================================================
 * 千牛 JS Bridge 探针 —— 找出渲染层调用的原生接口
 *
 * 原理：聊天 UI 是本地资源包（origin = https://alires-webui），
 *       它把消息交给原生 C++ 层（MessageSDKBiz/AliIMX/prgnet）去发，
 *       中间必然经过一个 JS bridge。找到它，就等于拿到了官方发送通道，
 *       不用再模拟点击 DOM。
 *
 * 手法：新建一个空白 iframe，用它干净的 window 和当前 window 做「差集」，
 *       差出来的就是千牛 App 注入到页面里的全局对象/函数——bridge 必在其中。
 *
 * 用法：F12 → Console → 粘贴全文 → 回车。只读，不改任何状态。
 * ===================================================================== */
(function () {
  'use strict';

  var out = {
    at: new Date().toLocaleString('zh-CN'),
    ctx: {},
    bridgeCandidates: {},
    appGlobals: [],
    interesting: [],
    scriptHints: []
  };

  /* ---------- 1. 当前上下文 ---------- */
  out.ctx = {
    url: location.href,
    origin: location.origin || '(无)',
    host: location.host || '(无)',
    title: document.title,
    referrer: document.referrer || '(无)',
    isTop: (function () { try { return window === window.top; } catch (e) { return '跨域不可判'; } })(),
    iframeCount: document.querySelectorAll('iframe').length,
    injectTestRan: !!window.QNTEST,
    looksLocal: /alires-webui/i.test((location.host || '') + (location.origin || ''))
  };

  /* ---------- 2. 已知的 CEF / 桥接对象名，逐个 typeof ---------- */
  var candidates = [
    'cefQuery', 'cef', '__cefQuery', 'external', 'qt', 'QWebChannel', 'chrome', 'webkit',
    'jsBridge', 'jsbridge', 'JsBridge', 'bridge', 'nativeBridge', 'NativeBridge',
    'aliBridge', '__aliBridge', 'AliBridge', 'aliEService', 'AliEService',
    'ww', 'WangWang', 'aliIM', 'AliIMX', 'execCmd', 'ExecCmd', 'AliWorkbench'
  ];
  candidates.forEach(function (n) {
    var t = typeof window[n];
    if (t !== 'undefined') out.bridgeCandidates[n] = t;
  });

  /* ---------- 3. 差集：找出 App 注入的全局量 ---------- */
  try {
    var ifr = document.createElement('iframe');
    ifr.style.display = 'none';
    document.documentElement.appendChild(ifr);

    var freshWin = ifr.contentWindow;
    var freshKeys = {};
    Object.getOwnPropertyNames(freshWin).forEach(function (k) { freshKeys[k] = 1; });

    if (ifr.parentNode) ifr.parentNode.removeChild(ifr);

    var added = Object.getOwnPropertyNames(window).filter(function (k) {
      return !freshKeys[k];
    });

    out.appGlobals = added.map(function (k) {
      var v, t, info;
      try { v = window[k]; t = typeof v; } catch (e) { return { name: k, type: '读取失败', info: e.message }; }

      if (t === 'object' && v) {
        try { info = Object.getOwnPropertyNames(v).slice(0, 15).join(', '); }
        catch (e) { info = '(不可枚举)'; }
      } else if (t === 'function') {
        info = (v.name || '(匿名)') + ' / 形参' + v.length;
      } else {
        info = String(v).slice(0, 60);
      }
      return { name: k, type: t, info: info };
    });

    out.interesting = out.appGlobals.filter(function (g) {
      return /send|msg|message|im\b|bridge|native|invoke|exec|cmd|ali|ww|chat|draft|contact|session/i.test(g.name);
    });
  } catch (e) {
    out.appGlobals = [{ name: '(差集失败)', type: 'error', info: e.message }];
  }

  /* ---------- 4. 扫描页面脚本里的桥接痕迹 ---------- */
  try {
    Array.prototype.forEach.call(document.querySelectorAll('script'), function (s, i) {
      var src = s.getAttribute('src') || '';
      if (src) { out.scriptHints.push({ idx: i, kind: '外链', detail: src.slice(0, 130) }); return; }
      var txt = s.textContent || '';
      if (txt.length < 20) return;
      var hits = ['cefQuery', 'ExecCmd', 'execCmd', 'nativeCall', 'invokeNative', 'jsBridge', 'JsBridge',
                  'sendmsg', 'sendMsg', 'postMessage', 'alires'].filter(function (k) {
        return txt.indexOf(k) >= 0;
      });
      if (hits.length) {
        out.scriptHints.push({ idx: i, kind: '内联', detail: '命中 [' + hits.join(', ') + ']，长度 ' + txt.length });
      }
    });
  } catch (e) { /* ignore */ }

  /* ---------- 输出 ---------- */
  console.log('%c=== 千牛 Bridge 探针 ===', 'color:#7c3aed;font-weight:bold;font-size:14px');
  console.table([{
    URL: out.ctx.url.slice(0, 70),
    标题: out.ctx.title,
    origin: out.ctx.origin,
    顶层窗口: String(out.ctx.isTop),
    iframe数: out.ctx.iframeCount,
    本地资源: String(out.ctx.looksLocal),
    注入自检已跑: String(out.ctx.injectTestRan)
  }]);

  var bc = Object.keys(out.bridgeCandidates);
  if (bc.length) {
    console.log('%c【命中已知桥接名】', 'color:#0a7;font-weight:bold');
    out.bridgeCandidates && console.table(bc.map(function (k) {
      return { 名称: k, 类型: out.bridgeCandidates[k] };
    }));
  } else {
    console.log('%c【已知桥接名】全部未命中（App 可能用了自定义名字，看下面的差集）', 'color:#f59e0b');
  }

  console.log('%c【App 注入的全局量（共 ' + out.appGlobals.length + ' 个）】', 'color:#0a7;font-weight:bold');
  console.table(out.appGlobals.slice(0, 60));

  console.log('%c【★ 值得深挖的（名字含 send/msg/bridge/native/im 等）】', 'color:#0a7;font-weight:bold');
  console.table(out.interesting);

  console.log('%c【页面脚本线索】', 'color:#0a7;font-weight:bold');
  console.table(out.scriptHints.slice(0, 25));

  try {
    copy(JSON.stringify(out, null, 2));
    console.log('%c✅ 完整报告已复制到剪贴板。', 'color:#0a7;font-weight:bold');
  } catch (e) { console.log('（剪贴板不可用，请展开上面的对象）'); }

  window.QNBRIDGE = out;
})();
