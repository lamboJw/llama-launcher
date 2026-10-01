// kvmem.ts — kvmem 定制构建的版本发现（规格 §2/§3，纯 Node 可测）
import * as fs from 'node:fs';
import path from 'node:path';

export interface KvmemVersion {
  tag: string; // 'kvmem-<子目录名>'
  exe: string; // 解析出的可执行文件绝对路径
}

/** 目录内解析 kvmem exe（规格 §3）：llama-kvmem-server.exe 优先；
 *  否则恰好 1 个 *.exe；0 或 ≥2 → null；目录不可读 → null */
export function kvmemExePath(dir: string): string | null {
  const canonical = path.join(dir, 'llama-kvmem-server.exe');
  if (fs.existsSync(canonical)) return canonical;
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const exes = names.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.exe'));
  return exes.length === 1 ? path.join(dir, exes[0].name) : null;
}

/** 遍历 baseDir/kvmem/*（规格 §3）：按 §2 规则解析 exe → 条目；
 *  无 exe 的子目录跳过；单项 fs 失败跳过不抛 */
export function scanKvmemVersions(baseDir: string): KvmemVersion[] {
  const kvmemDir = path.join(baseDir, 'kvmem');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(kvmemDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: KvmemVersion[] = [];
  for (const e of entries) {
    try {
      if (!e.isDirectory()) continue;
      const exe = kvmemExePath(path.join(kvmemDir, e.name));
      if (exe) out.push({ tag: `kvmem-${e.name}`, exe });
    } catch {
      /* 单项失败跳过 */
    }
  }
  return out;
}
