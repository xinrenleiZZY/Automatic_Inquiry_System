/* =====================================================================
 * 零依赖 CDP 基础设施（被 cdp.mjs / webim.mjs 共用）
 * 依赖 Node 22+ 的全局 fetch 与 WebSocket
 * ===================================================================== */

import http from 'node:http';

export const BASE = process.env.CDP_BASE || 'http://127.0.0.1:9222';

const _u = new URL(BASE);
const HOST = _u.hostname;
const PORT = Number(_u.port || 80);

/* 用 node:http + agent:false 取 JSON。
   为什么不用 fetch：undici 默认开 keep-alive 连接池，Chrome 重启后
   池里的半死 socket 会被复用，请求永远等不到响应且没有超时——
   实测导致监听器整个卡死 4 天（CPU 归零、零 TCP 连接）。
   agent:false 每次新建连接，配合显式超时，从根上避免这类挂死。 */
export function httpGetJson(path, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: HOST, port: PORT, path, method: 'GET', agent: false, timeout: timeoutMs },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('返回不是合法 JSON')); }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`请求超时(${timeoutMs}ms)`)));
    req.on('error', reject);
    req.end();
  });
}

export async function listPages() {
  const all = await httpGetJson('/json');
  if (!Array.isArray(all)) throw new Error('CDP 返回格式异常');
  /* 排除 DevTools 自身页面：它的标题常常含有被调试页面的 URL，
     不排掉就会被关键字匹配误抓，导致脚本跑在 devtools:// 里。 */
  return all.filter((t) => t.type === 'page' && !(t.url || '').startsWith('devtools://'));
}

export async function pickPage(match, opts = {}) {
  const pages = await listPages();
  if (!pages.length) throw new Error('没有可用的 page target');
  if (!match || match === '-') return pages[0];
  /* match 可以是字符串，也可以是字符串数组（按顺序找第一个命中的） */
  const patterns = Array.isArray(match) ? match : [match];
  /* 匹配规则（踩过大坑）：
     - 纯数字（如 imageId）→ 只能匹配完整 URL，因为它在查询参数里；
     - 其它（路径片段）→ 只匹配 URL 的 **pathname**。
       为什么不用整串：聊天页 URL 的 traceParams 里编码了结果页地址
       （含 "pc-image-search"），整串匹配会把聊天页误认成结果页。 */
  const pathOf = (u) => { try { return new URL(u).pathname; } catch { return u || ''; } };
  let hit = null;
  for (const p of patterns) {
    hit = /^\d+$/.test(p)
      ? pages.find((x) => (x.url || '').includes(p))
      : pages.find((x) => pathOf(x.url).includes(p));
    if (hit) break;
  }
  /* 标题兜底默认开着，但对"必须精确"的场景要关掉：
     1688 的搜索入口页和结果页标题都叫「批发_供应_阿里巴巴」，
     按标题兜底会把搜索页误当成结果页（实测踩过）。 */
  if (!hit && opts.allowTitle !== false) {
    for (const p of patterns) { hit = pages.find((x) => (x.title || '').includes(p)); if (hit) break; }
  }
  if (!hit) {
    const list = pages.map((p, i) => `  [${i}] ${p.title || '(无标题)'}  ${p.url}`).join('\n');
    throw new Error(`没匹配到 target: "${patterns.join(' | ')}"\n可选：\n${list}`);
  }
  return hit;
}

export class Session {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = [];
    this.closed = false;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else {
        this.listeners.forEach((fn) => fn(msg));
      }
    };
    /* socket 断掉时把所有挂起的请求直接置为失败，
       否则它们会永远挂着（这是另一条卡死路径）。 */
    ws.onclose = () => {
      this.closed = true;
      for (const [id, p] of this.pending) {
        p.reject(new Error('WebSocket 已关闭'));
        this.pending.delete(id);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      /* 超时定时器必须在响应到达时清掉，否则它会一直挂着，
         把 Node 的事件循环多撑 30 秒（实测让 15 秒的任务跑了 45 秒）。 */
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`超时：${method}`));
        }
      }, 30000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(fn) { this.listeners.push(fn); }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

export async function attach(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error('WebSocket 连接超时(10s)'));
    }, 10000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket 连接失败')); };
  });
  return new Session(ws);
}

/* 浏览器级会话：能管理标签页（列表/新建/关闭）。
   用于"点开一个聊天窗口后把旧的关掉，只保留一个"这类操作。 */
export async function browserSession() {
  const ver = await httpGetJson('/json/version');
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error('浏览器端连接超时(10s)')); }, 10000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('浏览器端连接失败')); };
  });
  return new Session(ws);
}

export async function evaluate(s, expression) {
  const r = await s.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  });
  if (r.exceptionDetails) {
    throw new Error('页面执行出错：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result?.value;
}

export const KEYMAP = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 }
};

export async function pressKey(s, name) {
  const k = KEYMAP[name] || { key: name, code: name };
  await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
