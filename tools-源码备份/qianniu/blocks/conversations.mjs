/* =====================================================================
 * 区块：会话列表（Conversations）
 * [功能区块 · v0.1 · 状态：待集成到系统 —— 见 INTEGRATION.md]
 *
 * 职责：读取左侧会话列表（含未读、最后一条预览），并提供「变化检测」。
 *       有了它，不打开某个会话也能发现客户来消息。
 *
 * 对外接口：
 *   readConversations(opts) / readConversationsOn(session)
 *   fingerprint(convs)                 -> Map<名称, {keys:Set, sample, active}>
 *   diffConversations(prev, convs)     -> { next, changed: [...] }
 *
 * 注意：指纹只用「最后一条内容 + 未读数」，绝不含相对时间
 *       （"6分钟前"会自然漂移，否则每轮都会误报新消息）。
 * ===================================================================== */

import { withSession, evaluate, sleep } from './session.mjs';

export async function readConversationsOn(session) {
  /* 会话列表有三个标签页（全部 / AI询 / 联系人）。停在"AI询"或"联系人"
     时会读不到普通会话（实测读到 0 条），所以先确保切回"全部"。 */
  try {
    const tab = await evaluate(session, `(() => (window.__QN && __QN.ensureAllTab) ? __QN.ensureAllTab() : 'no-helper')()`);
    if (tab === 'clicked') await sleep(1200);
  } catch { /* 忽略：不影响后续读取 */ }
  return evaluate(session, `(() => __QN.convs())()`);
}

export async function readConversations(opts) {
  return withSession((s) => readConversationsOn(s), opts);
}

export function convKey(c) {
  return c.desc + '|' + c.unread;
}

/* 主键用会话 id（不是显示名）：显示名会重名，
   例如 playworld152:it（本账号）与 playworld152:cqy（同事）显示名都是 playworld152。 */
export function convId(c) {
  return c.key || c.id || ('name:' + c.name);
}

/* 同一会话可能在置顶区和最近区各出现一条，所以用「id -> 指纹集合」，
   用单值会互相覆盖导致每轮误报。 */
export function fingerprint(convs) {
  const map = new Map();
  for (const c of convs) {
    const k = convId(c);
    if (!map.has(k)) map.set(k, { keys: new Set(), sample: c, active: false });
    const rec = map.get(k);
    rec.keys.add(convKey(c));
    if (c.active) rec.active = true;
  }
  return map;
}

export function sameKeys(a, b) {
  return a.size === b.size && [...a].every((v) => b.has(v));
}

export function diffConversations(prev, convs) {
  const next = fingerprint(convs);
  const changed = [];
  for (const [name, info] of next) {
    const before = prev.get(name);
    if (!before) continue;                     // 首次登记，不算变化
    if (sameKeys(before.keys, info.keys)) continue;
    if (info.active) continue;                 // 当前会话交给消息级处理，避免重复
    changed.push({ name, sample: info.sample });
  }
  return { next, changed };
}

export function summarize(convs) {
  return {
    total: convs.length,
    unread: convs.filter((c) => c.unread).length,
    self: convs.filter((c) => c.isSelf).length,
    withPeer: convs.filter((c) => c.peer).length,
    active: (convs.find((c) => c.active) || {}).name || null
  };
}

/* 展示用标签：显示名 + 账号 + 是否本账号自己 */
export function label(c) {
  if (!c) return '(未知)';
  const tag = c.isSelf ? '本账号自己' : (c.peer ? '账号 ' + c.peer : '');
  return tag ? `${c.name}（${tag}）` : c.name;
}
