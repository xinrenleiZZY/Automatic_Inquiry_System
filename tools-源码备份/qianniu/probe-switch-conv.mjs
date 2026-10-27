/* 实验：哪种点法能真正切换会话
   node tools/qianniu/probe-switch-conv.mjs
*/
import { withSession, evaluate, sleep } from './blocks/session.mjs';

const state = `(() => ({ active: __QN.activeConvId(), msgs: __QN.msgItems().length }))()`;

const out = await withSession(async (s) => {
  await evaluate(s, `(() => __QN.ensureAllTab())()`);
  await sleep(1200);

  const list = await evaluate(s, `(() => {
    const d = __QN.core();
    return Array.from(d.querySelectorAll('.conversation-item')).slice(0, 3).map((e) => ({
      id: e.id, name: ((e.querySelector('.name') || {}).textContent || '').trim(),
      cls: String(e.className)
    }));
  })()`);
  const before = await evaluate(s, state);
  const results = [];

  for (const item of list) {
    if (item.id === before.active) continue;   // 跳过当前已打开的

    /* 方法 A：对会话项本体 JS click() */
    await evaluate(s, `(() => { const e = Array.from(__QN.core().querySelectorAll('.conversation-item')).find(x => x.id === ${JSON.stringify(item.id)}); if (e) e.click(); return !!e; })()`);
    await sleep(2500);
    const a = await evaluate(s, state);
    results.push({ 方法: 'A: item.click()', 目标: item.name, 结果: a.active === item.id ? '✅ 切换成功' : '❌ 没换', active: a.active.slice(0, 30) });
    if (a.active === item.id) break;

    /* 方法 B：对内部 .conversation JS click() */
    await evaluate(s, `(() => { const e = Array.from(__QN.core().querySelectorAll('.conversation-item')).find(x => x.id === ${JSON.stringify(item.id)}); const inner = e && (e.querySelector('.conversation') || e); if (inner) inner.click(); return !!inner; })()`);
    await sleep(2500);
    const b = await evaluate(s, state);
    results.push({ 方法: 'B: inner.click()', 目标: item.name, 结果: b.active === item.id ? '✅ 切换成功' : '❌ 没换', active: b.active.slice(0, 30) });
    if (b.active === item.id) break;

    /* 方法 C：页面内合成完整鼠标事件序列 */
    await evaluate(s, `(() => {
      const e = Array.from(__QN.core().querySelectorAll('.conversation-item')).find(x => x.id === ${JSON.stringify(item.id)});
      if (!e) return 'no';
      const r = e.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 };
      e.dispatchEvent(new MouseEvent('mouseover', o));
      e.dispatchEvent(new MouseEvent('mousedown', o));
      e.dispatchEvent(new MouseEvent('mouseup', o));
      e.dispatchEvent(new MouseEvent('click', o));
      return 'ok';
    })()`);
    await sleep(2500);
    const c = await evaluate(s, state);
    results.push({ 方法: 'C: 合成鼠标事件', 目标: item.name, 结果: c.active === item.id ? '✅ 切换成功' : '❌ 没换', active: c.active.slice(0, 30) });
    if (c.active === item.id) break;

    /* 方法 D：CDP 真实鼠标双击 */
    const box = await evaluate(s, `(() => {
      const e = Array.from(__QN.core().querySelectorAll('.conversation-item')).find(x => x.id === ${JSON.stringify(item.id)});
      if (!e) return null; e.scrollIntoView({ block: 'center' });
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (box) {
      await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
      await sleep(200);
      await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 2, buttons: 1 });
      await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 2, buttons: 0 });
      await sleep(2500);
      const d2 = await evaluate(s, state);
      results.push({ 方法: 'D: CDP 双击', 目标: item.name, 结果: d2.active === item.id ? '✅ 切换成功' : '❌ 没换', active: d2.active.slice(0, 30) });
      if (d2.active === item.id) break;
    }
  }
  return { before, list, results };
}, { match: 'def_cbu_web_im' });

console.log('当前激活：', out.before.active.slice(0, 40));
console.log('列表前 3 个：');
out.list.forEach((x) => console.log('  -', x.name, '|', x.id.slice(0, 40)));
console.log('\n各种点法的结果：');
console.table(out.results);
