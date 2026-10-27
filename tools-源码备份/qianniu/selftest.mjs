/* =====================================================================
 * 功能区块自测
 *
 *   node im.mjs selftest        或        node selftest.mjs
 *
 * 逐个区块跑真实检查（对着活着的聊天页），不发送任何消息：
 *   session        连接 CDP 并定位核心聊天文档
 *   messages       读取消息、方向判定
 *   conversations  读取会话列表
 *   input          填入草稿 → 校验 → 清空（不发送）
 *   phrases        点开快捷短语 → 选中 → 校验填入 → 清空（不发送）
 *   logstore       事件落盘与读回（用独立测试文件，不污染正式日志）
 *   monitor        单次巡检（只登记基线，不产生事件）
 * ===================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { session, messages, conversations, input, phrases, monitor, logstore, db, reply, imageSearch } from './blocks/index.mjs';

const MARK = '__QN_SELFTEST__';
const results = [];

function record(block, what, pass, detail) {
  results.push({ 区块: block, 检查项: what, 结果: pass ? '✅ 通过' : '❌ 失败', 说明: String(detail).slice(0, 70) });
}

async function check(block, what, fn) {
  try {
    const detail = await fn();
    record(block, what, true, detail === undefined ? 'OK' : detail);
    return true;
  } catch (e) {
    record(block, what, false, e.message);
    return false;
  }
}

export async function runSelfTest() {
  console.log('=== 功能区块自测（只读 / 可回滚，不发送任何消息）===\n');

  /* ---- 1. session ---- */
  await check('session', '连接 CDP 并定位核心文档', async () => {
    return session.withSession(async (s, page) => {
      const info = await session.evaluate(s, `(() => {
        const d = __QN.core();
        return d ? { url: d.location.href, title: d.title, docs: __QN.docs().length } : null;
      })()`);
      if (!info) throw new Error('没找到核心聊天文档（聊天窗口没开？）');
      /* 顺带守住一类 bug：注入字符串里的正则转义写漏，
         会导致 cookie 解析失败、认不出本账号 id（踩过一次）。 */
      const selfIds = await session.evaluate(s, `(() => __QN.selfIds())()`);
      if (!selfIds || !selfIds.length) throw new Error('认不出本账号 id（cookie 解析失败）');
      /* 守住「聊天页身份」：attach 到的必须是那个聊天页，别操作错页面 */
      if (!session.isChatPage(page && page.url)) {
        throw new Error('attach 到的不是聊天页：' + (page && page.url));
      }
      return `聊天页确认 ✓ | 同源文档 ${info.docs} 个；本账号 id ${selfIds.join(' / ')}`;
    });
  });

  /* ---- 2. messages ---- */
  await check('messages', '读取消息 + 方向判定', async () => {
    const msgs = await messages.readMessages();
    const sum = messages.summarize(msgs);
    const bad = msgs.find((m) => m.kind !== 'msg' && m.kind !== 'system');
    if (bad) throw new Error('存在结构异常的消息条目');
    if (!msgs.length) throw new Error('一条消息都没读到（当前会话可能是空的）');
    return `共 ${sum.total} 条 = 对方 ${sum.inbound} / 我方 ${sum.outbound} / 模板 ${sum.system}`;
  });

  /* ---- 3. conversations ---- */
  await check('conversations', '读取会话列表', async () => {
    const convs = await conversations.readConversations();
    if (!convs.length) throw new Error('会话列表为空');
    const noName = convs.filter((c) => !c.name);
    if (noName.length) throw new Error(`${noName.length} 个会话缺少名称`);
    /* 主键必须唯一：显示名会重名（playworld152:it 与 playworld152:cqy），
       所以主键必须用会话 id，不能退回名称。 */
    const keys = convs.map(conversations.convId);
    const uniq = new Set(keys);
    if (uniq.size !== keys.length) {
      throw new Error(`会话主键不唯一：${keys.length} 条会话只有 ${uniq.size} 个唯一键`);
    }
    const s = conversations.summarize(convs);
    const fp = conversations.fingerprint(convs);
    return `${s.total} 个会话（未读 ${s.unread}，本账号自己 ${s.self}）| 唯一主键 ${uniq.size} 个`;
  });

  /* ---- 4. input ---- */
  await check('input', '填入草稿 → 校验 → 清空', async () => {
    await input.draft(MARK);
    const got = await input.readDraft();
    if (got !== MARK) throw new Error(`填入校验不符：期望 ${MARK}，实到 ${got}`);
    const left = await input.clear();
    if (left) throw new Error(`清空失败，残留：${left}`);
    return '填入与清空均正常，输入框已还原为空';
  });

  /* ---- 5. phrases ---- */
  let phraseCount = 0;
  await check('phrases', '打开弹窗 → 选中 → 填入 → 清空', async () => {
    /* 先确认聊天窗口开着会话：没开的话是环境未就绪，不是功能问题，
       这种情况标记为"跳过"，避免误判成故障。 */
    const state = await session.withSession((s) => session.evaluate(s, `(() => ({
      hasInput: !!__QN.input(),
      activeConv: __QN.activeConvId()
    }))()`));
    if (!state.hasInput || !state.activeConv) {
      return '聊天窗口未打开任何会话 → 跳过（先在左侧点开一个会话再复查）';
    }
    const items = await phrases.list();
    if (!items || !items.length) throw new Error('短语列表为空或弹窗没打开');
    phraseCount = items.length;
    const picked = await phrases.use(0);
    if (picked.draft !== picked.text) {
      throw new Error(`选中后输入框内容不符：期望 ${picked.text}，实到 ${picked.draft}`);
    }
    if (picked.dialogOpen) throw new Error('选中后弹窗没有自动关闭');
    const left = await input.clear();
    if (left) throw new Error(`清理失败，残留：${left}`);
    return `短语 ${items.length} 条；选中「${picked.text}」成功填入并已清空`;
  });

  /* ---- 6. logstore ---- */
  await check('logstore', '事件落盘与读回', async () => {
    const f = path.join(logstore.LOG_DIR, 'selftest-events.jsonl');
    const before = logstore.readEvents(10, f).length;
    logstore.appendEvent(logstore.makeEvent('selftest', { note: MARK }), f);
    const rows = logstore.readEvents(10, f);
    if (rows.length !== before + 1) throw new Error('写入后读回条数不对');
    const last = rows[rows.length - 1];
    if (last.type !== 'selftest' || last.note !== MARK) throw new Error('读回内容不匹配');
    const s = logstore.summarizeEvents(rows);
    fs.unlinkSync(f);   // 测试文件用完即删
    return `路径 ${path.basename(f)}；写入/读回/汇总(总 ${s.total}) 正常`;
  });

  /* ---- 7. monitor ---- */
  await check('monitor', '单次巡检（仅登记基线）', async () => {
    const mon = new monitor.EventMonitor({
      quiet: true,
      db: false,                                   // 自测不写正式库
      out: path.join(logstore.LOG_DIR, 'selftest-events.jsonl')
    });
    await mon.tick();
    const attached = mon.sessions.size;
    mon.close();
    const f = path.join(logstore.LOG_DIR, 'selftest-events.jsonl');
    if (fs.existsSync(f)) fs.unlinkSync(f);
    if (!attached) throw new Error('没有接入任何聊天窗口');
    return `接入 ${attached} 个窗口，首轮基线登记完成（未产生事件）`;
  });

  /* ---- 8. db（落库）---- */
  await check('db', '建表 → 写入 → 去重 → 查询 → 导出', async () => {
    const d = db.openDb(':memory:');
    try {
      const key = 'TEST.1-PEER.1#11152@cnalichn';
      db.saveConversations(d, [{
        key, name: '测试联系人', peer: 'PEER', isSelf: false,
        cidType: '11152', site: 'cnalichn', desc: '你好', time: '12:00:00', unread: ''
      }]);
      const msgs = [
        { kind: 'msg', mine: false, sender: '测试联系人', time: '12:00:00', text: '你好' },
        { kind: 'msg', mine: true, sender: 'me', time: '12:00:05', text: '在的' },
        { kind: 'system', mine: false, sender: '', time: '', text: '模板消息不应入消息表' }
      ];
      const first = db.saveMessages(d, { convKey: key, convName: '测试联系人', msgs, source: 'selftest' });
      const again = db.saveMessages(d, { convKey: key, convName: '测试联系人', msgs, source: 'selftest' });
      if (first !== 2) throw new Error(`首次应写 2 条（模板消息排除），实际 ${first}`);
      if (again !== 0) throw new Error(`重复写入未去重，又写入 ${again} 条`);

      db.saveEvent(d, logstore.makeEvent('inbound', {
        convId: key, conv: '测试联系人', text: '你好', sender: '测试联系人'
      }));
      const s = db.stats(d);
      if (s.contacts !== 1 || s.messages !== 2 || s.events !== 1) {
        throw new Error('统计不符：' + JSON.stringify(s));
      }
      if (!db.parseUiTime('12:00:00')) throw new Error('界面时间解析失败');

      const f = path.join(logstore.LOG_DIR, 'selftest-export.csv');
      const rows = db.exportCsv(d, f);
      if (rows !== 2) throw new Error(`CSV 应导出 2 行，实际 ${rows}`);
      fs.unlinkSync(f);
      return `联系人 1 / 消息 2（去重生效）/ 事件 1 / CSV 2 行`;
    } finally {
      d.close();
    }
  });

  /* ---- 9. reply（回复：规则匹配 + 护栏，演练模式不发送）---- */
  await check('reply', '规则匹配 / 模板渲染 / 护栏拦截（演练不发送）', async () => {
    const engine = new reply.ReplyEngine({
      rules: [
        { name: '问价', match: { keywordsAny: ['价格', '多少钱'] }, reply: { text: '报价：{{contact}} 问的是 {{text}}' } },
        { name: '问量', match: { keywordsAll: ['起批', '多少'] }, reply: { text: '请告知起订量' } }
      ],
      guards: { dryRun: true, minIntervalMs: 0, maxPerHour: 9999, maxPerConvPerHour: 9999, dedupeWindowMs: 0 },
      db: false
    });

    if (!reply.matchRule('这个价格多少', engine.rules, {})) throw new Error('关键词规则未命中');
    if (reply.matchRule('你好在吗', engine.rules, {})) throw new Error('不该命中的规则被命中');
    const tpl = reply.renderTemplate('报价：{{contact}} 问的是 {{text}}', { contact: '张三', text: '价格' });
    if (tpl !== '报价：张三 问的是 价格') throw new Error('模板渲染错误：' + tpl);

    /* 演练模式：只走流程，不开会话、不发送 */
    const r1 = await engine.handleInbound({ convKey: 'C1', convName: '张三', text: '价格多少' });
    if (r1.status !== 'dry-run') throw new Error('演练模式应返回 dry-run，实际 ' + r1.status);
    const r2 = await engine.handleInbound({ convKey: 'C1', convName: '张三', text: '随便聊聊' });
    if (r2.status !== 'skipped') throw new Error('无规则时应 skipped，实际 ' + r2.status);

    /* 间隔护栏 */
    engine.guards.minIntervalMs = 8000;
    engine.lastSentAt.set('C1', Date.now());
    const gate = engine.check('C1', '新消息');
    if (gate.ok) throw new Error('最小间隔护栏未生效');

    /* 去重护栏 */
    engine.guards.minIntervalMs = 0;
    engine.guards.dedupeWindowMs = 60000;
    engine.replied.set('C2|同一条', Date.now());
    const gate2 = engine.check('C2', '同一条');
    if (gate2.ok) throw new Error('去重护栏未生效');

    engine.close();
    return `命中/未命中/模板/演练/间隔/去重 六项均正确（未发送任何消息）`;
  });

  /* ---- 10. imageSearch（以图搜图）---- */
  await check('imageSearch', '搜索页按钮 + 结果页卡片解析', async () => {
    const { listPages } = await import('./cdp-lib.mjs');
    const pages = await listPages();
    const searchPage = pages.find((p) => (p.url || '').includes(imageSearch.SEARCH_MATCH));
    const resultPage = pages.find((p) => (p.url || '').includes('pc-image-search'));
    const notes = [];

    if (searchPage) {
      const ok = await session.withSession(
        (s) => session.evaluate(s, `!!document.querySelector(${JSON.stringify(imageSearch.SEARCH_BTN_SELECTOR)})`),
        { match: imageSearch.SEARCH_MATCH }
      );
      if (!ok) throw new Error('搜索按钮选择器失效，页面可能改版：' + imageSearch.SEARCH_BTN_SELECTOR);
      const fileInput = await session.withSession(
        (s) => session.evaluate(s, `!!document.querySelector(${JSON.stringify(imageSearch.IMAGE_FILE_INPUT)})`),
        { match: imageSearch.SEARCH_MATCH }
      );
      notes.push('搜索按钮 ✓' + (fileInput ? ' / 上传input ✓' : ' / 无上传input'));
    } else {
      notes.push('搜索页未打开（跳过按钮检查）');
    }

    if (resultPage) {
      const r = await imageSearch.readResults({ limit: 3 });
      if (!r.cards.length) throw new Error('结果页卡片解析返回 0 条（结构可能改版）');
      notes.push(`结果页 ${r.total} 张卡片，解析出 ${r.cards.length} 条（含 offerId ${r.cards[0].offerId || '无'}）`);
    } else {
      notes.push('结果页未打开（跳过卡片解析）');
    }
    return notes.join(' | ');
  });

  /* ---- 汇总 ---- */
  console.log('逐区块结果：\n');
  console.table(results);
  const pass = results.filter((r) => r.结果.startsWith('✅')).length;
  console.log(`\n通过 ${pass}/${results.length} 项` +
    (pass === results.length ? '　🎉 所有功能区块正常' : '　⚠️ 有失败项，见上表'));
  console.log('\n说明：本自测只在输入框里写了内容并清空，没有发送任何消息；' +
    '短语弹窗会被打开一次以验证选中链路。');
  return results;
}

/* 直接运行时才设置退出码 */
if (process.argv[1] && process.argv[1].endsWith('selftest.mjs')) {
  runSelfTest()
    .then((rows) => {
      const failed = rows.filter((r) => r.结果.startsWith('❌')).length;
      process.exitCode = failed ? 1 : 0;
    })
    .catch((e) => { console.error('❌ 自测异常：' + e.message); process.exitCode = 1; });
}
