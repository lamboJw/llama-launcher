// hf-cache.ts — HF cache 模型枚举（规格 §4.1，逐条对照 b10488 hf-cache.cpp 行为）
// ① 枚举顶层 models--* 目录且含 snapshots/ 子目录
// ② 去前缀后所有 -- 替换为 /，重新校验（非空、≤256、恰好一个 /、字符集 [A-Za-z0-9_.-]）
// ③ refs/ 中第一个 40-hex 首行的常规文件为 commit（refs/main 优先），snapshots/<commit>/ 须存在且含 ≥1 *.gguf
// ④ 请求名可带 :QUANT（匹配前剥离，完整名传给 --hf-repo）
// ⑤ 请求匹配大小写不敏感；启动用目录名反解的原始大小写
import fs from 'node:fs';
import path from 'node:path';
import type { HfModel, LocalModel, ModelRef } from '../shared/types.js';

const REPO_CHARS = /^[A-Za-z0-9_.-]+$/;
const QUANT_RE = /^(.*?)[-_]((?:Q[0-9]+[A-Z0-9_]*|F16|F32|BF16))$/i;

export function isRepoId(s: string): boolean {
  if (s.length === 0 || s.length > 256) return false;
  const parts = s.split('/');
  return parts.length === 2 && parts.every(p => REPO_CHARS.test(p));
}

export function parseRepoFromDirName(dirName: string): string | null {
  if (!dirName.startsWith('models--')) return null;
  const repo = dirName.slice('models--'.length).split('--').join('/');
  return isRepoId(repo) ? repo : null;
}

export function extractQuant(fileName: string): string | null {
  const base = path.basename(fileName, path.extname(fileName));
  const m = base.match(QUANT_RE);
  return m ? m[2].toUpperCase() : null;
}

export function readCommit(repoDir: string): string | null {
  const refsDir = path.join(repoDir, 'refs');
  if (!fs.existsSync(refsDir) || !fs.statSync(refsDir).isDirectory()) return null;
  const files = fs.readdirSync(refsDir).filter(f => fs.statSync(path.join(refsDir, f)).isFile());
  const order = [...files].sort((a, b) => {
    if (a === 'main') return -1;
    if (b === 'main') return 1;
    return a.localeCompare(b);
  });
  for (const f of order) {
    const first = (fs.readFileSync(path.join(refsDir, f), 'utf8').split(/\r?\n/)[0] ?? '').trim();
    if (/^[0-9a-f]{40}$/i.test(first)) return first;
  }
  return null;
}

export function scanHfCache(hfDir: string): HfModel[] {
  if (!hfDir || !fs.existsSync(hfDir) || !fs.statSync(hfDir).isDirectory()) return [];
  const out: HfModel[] = [];
  for (const e of fs.readdirSync(hfDir, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith('models--')) continue;
    const dir = path.join(hfDir, e.name);
    if (!fs.existsSync(path.join(dir, 'snapshots'))) continue;
    const repo = parseRepoFromDirName(e.name);
    if (!repo) continue;
    const commit = readCommit(dir);
    if (!commit) continue;
    const snap = path.join(dir, 'snapshots', commit);
    if (!fs.existsSync(snap) || !fs.statSync(snap).isDirectory()) continue;
    const files = fs.readdirSync(snap).filter(f => /\.gguf$/i.test(f));
    if (files.length === 0) continue;
    const ggufs = files.filter(f => !/mmproj/i.test(f)); // mmproj 不算量化
    const quants = [...new Set(ggufs.map(extractQuant).filter((q): q is string => q !== null))].sort();
    const quant = quants.includes('Q4_K_M') ? 'Q4_K_M' : (quants[0] ?? null);
    const size = files.reduce((s, f) => s + fs.statSync(path.join(snap, f)).size, 0);
    const mmproj = files.some(f => /mmproj/i.test(f));
    out.push({ repo, path: snap, size, quants, quant, mmproj });
  }
  out.sort((a, b) => a.repo.localeCompare(b.repo));
  return out;
}

// 并集：同名（大小写不敏感）冲突时本地优先（规格 §4.1「同名冲突」）
// 本地名与 HF repo 全名或 base 名（最后一个 / 之后，如 GLM-4.7-Flash-GGUF）相同 → 本地遮蔽 HF
export function buildModelUnion(local: LocalModel[], hf: HfModel[]): ModelRef[] {
  const out: ModelRef[] = [];
  const seenFull = new Set<string>();
  const seenBase = new Set<string>();
  for (const l of local) {
    const key = l.name.toLowerCase();
    if (seenFull.has(key)) continue;
    seenFull.add(key);
    seenBase.add(key);
    out.push({ name: l.name, source: 'local', local: l });
  }
  for (const h of hf) {
    const key = h.repo.toLowerCase();
    const base = (h.repo.split('/').pop() ?? '').toLowerCase();
    if (seenFull.has(key) || seenBase.has(base)) continue; // 本地遮蔽
    seenFull.add(key);
    out.push({ name: h.repo, source: 'hf', hf: h });
  }
  return out;
}

// 请求解析：剥离 :QUANT 后按名大小写不敏感匹配（规格 §4.1 ④⑤）
export function resolveModelRef(union: ModelRef[], request: string): ModelRef | null {
  const base = (request.split(':')[0] ?? '').trim();
  if (!base) return null;
  const key = base.toLowerCase();
  return union.find(r => r.name.toLowerCase() === key) ?? null;
}