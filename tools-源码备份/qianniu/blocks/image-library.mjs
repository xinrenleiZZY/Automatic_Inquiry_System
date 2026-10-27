/* =====================================================================
 * 区块：图片库（Image Library）
 * [功能区块 · v0.1 · 状态：待集成到系统 —— 见 INTEGRATION.md]
 *
 * 对接方式（不需要接口地址，二选一即可）：
 *   ① **本地文件夹**（默认）：把图片丢进 tools/qianniu/image/ 就行，
 *      文件名当产品名用；跑 `node im.mjs lib-images sync` 入库。
 *   ② 其它来源（HTTP/接口/共享盘）：只要实现一个 listImages() 返回
 *      `[{ path|url, fileName, size, hash }]`，其余流程完全复用本区块。
 *
 * 数据库用 image_library 表记录：图片 → 配哪条短语 → 处理状态 → 搜图 imageId。
 * 处理完成的图片标 done，下次 `--all-pending` 会跳过。
 * ===================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as store from './db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BASE_DIR = path.resolve(__dirname, '..');
export const DEFAULT_IMAGE_DIR = path.join(BASE_DIR, 'image');
export const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'];

const sha1 = (file) => {
  try { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 16); }
  catch { return ''; }
};

/* 列出图片库里的图片（默认扫本地文件夹） */
export function listImages(opts = {}) {
  const dir = opts.dir || DEFAULT_IMAGE_DIR;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => IMAGE_EXTS.includes(path.extname(f).toLowerCase()))
    .map((f) => {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      return {
        path: full,
        fileName: f,
        base: path.basename(f, path.extname(f)),
        size: st.size,
        hash: sha1(full)
      };
    })
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
}

/* 把文件夹里的图片同步进库（不动已存在的短语/状态） */
export function syncLibrary(db, images) {
  let added = 0;
  for (const img of images) {
    const before = db.prepare(`SELECT id FROM image_library WHERE path = ?`).get(img.path);
    store.upsertLibraryImage(db, img);
    if (!before) added++;
  }
  return { total: images.length, added };
}

/* 待处理的图片：库里没有的（新丢进来的）或状态不是 done 的 */
export function pendingImages(db, images) {
  const rows = store.listLibraryImages(db);
  const byPath = new Map(rows.map((r) => [r.path, r]));
  return images.filter((img) => {
    const r = byPath.get(img.path);
    return !r || r.status !== 'done';
  });
}

/* 给某张图指定用哪条短语（图片库 ↔ 短语库的对应关系） */
export function bindPhrase(db, imagePath, phraseId) {
  store.upsertLibraryImage(db, { path: imagePath, phraseId });
  return store.markLibraryImage(db, imagePath, { phraseId });
}
