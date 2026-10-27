/* =====================================================================
 * 区块：多任务调度器（Scheduler）
 * [功能区块 · v0.1 · 状态：待集成到系统 —— 见 INTEGRATION.md]
 *
 * 目标：**一个终端、一个进程，同时推进多个比价任务**（不同图片 + 不同短语）。
 *
 * 怎么做到不冲突：浏览器是独占资源（发送/读消息都要求"当前打开的就是那个会话"），
 * 所以不做真并行，而是**轮流推进每个任务的一小步**：
 *
 *   轮1: 任务A 搜图    → 任务B 联系2家  → 任务C 解析2个会话
 *   轮2: 任务A 联系2家 → 任务B 解析2个会话 → 任务C 联系2家
 *   ...
 *
 * 每步只有几秒，所以业务上多个任务在同时推进；任何时刻只有一个流程在动浏览器，
 * 加上进程锁（lock.mjs）兜底，绝不会互相抢窗口。
 *
 * 每个任务按 stage 自动分派：
 *   created   → 搜图 + 页面价入库
 *   searched  → 联系下一批商家（跳过已联系的），达到目标数后转 contacted
 *   contacted → 解析新回复 + 生成追问（每次只处理 slice 个会话）
 *
 * 对外接口：
 *   runScheduler({ roundMs, slice, perTask, mode, once, duration, dry })
 * ===================================================================== */

import * as store from './db.mjs';
import * as library from './library.mjs';
import * as campaignBlock from './campaign.mjs';
import * as outreach from './outreach.mjs';
import { withBrowserLock } from './lock.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

/* 推进单个任务一小步；返回这一步做了什么 */
export async function advanceCampaign(db, c, opts = {}) {
  const slice = Number(opts.slice) || 2;
  const perTask = Number(opts.perTask) || 10;
  const phrase = c.phrase_id ? library.getPhrase(library.DEFAULT_LIBRARY, c.phrase_id) : null;
  const phraseForSend = phrase ? { ...phrase, image: c.image_file } : null;

  /* ① 还没搜图 → 搜图 + 页面价入库 */
  if (!c.image_id) {
    console.log(`[${stamp()}] ▶ 任务${c.id}《${c.name}》阶段①搜图`);
    const r = await campaignBlock.launchCampaign(db, c, { yes: false, limit: 0 });
    return { stage: 'searched', detail: `imageId=${r.imageId}` };
  }

  /* ② 已搜图、商家还没凑够 → 联系下一批（skipSent 自动跳过已联系的） */
  const contacted = store.campaignContacts(db, c.id).length;
  if (contacted < perTask) {
    if (opts.dry) return { stage: 'searched', detail: `演练：还需联系 ${perTask - contacted} 家（未执行）` };
    const want = Math.min(slice, perTask - contacted);
    console.log(`[${stamp()}] ▶ 任务${c.id}《${c.name}》阶段②联系 ${want} 家（已联系 ${contacted}/${perTask}）`);
    const r = await outreach.contactTopSellers({
      limit: want, keep: 1, match: c.image_id,
      imageId: c.image_id, imageFile: c.image_file,
      phrase: phraseForSend, order: opts.order || 'text-first', baseDir: library.BASE_DIR,
      campaignId: c.id, skipSent: true, gapMs: Number(opts.gapMs) || 3000
    });
    const now = store.campaignContacts(db, c.id).length;
    if (now >= perTask) store.updateCampaign(db, c.id, { stage: 'contacted' });
    return { stage: now >= perTask ? 'contacted' : 'searched',
             detail: `本次联系 ${r.opened} 家，累计 ${now}/${perTask}` };
  }

  /* ③ 商家够了 → 解析新回复（每次只处理 slice 个会话） */
  console.log(`[${stamp()}] ▶ 任务${c.id}《${c.name}》阶段③解析回复`);
  const r = await campaignBlock.collectCampaign(db, c, { mode: opts.mode || 'dry', slice });
  return { stage: 'contacted',
           detail: `处理 ${r.processed}/${r.matched || 0} 个会话 ｜ 追问 ${r.asked || 0} ｜ 放弃 ${r.dropped || 0}` +
                   (opts.mode === 'send' ? ` ｜ 已发 ${r.sent || 0}` : '') };
}

export async function runScheduler(opts = {}) {
  const roundMs = Number(opts.roundMs) || 180000;   // 每轮间隔，默认 3 分钟
  const once = !!opts.once;
  const dbFile = opts.dbFile || store.DB_PATH;

  console.log('=== 多任务调度器 ===');
  console.log(`每轮间隔 ${Math.round(roundMs / 1000)}s ｜ 每次推进 ${opts.slice || 2} 步 ｜ 每任务目标 ${opts.perTask || 10} 家商家`);
  console.log(`模式：${opts.dry ? '演练（只搜图）' : (opts.mode === 'send' ? '★真实发送★' : opts.mode === 'draft' ? '仅填草稿' : '只解析不发送')}`);
  console.log('（单进程轮流推进所有 running 任务；浏览器操作串行，绝不抢窗口）\n');

  let round = 0;
  const t0 = Date.now();
  for (;;) {
    round++;
    const db = store.openDb(dbFile);
    let campaigns = [];
    try {
      campaigns = store.listCampaigns(db, 50).filter((c) => c.status === 'running');

      if (!campaigns.length) {
        console.log(`[${stamp()}] 轮${round}：没有 running 状态的任务（用 campaign new 建任务）`);
      } else {
        console.log(`[${stamp()}] 轮${round}：${campaigns.length} 个任务待推进`);
        /* 最久没推进的排前面：保证各任务均衡推进 */
        campaigns.sort((a, b) => (a.updated_at || 0) - (b.updated_at || 0));

        for (const c of campaigns) {
          try {
            const r = await advanceCampaign(db, c, opts);
            console.log(`          → 任务${c.id} ${r.stage}：${r.detail}`);
          } catch (e) {
            console.log(`          ⚠️ 任务${c.id} 推进失败：${e.message}`);
          }
          await sleep(Number(opts.gapThens) || 1500);   // 任务之间喘口气
        }
      }
    } finally { db.close(); }

    if (once) break;
    if (opts.duration && (Date.now() - t0) / 1000 >= opts.duration) break;
    console.log(`[${stamp()}] 本轮结束，休息 ${Math.round(roundMs / 1000)}s…\n`);
    await sleep(roundMs);
  }

  console.log(`\n调度器结束：共 ${round} 轮，运行 ${Math.round((Date.now() - t0) / 1000)}s`);
}
