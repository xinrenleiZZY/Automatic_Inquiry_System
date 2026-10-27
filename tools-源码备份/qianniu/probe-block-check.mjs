/* 用区块自身的调用路径，对比几个选择器的命中数
   node tools/qianniu/probe-block-check.mjs
*/
import { withSession, evaluate } from './blocks/session.mjs';

const out = await withSession(async (s) => evaluate(s, `(() => ({
  url: location.href,
  byId: document.querySelectorAll('#offer-list-content').length,
  scoped: document.querySelectorAll('#offer-list-content [class*="searchOfferWrapper"]').length,
  global: document.querySelectorAll('[class*="searchOfferWrapper"]').length,
  fallback: document.querySelectorAll('[class*="offerListLayoutWrapper"] > div').length,
  arrayFrom: Array.from(document.querySelectorAll('#offer-list-content [class*="searchOfferWrapper"]')).length
}))()`), { match: ['pc-image-search', 'offer_search'] });

console.log(JSON.stringify(out, null, 2));
