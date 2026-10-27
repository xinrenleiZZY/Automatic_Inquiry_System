/* =====================================================================
 * 区块：消息（Messages）
 * [功能区块 · v0.1 · 状态：待集成到系统 —— 见 INTEGRATION.md]
 *
 * 职责：读取当前会话的消息、判断方向（我方/对方/系统模板）、
 *       去重指纹、增量比对（找出新消息）。
 *
 * 对外接口：
 *   readMessages(opts)            读当前会话全部消息
 *   readMessagesOn(session)       同上，复用已有会话
 *   split(msgs)                   -> { inbound, outbound, system }
 *   msgKey(m)                     消息指纹
 *   prime(seen, msgs)             把历史消息登记进 seen
 *   diff(seen, msgs)              -> { fresh, bulk }  bulk=true 表示疑似切会话/重载
 *   currentConversation(msgs)     由消息反推当前会话名
 * ===================================================================== */

import { withSession, evaluate } from './session.mjs';

export async function readMessagesOn(session) {
  return evaluate(session, `(() => __QN.parse())()`);
}

export async function readMessages(opts) {
  return withSession((s) => readMessagesOn(s), opts);
}

export function split(msgs) {
  return {
    inbound: msgs.filter((m) => m.kind === 'msg' && !m.mine),
    outbound: msgs.filter((m) => m.mine),
    system: msgs.filter((m) => m.kind === 'system')
  };
}

export function msgKey(m) {
  return (m.mine ? 'O' : 'I') + '|' + m.time + '|' + m.text;
}

export function prime(seen, msgs) {
  msgs.forEach((m) => { if (m.kind === 'msg') seen.add(msgKey(m)); });
}

/* bulk = 一次冒出 >=4 条"新"消息，基本可以断定是切换会话或页面重载，
   而不是真的来了 4 条新消息，调用方应重置基线而不是逐条告警。 */
export function diff(seen, msgs) {
  const fresh = msgs.filter((m) => m.kind === 'msg' && !seen.has(msgKey(m)));
  return { fresh, bulk: fresh.length >= 4 };
}

/* 会话名由消息反推：出现次数最多的「非我」发送者。
   比会话列表的 active 标记可靠（实测 active 会指向别的会话）。 */
export function currentConversation(msgs, convs = []) {
  const counter = new Map();
  msgs.forEach((m) => {
    if (m.kind === 'msg' && !m.mine && m.sender) {
      const shop = m.sender.split(':')[0].trim();
      counter.set(shop, (counter.get(shop) || 0) + 1);
    }
  });
  const top = [...counter.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top) return top[0];
  const active = convs.find((c) => c.active);
  return active ? active.name : '(未知会话)';
}

export function summarize(msgs) {
  const { inbound, outbound, system } = split(msgs);
  return {
    total: msgs.length,
    inbound: inbound.length,
    outbound: outbound.length,
    system: system.length,
    lastInbound: inbound[inbound.length - 1] || null,
    lastOutbound: outbound[outbound.length - 1] || null
  };
}
