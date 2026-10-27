/* 看结果卡片里有没有商品链接 / offerId
   node tools/qianniu/cdp.mjs eval pc-image-search tools/qianniu/probe-card-links.js
*/
(function () {
  'use strict';
  const nodes = Array.from(document.querySelectorAll('#offer-list-content [class*="searchOfferWrapper"]'));
  const out = { cardCount: nodes.length, cards: [] };

  nodes.slice(0, 3).forEach((el, i) => {
    const attrs = {};
    Array.prototype.forEach.call(el.attributes || [], (a) => {
      if (a.name !== 'class' && a.name !== 'style') attrs[a.name] = String(a.value).slice(0, 60);
    });

    const anchors = Array.from(el.querySelectorAll('a')).map((a) => ({
      href: (a.getAttribute('href') || '').slice(0, 90),
      title: (a.getAttribute('title') || '').slice(0, 40),
      text: (a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 30),
      cls: String(a.className || '').slice(0, 40)
    }));

    /* 任何带 data-* 的元素（offerId 常藏在这里） */
    const dataEls = [];
    el.querySelectorAll('*').forEach((d) => {
      const ds = Object.keys(d.dataset || {});
      if (!ds.length) return;
      if (dataEls.length >= 10) return;
      dataEls.push({
        tag: d.tagName.toLowerCase(),
        cls: String(d.className || '').slice(0, 36),
        data: ds.slice(0, 5).map((k) => k + '=' + String(d.dataset[k]).slice(0, 30)).join(' ')
      });
    });

    out.cards.push({
      i,
      cardAttrs: attrs,
      anchorCount: anchors.length,
      anchors: anchors.slice(0, 6),
      dataEls,
      /* 卡片上是否挂了 React fiber 之类（点它可能触发跳转） */
      hasReactProps: Object.keys(el).some((k) => /^__react/i.test(k))
    });
  });

  /* 整页找 offerId 线索 */
  const html = document.documentElement.innerHTML;
  out.offerIdHits = [...new Set((html.match(/(?:offerId|offer_id)["'=:\\s]{1,4}(\\d{8,})/gi) || []))].slice(0, 8);
  return out;
})();
