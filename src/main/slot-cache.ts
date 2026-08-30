// slot-cache.ts — llama-server slots API 的 slot 上下文（KV 缓存）保存 / 恢复
// 设计规格：docs/superpowers/specs/2026-08-30-slot-cache-design.md §1
// 纯 Node（无 Electron 依赖），fake-server.mjs 可单测
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Windows 非法字符替换为 _；去尾部点号与空白；净化后为空 → 'model' */
export function sanitizeModelName(name: string): string {
  const s = name.replace(/[\/:*?"<>|]/g, '_').replace(/[.\s]+$/, '');
  return s === '' ? 'model' : s;
}

/** 存档文件名：<净化名>_<slotId>.bin */
export function slotFileName(model: string, slotId: number): string {
  return `${sanitizeModelName(model)}_${slotId}.bin`;
}

/** 扫描 dir 下 <净化名>_<id>.bin（id 为非负整数）→ Map(slotId → 绝对路径)；目录不存在 → 空 Map */
export function findSlotSaves(dir: string, model: string): Map<number, string> {
  const map = new Map<number, string>();
  let files: string[] = [];
  try { files = fs.readdirSync(dir); } catch { return map; }
  const prefix = `${sanitizeModelName(model)}_`;
  for (const f of files) {
    if (!f.startsWith(prefix)) continue;
    const m = /^(\d+)\.bin$/.exec(f.slice(prefix.length));
    if (!m) continue;
    const id = Number(m[1]);
    if (!Number.isSafeInteger(id)) continue;
    map.set(id, path.join(dir, f));
  }
  return map;
}
