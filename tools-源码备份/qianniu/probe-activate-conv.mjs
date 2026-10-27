/* 实验：怎么让聊天窗口"激活"某个会话（当前点会话项没反应）
   node tools/qianniu/probe-activate-conv.mjs
*/
import { withSession, evaluate, sleep } from './blocks/session.mjs';

const dump = `(() => {
  const d = __QN.core();
  const items = d ? Array.from(d.querySelectorAll('.conversation-item')) : [];
  return {
    active: __QN.activeConvId(),
    activeCls: items.filter((e) => e.classList.contains('active')).length,
    anyActiveLike: items.filter((e) => /active|select|current/i.test(String(e.className))).length,
    msgs: __QN.msgItems().length,
    firstCls: items[0] ? String(items[0].className) : '',
    item0Html: items[0] ? items[0].outerHTML.replace(/\\s+/g, ' ').slice(0, 260) : ''
  };
})()`;

const out = await withSession(async (s) => {
  const before = await evaluate(s, dump);

  /* 监听 DOM 变化，看点击有没有引发任何反应 */
  await evaluate(s, `(() => {
    window.__mut = [];
    const d = __QN.core();
    const target = d.querySelector('.conversation-list-scroll') || d.body;
    const ob = new MutationObserver((ms) => {
      window.__mut.push({ t: Date.now(), n: ms.length });
    });
    ob.observe(target, { childList: true, subtree: true, attributes: true });
    window.__mutStop = () => ob.disconnect();
    return 'ok';
  })()`);

  const box = await evaluate(s, `(() => {
    const d = __QN.core();
    const it = d.querySelector('.conversation-item');
    if (!it) return null;
    it.scrollIntoView({ block: 'center' });
    const inner = it.querySelector('.conversation') || it;
    const r = inner.getBoundingClientRect();
    const r2 = it.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height,
             itemX: r2.x, itemY: r2.y, itemW: r2.width, itemH: r2.height,
             name: (it.querySelector('.name') || {}).textContent || '' };
  })()`);
  if (!box) return { before, error: '找不到会话项' };

  const fire = async (type, x, y, clicks) => {
    await s.send('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', clickCount: clicks,
      buttons: type === 'mousePressed' ? 1 : 0
    });
  };

  /* ① hover */
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await sleep(400);
  const afterHover = await evaluate(s, dump);

  /* ② 单击（内层 .conversation） */
  await fire('mousePressed', box.x, box.y, 1);
  await sleep(120);
  await fire('mouseReleased', box.x, box.y, 1);
  await sleep(2500);
  const afterClick = await evaluate(s, dump);

  /* ③ 双击 */
  await fire('mousePressed', box.x, box.y, 2);
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 2, buttons: 0 });
  await sleep(2500);
  const afterDbl = await evaluate(s, dump);

  const mut = await evaluate(s, `(() => { const a = window.__mut || []; if (window.__mutStop) window.__mutStop(); return a.slice(0, 8); })()`);
  return { before, box, afterHover, afterClick, afterDbl, mutations: mut };
}, { match: 'def_cbu_web_im' });

console.log('=== 点击前 ===');
console.log(JSON.stringify(out.before, null, 2));
console.log('\n=== 点击坐标 ===');
console.log(JSON.stringify(out.box, null, 2));
for (const k of ['afterHover', 'afterClick', 'afterDbl']) {
  console.log(`\n=== ${k} ===`);
  console.log(JSON.stringify(out[k], null, 2));
}
console.log('\n=== 期间 DOM 变化 ===');
console.log(JSON.stringify(out.mutations, null, 2));
