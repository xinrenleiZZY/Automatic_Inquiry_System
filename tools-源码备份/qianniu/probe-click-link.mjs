/* 实验：结果页的"联系卖家"链接怎么点才能真正打开新窗口
   node tools/qianniu/probe-click-link.mjs
*/
import { browserSession } from './cdp-lib.mjs';
import { withSession, evaluate, sleep } from './blocks/session.mjs';

const BEFORE = `(() => {
  const cards = document.querySelectorAll('#offer-list-content [class*="searchOfferWrapper"]');
  const card = cards[0];
  if (!card) return null;
  const link = card.querySelector('[class*="offerShopRow"] a[href*="def_cbu_web_im"]') || card.querySelector('a.ww-link');
  if (!link) return null;
  return {
    cards: cards.length,
    href: (link.getAttribute('href') || '').slice(0, 160),
    target: link.getAttribute('target') || '(无)',
    rel: link.getAttribute('rel') || '(无)',
    cls: String(link.className),
    text: (link.innerText || '').trim(),
    rect: (() => { const r = link.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })()
  };
})()`;

const browser = await browserSession();
const chatIds = async () => {
  const { targetInfos } = await browser.send('Target.getTargets');
  return targetInfos.filter((t) => t.type === 'page' && (t.url || '').includes('/def_cbu_web_im/')).map((t) => t.targetId);
};
const beforeIds = new Set(await chatIds());

const info = await withSession(async (s) => evaluate(s, BEFORE), { match: 'pc-image-search', allowTitle: false });
console.log('=== 第一个卡片的联系链接 ===');
console.log(JSON.stringify(info, null, 2));

/* 试 ①：JS 直接 click() */
const r1 = await withSession(async (s) => evaluate(s, `(() => {
  const card = document.querySelectorAll('#offer-list-content [class*="searchOfferWrapper"]')[0];
  const link = card && (card.querySelector('[class*="offerShopRow"] a[href*="def_cbu_web_im"]') || card.querySelector('a.ww-link'));
  if (!link) return 'no-link';
  link.click();
  return 'clicked';
})()`), { match: 'pc-image-search', allowTitle: false });
await sleep(4000);
let ids = await chatIds();
let added = ids.filter((id) => !beforeIds.has(id));
console.log(`\n① JS click() → ${r1}；新窗口 ${added.length} 个`);

if (!added.length) {
  /* 试 ②：先 hover 再 CDP 真实点击（坐标取自链接自身） */
  const box = info.rect;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  await withSession(async (s) => {
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
    await sleep(300);
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1, buttons: 1 });
    await sleep(120);
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1, buttons: 0 });
  }, { match: 'pc-image-search', allowTitle: false });
  await sleep(4000);
  ids = await chatIds();
  added = ids.filter((id) => !beforeIds.has(id));
  console.log(`② 坐标真实点击 @(${Math.round(cx)},${Math.round(cy)}) → 新窗口 ${added.length} 个`);
}

if (!added.length) {
  /* 试 ③：在页面内用 dispatchEvent 发完整鼠标事件序列 */
  await withSession(async (s) => evaluate(s, `(() => {
    const card = document.querySelectorAll('#offer-list-content [class*="searchOfferWrapper"]')[0];
    const link = card && (card.querySelector('[class*="offerShopRow"] a[href*="def_cbu_web_im"]') || card.querySelector('a.ww-link'));
    if (!link) return 'no-link';
    const r = link.getBoundingClientRect();
    const opt = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 };
    link.dispatchEvent(new MouseEvent('mouseover', opt));
    link.dispatchEvent(new MouseEvent('mousedown', opt));
    link.dispatchEvent(new MouseEvent('mouseup', opt));
    link.dispatchEvent(new MouseEvent('click', opt));
    return 'dispatched';
  })()`), { match: 'pc-image-search', allowTitle: false });
  await sleep(4000);
  ids = await chatIds();
  added = ids.filter((id) => !beforeIds.has(id));
  console.log(`③ 合成鼠标事件 → 新窗口 ${added.length} 个`);
}

browser.close();
if (added.length) {
  const { targetInfos } = await (async () => { const b = await browserSession(); const r = await b.send('Target.getTargets'); b.close(); return r; })();
  const t = targetInfos.find((x) => x.targetId === added[0]);
  console.log('\n新窗口 URL：' + (t ? t.url.slice(0, 160) : '?'));
} else {
  console.log('\n三种点法都没能打开新窗口');
}
