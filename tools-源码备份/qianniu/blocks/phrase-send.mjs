/* =====================================================================
 * 区块：图文短语发送（Phrase Send）
 * [功能区块 · v0.1 · 状态：待集成到系统 —— 见 INTEGRATION.md]
 *
 * 重要前提（实测结论）：
 *   聊天输入区的「图片」按钮是 **点了就发** —— 给它的 file input 塞文件后，
 *   页面立刻上传并作为一条图片消息发出，没有"预览/待发"这一步。
 *   所以「一段文字 + 一张图」的短语实际是 **两条消息**。
 *
 * 对外接口：
 *   sendImageOn(session, file)            只发图（粘贴即发）
 *   sendPhraseOn(session, phrase, opts)   按顺序发 图/文
 *   sendPhrase(phrase, opts)              自带会话
 * ===================================================================== */

import path from 'node:path';
import { withSession, setFileInput, evaluate, sleep } from './session.mjs';
import * as input from './input.mjs';
import * as store from './db.mjs';
import { resolveImage } from './library.mjs';

/* 贴图入口：图标容器里的 file input（实测） */
export const CHAT_IMAGE_INPUT =
  'div.editor-tool div.ybdd-im-picupload input[type="file"][accept="image/*"]';

async function msgCount(session) {
  return evaluate(session, `(() => __QN.msgItems().length)()`);
}

async function waitMessageIncrease(session, before, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const n = await msgCount(session);
    if (n > before) return n;
    await sleep(500);
  }
  return await msgCount(session);
}

/* 只发一张图：塞文件 → 等消息数增加（图片由页面自动发出） */
export async function sendImageOn(session, file) {
  const before = await msgCount(session);

  /* ① 先把 input 的 value 清掉：文件 input 持有同名文件时再塞不会触发 change
        （实测：第一次能发，之后毫无反应、连上传请求都不发） */
  await evaluate(session, `(() => {
    const d = __QN.core(); if (!d) return 0;
    const el = d.querySelector(${JSON.stringify(CHAT_IMAGE_INPUT)});
    if (!el) return -1;
    try { el.value = ''; } catch (e) { /* ignore */ }
    return el.files ? el.files.length : 0;
  })()`);

  /* ② 正式塞文件 */
  await setFileInput(session, CHAT_IMAGE_INPUT, file, { inCore: true });
  let after = await waitMessageIncrease(session, before, 8000);
  let via = 'setFileInputFiles';

  /* ③ 还没反应 → 手动补发 input/change 事件（有些组件只认自己绑定的事件） */
  if (after <= before) {
    await evaluate(session, `(() => {
      const d = __QN.core(); if (!d) return 0;
      const el = d.querySelector(${JSON.stringify(CHAT_IMAGE_INPUT)});
      if (!el) return -1;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.files ? el.files.length : 0;
    })()`);
    after = await waitMessageIncrease(session, before, 15000);
    via = 'setFileInputFiles + 手动 change';
  }

  return { ok: after > before, msgBefore: before, msgAfter: after, file, via };
}

/* 发一条图文短语。order: 'text-first'（默认）| 'image-first' */
export async function sendPhraseOn(session, phrase, opts = {}) {
  const order = opts.order || 'text-first';

  /* 保险：定时刷新页面后，聊天窗口会回到"未选择联系人"状态，
     此时发消息会静默失败。这里先确保有一个活跃会话。 */
  if (opts.ensureConversation !== false) {
    const st = await evaluate(session, `(() => {
      const d = __QN.core(); if (!d) return { ok: false, why: 'no-core' };
      try { __QN.ensureAllTab(); } catch (e) { /* ignore */ }
      const active = __QN.activeConvId();
      if (active) return { ok: true, active };
      const first = d.querySelector('.conversation-item');
      if (!first) return { ok: false, why: 'no-conversation' };
      (first.querySelector('.conversation') || first).click();
      return { ok: true, active: first.id, opened: true };
    })()`);
    if (!st.ok) throw new Error('聊天窗口没有可用会话（' + st.why + '），先手动点开一个联系人再发送');
    if (st.opened) await sleep(2500);
  }

  const out = { phraseId: phrase.id, text: phrase.text || '', image: '', imageResult: null, textResult: null };

  /* 用短语库的多根解析，避免相对路径拼重叠 */
  const imagePath = phrase.image ? resolveImage(phrase.image) : '';
  out.image = imagePath;

  const doText = async () => {
    if (!phrase.text) return;
    const r = await input.sendTextOn(session, phrase.text);
    out.textResult = r;
  };
  const doImage = async () => {
    if (!imagePath) return;
    out.imageResult = await sendImageOn(session, imagePath);
    /* 刚打开的窗口偶尔会静默失败，等一拍重试一次（实测有效） */
    if (!out.imageResult.ok && opts.retryImage !== false) {
      await sleep(2500);
      const retry = await sendImageOn(session, imagePath);
      out.imageResult = { ...retry, retried: true };
    }
  };

  if (order === 'image-first') { await doImage(); await sleep(800); await doText(); }
  else { await doText(); await sleep(800); await doImage(); }

  const textOk = !phrase.text || (out.textResult && out.textResult.ok);
  const imageOk = !imagePath || (out.imageResult && out.imageResult.ok);
  return { ...out, ok: textOk && imageOk };
}

export async function sendPhrase(phrase, opts = {}) {
  const r = await withSession((s) => sendPhraseOn(s, phrase, opts), opts);
  if (opts.db !== false) {
    const db = store.openDb(opts.dbFile || store.DB_PATH);
    try {
      store.savePhraseSend(db, {
        epoch: Date.now(),
        phraseId: phrase.id, phraseText: phrase.text, imagePath: r.image,
        convKey: opts.convKey || '', convName: opts.convName || '',
        imageStatus: r.imageResult ? (r.imageResult.ok ? 'sent' : 'failed') : 'skipped',
        textStatus: r.textResult ? (r.textResult.ok ? 'sent' : 'failed') : 'skipped',
        detail: JSON.stringify({ text: r.textResult || null, image: r.imageResult || null }).slice(0, 300)
      });
    } finally { db.close(); }
  }
  return r;
}
