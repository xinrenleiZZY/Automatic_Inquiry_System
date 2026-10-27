/* 抓 getSearchImageUpload 的完整请求与响应，确认 imageId 的来源
   node tools/qianniu/probe-imageid-api.mjs
*/
import { withSession, sleep } from './blocks/session.mjs';
import * as imageSearch from './blocks/image-search.mjs';

const FILE = 'tools/qianniu/image/示例.png';
const hits = [];
const isTarget = (u) => /getSearchImageUpload|imageSearch\/upload|uploadImage/i.test(u || '');

const opened = await imageSearch.openSearchPage();
if (opened.opened) await sleep(3000);

await withSession(async (s) => {
  s.on((msg) => {
    if (msg.method === 'Network.requestWillBeSent' && isTarget(msg.params.request.url)) {
      hits.push({
        requestId: msg.params.requestId,
        method: msg.params.request.method,
        url: msg.params.request.url,
        headers: msg.params.request.headers,
        postData: (msg.params.request.postData || '').slice(0, 800)
      });
    }
    if (msg.method === 'Network.responseReceived' && isTarget(msg.params.response.url)) {
      const rec = hits.find((h) => h.requestId === msg.params.requestId);
      if (rec) {
        rec.status = msg.params.response.status;
        rec.mimeType = msg.params.response.mimeType;
        rec.respHeaders = msg.params.response.headers;
      }
      /* 响应体要单独取 */
      s.send('Network.getResponseBody', { requestId: msg.params.requestId })
        .then((body) => {
          const r = hits.find((h) => h.requestId === msg.params.requestId);
          if (r) r.body = (body.body || '').slice(0, 1500);
        })
        .catch((e) => {
          const r = hits.find((h) => h.requestId === msg.params.requestId);
          if (r) r.bodyError = e.message;
        });
    }
  });

  await s.send('Network.enable');
  await imageSearch.uploadByFileInput(s, FILE);
  await sleep(2500);
  await imageSearch.clickSearchButton(s);
  await sleep(7000);
}, { match: imageSearch.SEARCH_MATCH });

console.log('=== 命中的上传类请求 ===');
if (!hits.length) {
  console.log('（没抓到；可能走了别的通道）');
} else {
  for (const h of hits) {
    console.log('\n--- 请求 ---');
    console.log('method :', h.method);
    console.log('url    :', h.url);
    if (h.postData) console.log('post   :', h.postData);
    console.log('status :', h.status, h.mimeType || '');
    if (h.body) console.log('响应体 :', h.body);
    if (h.bodyError) console.log('响应体读取失败 :', h.bodyError);
  }
}
