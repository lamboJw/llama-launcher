import { describe, it, expect } from 'vitest';
import { StatsStore } from '../src/main/stats.js';
import type { RequestStats } from '../src/shared/types.js';
import type { LogRound } from '../src/main/log-parser.js';

const REQ: RequestStats = { model: 'm', ttftMs: 120, cacheHitRate: 0.5, ts: 1000 };
const ROUND: LogRound = { ts: 1500, prefillMs: 44009.4, prefillTps: 441.2, decodeMs: 5872.68, decodeTps: 39.68 };

describe('StatsStore', () => {
  it('pairs request with nearest round in window', () => {
    const s = new StatsStore();
    s.addRequest(REQ);
    s.addRound(ROUND);
    expect(s.getLatest()).toEqual({
      ts: 1000, model: 'm', ttftMs: 120, cacheHitRate: 0.5,
      prefillMs: 44009.4, prefillTps: 441.2, decodeTps: 39.68,
    });
  });

  it('round outside window not paired', () => {
    const s = new StatsStore();
    s.addRequest(REQ);
    s.addRound({ ...ROUND, ts: 1000 + 300_001 });
    expect(s.getLatest()!.prefillMs).toBeNull();
    expect(s.getLatest()!.ttftMs).toBe(120);
  });

  it('two requests pair with two rounds in order', () => {
    const s = new StatsStore();
    s.addRequest(REQ);
    s.addRequest({ ...REQ, ts: 5000, ttftMs: 90 });
    s.addRound(ROUND);
    s.addRound({ ...ROUND, ts: 5500, prefillMs: 100 });
    const h = s.getHistory();
    expect(h).toHaveLength(2);
    expect(h[0].prefillMs).toBe(44009.4);
    expect(h[1].prefillMs).toBe(100);
  });

  it('no requests -> latest from round only', () => {
    const s = new StatsStore();
    s.addRound(ROUND);
    expect(s.getLatest()).toEqual({
      ts: 1500, model: null, ttftMs: null, cacheHitRate: null,
      prefillMs: 44009.4, prefillTps: 441.2, decodeTps: 39.68,
    });
  });

  it('empty store -> null', () => {
    expect(new StatsStore().getLatest()).toBeNull();
  });
});