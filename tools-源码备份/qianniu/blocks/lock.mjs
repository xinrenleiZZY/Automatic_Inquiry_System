/* =====================================================================
 * 区块：浏览器操作锁（Browser Lock）
 * [功能区块 · v0.1 · 状态：待集成到系统]
 *
 * 为什么需要：聊天窗口是**独占资源**（发送/读消息都要求"当前打开的就是那个会话"），
 * 所以浏览器操作必须串行。两个进程同时跑会互相抢窗口 ——
 * A 正在发消息时，B 的"开一个关一个"逻辑会把 A 的窗口关掉。
 *
 * 这个锁是**防止误操作的最后一道闸**：拿不到锁就直接报错，
 * 而不是让两个流程互相破坏数据。
 *
 * 对外接口：
 *   withBrowserLock(fn, opts)   —— 拿到锁执行；拿不到抛错（默认不等）
 *   lockStatus()                —— 看当前谁拿着锁
 * ===================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
export const LOCK_FILE = path.join(DATA_DIR, '.browser.lock');

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function lockStatus() {
  if (!fs.existsSync(LOCK_FILE)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (!alive(j.pid)) { fs.unlinkSync(LOCK_FILE); return null; }   // 陈旧锁自动清理
    return j;
  } catch { return null; }
}

export function releaseLock() {
  try {
    const j = lockStatus();
    if (j && j.pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch { /* ignore */ }
}

/* 拿不到锁时默认直接报错：宁可让用户等一下，也不要两个流程互相破坏 */
export async function withBrowserLock(fn, opts = {}) {
  const waitMs = Number(opts.waitMs) || 0;
  const deadline = Date.now() + waitMs;

  for (;;) {
    const cur = lockStatus();
    if (!cur) break;
    if (cur.pid === process.pid) break;                 // 同进程重入，直接放行
    if (Date.now() >= deadline) {
      throw new Error(
        `浏览器正被另一个流程占用（PID ${cur.pid}，任务「${cur.what || '未标注'}」，开始于 ` +
        `${new Date(cur.at).toLocaleTimeString('zh-CN')}）。\n` +
        `浏览器操作必须串行，否则会互相抢聊天窗口。请等它结束，或先停掉那个进程。`
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LOCK_FILE, JSON.stringify({
    pid: process.pid, what: opts.what || '', at: Date.now()
  }), 'utf8');

  try {
    return await fn();
  } finally {
    releaseLock();
  }
}
