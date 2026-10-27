/* =====================================================================
 * 千牛 JS 注入 —— 自检脚本（第一颗探路石）
 *
 * 它同时回答两个问题：
 *   ① 注入有没有生效？        → 页面右上角会出现一个实时跳动的徽章
 *   ② 注入的是不是聊天 webview？→ 徽章里的「聊天区判定」会直接告诉你
 *
 * 副作用：只有 1 个徽章 + 1 个每秒计时器 + console 日志。
 *        不点击、不输入、不发送、不读数据。刷新页面即彻底清除。
 *
 * 用法：先点一下窗口里的目标区域 → F12 → Console → 粘贴全文 → 回车
 *      想关掉：在 Console 跑 QNTEST.stop()
 * ===================================================================== */
(function () {
  'use strict';

  /* 重复粘贴时，先把上一份收掉，避免叠加 */
  if (window.QNTEST && typeof window.QNTEST.stop === 'function') {
    try { window.QNTEST.stop(); } catch (e) { /* ignore */ }
  }

  var BADGE_ID = '__qn_test_badge__';
  var old = document.getElementById(BADGE_ID);
  if (old && old.parentNode) old.parentNode.removeChild(old);

  var ticks = 0;
  var logs = [];

  /* ---------- ① 判断当前是不是聊天 webview ---------- */
  function sniff() {
    var evidence = [];

    /* 明确的"反证"：聊条区不可能叫这些名字 */
    if (/quickPhrase|shortcutPhrase/i.test(location.href)) evidence.push('URL=快捷短语面板 ✗');

    /* 正向证据一：存在「发送」按钮 */
    var sendBtn = null;
    try {
      Array.prototype.forEach.call(document.querySelectorAll('button, div, span, a'), function (el) {
        if (sendBtn) return;
        if ((el.textContent || '').trim() === '发送' && el.children.length <= 2) sendBtn = el;
      });
    } catch (e) { /* ignore */ }
    if (sendBtn) evidence.push('有「发送」按钮 ✓');

    /* 正向证据二：存在可输入框（排除搜索框） */
    var editables = [];
    try {
      Array.prototype.forEach.call(document.querySelectorAll('[contenteditable="true"], textarea, input'), function (el) {
        if (el.tagName === 'INPUT' && (el.getAttribute('type') || 'text').toLowerCase() === 'hidden') return;
        var ph = el.getAttribute('placeholder') || '';
        if (el.tagName === 'INPUT' && /搜索|search/i.test(ph)) return;
        var st = getComputedStyle(el);
        if (st && (st.display === 'none' || st.visibility === 'hidden')) return;
        editables.push(el);
      });
    } catch (e) { /* ignore */ }
    if (editables.length) {
      evidence.push('可输入元素 x' + editables.length +
        '（' + editables.slice(0, 3).map(function (e) {
          return e.tagName.toLowerCase() + (e.getAttribute('placeholder') ? '["' + e.getAttribute('placeholder') + '"]' : '');
        }).join(', ') + '）✓');
    }

    /* 正向证据三：消息时间戳 / 未读标记 */
    var timeHits = 0, unreadHits = 0;
    try {
      Array.prototype.forEach.call(document.querySelectorAll('*'), function (el) {
        if (el.children.length) return;
        var t = (el.textContent || '').trim();
        if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) timeHits++;
        if (t === '未读') unreadHits++;
      });
    } catch (e) { /* ignore */ }
    if (timeHits >= 3) evidence.push('时间戳 x' + timeHits + ' ✓');
    if (unreadHits) evidence.push('未读标记 x' + unreadHits + ' ✓');

    var isChat = !!sendBtn && editables.length > 0 && !/quickPhrase/i.test(location.href);

    return {
      isChat: isChat,
      sendBtn: sendBtn,
      editables: editables,
      evidence: evidence.join(' | ')
    };
  }

  var sniffResult = sniff();

  /* ---------- ② 右上角实时徽章 ---------- */
  var badge = document.createElement('div');
  badge.id = BADGE_ID;
  badge.style.cssText = [
    'position:fixed', 'top:8px', 'right:8px', 'z-index:2147483647',
    'padding:6px 10px', 'border-radius:6px',
    'font:12px/1.5 Consolas,Menlo,monospace',
    'color:#fff', 'background:rgba(15,23,42,.92)',
    'border:2px solid ' + (sniffResult.isChat ? '#22c55e' : '#f59e0b'),
    'box-shadow:0 4px 14px rgba(0,0,0,.35)',
    'pointer-events:none', 'white-space:pre', 'max-width:46vw'
  ].join(';');

  function render() {
    badge.textContent =
      (sniffResult.isChat ? '✅ 聊天区，注入成功' : '⚠️ 注入成功，但不是聊天区') +
      '\n心跳: ' + ticks +
      '\n页面: ' + document.title +
      '\n路径: ' + location.pathname.split('/').slice(-2).join('/');
  }
  render();
  (document.body || document.documentElement).appendChild(badge);

  /* ---------- ③ 心跳：证明代码持续存活（关掉 DevTools 也会继续） ---------- */
  var timer = setInterval(function () {
    ticks++;
    render();
    logs.push({ t: Date.now(), ticks: ticks, url: location.href });
    if (logs.length > 500) logs.shift();
    if (ticks % 5 === 0) console.log('[QNTEST] 心跳 #' + ticks + ' @ ' + location.href);
  }, 1000);

  /* ---------- 输出结论 ---------- */
  console.log('%c=== 千牛注入自检 ===', 'color:#7c3aed;font-weight:bold;font-size:14px');
  console.log('页面标题：', document.title);
  console.log('完整 URL：', location.href);
  console.log('是否顶层窗口：', (function () { try { return window === window.top; } catch (e) { return '跨域不可判'; } })());
  console.log('页内 iframe 数：', document.querySelectorAll('iframe').length);
  console.log('%c聊天区判定：' + (sniffResult.isChat ? '✅ 是' : '⚠️ 不是'),
              'color:' + (sniffResult.isChat ? '#22c55e' : '#f59e0b') + ';font-weight:bold;font-size:13px');
  console.log('  依据：', sniffResult.evidence || '(无任何特征)');
  if (sniffResult.sendBtn) console.log('  发送按钮：', sniffResult.sendBtn.className || sniffResult.sendBtn.tagName);
  console.log('  可输入框数量：', sniffResult.editables.length);
  console.log('%c👉 现在看窗口右上角：徽章出现在哪个面板，注入就落在哪个 webview 上，',
              'color:#0a7;font-weight:bold');
  console.log('%c   徽章边框是绿色 = 聊天区；橙色 = 不是。徽章里的"心跳"数字应在每秒 +1。',
              'color:#0a7;font-weight:bold');

  window.QNTEST = {
    context: {
      url: location.href,
      title: document.title,
      isChat: sniffResult.isChat,
      evidence: sniffResult.evidence,
      editableCount: sniffResult.editables.length
    },
    heartbeat: function () { return ticks; },
    logs: logs,
    stop: function () {
      clearInterval(timer);
      if (badge.parentNode) badge.parentNode.removeChild(badge);
      console.log('[QNTEST] 已停止，徽章已移除');
    }
  };

  console.log('%c提示：等 10 秒后把窗口右上角徽章的样子截图发我，或直接跑 QNTEST.context 把结果贴回来。',
              'color:#0a7');
})();
