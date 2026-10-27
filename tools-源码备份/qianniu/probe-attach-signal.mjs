/* 探"聊天框贴图"的 DOM 变化与清除控件
   node tools/qianniu/probe-attach-signal.mjs
   （贴完不发送；会尝试把附件清掉）
*/
import path from 'node:path';
import fs from 'node:fs';
import { withSession, evaluate, setFileInput, sleep } from './blocks/session.mjs';

const FILE = path.resolve('tools/qianniu/image/LuminousMemories.jpg');
const INPUT_SEL = 'div.editor-tool div.ybdd-im-picupload input[type="file"][accept="image/*"]';

const SNAP = `(() => {
  const core = __QN.core();
  const panel = core.querySelector('div.text-panel .biz-expression-editor') || core.querySelector('div.text-panel');
  const btn = core.querySelector('button.send-btn');
  const imgs = panel ? Array.from(panel.querySelectorAll('img')).map((i) => ({
    src: (i.getAttribute('src') || '').slice(0, 70),
    cls: String(i.className || '').slice(0, 30),
    w: Math.round(i.getBoundingClientRect().width),
    h: Math.round(i.getBoundingClientRect().height)
  })) : [];
  const removers = panel ? Array.from(panel.querySelectorAll('[class*="close"],[class*="del"],[class*="remove"],[class*="cancel"]'))
    .map((e) => ({ cls: String(e.className || '').slice(0, 40), tag: e.tagName.toLowerCase() })) : [];
  return {
    draft: __QN.readDraft(),
    btnCls: btn ? String(btn.className) : '',
    panelCls: panel ? String(panel.className) : '',
    imgCount: imgs.length,
    imgs,
    removers,
    draftText: (panel ? (panel.innerText || '') : '').replace(/\\s+/g, ' ').trim().slice(0, 60)
  };
})()`;

const out = await withSession(async (s) => {
  const before = await evaluate(s, SNAP);

  /* 塞图片进 input（跨 frame：inCore=true） */
  await setFileInput(s, INPUT_SEL, FILE, { inCore: true });

  await sleep(3500);
  const after = await evaluate(s, SNAP);

  /* 试着清掉附件：点第一个 remover */
  let cleared = null;
  if (after.removers.length) {
    const box = await evaluate(s, `(() => {
      const core = __QN.core();
      const panel = core.querySelector('div.text-panel .biz-expression-editor') || core.querySelector('div.text-panel');
      const el = panel.querySelector('[class*="close"],[class*="del"],[class*="remove"],[class*="cancel"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, cls: String(el.className) };
    })()`);
    if (box && box.w > 2) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await s.send('Input.dispatchMouseEvent', {
          type, x: box.x, y: box.y, button: 'left', clickCount: 1,
          buttons: type === 'mousePressed' ? 1 : 0
        });
      }
      await sleep(1200);
      cleared = { clicked: box.cls, after: await evaluate(s, SNAP) };
    } else {
      cleared = { clicked: null, note: '有 remover 但不可点' };
    }
  } else {
    cleared = { clicked: null, note: '没找到 remover' };
  }

  return { before, after, cleared };
}, { match: 'def_cbu_web_im' });

console.log('=== 贴图前 ===');
console.log(JSON.stringify(out.before, null, 2));
console.log('\n=== 贴图后（关键：imgCount / removers / btnCls）===');
console.log(JSON.stringify(out.after, null, 2));
console.log('\n=== 清除尝试 ===');
console.log(JSON.stringify(out.cleared.after
  ? { clicked: out.cleared.clicked, imgCount: out.cleared.after.imgCount, btnCls: out.cleared.after.btnCls, draft: out.cleared.after.draft }
  : out.cleared, null, 2));
