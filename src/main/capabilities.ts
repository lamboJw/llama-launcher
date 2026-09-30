// capabilities.ts — 目标 exe 参数能力探测（规格 §5.3 补充：fork 兼容）
// 启动前跑一次 `exe --help` 解析出支持的长参数集合（按 exe 路径缓存），
// 过滤 buildArgs 产出中不支持的参数——kvmem 等 fork 与 b10488 参数面不同，
// 强制尾参（--log-colors/--metrics）与 bool 恒显式参数在 fork 上会直接拒；
// 探测失败或解析结果不含 --port（非 server 的 help）→ 返回 null，不过滤（行为同现状）
import { execFile } from 'node:child_process';

/** 启动器强制传 --port：help 里没有它就不是目标 server 的 help，不可据此过滤 */
const SANITY_FLAG = '--port';

const cache = new Map<string, Set<string>>();

/** 从 --help 文本提取长参数名集合（--flag；含短选项行中的长名与描述中提及的） */
export function parseHelpFlags(help: string): Set<string> {
  const out = new Set<string>();
  for (const m of help.matchAll(/--[a-z][a-z0-9-]*/gi)) out.add(m[0]);
  return out;
}

export interface FilterResult {
  argv: string[];
  removed: string[]; // 被移除的 flag 名（去重、保持出现顺序）
}

/**
 * 按支持集合过滤 argv：不支持的 `--flag` 连同其后一个非 `--` 值 token 一并移除；
 * 支持的 flag 连同其值保留（值消费在 flag 分支内完成，孤立裸 token 保守保留）。
 * supported 为 null（未探测/探测失败）时原样返回。`--flag=value` 按 flag 名整体判断。
 */
export function filterArgv(argv: string[], supported: Set<string> | null): FilterResult {
  if (supported === null) return { argv: [...argv], removed: [] };
  const out: string[] = [];
  const removed: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) {
      out.push(tok); // 孤立裸 token（构建器不产生，保守保留）
      continue;
    }
    const name = tok.split('=', 1)[0];
    const next = argv[i + 1];
    const hasNextValue = next !== undefined && !next.startsWith('--');
    if (supported.has(name)) {
      out.push(tok);
      if (hasNextValue && !tok.includes('=')) { out.push(next); i++; }
      continue;
    }
    // 不支持：flag（及未含 = 的值）一并移除
    if (!tok.includes('=') && hasNextValue) i++;
    if (!removed.includes(name)) removed.push(name);
  }
  return { argv: out, removed };
}

/** 跑 `exe --help`（10s 超时）；失败或无输出 → null */
function runHelp(exe: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      exe,
      ['--help'],
      { timeout: 10000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const out = `${stdout ?? ''}\n${stderr ?? ''}`;
        resolve(out.trim() === '' ? null : out);
      },
    );
  });
}

/**
 * 目标 exe 支持的长参数集合（只读，勿修改）；按 exe 路径缓存。
 * 探测失败 / help 不含 SANITY_FLAG → null（调用方按不过滤处理）。
 */
export async function getSupportedFlags(exe: string): Promise<Set<string> | null> {
  const hit = cache.get(exe);
  if (hit) return hit;
  const help = await runHelp(exe);
  if (help === null) return null;
  const flags = parseHelpFlags(help);
  if (!flags.has(SANITY_FLAG)) return null; // 非 server help（如 node --help）→ 不过滤
  cache.set(exe, flags);
  return flags;
}

/** 测试用：清空探测缓存 */
export function clearFlagCache(): void {
  cache.clear();
}
