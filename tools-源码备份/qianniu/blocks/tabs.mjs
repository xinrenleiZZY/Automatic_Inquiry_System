/* =====================================================================
 * 区块：标签页治理（Tabs）
 * [功能区块 · v0.1 · 状态：待集成到系统 —— 见 INTEGRATION.md]
 *
 * 规则：搜索页 / 搜索结果页 / 旺旺聊天 各只保留一个，防止标签越开越多导致卡顿。
 *       同类的多余标签会被关掉，每个类别保留"最新"的那个。
 *
 * 对外接口：
 *   classifyTab(url)                      -> 'search' | 'results' | 'chat' | 'other'
 *   listTabs()                            -> 分类后的标签清单
 *   enforceSingleTabs(opts)               -> 每类只留一个；返回关闭明细
 * ===================================================================== */

import { listPages, browserSession } from '../cdp-lib.mjs';

export const KIND = { search: '搜索页', results: '搜索结果页', chat: '旺旺聊天', other: '其它' };

export function classifyTab(url) {
  let p = '';
  try { p = new URL(url).pathname; } catch { p = url || ''; }
  if (p.includes('/def_cbu_web_im/')) return 'chat';
  if (p.includes('/pc-image-search')) return 'results';
  if (p.includes('/selloffer/offer_search.htm')) return 'search';
  return 'other';
}

export async function listTabs() {
  const pages = await listPages();
  return pages.map((p) => ({
    targetId: p.id,
    kind: classifyTab(p.url),
    title: p.title,
    url: p.url,
    imageId: ((p.url || '').match(/imageId=(\d+)/) || [])[1] || '',
    chatUid: (() => {
      /* 聊天页 URL 有两种参数形态：uid=（联系链接）与 touid=（正式会话） */
      const m = (p.url || '').match(/[?&](?:touid|uid)=([^&#]+)/);
      if (!m) return '';
      try { return decodeURIComponent(m[1]); } catch { return m[1]; }
    })()
  }));
}

/* 每类只保留一个。keep 可以显式指定要保留的 targetId / 结果页 imageId。 */
export async function enforceSingleTabs(opts = {}) {
  const tabs = await listTabs();
  const groups = {};
  for (const t of tabs) {
    if (t.kind === 'other' && opts.skipOther !== false) continue;   // 其它页面不动
    (groups[t.kind] = groups[t.kind] || []).push(t);
  }

  const closed = [];
  const kept = [];
  const browser = await browserSession();
  try {
    for (const [kind, list] of Object.entries(groups)) {
      if (list.length <= 1) { kept.push(...list); continue; }

      /* 选保留者：显式指定 > 匹配 imageId/uid > 列表第一个 */
      let keeper = null;
      const explicitId = opts.keepTargetId && list.find((t) => t.targetId === opts.keepTargetId);
      if (explicitId) keeper = explicitId;
      if (!keeper && kind === 'results' && opts.keepImageId) {
        keeper = list.find((t) => t.imageId === String(opts.keepImageId));
      }
      if (!keeper && kind === 'chat' && opts.keepChatUid) {
        keeper = list.find((t) => t.chatUid === opts.keepChatUid);
      }
      if (!keeper) keeper = list[0];

      kept.push(keeper);
      for (const t of list) {
        if (t.targetId === keeper.targetId) continue;
        try {
          await browser.send('Target.closeTarget', { targetId: t.targetId });
          closed.push({ kind, targetId: t.targetId, title: (t.title || '').slice(0, 20) });
        } catch (e) {
          closed.push({ kind, targetId: t.targetId, error: e.message });
        }
      }
    }
  } finally { browser.close(); }

  return { kept, closed };
}

/* 打印一行概要，便于在流程里提示 */
export function summarizeTabs(tabs) {
  const c = { search: 0, results: 0, chat: 0, other: 0 };
  tabs.forEach((t) => { c[t.kind]++; });
  return `搜索页 ${c.search} / 结果页 ${c.results} / 聊天 ${c.chat} / 其它 ${c.other}`;
}
