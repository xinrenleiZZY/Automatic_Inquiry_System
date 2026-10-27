/* =====================================================================
 * 区块：全量抓取会话历史（Sweep）
 * [功能区块 · v0.1 · 状态：待集成到系统 —— 见 INTEGRATION.md]
 *
 * 背景：网页版旺旺只在"打开某个会话"时才加载该会话的消息 DOM，
 *       所以不打开就抓不到。sweep 就是逐个点开会话，把历史读下来入库。
 *
 * 做什么：
 *   1) 读会话列表（自动切回"全部"标签）
 *   2) 逐个用 JS click 切换过去，等 **当前激活会话 id == 目标 id** 才算切好
 *   3) 读消息 → 落库（messages 表按指纹去重，重复跑不会产生重复数据）
 *   4) 可选向上滚动加载更早的历史（--scroll N）
 *
 * 用法：
 *   node im.mjs sweep [--limit 50] [--scroll 3] [--interval 1500]
 * ===================================================================== */

import { withSession, evaluate, sleep } from './session.mjs';
import * as store from './db.mjs';
import { openConversation, waitConversationLoaded } from './auto-reply.mjs';
import { enforceSingleTabs } from './tabs.mjs';
import { withBrowserLock } from './lock.mjs';

/* 把消息区滚到顶部触发加载更早的历史；返回本次新增的消息数 */
async function scrollUp(session) {
  const before = await evaluate(session, `(() => __QN.msgItems().length)()`);
  await evaluate(session, `(() => {
    const v = __QN.msgView();
    if (!v) return 0;
    v.scrollTop = 0;                       // 有的实现用外层容器滚动
    // 有的实现把滚动放在父级
    let p = v.parentElement, n = 0;
    while (p && n < 3) { p.scrollTop = 0; p = p.parentElement; n++; }
    v.dispatchEvent(new Event('scroll', { bubbles: true }));
    return 1;
  })()`);
  await sleep(1800);
  const after = await evaluate(session, `(() => __QN.msgItems().length)()`);
  return after - before;
}

export async function sweep(opts = {}) {
  return withBrowserLock(() => sweepInner(opts), { what: 'sweep', waitMs: opts.waitMs });
}

async function sweepInner(opts = {}) {
  const limit = Number(opts.limit) || 50;
  const maxScroll = Number(opts.scroll) || 0;
  const gapMs = Number(opts.interval) || 1500;
  const dbFile = opts.dbFile || store.DB_PATH;

  const db = store.openDb(dbFile);
  const report = { conversations: 0, visited: 0, skipped: 0, saved: 0, results: [] };
  try {
    const convs = await withSession((s) => evaluate(s, `(() => __QN.convs())()`));
    const targets = convs.filter((c) => !c.isSelf).slice(0, limit);
    report.conversations = targets.length;
    console.log(`准备抓取 ${targets.length} 个会话的历史（滚动轮数 ${maxScroll}）`);

    for (const c of targets) {
      const convKey = c.key || c.id || '';
      const line = (s) => console.log(`   ${s}`);
      console.log(`\n── ${c.name} ──`);

      const res = await withSession(async (s) => {
        const clicked = await openConversation(s, { convKey, convName: c.name });
        if (!clicked) return { ok: false, why: '会话列表里找不到这一项' };
        const st = await waitConversationLoaded(s, convKey, 20000);
        if (st.active !== convKey) {
          return { ok: false, why: `会话没切换成功（当前=${(st.active || '(空)').slice(0, 30)}）` };
        }

        let msgs = await evaluate(s, `(() => __QN.parse())()`);
        let rounds = 0;
        /* 向上滚动，尽量把更早的历史也加载出来 */
        while (rounds < maxScroll) {
          const added = await scrollUp(s);
          rounds++;
          if (added <= 0) break;
          msgs = await evaluate(s, `(() => __QN.parse())()`);
        }
        return { ok: true, msgs, rounds };
      });

      if (!res.ok) { line('跳过：' + res.why); report.skipped++; continue; }

      const saved = store.saveMessages(db, {
        convKey, convName: c.name, msgs: res.msgs, source: 'sweep'
      });
      store.saveConversations(db, [c]);          // 顺带更新客户档案

      const inbound = res.msgs.filter((m) => m.kind === 'msg' && !m.mine).length;
      report.visited++;
      report.saved += saved;
      line(`读到 ${res.msgs.length} 条（对方 ${inbound}）｜ 新入库 ${saved} 条` +
           (maxScroll ? ` ｜ 上滚 ${res.rounds} 轮` : ''));
      report.results.push({ conv: c.name, read: res.msgs.length, inbound, saved, rounds: res.rounds });
      await sleep(gapMs);
    }
  } finally {
    db.close();
    try { await enforceSingleTabs({}); } catch { /* ignore */ }
  }
  return report;
}
