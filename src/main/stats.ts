// stats.ts — 代理请求（TTFT/缓存命中率）× 日志轮次（prefill/decode）归并（规格 §7）
import type { RequestStats, RoundStats } from '../shared/types.js';
import type { LogRound } from './log-parser.js';

const WINDOW_BEFORE = 2000;    // 轮次 ts 可早于请求 ts 的上限（时钟抖动）
const WINDOW_AFTER = 300_000;  // prefill 可能长达数十秒
const CAP = 1000;

export class StatsStore {
  private requests: RequestStats[] = [];
  private rounds: LogRound[] = [];

  addRequest(r: RequestStats): void {
    this.requests.push(r);
    if (this.requests.length > CAP) this.requests.shift();
  }

  addRound(r: LogRound): void {
    this.rounds.push(r);
    if (this.rounds.length > CAP) this.rounds.shift();
  }

  merge(): RoundStats[] {
    const used = new Set<LogRound>();
    const out: RoundStats[] = [];
    const reqs = [...this.requests].sort((a, b) => a.ts - b.ts);
    for (const req of reqs) {
      let best: LogRound | null = null;
      let bestD = Infinity;
      for (const r of this.rounds) {
        if (used.has(r)) continue;
        const d = r.ts - req.ts;
        if (d < -WINDOW_BEFORE || d > WINDOW_AFTER) continue;
        if (d < bestD) { bestD = d; best = r; }
      }
      if (best) used.add(best);
      out.push({
        ts: req.ts,
        model: req.model,
        ttftMs: req.ttftMs,
        cacheHitRate: req.cacheHitRate,
        prefillMs: best?.prefillMs ?? null,
        prefillTps: best?.prefillTps ?? null,
        decodeTps: best?.decodeTps ?? null,
      });
    }
    return out;
  }

  getLatest(): RoundStats | null {
    const m = this.merge();
    if (m.length > 0) return m[m.length - 1];
    const r = this.rounds[this.rounds.length - 1];
    if (r) return {
      ts: r.ts, model: null, ttftMs: null, cacheHitRate: null,
      prefillMs: r.prefillMs, prefillTps: r.prefillTps, decodeTps: r.decodeTps,
    };
    return null;
  }

  getHistory(): RoundStats[] { return this.merge(); }
}