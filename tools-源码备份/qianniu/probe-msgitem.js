/* =====================================================================
 * 消息条目结构探针：找出「我方 / 对方」的判别标志
 *
 *   node tools/qianniu/cdp.mjs eval def_cbu_web_im tools/qianniu/probe-msgitem.js
 *
 * 返回：每个 message-item-line 的类名、内层类名集合、气泡水平位置、
 *       以及页面里能拿到的登录账号线索（用来判定"哪条是我发的"）。
 * ===================================================================== */
(function () {
  'use strict';

  const core = (() => {
    const f = document.querySelector('iframe');
    return f && f.contentDocument ? f.contentDocument : null;
  })();
  if (!core) return { error: '拿不到核心聊天文档（iframe 未就绪？）' };

  const view = core.querySelector('.message-list .rc-scrollbars-view') || core.querySelector('.message-list');
  if (!view) return { error: '找不到消息容器' };

  const items = Array.prototype.slice.call(view.children);
  const out = { total: items.length, items: [], accountHints: {} };

  /* 只看最后 8 条，足够判别 */
  items.slice(-8).forEach((el, i) => {
    const r = el.getBoundingClientRect();

    /* 收集内层所有 class，找 self/mine/right 之类的线索 */
    const innerCls = {};
    el.querySelectorAll('*').forEach((d) => {
      const c = typeof d.className === 'string' ? d.className : '';
      c.split(/\s+/).filter(Boolean).forEach((x) => { innerCls[x] = (innerCls[x] || 0) + 1; });
    });

    /* 找内容气泡：通常是含有最多文字的块级子元素 */
    let bubble = null;
    el.querySelectorAll('div, p, span, pre').forEach((d) => {
      const t = (d.innerText || '').trim();
      if (t.length < 2 || d.children.length > 3) return;
      const br = d.getBoundingClientRect();
      if (br.width < 8 || br.height < 8) return;
      if (!bubble || br.width * br.height > bubble.w * bubble.h) {
        bubble = { x: Math.round(br.x), y: Math.round(br.y), w: Math.round(br.width), h: Math.round(br.height), text: t.slice(0, 30) };
      }
    });

    out.items.push({
      idx: items.length - 8 + i,
      rowX: Math.round(r.x), rowW: Math.round(r.width),
      bubble,
      /* 气泡中心相对整行中心的偏移：正=偏右（通常是我发的） */
      bias: bubble ? Math.round((bubble.x + bubble.w / 2) - (r.x + r.width / 2)) : null,
      innerClasses: Object.keys(innerCls).slice(0, 14),
      html: (el.innerHTML || '').replace(/\s+/g, ' ').slice(0, 220)
    });
  });

  /* 账号线索：cookie / 全局变量里找 tb\d+ 或 cnalichn 形式的登录名 */
  try {
    const cookie = document.cookie || '';
    const m = cookie.match(/(tb\d{6,}|cnalichn[\w\u4e00-\u9fa5]+|cna[\w]+)/gi);
    out.accountHints.cookieMatches = m ? [...new Set(m)].slice(0, 8) : [];
  } catch (e) { out.accountHints.cookieMatches = ['(读取失败)']; }

  try {
    const keys = Object.keys(window).filter((k) => /user|login|nick|uid|member|account/i.test(k));
    out.accountHints.globalKeys = keys.slice(0, 15);
    out.accountHints.globalValues = keys.slice(0, 8).map((k) => {
      let v;
      try { v = window[k]; } catch (e) { return k + '=??'; }
      const t = typeof v;
      if (t === 'string' || t === 'number') return k + '=' + String(v).slice(0, 40);
      if (t === 'object' && v) {
        try { return k + '={' + Object.keys(v).slice(0, 5).join(',') + '}'; } catch (e) { return k + '={}'; }
      }
      return k + ':' + t;
    });
  } catch (e) { out.accountHints.globalKeys = ['(失败)']; }

  /* 会话列表里能看到的对方名字（用于确认"非我"的一方） */
  try {
    out.accountHints.convTitles = Array.prototype.map.call(
      core.querySelectorAll('.conversation-list-scroll > div'),
      (el) => (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40)
    ).slice(0, 6);
  } catch (e) { /* ignore */ }

  return out;
})();
