/* =====================================================================
 * 自检：自己账号 id 的识别情况
 *
 *   node tools/qianniu/cdp.mjs eval def_cbu_web_im tools/qianniu/probe-selfids.js
 *
 * 目的：确认能否从 cookie 里认出「本账号」的 id，
 *       从而把「自己给自己」的会话与同事会话区分开。
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

  const win = core.defaultView;
  const cookie = core.cookie || '';

  const pick = (re) => {
    const m = cookie.match(re);
    return m ? m.slice(0, 6) : [];
  };

  const out = {
    cookieKeys: cookie.split(/;\s*/).map((s) => s.split('=')[0]).slice(0, 40),
    aui: pick(/(?:^|;\s*)aui=(\d+)/g),
    unb: pick(/(?:^|;\s*)unb=(\d+)/g),
    cnaui: pick(/(?:^|;\s*)cnaui=(\d+)/g),
    cMid: pick(/c_mid=b2b-(\d+)/g),
    logonId: pick(/__cn_logon_id__=([^;]+)/g),
    agreements: []
  };

  /* 会话列表里每条的 id 拆解 */
  Array.prototype.forEach.call(core.querySelectorAll('.conversation-item'), (el, i) => {
    const id = el.id || '';
    const m = /^(.+?)-(.+?)#(\d+)@(\w+)$/.exec(id);
    out.agreements.push({
      idx: i,
      name: (el.querySelector('.name') || {}).textContent || '',
      id,
      sideA: m ? String(m[1]).split('.')[0] : '',
      sideB: m ? String(m[2]).split('.')[0] : '',
      cidType: m ? m[3] : '',
      active: el.classList.contains('active')
    });
  });

  return out;
})();
