/* =====================================================================
 * 会话列表结构探针：为了能「跨会话」监听新消息
 *
 *   node tools/qianniu/cdp.mjs eval def_cbu_web_im tools/qianniu/probe-convitem.js
 *
 * 目标：拿到每个会话项的 昵称 / 最后一条消息 / 时间 / 未读数 的稳定选择器，
 *       这样即使不打开某个会话，也能从列表上发现"有客户来消息了"。
 * ===================================================================== */
(function () {
  'use strict';

  const core = (() => {
    const f = document.querySelector('iframe');
    return f && f.contentDocument ? f.contentDocument : null;
  })();
  if (!core) return { error: '拿不到核心聊天文档' };

  const list = core.querySelector('.conversation-list-scroll');
  if (!list) return { error: '找不到 .conversation-list-scroll' };

  const items = Array.prototype.slice.call(list.querySelectorAll(':scope > div'));
  const out = { containerPath: '.conversation-list-scroll', itemCount: items.length, items: [] };

  items.slice(0, 12).forEach((el, i) => {
    /* 收集内层 class 计数，找 badge/count/unread 之类的线索 */
    const clsCount = {};
    el.querySelectorAll('*').forEach((d) => {
      String(d.className || '').split(/\s+/).filter(Boolean)
        .forEach((c) => { clsCount[c] = (clsCount[c] || 0) + 1; });
    });

    /* 数字型小元素（未读数通常是纯数字） */
    const numbers = [];
    el.querySelectorAll('span, div, i, em, sup').forEach((d) => {
      if (d.children.length) return;
      const t = (d.textContent || '').trim();
      if (/^\d{1,3}$/.test(t)) numbers.push({ text: t, cls: String(d.className || '').slice(0, 30) });
    });

    out.items.push({
      idx: i,
      cls: String(el.className || '').slice(0, 60),
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 100),
      innerClasses: Object.keys(clsCount).slice(0, 18),
      numberBadges: numbers.slice(0, 5),
      html: (el.innerHTML || '').replace(/\s+/g, ' ').slice(0, 260)
    });
  });

  return out;
})();
