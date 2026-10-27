/* 单独跑一遍"卡片提取"逻辑，看每一步的中间结果
   node tools/qianniu/cdp.mjs eval pc-image-search tools/qianniu/probe-extract.js
*/
(function () {
  'use strict';
  const nodes = Array.from(document.querySelectorAll('#offer-list-content [class*="searchOfferWrapper"]'));
  const out = { nodeCount: nodes.length, steps: [] };

  nodes.slice(0, 5).forEach((el, i) => {
    const flat = (el.innerText || '').replace(/\s+/g, ' ').trim();
    const priceRow = el.querySelector('[class*="offerPriceRow"]');
    const priceFlat = (priceRow ? priceRow.innerText : flat).replace(/\s+/g, '');
    const price = (priceFlat.match(/[￥¥]([\d]+(?:\.\d+)?)/) || [])[1] || '';
    const link = el.querySelector('a[href*="offer"], a[href*="detail"], a[title]');
    const byAttr = link ? (link.getAttribute('title') || '') : '';
    const byText = link ? (link.innerText || '') : '';
    const fallbackTitle = flat.split(/[￥¥]/)[0].replace(/^找相似/, '').trim();
    out.steps.push({
      i,
      flat: flat.slice(0, 50),
      price,
      linkTag: link ? link.tagName : '',
      linkHref: link ? (link.getAttribute('href') || '').slice(0, 50) : '',
      titleAttr: byAttr.slice(0, 30),
      titleInnerText: byText.slice(0, 30),
      fallbackTitle: fallbackTitle.slice(0, 40)
    });
  });

  /* 所有卡片的 key 是否会重复？ */
  const keys = nodes.map((el) => {
    const flat = (el.innerText || '').replace(/\s+/g, ' ').trim();
    const link = el.querySelector('a[href*="offer"], a[href*="detail"], a[title]');
    let title = link ? (link.getAttribute('title') || link.innerText || '') : '';
    if (!title) title = flat.split(/[￥¥]/)[0].replace(/^找相似/, '').trim();
    return (title || flat.slice(0, 40)).slice(0, 30);
  });
  const uniq = new Set(keys);
  out.keyTotal = keys.length;
  out.keyUnique = uniq.size;
  out.dupSamples = keys.slice(0, 6);
  return out;
})();
