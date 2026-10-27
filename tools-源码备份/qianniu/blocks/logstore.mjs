/* =====================================================================
 * 区块：事件日志（LogStore）
 * [功能区块 · v0.1 · 状态：待集成到系统 —— 见 INTEGRATION.md]
 *
 * 职责：事件落盘（JSONL）、读回、汇总统计。统一管理所有路径，
 *       其它区块不要再自己拼路径。
 * ===================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LOG_DIR = path.resolve(__dirname, '..', 'logs');

export const PATHS = {
  dir: LOG_DIR,
  events: path.join(LOG_DIR, 'im-events.jsonl'),
  monitorOut: path.join(LOG_DIR, 'monitor.out.log'),
  monitorErr: path.join(LOG_DIR, 'monitor.err.log'),
  pid: path.join(LOG_DIR, 'monitor.pid')
};

export function makeEvent(type, fields = {}) {
  return { epoch: Date.now(), iso: new Date().toISOString(), type, ...fields };
}

export function appendEvent(event, file = PATHS.events) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
  } catch (e) {
    console.error('写日志失败:', e.message);
  }
}

export function readEvents(limit = 50, file = PATHS.events) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-limit).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

export function clearEvents(file = PATHS.events) {
  const before = readEvents(1e6, file).length;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '', 'utf8');
  return before;
}

export function summarizeEvents(rows) {
  const inbound = rows.filter((r) => r.type === 'inbound');
  const outbound = rows.filter((r) => r.type === 'outbound');
  const convUpdates = rows.filter((r) => r.type === 'conv-update');
  const byConv = {};
  inbound.forEach((r) => { byConv[r.conv] = (byConv[r.conv] || 0) + 1; });
  return {
    total: rows.length,
    inbound: inbound.length,
    outbound: outbound.length,
    convUpdates: convUpdates.length,
    conversations: Object.keys(byConv).length,
    byConv: Object.entries(byConv)
      .map(([name, count]) => ({ conversation: name, inbound: count }))
      .sort((a, b) => b.inbound - a.inbound),
    first: rows[0] || null,
    last: rows[rows.length - 1] || null
  };
}
