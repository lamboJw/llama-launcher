import { describe, it, expect } from 'vitest';
import { parseTimingLine, splitLines, RoundTracker } from '../src/main/log-parser.js';

const PROMPT = 'prompt eval time =   44009.40 ms / 19417 tokens (    2.27 ms per token,   441.20 tokens per second)';
const EVAL = '       eval time =    5872.68 ms /   233 tokens (   25.20 ms per token,    39.68 tokens per second)';
const EVAL_RUNS = '       eval time =    5872.68 ms /   233 runs (   25.20 ms per token,    39.68 runs per second)';
const PREFIXED = 'llama_print_timings: prompt eval time = 100.00 ms / 50 tokens ( 2.00 ms per token, 50.00 tokens per second)';

describe('parseTimingLine', () => {
  it('prompt line -> prefill metrics', () => {
    const e = parseTimingLine(PROMPT)!;
    expect(e).toEqual({ kind: 'prompt', ms: 44009.4, tokens: 19417, msPerToken: 2.27, tps: 441.2 });
  });
  it('eval line (tokens unit) -> decode metrics', () => {
    const e = parseTimingLine(EVAL)!;
    expect(e).toEqual({ kind: 'eval', ms: 5872.68, tokens: 233, msPerToken: 25.2, tps: 39.68 });
  });
  it('eval line (runs unit) tolerated', () => {
    expect(parseTimingLine(EVAL_RUNS)!.kind).toBe('eval');
  });
  it('llama_print_timings: prefix tolerated', () => {
    const e = parseTimingLine(PREFIXED)!;
    expect(e.kind).toBe('prompt');
    expect(e.ms).toBe(100);
  });
  it('ansi codes tolerated', () => {
    expect(parseTimingLine('\x1b[32m' + PROMPT + '\x1b[0m')!.kind).toBe('prompt');
  });
  it('non-timing line -> null', () => {
    expect(parseTimingLine('slot release: id  0 | task 0')).toBeNull();
    expect(parseTimingLine('      total time =   49882.08 ms / 19650 tokens')).toBeNull();
    expect(parseTimingLine('')).toBeNull();
  });
});

describe('splitLines', () => {
  it('keeps trailing partial line as rest', () => {
    expect(splitLines('a\nb\nc')).toEqual({ lines: ['a', 'b'], rest: 'c' });
  });
  it('handles CRLF', () => {
    expect(splitLines('a\r\nb\n')).toEqual({ lines: ['a', 'b'], rest: '' });
  });
});

describe('RoundTracker', () => {
  it('pairs prompt then eval into one round', () => {
    const t = new RoundTracker();
    t.onPrompt(parseTimingLine(PROMPT)!, 1000);
    t.onEval(parseTimingLine(EVAL)!, 2000);
    expect(t.rounds).toHaveLength(1);
    expect(t.rounds[0]).toEqual({ ts: 1000, prefillMs: 44009.4, prefillTps: 441.2, decodeMs: 5872.68, decodeTps: 39.68 });
  });
  it('concurrent slots: evals merge into latest open rounds', () => {
    const t = new RoundTracker();
    t.onPrompt(parseTimingLine(PROMPT)!, 1000);
    t.onPrompt(parseTimingLine(PROMPT)!, 1100);
    t.onEval(parseTimingLine(EVAL)!, 2000);
    t.onEval(parseTimingLine(EVAL)!, 2100);
    expect(t.rounds).toHaveLength(2);
    expect(t.rounds[0].decodeMs).toBeNull();
    expect(t.rounds[1].decodeMs).toBe(5872.68);
  });
  it('eval without prior prompt creates a round', () => {
    const t = new RoundTracker();
    t.onEval(parseTimingLine(EVAL)!, 500);
    expect(t.rounds[0]).toEqual({ ts: 500, prefillMs: null, prefillTps: null, decodeMs: 5872.68, decodeTps: 39.68 });
  });
  it('clear resets', () => {
    const t = new RoundTracker();
    t.onPrompt(parseTimingLine(PROMPT)!, 1);
    t.clear();
    expect(t.rounds).toEqual([]);
  });
});