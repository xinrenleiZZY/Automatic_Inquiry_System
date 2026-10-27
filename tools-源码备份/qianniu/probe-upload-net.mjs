/* 抓"以图搜图上传"时的网络请求，定位 imageId 到底从哪来
   node tools/qianniu/probe-upload-net.mjs
*/
import { withSession, evaluate, sleep } from './blocks/session.mjs';
import * as imageSearch from './blocks/image-search.mjs';

const FILE = 'tools/qianniu/image/示例.png';
const reqs = [];

/* 确保入口页在 */
const opened = await imageSearch.openSearchPage();
console.log(opened.opened ? '已补开搜索页，等待加载…' : '搜索页已在');
await sleep(opened.opened ? 3000 : 500);

const hrefs = await withSession(async (s) => {
  s.on((msg) => {
    if (msg.method === 'Network.requestWillBeSent') {
      reqs.push({
        method: msg.params.request.method,
        type: msg.params.type,
        url: msg.params.request.url,
        post: (msg.params.request.postData || '').slice(0, 300)
      });
    }
  });
  await s.send('Network.enable');

  const before = await evaluate(s, 'location.href');
  await imageSearch.uploadByFileInput(s, FILE);
  await sleep(1500);
  await imageSearch.clickSearchButton(s);
  await sleep(9000);
  let after = '';
  try { after = await evaluate(s, 'location.href'); } catch (e) { after = '(读不到:' + e.message + ')'; }
  return { before, after };
}, { match: imageSearch.SEARCH_MATCH });

console.log('\nURL 变化：');
console.log('  before =', hrefs.before);
console.log('  after  =', hrefs.after);

/* 只挑和上传/图片/搜索相关的请求 */
const hot = reqs.filter((r) => /upload|image|img|search|mtop/i.test(r.url));
console.log(`\n共捕获 ${reqs.length} 条请求，其中相关 ${hot.length} 条：`);
console.table(hot.map((r) => ({
  method: r.method,
  type: r.type,
  url: r.url.split('?')[0].slice(0, 78),
  api: (r.url.match(/[?&]api=([^&]+)/) || [])[1] || ''
})));

/* 从 URL 里抽 imageId */
const id = (hrefs.after.match(/imageId=(\d+)/) || [])[1] || '';
console.log('\n结果页里的 imageId =', id || '(没拿到)');
