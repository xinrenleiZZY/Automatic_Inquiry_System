/* =====================================================================
 * 区块：输入框与发送（Input）
 * [功能区块 · v0.1 · 状态：待集成到系统 —— 见 INTEGRATION.md]
 *
 * 职责：聚焦输入框、填入草稿、清空草稿、点击发送，并校验发送结果。
 *
 * 对外接口（On 后缀 = 复用已有 session；不带 = 自己开会话）：
 *   readDraft / readDraftOn
 *   draft(text) / draftOn(session, text)
 *   clear() / clearOn(session)
 *   send() / sendOn(session)        发送当前草稿并校验
 *   sendText(text) / sendTextOn(session, text)
 *
 * 输入方式：CDP Input.insertText（可信输入事件，框架能正常识别）
 * 点击方式：CDP Input.dispatchMouseEvent（真实鼠标事件）
 * ===================================================================== */

import { withSession, evaluate, clickSelector, pressKey, selectAll, sleep } from './session.mjs';

export async function readDraftOn(session) {
  return evaluate(session, `(() => __QN.readDraft())()`);
}

export async function readDraft(opts) {
  return withSession((s) => readDraftOn(s), opts);
}

/* 聚焦输入框 */
export async function focusOn(session) {
  /* 只用 el.focus() 不可靠：实测 document.activeElement 停在顶层 IFRAME 上，
     键盘事件（Ctrl+A / Backspace）根本进不到编辑器里，
     于是"清空"变成空操作、后面输入就变成追加。
     可靠做法：先对输入框发一次**真实鼠标点击**，再校验 core 文档里的 activeElement。 */
  const info = await evaluate(session, `(() => {
    const d = __QN.core(); if (!d) return { ok: false, why: 'NO_CORE' };
    const el = __QN.input(); if (!el) return { ok: false, why: 'NO_INPUT' };
    const b = __QN.toTopBox(el);
    return { ok: true, x: b.x, y: b.y, w: b.w, h: b.h,
             tag: el.tagName + (el.isContentEditable ? ':editable' : '') };
  })()`);
  if (!info.ok) throw new Error(info.why === 'NO_CORE' ? '拿不到核心聊天文档' : '找不到输入框');

  if (info.w > 2 && info.h > 2) {
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.x, y: info.y });
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', clickCount: 1, buttons: 1 });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', clickCount: 1, buttons: 0 });
    await sleep(200);
  }
  /* 兜底 + 校验：确认 core 文档里的 activeElement 就是输入框 */
  await evaluate(session, `(() => {
    const d = __QN.core(); const el = __QN.input();
    if (d && el && d.activeElement !== el) el.focus();
    return 1;
  })()`);
  return info.tag;
}

/* 先清空再输入。
   注意：不能靠 DOM Range 全选——这个编辑器不认 DOM 选区，
   那样 insertText 会变成"插入"而不是"覆盖"（实测踩到过）。 */
export async function draftOn(session, text) {
  await clearOn(session);
  await focusOn(session);
  await session.send('Input.insertText', { text });
  await sleep(250);
  return readDraftOn(session);
}

export async function draft(text, opts) {
  return withSession((s) => draftOn(s, text), opts);
}

export async function clearOn(session) {
  await focusOn(session);
  /* 清空方式实测对比（同一个编辑器）：
       × Range 全选 + execCommand('delete')  → 无效
       × Range 全选 + insertText 空串         → 无效
       √ 直接把 innerHTML 置空 + 派发 input 事件 → 有效
       √ CDP Ctrl+A + Backspace                → 有效（留作兜底）
     这个编辑器是自定义 contenteditable，前两种"标准做法"它不认。 */
  let left = await evaluate(session, `(() => {
    const el = __QN.input(); if (!el) return null;
    el.innerHTML = '';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    return (el.innerText || '').replace(/\\s+/g, ' ').trim();
  })()`);

  if (left) {
    /* 兜底：真实按键 Ctrl+A + Backspace，最多几轮 */
    let guard = 0;
    while (left && guard++ < 8) {
      await selectAll(session);
      await pressKey(session, 'Backspace');
      await sleep(200);
      left = await readDraftOn(session);
    }
  }
  return left;
}

export async function clear(opts) {
  return withSession((s) => clearOn(s), opts);
}

export async function sendOn(session) {
  const before = await evaluate(session, `(() => __QN.msgItems().length)()`);
  await clickSelector(session, 'button.send-btn');
  await sleep(1200);
  const after = await evaluate(session, `(() => {
    const el = __QN.input();
    return { count: __QN.msgItems().length, draft: el ? (el.innerText || '').replace(/\\s+/g, ' ').trim() : null };
  })()`);
  return {
    countBefore: before,
    countAfter: after.count,
    draftAfter: after.draft,
    ok: after.count > before && !after.draft
  };
}

export async function send(opts) {
  return withSession((s) => sendOn(s), opts);
}

export async function sendTextOn(session, text) {
  const draft = await draftOn(session, text);
  const result = await sendOn(session);
  return { draft, ...result };
}

export async function sendText(text, opts) {
  return withSession((s) => sendTextOn(s, text), opts);
}
