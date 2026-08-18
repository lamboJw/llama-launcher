// scan.ts — 递归扫描本地 .gguf（规格 §4）
// 命名规则：子目录 → 目录名（分片取 -00001-of- 首片为启动路径）；散文件 → 去 .gguf 文件名
import fs from 'node:fs';
import path from 'node:path';
import type { LocalModel } from '../shared/types.js';

const GGUF = /\.gguf$/i;
const MMPROJ = /mmproj.*\.gguf$/i;
const SHARD_FIRST = /-00001-of-/i;

export function scanModels(dir: string): LocalModel[] {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const files: string[] = [];
  walk(dir, files);

  const groups = new Map<string, string[]>();
  for (const f of files) {
    if (MMPROJ.test(path.basename(f))) continue; // mmproj 不是模型分片，不计入 size/mtime
    const d = path.dirname(f);
    const name = d === dir ? path.basename(f).replace(GGUF, '') : path.basename(d);
    const g = groups.get(name);
    if (g) g.push(f);
    else groups.set(name, [f]);
  }

  const out: LocalModel[] = [];
  for (const [name, fsList] of groups) {
    fsList.sort((a, b) => a.localeCompare(b));
    const dirOf = path.dirname(fsList[0]);
    const shard = fsList.find(f => SHARD_FIRST.test(path.basename(f))) ?? fsList[0];
    const size = fsList.reduce((s, f) => s + fs.statSync(f).size, 0);
    const mtime = Math.max(...fsList.map(f => fs.statSync(f).mtimeMs));
    const mmprojs = fs.readdirSync(dirOf).filter(f => MMPROJ.test(f));
    out.push({
      name,
      path: shard,
      size,
      mtime,
      mmproj: mmprojs.length === 1 ? path.join(dirOf, mmprojs[0]) : null,
      mmprojCandidates: mmprojs.length > 1 ? mmprojs.map(m => path.join(dirOf, m)) : [],
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (GGUF.test(e.name)) out.push(p);
  }
}