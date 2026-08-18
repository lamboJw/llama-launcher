// version.ts — llama.cpp 版本解析与启动失败精准诊断（规格 §9.1）
// 被动兼容 + 精准诊断：不做自动改名，只告诉用户哪个参数坏了、在哪改
import type { ParsedVersion } from '../shared/types.js';

export const BASELINE_BUILD = 10488;

// 旧版（v9222 实测）：version: 9222 (9a532ae4b)
const OLD_RE = /version:\s*(\d+)\s*\(([0-9a-f]{7,40})\)/i;
// 新版（b10488 实测）：version: 0.1.2-dev (build 10488, commit 9d77fa172)
const NEW_RE = /version:.*\(build\s+(\d+),\s*commit\s+([0-9a-f]{7,40})\)/i;

export function parseVersion(output: string): ParsedVersion {
  const line = output.split(/\r?\n/).find(l => /version:/i.test(l)) ?? output.trim();
  const m = line.match(OLD_RE) ?? line.match(NEW_RE);
  if (!m) return { build: null, commit: null, raw: line.trim() };
  return { build: +m[1], commit: m[2], raw: line.trim() };
}

/** 非基线版本 → 黄色横幅文案；基线或解析失败 → null */
export function versionBanner(v: ParsedVersion): string | null {
  if (v.build === null || v.build === BASELINE_BUILD) return null;
  return `检测到 llama.cpp v${v.build}，参数表单基于 b${BASELINE_BUILD} 设计，个别参数可能已改名`;
}

export interface LaunchFailure {
  arg: string;            // 出问题的 CLI 参数（removed 且无法提取时为空串）
  field: string | null;   // 表单字段 key / 'extraArgs' / null（强制参数或未映射）
  reason: 'invalid' | 'removed';
  message: string;        // 直接展示给用户的中文提示
}

const INVALID_RE = /error:\s*invalid argument:\s*(--[A-Za-z0-9][\w-]*)/;
const REMOVED_RE = /the argument\s+((?:--\w[\w-]*)\s+)?has been removed/i;

/** stderr 扫描：启动 <10s 非零退出时调用；argToField 由 buildArgs 产出 */
export function diagnoseStartupFailure(stderr: string, argToField: Record<string, string>): LaunchFailure | null {
  const mi = stderr.match(INVALID_RE);
  const mr = mi ? null : stderr.match(REMOVED_RE);
  if (!mi && !mr) return null;
  const reason: 'invalid' | 'removed' = mi ? 'invalid' : 'removed';
  const arg = mi ? mi[1] : (mr ? (mr[1] ?? '').trim() : '');
  const field = arg !== '' ? (argToField[arg] ?? null) : null;
  const head = reason === 'invalid'
    ? `参数「${arg}」未被当前版本识别（可能已改名或移除）`
    : `参数「${arg}」在当前版本已被移除`;
  let tail = '';
  if (field !== null) {
    tail = field === 'extraArgs' ? '，请清空『附加参数』' : `，请清空表单字段「${field}」`;
  }
  const message = arg !== ''
    ? `${head}${tail}，或改用『附加参数』填新版本参数`
    : 'llama-server 启动即退出并报告参数已被移除，请检查表单参数与当前版本是否匹配';
  return { arg, field, reason, message };
}