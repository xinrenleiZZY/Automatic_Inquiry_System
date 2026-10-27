/* 探"联系商家"按钮结构（结果页每张卡片的 shop row）
   node tools/qianniu/cdp.mjs eval pc-image-search tools/qianniu/probe-shoprow.js
*/
(function () {
  'use strict';

  const USER_SELECTOR = '#offer-list-content > div > div.colFeeds--cDXP1T0K > div > div:nth-child(1) > div.offerShopRow--GrxWF5ev > div.colRight--CxHK5xFZ > span > a';

  const cards = Array.from(document.querySelectorAll('#offer-list-content [class*="searchOfferWrapper"]'));
  const out = {
    url: location.href,
    cardCount: cards.length,
    userSelectorOnFirstCard: !!document.querySelector(USER_SELECTOR),
    cards: []
  };

  const pick = (el, sels) => {
    for (const s of sels) {
      const e = el.querySelector(s);
      if (e) return e;
    }
    return null;
  };

  cards.slice(0, 4).forEach((card, i) => {
    const shopRow = pick(card, ['[class*="offerShopRow"]', '[class*="shopRow"]']);
    const anchors = Array.from(card.querySelectorAll('a[href]')).map((a) => ({
      href: (a.getAttribute('href') || '').slice(0, 120),
      title: (a.getAttribute('title') || '').slice(0, 30),
      text: (a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 20),
      cls: String(a.className || '').slice(0, 40),
      inShopRow: shopRow ? shopRow.contains(a) : false
    }));
    const ww = card.querySelector('[data-nick]');
    out.cards.push({
      i,
      renderKey: card.getAttribute('data-renderkey') || '',
      shopRowFound: !!shopRow,
      shopRowText: shopRow ? (shopRow.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60) : '',
      nickAttr: ww ? (ww.getAttribute('data-nick') || '').slice(0, 60) : '',
      anchors
    });
  });

  /* 统计：有多少张卡片能从 shop row 里找到联系链接 */
  let withLink = 0;
  cards.forEach((card) => {
    const sels = ['[class*="offerShopRow"] a[href*="def_cbu_web_im"]', 'a.ww-link', '[class*="colRight"] a[href]'];
    if (pick(card, sels)) withLink++;
  });
  out.cardsWithContactLink = withLink;
  return out;
})();
