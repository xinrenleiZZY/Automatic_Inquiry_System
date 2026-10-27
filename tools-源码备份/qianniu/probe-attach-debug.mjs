/* 精确诊断：贴图后 input.files 是否生效、有没有发上传请求、预览图去哪了
   node tools/qianniu/probe-attach-debug.mjs
*/
import path from 'node:path';
import { withSession, evaluate, setFileInput, sleep } from './blocks/session.mjs';

const FILE = path.resolve('tools/qianniu/image/LuminousMemories.jpg');
const INPUT_SEL = 'div.editor-tool div.ybdd-im-picupload input[type="file"][accept="image/*"]';

const STATE = `(() => {
  const core = __QN.core();
  const input = core.querySelector(${JSON.stringify(INPUT_SEL)});
  const all = Array.from(core.querySelectorAll('img'));
  return {
    inputFound: !!input,
    inputFiles: input && input.files ? input.files.length : -1,
    inputFileName: input && input.files && input.files[0] ? input.files[0].name : '',
    blobImgs: all.filter((i) => /^(blob:|data:)/.test(i.getAttribute('src') || ''))
                 .map((i) => ({ src: (i.getAttribute('src') || '').slice(0, 40), w: Math.round(i.getBoundingClientRect().width) })),
    coreImgsTotal: all.length,
    draft: __QN.readDraft(),
    btnCls: (__QN.sendBtn() || {}).className || ''
  };
})()`;

const reqs = [];
const out = await withSession(async (s) => {
  s.on((msg) => {
    if (msg.method === 'Network.requestWillBeSent') {
      const u = msg.params.request.url || '';
      if (/upload|image|pic|file|media/i.test(u)) {
        reqs.push({ method: msg.params.request.method, url: u.split('?')[0].slice(0, 90), type: msg.params.type });
      }
    }
  });
  await s.send('Network.enable');

  const before = await evaluate(s, STATE);
  const info = await setFileInput(s, INPUT_SEL, FILE, { inCore: true });
  await sleep(1200);
  const mid = await evaluate(s, STATE);
  await sleep(3000);
  const after = await evaluate(s, STATE);
  return { before, info, mid, after };
}, { match: 'def_cbu_web_im' });

console.log('=== 贴图前 ===');
console.log(JSON.stringify(out.before, null, 2));
console.log('\n=== 传入的文件 ===');
console.log(JSON.stringify(out.info, null, 2));
console.log('\n=== 1.2 秒后 ===');
console.log(JSON.stringify(out.mid, null, 2));
console.log('\n=== 4.2 秒后 ===');
console.log(JSON.stringify(out.after, null, 2));
console.log('\n=== 期间的上传类请求 ===');
console.table(reqs.slice(0, 12));
