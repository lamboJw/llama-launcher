// log-parser.ts — 日志行切分 + 时序行解析 + 轮次聚合（规格 §7）
// 时序行来源：prompt eval time → prefill 时间/速度；eval time → decode 速度
// 并发 slot 时行交错：eval 行并入最近一个尚未有 decode 的轮次
import type { TimingEvent } from '../shared/types.js';

const ANSI = /\x1b\[[0-9;]*m/g;

// 两种单位（tokens/runs）+ 可选 llama_print_timings: 前缀 + 可选 ANSI，全部容错
const PROMPT_RE = /^\s*(?:llama_print_timings:\s*)?prompt eval time =\s+([\d.]+)\s*ms\s*\/\s*(\d+)\s+\S+\s*\(\s*([\d.]+)\s*ms per token,\s*([\d.]+)\s*\S+ per second\)/;
const EVAL_RE = /^\s*(?:llama_print_timings:\s*)?eval time =\s+([\d.]+)\s*ms\s*\/\s*(\d+)\s+\S+\s*\(\s*([\d.]+)\s*ms per token,\s*([\d.]+)\s*\S+ per second\)/;

export function parseTimingLine(raw: string): TimingEvent | null {
  const line = raw.replace(ANSI, '');
  const m = line.match(PROMPT_RE);
  if (m) return { kind: 'prompt', ms: +m[1], tokens: +m[2], msPerToken: +m[3], tps: +m[4] };
  const e = line.match(EVAL_RE);
  if (e) return { kind: 'eval', ms: +e[1], tokens: +e[2], msPerToken: +e[3], tps: +e[4] };
  return null;
}

export function splitLines(buf: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let i = 0;
  for (;;) {
    const idx = buf.indexOf('\n', i);
    if (idx === -1) break;
    lines.push(buf.slice(i, idx).replace(/\r$/, ''));
    i = idx + 1;
  }
  return { lines, rest: buf.slice(i) };
}

export interface LogRound {
  ts: number;
  prefillMs: number | null;
  prefillTps: number | null;
  decodeMs: number | null;
  decodeTps: number | null;
}

export class RoundTracker {
  private list: LogRound[] = [];

  onPrompt(ev: TimingEvent, ts: number): void {
    this.list.push({ ts, prefillMs: ev.ms, prefillTps: ev.tps, decodeMs: null, decodeTps: null });
  }

  onEval(ev: TimingEvent, ts: number): void {
    // 并入最近一个有 prefill 的轮次（并发 slot 行交错时的启发式配对）
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (this.list[i].prefillMs !== null) {
        this.list[i].decodeMs = ev.ms;
        this.list[i].decodeTps = ev.tps;
        return;
      }
    }
    this.list.push({ ts, prefillMs: null, prefillTps: null, decodeMs: ev.ms, decodeTps: ev.tps });
  }

  get rounds(): LogRound[] { return this.list; }

  clear(): void { this.list = []; }
}