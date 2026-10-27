/* =====================================================================
 * 区块：事件监听（Monitor）
 * [功能区块 · v0.1 · 状态：待集成到系统 —— 见 INTEGRATION.md]
 *
 * 职责：常驻轮询，产出「新消息 / 其它会话有动静」两类事件。
 *   - 消息级：当前打开的会话，逐条精确解析（我方/对方）
 *   - 会话级：从会话列表发现任何客户来消息（不打开该会话也能发现）
 *   - 自愈：页面刷新、target 变化、WebSocket 断开都会自动重连
 *
 * 对外接口：
 *   new EventMonitor({ interval, out, quiet, onEvent })
 *   monitor.tick()        单次巡检
 *   monitor.run({ duration })  常驻运行
 *   monitor.summary()
 * ===================================================================== */

import { listPages, attach } from '../cdp-lib.mjs';
import { evaluate, ensureHelpers, PAGE_MATCH, sleep } from './session.mjs';
import { diff as diffMessages, prime as primeMessages, currentConversation } from './messages.mjs';
import { diffConversations, fingerprint, label } from './conversations.mjs';
import { appendEvent, makeEvent, PATHS } from './logstore.mjs';
import * as store from './db.mjs';
import * as replyBlock from './reply.mjs';

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

/* 给任意 Promise 加超时，防止某一环卡住把整个轮询循环拖死。
   超时后原 Promise 仍会继续跑，但循环已经能往下走了。 */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })
  ]);
}

export class EventMonitor {
  constructor(opts = {}) {
    this.interval = Number(opts.interval) || 15000;   // 默认 15 秒轮询一次
    this.out = opts.out || PATHS.events;
    this.quiet = !!opts.quiet;
    this.onEvent = opts.onEvent || null;
    this.heartbeatMs = Number(opts.heartbeatMs) || 300000;   // 默认 5 分钟
    this.tickTimeoutMs = Number(opts.tickTimeoutMs) || 30000; // 单次巡检上限
    /* 定时刷新聊天网页（分钟，0=不刷新）：清内存、同步会话列表、刷新登录态。
       注意：刷新后页面会回到"未选择联系人"，所以刷新后要重新登记基线。 */
    this.refreshMin = Number(opts.refreshMin) || 0;
    this.lastRefreshAt = Date.now();
    /* 落库：opts.db === false 可关闭（自测用），opts.dbFile 可指定路径 */
    this.dbFile = opts.db === false ? null : (opts.dbFile || store.DB_PATH);
    this.db = null;
    this.replyEngine = opts.replyEngine || null;   // 自动回复引擎（可选）
    this.sessions = new Map();     // targetId -> { page, session }
    this.msgSeen = new Map();      // targetId -> Set(消息指纹)
    this.convSeen = new Map();     // targetId -> Map(会话名 -> {keys})
    this.stats = { inbound: 0, outbound: 0, convAlerts: 0, ticks: 0, reconnects: 0, errors: 0 };
    this.startedAt = Date.now();
    this.lastTickAt = Date.now();
    this.lastBeat = Date.now();
  }

  log(msg) { if (!this.quiet) console.log(msg); }

  async syncTargets() {
    /* 只按 pathname 判断是不是聊天页：聊天页 URL 的 traceParams 里可能
       编码着别的地址，整串匹配会误抓。 */
    const pathOf = (u) => { try { return new URL(u).pathname; } catch { return u || ''; } };
    const pages = (await listPages()).filter((p) =>
      pathOf(p.url).includes(PAGE_MATCH) || (p.title || '').includes('旺旺聊天'));
    const alive = new Set(pages.map((p) => p.id));

    for (const [id, entry] of this.sessions) {
      if (!alive.has(id)) { entry.session.close(); this.sessions.delete(id); }
    }
    for (const p of pages) {
      if (this.sessions.has(p.id)) continue;
      try {
        const session = await attach(p);
        await ensureHelpers(session);
        this.sessions.set(p.id, { page: p, session, conv: null });
        this.msgSeen.set(p.id, new Set());
        this.convSeen.set(p.id, new Map());
        this.log(`[${stamp()}] 🔗 已接入窗口：${(p.title || '').slice(0, 24)}`);
      } catch (e) {
        this.log(`[${stamp()}] ⚠️ 接入失败：${e.message}`);
      }
    }
  }

  emit(event) {
    const rec = makeEvent(event.type, event);
    appendEvent(rec, this.out);
    if (this.db) store.saveEvent(this.db, rec);
    if (this.onEvent) {
      try { this.onEvent(rec); } catch (e) { console.error('onEvent 回调异常:', e.message); }
    }
    return rec;
  }

  async tick() {
    await this.syncTargets();
    if (this.dbFile && !this.db) this.db = store.openDb(this.dbFile);   // 懒加载
    if (!this.sessions.size) {
      this.log(`[${stamp()}] ⏳ 没有可接入的聊天窗口，等待中……`);
      return;
    }

    for (const [id, entry] of this.sessions) {
      let snap;
      try {
        snap = await evaluate(entry.session, `(() => __QN.snapshot())()`);
      } catch (e) {
        this.stats.errors++;
        this.log(`[${stamp()}] ⚠️ 读取失败，将重连：${e.message}`);
        entry.session.close();
        this.sessions.delete(id);
        this.stats.reconnects++;
        continue;
      }
      if (!snap) {
        try { await ensureHelpers(entry.session); } catch { /* 页面跳转中 */ }
        continue;
      }

      const conv = currentConversation(snap.msgs, snap.convs);
      const activeRow = snap.convs.find((c) => c.active)
        || snap.convs.find((c) => c.name === conv) || null;
      /* 会话身份用 id（显示名会重名：playworld152:it 与 playworld152:cqy 都叫 playworld152） */
      const convId = snap.activeId || (activeRow ? activeRow.key : conv);

      /* 两种情况都只登记基线、绝不上报：
         ① 新接入的窗口（首次）
         ② 同一窗口内切换了会话
         否则「历史消息少于 4 条」的会话会被整段当成新消息（实测踩到过两次）。 */
      if (entry.conv !== convId) {
        const seen0 = this.msgSeen.get(id) || new Set();
        primeMessages(seen0, snap.msgs);
        this.msgSeen.set(id, seen0);
        this.convSeen.set(id, fingerprint(snap.convs));
        const first = entry.conv === null;
        entry.conv = convId;
        /* 首次接入 / 切换会话时，把当前可见的历史消息也落库，
           这样库里一开始就有基线数据，而不是空的。 */
        if (this.db) {
          store.saveConversations(this.db, snap.convs);
          store.saveMessages(this.db, {
            convKey: convId,
            convName: activeRow ? activeRow.name : conv,
            msgs: snap.msgs, source: entry.page.title
          });
        }
        this.log(`[${stamp()}] 📌 ${first ? '已登记基线' : '会话切换 → 重置基线'}：` +
                 `${label(activeRow) || conv}（${snap.msgs.length} 条消息 / ${snap.convs.length} 个会话）`);
        continue;
      }

      /* ---- 1) 消息级 ---- */
      const seen = this.msgSeen.get(id) || new Set();
      const { fresh, bulk } = diffMessages(seen, snap.msgs);
      if (bulk) {
        primeMessages(seen, snap.msgs);
        if (this.db) {
          store.saveMessages(this.db, {
            convKey: convId, convName: activeRow ? activeRow.name : conv,
            msgs: snap.msgs, source: entry.page.title
          });
        }
        this.log(`[${stamp()}] ℹ️ ${conv} 批量刷新 ${fresh.length} 条，已重置基线`);
      } else {
        if (this.db && fresh.length) {
          store.saveMessages(this.db, {
            convKey: convId, convName: activeRow ? activeRow.name : conv,
            msgs: fresh, source: entry.page.title
          });
        }
        for (const m of fresh) {
          seen.add(`${m.mine ? 'O' : 'I'}|${m.time}|${m.text}`);
          this.stats[m.mine ? 'outbound' : 'inbound']++;
          const ev = this.emit({
            type: m.mine ? 'outbound' : 'inbound',
            conv: activeRow ? activeRow.name : conv,
            convId,
            peer: activeRow ? activeRow.peer : '',
            isSelf: activeRow ? !!activeRow.isSelf : false,
            sender: m.sender, msgTime: m.time, text: m.text,
            target: entry.page.title
          });
          this.log(m.mine
            ? `[${stamp()}] ⬅️ 我方 · ${conv}：${m.text.slice(0, 60)}`
            : `[${stamp()}] ➡️ 对方 · ${conv}：${m.sender} — ${m.text.slice(0, 60)}`);
          void ev;

          /* 自动回复：只对「对方发来的」消息触发。
             注意：这里只处理当前打开会话的消息（消息级事件天然满足），
             其它会话的动静走 conv-update，不会误发到别的会话。 */
          if (!m.mine && this.replyEngine) {
            try {
              await this.replyEngine.handleInbound({
                convKey: convId,
                convName: activeRow ? activeRow.name : conv,
                peer: activeRow ? activeRow.peer : '',
                text: m.text
              });
            } catch (e) {
              this.log(`[${stamp()}] ⚠️ 自动回复异常：${e.message}`);
            }
          }
        }
      }
      this.msgSeen.set(id, seen);

      /* ---- 2) 会话级（其它会话） ---- */
      const prevMap = this.convSeen.get(id) || new Map();
      const { next, changed } = diffConversations(prevMap, snap.convs);
      for (const item of changed) {
        const c = item.sample;
        this.stats.convAlerts++;
        this.emit({
          type: 'conv-update', conv: item.name, msgTime: c.time,
          desc: c.desc, unread: c.unread, target: entry.page.title
        });
        this.log(`[${stamp()}] 🔔 其他会话有动静 · ${item.name}` +
                 `${c.unread ? ' [未读' + c.unread + ']' : ''}：${c.desc.slice(0, 50)}`);
      }
      this.convSeen.set(id, next);
    }
  }

  async run(opts = {}) {
    const duration = Number(opts.duration) || 0;   // 0 = 一直跑
    let stopping = false;
    const bye = () => { if (!stopping) { stopping = true; console.log('\n收到停止信号……'); } };
    process.on('SIGINT', bye);
    process.on('SIGTERM', bye);

    const t0 = Date.now();
    while (!stopping) {
      const started = Date.now();
      try {
        /* 单次巡检加硬超时：任何一环挂住都不会拖死整个循环 */
        await withTimeout(this.tick(), this.tickTimeoutMs,
                          `单次巡检超时(${this.tickTimeoutMs}ms)，可能有连接卡住`);
        this.stats.ticks++;
        this.lastTickAt = Date.now();
      } catch (e) {
        this.stats.errors++;
        console.log(`[${stamp()}] ⚠️ 轮询异常：${e.message}`);
        this.dropSessions('异常后自愈');
      }

      /* 心跳：让「频率」可观测，也便于判断进程是否还活着 */
      if (Date.now() - this.lastBeat > this.heartbeatMs) {
        this.lastBeat = Date.now();
        const mins = ((Date.now() - this.startedAt) / 60000).toFixed(0);
        const events = this.stats.inbound + this.stats.outbound + this.stats.convAlerts;
        console.log(`[${stamp()}] 💓 心跳：运行 ${mins} 分钟 | 轮询 ${this.stats.ticks} 次 | ` +
                    `接入窗口 ${this.sessions.size} 个 | 累计事件 ${events} 条 | 重连 ${this.stats.reconnects} 次`);
        if (this.db) store.saveHeartbeat(this.db, Date.now(), this.stats, this.sessions.size);
      }

      /* 卡顿告警：距上次成功巡检过久 */
      const gap = Date.now() - this.lastTickAt;
      if (gap > this.interval * 5) {
        console.log(`[${stamp()}] ⚠️ 距上次成功巡检已 ${(gap / 1000).toFixed(0)}s（阈值 ${this.interval * 5 / 1000}s）`);
      }

      /* 定时刷新网页（默认关闭；0 表示不刷新） */
      if (this.refreshMin > 0 && Date.now() - this.lastRefreshAt >= this.refreshMin * 60000) {
        this.lastRefreshAt = Date.now();
        try { await this.refreshPages(); } catch (e) { console.log(`[${stamp()}] ⚠️ 刷新异常：${e.message}`); }
      }

      if (duration > 0 && (Date.now() - t0) / 1000 >= duration) break;
      await sleep(Math.max(200, this.interval - (Date.now() - started)));
    }
    this.summary();
  }

  summary() {
    const mins = ((Date.now() - this.startedAt) / 60000).toFixed(1);
    const since = ((Date.now() - this.lastTickAt) / 1000).toFixed(0);
    console.log('\n' + '='.repeat(58));
    console.log(`监听到 对方 ${this.stats.inbound} 条 / 我方 ${this.stats.outbound} 条`);
    console.log(`其他会话提醒 ${this.stats.convAlerts} 次 | 轮询 ${this.stats.ticks} 次 | 重连 ${this.stats.reconnects} 次 | 失败 ${this.stats.errors} 次`);
    console.log(`运行 ${mins} 分钟 | 距上次成功巡检 ${since}s | 日志：${this.out}`);
    console.log('='.repeat(58));
    return this.stats;
  }

  close() {
    for (const [, entry] of this.sessions) entry.session.close();
    this.sessions.clear();
    if (this.db) {
      try { this.db.close(); } catch { /* ignore */ }
      this.db = null;
    }
  }

  /* 丢弃全部会话，让下一轮重新接入（自愈用） */
  dropSessions(reason) {
    for (const [, entry] of this.sessions) {
      try { entry.session.close(); } catch { /* ignore */ }
    }
    this.sessions.clear();
    this.msgSeen.clear();
    this.convSeen.clear();
    if (reason) this.log(`[${stamp()}] ♻️ ${reason} → 已丢弃全部连接，将重新接入`);
  }

  /* 定时刷新所有聊天页面，并做刷新后的恢复 */
  async refreshPages() {
    let n = 0;
    for (const [, entry] of this.sessions) {
      try {
        await entry.session.send('Page.enable');
        await entry.session.send('Page.reload', { ignoreCache: false });
        n++;
      } catch (e) {
        this.log(`[${stamp()}] ⚠️ 刷新失败：${e.message}`);
      }
    }
    if (!n) return;
    this.log(`[${stamp()}] 🔄 已刷新 ${n} 个聊天页面（每 ${this.refreshMin} 分钟一次）`);
    await sleep(5000);
    for (const [, entry] of this.sessions) {
      try {
        await ensureHelpers(entry.session);
        /* 刷新后常停在"AI询"标签（看不到普通会话），切回"全部" */
        await evaluate(entry.session, `(() => __QN.ensureAllTab())()`);
      } catch { /* 页面重建期忽略 */ }
      /* 当前会话已丢失 → 让下一轮重新登记基线，避免把历史当成新消息 */
      entry.conv = null;
    }
    this.log(`[${stamp()}] ✅ 刷新后恢复完成（已切回"全部"标签，基线将在下一轮重建）`);
  }
}

export async function runMonitor(opts = {}) {
  const mon = new EventMonitor(opts);
  console.log('=== 1688 消息常驻监听 ===');
  console.log(`轮询间隔 ${mon.interval}ms | 日志 ${mon.out}\n`);

  /* 自动回复（可选）：给了规则文件才启用 */
  if (opts.rules || opts.rulesFile) {
    let rules = opts.rules || [];
    let guards = { ...(opts.replyGuards || {}) };
    if (opts.rulesFile) {
      const loaded = replyBlock.loadRulesFile(opts.rulesFile);
      rules = loaded.rules;
      guards = { ...loaded.guards, ...guards };     // 命令行显式参数优先于文件
    }
    if (opts.replyMode === 'send') guards.dryRun = false;
    else if (opts.replyMode === 'draft') { guards.dryRun = false; guards.draftOnly = true; }

    mon.replyEngine = new replyBlock.ReplyEngine({
      rules, guards,
      db: opts.db === false ? false : undefined,
      dbFile: opts.dbFile
    });
    const mode = guards.dryRun ? '演练（不发）' : (guards.draftOnly ? '仅填草稿（待人工发送）' : '★真实发送★');
    console.log(`自动回复：${rules.length} 条规则 | 模式：${mode}`);
  }

  if (opts.once) { await mon.tick(); mon.summary(); mon.close(); return; }
  try {
    await mon.run(opts);
  } finally {
    /* 必须关闭所有 WebSocket：否则事件循环被挂住，进程不会退出
       （实测 --duration 20 跑完仍常驻，把调用方一起拖住）。 */
    mon.close();
    if (mon.replyEngine) mon.replyEngine.close();
  }
  return mon.stats;
}
