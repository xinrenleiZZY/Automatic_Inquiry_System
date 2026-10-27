#!/usr/bin/env node
/* =====================================================================
 * 零依赖 CDP 驱动 —— 通过 Chrome 调试端口操作 work.1688.com
 *
 * 依赖：Node 22+（全局 WebSocket / fetch）。不需要 npm install。
 * 前置：Chrome 已用 --remote-debugging-port=9222 启动（本目录的 start-chrome.ps1）
 *
 * 命令：
 *   node cdp.mjs list                          列出所有页面 target
 *   node cdp.mjs frames [url关键字]             看页面里的 frame 结构（含 iframe）
 *   node cdp.mjs text   [url关键字]             粗看页面：标题/URL/关键词命中
 *   node cdp.mjs eval   <url关键字> <脚本文件>   在页面里执行 JS 文件
 *   node cdp.mjs code   <url关键字> "<表达式>"   在页面里执行一行 JS
 *   node cdp.mjs type   <url关键字> <选择器> <文本>   真实输入（trusted）
 *   node cdp.mjs press  <url关键字> Enter|Tab|...     真实按键（trusted）
 *   node cdp.mjs click  <url关键字> <选择器>          真实点击（trusted）
 *   node cdp.mjs net    <url关键字> [秒数] [过滤词]   抓网络请求（终于能看到真正的发送接口）
 *   node cdp.mjs shot   <url关键字> <输出.png>        截图存档
 *   node cdp.mjs open   <url>                         在调试实例里新开一个标签页
 *
 * url关键字传 - 表示取第一个页面，或者传片段如 work.1688 / chat
 * ===================================================================== */

import { BASE, listPages, pickPage, Session, attach, evaluate, KEYMAP } from './cdp-lib.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];

/* ---------------- 命令实现 ---------------- */

async function cmdList() {
  const pages = await listPages();
  console.log(`共 ${pages.length} 个 page target：`);
  pages.forEach((p, i) => {
    console.log(`  [${i}] ${p.title || '(无标题)'}`);
    console.log(`      ${p.url}`);
  });
}

async function cmdFrames(match) {
  const page = await pickPage(match);
  const s = await attach(page);
  try {
    await s.send('Page.enable');
    const tree = await s.send('Page.getFrameTree');
    const rows = [];
    (function walk(node, depth) {
      rows.push({
        层级: '  '.repeat(depth) + (depth ? '└ ' : '') + (node.frame.name || '(主框架)'),
        URL: (node.frame.url || '').slice(0, 110)
      });
      (node.childFrames || []).forEach((c) => walk(c, depth + 1));
    })(tree.frameTree, 0);
    console.table(rows);
  } finally { s.close(); }
}

async function cmdText(match) {
  const page = await pickPage(match);
  const s = await attach(page);
  try {
    const info = await evaluate(s, `(() => {
      const kw = ['发送','未读','消息','接待','买家','客户','输入','回复'];
      const hits = [];
      document.querySelectorAll('*').forEach(el => {
        if (el.children.length) return;
        const t = (el.textContent || '').trim();
        if (!t || t.length > 20) return;
        if (kw.some(k => t.includes(k))) {
          const r = el.getBoundingClientRect();
          hits.push({ text: t, tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0,40),
                      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
        }
      });
      const editables = [];
      document.querySelectorAll('[contenteditable="true"], textarea, input').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width < 5 || r.height < 5) return;
        editables.push({ tag: el.tagName.toLowerCase(), ph: el.getAttribute('placeholder') || '',
                         x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
      });
      return { out: { url: location.href, title: document.title, nodes: document.querySelectorAll('*').length,
                      iframes: document.querySelectorAll('iframe').length }, hits: hits.slice(0, 40), editables };
    })()`);
    console.log('页面:', info.out.title, '|', info.out.url);
    console.log(`节点 ${info.out.nodes} 个，iframe ${info.out.iframes} 个`);
    console.log('%c【可输入元素】', 'color:#0a7;font-weight:bold');
    console.table(info.editables);
    console.log('【关键词命中】');
    console.table(info.hits);
  } finally { s.close(); }
}

async function cmdEval(match, file) {
  if (!file) throw new Error('用法: eval <url关键字> <脚本文件>');
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(file, 'utf8');
  const page = await pickPage(match);
  const s = await attach(page);
  try {
    const out = await evaluate(s, code);
    console.log(JSON.stringify(out ?? null, null, 2));
  } finally { s.close(); }
}

async function cmdCode(match, expression) {
  if (!expression) throw new Error('用法: code <url关键字> "<表达式>"');
  const page = await pickPage(match);
  const s = await attach(page);
  try {
    const out = await evaluate(s, expression);
    console.log(JSON.stringify(out ?? null, null, 2));
  } finally { s.close(); }
}

async function cmdType(match, selector, text) {
  const page = await pickPage(match);
  const s = await attach(page);
  try {
    const r = await evaluate(s, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'NOT_FOUND';
      el.focus();
      return el.tagName + (el.isContentEditable ? ':contenteditable' : '');
    })()`);
    if (r === 'NOT_FOUND') throw new Error('选择器没找到元素: ' + selector);
    await s.send('Input.insertText', { text });
    console.log(`已在 <${r}> 中放入文本（trusted 输入事件）：${JSON.stringify(text)}`);
  } finally { s.close(); }
}

async function cmdPress(match, keyName) {
  const k = KEYMAP[keyName] || { key: keyName, code: keyName };
  const page = await pickPage(match);
  const s = await attach(page);
  try {
    await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
    console.log(`已按键: ${keyName}`);
  } finally { s.close(); }
}

async function cmdClick(match, selector) {
  const page = await pickPage(match);
  const s = await attach(page);
  try {
    const box = await evaluate(s, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
    })()`);
    if (!box) throw new Error('选择器没找到元素: ' + selector);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await s.send('Input.dispatchMouseEvent', {
        type, x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0
      });
    }
    console.log(`已真实点击 (${Math.round(box.x)},${Math.round(box.y)}) 元素尺寸 ${box.w}x${box.h}`);
  } finally { s.close(); }
}

async function cmdNet(match, seconds, filter) {
  const waitMs = (Number(seconds) || 10) * 1000;
  const page = await pickPage(match);
  const s = await attach(page);
  const reqs = new Map();
  s.on((msg) => {
    if (msg.method === 'Network.requestWillBeSent') {
      reqs.set(msg.params.requestId, { method: msg.params.request.method, url: msg.params.request.url, type: msg.params.type });
    } else if (msg.method === 'Network.responseReceived') {
      const r = reqs.get(msg.params.requestId);
      if (r) r.status = msg.params.response.status;
    }
  });
  try {
    await s.send('Network.enable');
    console.log(`开始抓取 ${waitMs / 1000} 秒（请在页面上执行一次真实操作，比如发一条消息）...`);
    await new Promise((r) => setTimeout(r, waitMs));
    let rows = [...reqs.values()];
    if (filter) rows = rows.filter((r) => r.url.includes(filter));
    console.log(`\n共 ${rows.length} 条请求：`);
    console.table(rows.map((r) => ({
      method: r.method, status: r.status ?? '-', type: r.type, url: r.url.slice(0, 120)
    })));
  } finally { s.close(); }
}

async function cmdOpen(url) {
  if (!url) throw new Error('用法: open <url>');
  const res = await fetch(`${BASE}/json/version`);
  const ver = await res.json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('浏览器端 WebSocket 连接失败'));
  });
  const session = new Session(ws);
  try {
    const r = await session.send('Target.createTarget', { url });
    console.log('已在调试实例中新开标签，targetId =', r.targetId);
  } finally { session.close(); }
}

async function cmdShot(match, outFile) {
  const fs = await import('node:fs/promises');
  const page = await pickPage(match);
  const s = await attach(page);
  try {
    await s.send('Page.enable');
    const shot = await s.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(shot.data, 'base64');
    await fs.writeFile(outFile, buf);
    console.log(`截图已保存：${outFile}（${(buf.length / 1024).toFixed(1)} KB）`);
  } finally { s.close(); }
}

/* ---------------- 入口 ---------------- */

const COMMANDS = {
  list: cmdList,
  frames: cmdFrames,
  text: cmdText,
  eval: cmdEval,
  code: cmdCode,
  type: cmdType,
  press: cmdPress,
  click: cmdClick,
  net: cmdNet,
  shot: cmdShot,
  open: cmdOpen
};

if (!cmd || !COMMANDS[cmd]) {
  console.log('可用命令：' + Object.keys(COMMANDS).join(', '));
  process.exit(cmd ? 1 : 0);
}

COMMANDS[cmd](...argv.slice(1)).catch((e) => {
  console.error('❌ ' + e.message);
  process.exit(1);
});
