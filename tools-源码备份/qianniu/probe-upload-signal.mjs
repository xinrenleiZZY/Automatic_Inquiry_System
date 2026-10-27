/* 找"图片已上传成功"的可观测信号：塞文件前后各拍一次 DOM，做差
   node tools/qianniu/probe-upload-signal.mjs
*/
import { withSession, evaluate, sleep } from './blocks/session.mjs';
import * as imageSearch from './blocks/image-search.mjs';

const FILE = 'tools/qianniu/image/示例.png';

const SNAP = `(() => {
  const btn = document.querySelector(${JSON.stringify(imageSearch.SEARCH_BTN_SELECTOR)});
  const box = document.querySelector('.copy-image-container');
  const imgs = box ? Array.from(box.querySelectorAll('img')).map((i) => (i.getAttribute('src') || '').slice(0, 60)) : [];
  return {
    btnFound: !!btn,
    btnClass: btn ? String(btn.className) : '',
    btnText: btn ? (btn.innerText || '').trim() : '',
    btnDisabled: btn ? (btn.getAttribute('disabled') !== null || /disabled/i.test(btn.className)) : null,
    boxText: box ? (box.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60) : '',
    boxImgs: imgs,
    fileInputFiles: (() => {
      const f = document.querySelector(${JSON.stringify(imageSearch.IMAGE_FILE_INPUT)});
      return f && f.files ? f.files.length : -1;
    })()
  };
})()`;

const opened = await imageSearch.openSearchPage();
if (opened.opened) await sleep(3000);
else await sleep(500);

const out = await withSession(async (s) => {
  const before = await evaluate(s, SNAP);

  /* 记录塞文件过程中的 DOM 变化 */
  await evaluate(s, `(() => {
    window.__sig = [];
    const btn = document.querySelector(${JSON.stringify(imageSearch.SEARCH_BTN_SELECTOR)});
    const obs = new MutationObserver(() => {
      const b = document.querySelector(${JSON.stringify(imageSearch.SEARCH_BTN_SELECTOR)});
      window.__sig.push({
        t: Date.now(),
        cls: b ? String(b.className) : 'gone',
        imgs: document.querySelectorAll('.copy-image-container img').length
      });
    });
    if (btn && btn.parentElement) obs.observe(btn.parentElement, { attributes: true, subtree: true, childList: true });
    else obs.observe(document.body, { attributes: true, subtree: true, childList: true });
    window.__sigStop = () => obs.disconnect();
    return 'watching';
  })()`);

  await imageSearch.uploadByFileInput(s, FILE);
  await sleep(2000);

  const after = await evaluate(s, SNAP);
  const sig = await evaluate(s, `(() => { if (window.__sigStop) window.__sigStop(); return (window.__sig || []).slice(0, 12); })()`);
  return { before, after, sig };
}, { match: imageSearch.SEARCH_MATCH });

console.log('=== 塞文件前 ===');
console.log(JSON.stringify(out.before, null, 2));
console.log('\n=== 塞文件后 ===');
console.log(JSON.stringify(out.after, null, 2));
console.log('\n=== 期间 DOM 变化（前 12 次）===');
console.log(JSON.stringify(out.sig, null, 2));
