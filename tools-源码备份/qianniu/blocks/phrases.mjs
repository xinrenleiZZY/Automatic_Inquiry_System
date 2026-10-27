/* =====================================================================
 * 区块：快捷短语（Quick Phrases）
 * [功能区块 · v0.1 · 状态：待集成到系统 —— 见 INTEGRATION.md]
 *
 * 职责：点开「选择快捷回复短语」弹窗 → 读取短语列表 → 选中某条
 *       （选中后自动填入输入框，弹窗自动关闭）→ 可选直接发送。
 *
 * 对外接口：
 *   isOpen(session) / list() / open() / ensure(session)
 *   pickOn(session, 序号或文本片段)  -> { text, draft, dialogOpen, btnCls }
 *   use(序号或文本, { send })        -> 一步到位（可带发送）
 *
 * 实测结论：点短语不产生任何网络请求，是纯前端插入。
 *          所以模拟真实点击即可，无需逆 mtop.ali.ww.getquickphrasesdata。
 * 按钮定位：按图标资源 ID 定位，比 nth-of-type 稳。
 * ===================================================================== */

import { withSession, evaluate, clickAt, pressKey, sleep } from './session.mjs';
import { sendOn } from './input.mjs';

export async function isOpen(session) {
  return evaluate(session, `(() => !!__QN.phraseDialog())()`);
}

export async function listOn(session) {
  return evaluate(session, `(() => (__QN.phraseDialog() ? __QN.phraseItems() : null))()`);
}

export async function openOn(session) {
  const box = await evaluate(session, `(() => __QN.boxOf(__QN.phraseBtnSel))()`);
  if (!box) throw new Error('找不到快捷短语按钮（图标选择器可能失效，跑 probe-tools.js 复查）');
  await clickAt(session, box);
  await sleep(900);
  const items = await listOn(session);
  if (items && items.length) return items;

  /* 点了按钮但弹窗没出来。实测这种情况多半是「没打开会话」——
     快捷短语是按会话加载的，没有会话就没有短语列表。
     把原因说清楚，别让人误以为功能坏了。 */
  const state = await evaluate(session, `(() => ({
    activeConv: __QN.activeConvId(),
    convCount: __QN.convs().length,
    hasInput: !!__QN.input()
  }))()`);
  if (!state.activeConv) {
    throw new Error('聊天窗口当前没有打开任何会话（左侧有 ' + state.convCount +
                    ' 个）——快捷短语是按会话加载的，先点开一个会话再试');
  }
  throw new Error('点了快捷短语按钮但弹窗没出现：该会话可能没有短语，或页面结构变了');
}

export async function ensureOn(session) {
  const items = await listOn(session);
  if (items && items.length) return items;
  return openOn(session);
}

export async function list(opts) {
  return withSession((s) => ensureOn(s), opts);
}

/* sel 可以是序号（0 起）或短语文本片段 */
export async function pickOn(session, sel) {
  const items = await ensureOn(session);
  if (!items || !items.length) throw new Error('没能打开快捷短语弹窗，或弹窗里没有短语');

  const idx = /^\d+$/.test(String(sel))
    ? Number(sel)
    : items.findIndex((it) => it.text.indexOf(String(sel)) >= 0);
  if (idx < 0 || idx >= items.length) {
    throw new Error('没匹配上，可选：' + items.map((it, i) => i + '=' + it.text).join(' | '));
  }

  const item = items[idx];
  await clickAt(session, item);

  /* 弹窗关闭带动画，轮询等它关；超时就按 Esc 兜底（实测偶尔关得慢） */
  let closed = false;
  for (let i = 0; i < 10; i++) {
    await sleep(250);
    if (!(await isOpen(session))) { closed = true; break; }
  }
  if (!closed) {
    await pressKey(session, 'Escape');
    await sleep(300);
    closed = !(await isOpen(session));
  }

  const state = await evaluate(session, `(() => ({
    draft: __QN.readDraft(),
    dialogOpen: !!__QN.phraseDialog(),
    btnCls: (__QN.sendBtn() || {}).className || null
  }))()`);
  return { text: item.text, ...state };
}

export async function use(sel, opts = {}) {
  return withSession(async (s) => {
    const picked = await pickOn(s, sel);
    if (!opts.send) return picked;
    const sent = await sendOn(s);
    return { ...picked, sent };
  }, opts);
}
