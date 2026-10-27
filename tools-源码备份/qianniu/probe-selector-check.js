/* =====================================================================
 * 选择器对照检查（结果页）
 *
 *   node tools/qianniu/cdp.mjs eval pc-image-search tools/qianniu/probe-selector-check.js
 *
 * 同样几个选择器各查一遍，确认哪个才是对的。
 * ===================================================================== */
(function () {
  'use strict';
  const tests = [
    '#offer-list-content',
    '#offer-list-content [class*="searchOfferWrapper"]',
    '[class*="searchOfferWrapper"]',
    '[class*="offerListLayoutWrapper"] > div',
    '#offer-list-content [class*="offerListLayoutWrapper"] > div'
  ];
  const out = { url: location.href, results: [] };
  for (const sel of tests) {
    let n = -1, err = '';
    try { n = document.querySelectorAll(sel).length; } catch (e) { err = e.message; }
    let firstText = '';
    try {
      const first = document.querySelector(sel);
      firstText = first ? (first.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 50) : '';
    } catch (e) { /* ignore */ }
    out.results.push({ selector: sel, count: n, error: err, firstText });
  }
  /* 顺带看看卡片容器的实际 childElementCount */
  const wrap = document.querySelector('[class*="offerListLayoutWrapper"]');
  out.wrapper = wrap ? { cls: String(wrap.className).slice(0, 60), children: wrap.children.length,
                         firstChildCls: wrap.children[0] ? String(wrap.children[0].className).slice(0, 60) : '' } : null;
  return out;
})();
