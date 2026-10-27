/* =====================================================================
 * 区块：快捷短语库（Phrase Library）
 * [功能区块 · v0.1 · 状态：待集成到系统 —— 见 INTEGRATION.md]
 *
 * 一条短语 = 一段文字 + 一张图（图可留空）。
 * **JSON 文件为准**（便于人工编辑/版本管理），数据库存一份可查询的镜像。
 *
 *   文件：phrase-library.json
 *   结构：{ version, phrases: [{ id, name, text, image, tags, enabled }] }
 *
 * 对外接口：
 *   loadLibrary(file?) / saveLibrary(file, lib)
 *   listPhrases(file?) / getPhrase(file, idOrName)
 *   addPhrase(file, {id,name,text,image,tags})
 *   syncToDb(db, phrases)     把 JSON 同步进 phrase_library 表
 * ===================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BASE_DIR = path.resolve(__dirname, '..');          // tools/qianniu
export const DEFAULT_LIBRARY = path.join(BASE_DIR, 'phrase-library.json');

/* 图片路径解析：绝对路径直接用；相对路径按多个根依次试，取第一个真实存在的。
   为什么多根：短语库里的路径可能是相对项目根写的（如 tools/qianniu/image/x.jpg），
   也可能是相对 tools/qianniu 写的（image/x.jpg）。只按一个根拼会拼成
   ...\tools\qianniu\tools\qianniu\image\x.jpg（实测踩过）。 */
export function resolveImage(p) {
  if (!p) return '';
  if (path.isAbsolute(p)) return p;
  const roots = [
    path.resolve(BASE_DIR, '..'),   // 项目根
    BASE_DIR,                       // tools/qianniu
    process.cwd()
  ];
  for (const r of roots) {
    const cand = path.resolve(r, p);
    if (fs.existsSync(cand)) return cand;
  }
  return path.resolve(BASE_DIR, p);   // 都不存在时给个可读的路径，方便报错定位
}

export function loadLibrary(file = DEFAULT_LIBRARY) {
  if (!fs.existsSync(file)) return { version: 1, phrases: [] };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const phrases = (Array.isArray(data) ? data : (data.phrases || []))
    .filter((p) => p && p.id)
    .map((p) => ({
      id: p.id,
      name: p.name || p.id,
      text: p.text || '',
      image: p.image || '',
      tags: p.tags || [],
      enabled: p.enabled !== false
    }));
  return { version: data.version || 1, phrases };
}

export function saveLibrary(file, lib) {
  const out = {
    _说明: '快捷短语库：一条短语 = 一段文字 + 一张图（图片可留空）。改完跑 node im.mjs lib sync 同步进数据库。',
    _注意: '聊天框的贴图按钮是『点了就发』，没有预览确认；所以图文短语会作为两条消息发出（默认先文字、后图片）。',
    version: lib.version || 1,
    phrases: lib.phrases || []
  };
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n', 'utf8');
  return out;
}

export function listPhrases(file = DEFAULT_LIBRARY) {
  return loadLibrary(file).phrases;
}

export function getPhrase(file = DEFAULT_LIBRARY, idOrName) {
  const list = listPhrases(file);
  const key = String(idOrName || '');
  return list.find((p) => p.id === key)
      || list.find((p) => p.name === key)
      || list.find((p) => p.name.includes(key) || p.text.includes(key))
      || null;
}

export function addPhrase(file, { id, name, text, image, tags }) {
  const lib = loadLibrary(file);
  const phraseId = id || ('p' + Date.now());
  const exists = lib.phrases.findIndex((p) => p.id === phraseId);
  const rec = {
    id: phraseId,
    name: name || phraseId,
    text: text || '',
    image: image || '',
    tags: tags || [],
    enabled: true
  };
  if (exists >= 0) lib.phrases[exists] = rec;
  else lib.phrases.push(rec);
  saveLibrary(file, lib);
  return rec;
}

/* 把 JSON 里的短语同步进数据库（镜像表） */
export function syncToDb(db, phrases) {
  let n = 0;
  for (const p of phrases) { store.savePhrase(db, p); n++; }
  return n;
}
