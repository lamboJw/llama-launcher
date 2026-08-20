import { describe, it, expect } from 'vitest';
import { buildArgs, shlex } from '../src/main/args.js';
import type { FormValues, ModelRef } from '../src/shared/types.js';

const BASE: FormValues = {
  modelFile: '', alias: '', mmproj: '', mmprojUrl: '',
  mmprojAuto: true, mmprojOffload: true, imageMinTokens: '', imageMaxTokens: '',
  visiblePort: 8080, proxyHost: '127.0.0.1', apiKey: '', timeout: '',
  jinja: true, ui: true, ssePingInterval: '',
  corsOrigins: '', corsMethods: '', corsHeaders: '', corsCredentials: false,
  nGpuLayers: '', threads: '', threadsBatch: '', splitMode: '',
  device: '', loadMode: '', fit: '', tensorSplit: '', cacheTypeK: '', cacheTypeV: '', nCpuMoE: '',
  ctxSize: '', parallel: '', batchSize: '', ubatchSize: '',
  cacheRam: '', flashAttn: '', swaFull: false,
  temperature: '', topK: '', topP: '', minP: '',
  repeatPenalty: '', presencePenalty: '', frequencyPenalty: '',
  repeatLastN: '', seed: '', ignoreEos: false,
  reasoningEffort: '', reasoningPreserve: false,
  specType: '', specDraftModel: '', specDraftHf: '',
  specDraftNMax: '', specDraftNMin: '', specDraftNgl: '',
  specDraftThreads: '', specDraftPSplit: '', specDraftPMin: '', specDraftTypeK: '', specDraftTypeV: '', specDefault: false,
  verbosity: '', warmup: true, contextShift: false, cacheReuse: '',
  perf: false, logPromptsDir: '', mcpServersConfig: '',
  mtmdBatchMaxTokens: '', specDraftBackendSampling: false, extraArgs: '',
  autoSwitch: false, hfCacheDir: '', recordRounds: false,
  scanDir: '', exeSelection: '', recordsMaxTotalBytes: 1073741824,
};

const LOCAL: ModelRef = {
  name: 'm', source: 'local',
  local: { name: 'm', path: 'C:/models/m.gguf', size: 1, mtime: 0, mmproj: null, mmprojCandidates: [] },
};

const HF: ModelRef = {
  name: 'u/n', source: 'hf',
  hf: { repo: 'u/n', path: 'C:/hf/snapshots/abc', size: 1, quants: ['Q4_K_M'], quant: 'Q4_K_M', mmproj: false },
};

function hasPair(argv: string[], flag: string, val: string): boolean {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1] === val) return true;
  }
  return false;
}

describe('buildArgs', () => {
  it('local model + forced args + explicit booleans', () => {
    const { argv, env, argToField } = buildArgs(BASE, LOCAL, 59999);
    expect(hasPair(argv, '--model', 'C:/models/m.gguf')).toBe(true);
    expect(hasPair(argv, '--log-colors', 'on')).toBe(true);
    expect(argv).toContain('--metrics');
    expect(hasPair(argv, '--host', '127.0.0.1')).toBe(true);
    expect(hasPair(argv, '--port', '59999')).toBe(true);
    expect(argv).toContain('--mmproj-auto');
    expect(argv).not.toContain('--no-mmproj-auto');
    expect(argv).toContain('--jinja');
    expect(argv).not.toContain('--swa-full');
    expect(argv).not.toContain('--no-swa-full');
    expect(argv).toContain('--warmup');
    expect(argv).not.toContain('--no-warmup');
    expect(env).toEqual({});
    expect(argToField['--n-gpu-layers']).toBeUndefined();
    expect(argToField['--log-colors']).toBe('forced');
  });

  it('empty string fields are not passed', () => {
    const { argv } = buildArgs(BASE, LOCAL, 59999);
    for (const f of ['--ctx-size', '--n-gpu-layers', '--threads', '--alias', '--mmproj', '--temperature']) {
      expect(argv).not.toContain(f);
    }
  });

  it('proxy-only fields never reach the server', () => {
    const { argv } = buildArgs({ ...BASE, corsOrigins: '*', proxyHost: '0.0.0.0' }, LOCAL, 59999);
    expect(argv).not.toContain('--cors-origins');
    expect(argv).not.toContain('--cors-credentials');
    expect(argv).not.toContain('0.0.0.0');
    expect(argv).not.toContain('8080');
  });

  it('hf source -> --hf-repo with quant + --offline + HF_HUB_CACHE env', () => {
    const { argv, env } = buildArgs({ ...BASE, hfCacheDir: 'C:/hf' }, HF, 59999);
    expect(hasPair(argv, '--hf-repo', 'u/n:Q4_K_M')).toBe(true);
    expect(argv).toContain('--offline');
    expect(env.HF_HUB_CACHE).toBe('C:/hf');
    expect(argv).not.toContain('--model');
  });

  it('hf source without default quant -> bare repo name', () => {
    const model: ModelRef = { name: 'u/n', source: 'hf', hf: { ...HF.hf!, quant: null } };
    const { argv } = buildArgs(BASE, model, 59999);
    expect(hasPair(argv, '--hf-repo', 'u/n')).toBe(true);
  });

  it('specType multi-select -> repeated flag', () => {
    const { argv } = buildArgs({ ...BASE, specType: 'none,draft-mtp' }, LOCAL, 59999);
    expect(hasPair(argv, '--spec-type', 'none')).toBe(true);
    expect(hasPair(argv, '--spec-type', 'draft-mtp')).toBe(true);
  });

  it('fit 是带值参数：on/off 带值传，空=不传（不再吞下一个 flag）', () => {
    expect(hasPair(buildArgs({ ...BASE, fit: 'on' }, LOCAL, 59999).argv, '--fit', 'on')).toBe(true);
    expect(hasPair(buildArgs({ ...BASE, fit: 'off' }, LOCAL, 59999).argv, '--fit', 'off')).toBe(true);
    expect(buildArgs(BASE, LOCAL, 59999).argv).not.toContain('--fit');
  });

  it('带值参数后绝不紧跟另一个 flag（--fit 不再吞 --cache-type-k）', () => {
    const { argv } = buildArgs({ ...BASE, fit: 'on', cacheTypeK: 'q8_0', cacheReuse: '128' }, LOCAL, 59999);
    for (const f of ['--fit', '--cache-reuse']) {
      const i = argv.indexOf(f);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(argv[i + 1]?.startsWith('--')).not.toBe(true);
    }
  });

  it('纯开关（b10488 无 --no- 变体）：未勾选不传任何东西，不产生非法 --no-*', () => {
    const argv = buildArgs(BASE, LOCAL, 59999).argv;
    for (const f of ['--swa-full', '--no-swa-full', '--ignore-eos', '--no-ignore-eos', '--spec-default', '--no-spec-default', '--no-cache-reuse', '--no-fit']) {
      expect(argv).not.toContain(f);
    }
    const on = buildArgs({ ...BASE, swaFull: true, ignoreEos: true, specDefault: true }, LOCAL, 59999).argv;
    expect(on).toContain('--swa-full');
    expect(on).toContain('--ignore-eos');
    expect(on).toContain('--spec-default');
  });

  it('cacheReuse 带数字（min chunk size）', () => {
    expect(hasPair(buildArgs({ ...BASE, cacheReuse: '128' }, LOCAL, 59999).argv, '--cache-reuse', '128')).toBe(true);
    expect(buildArgs(BASE, LOCAL, 59999).argv).not.toContain('--cache-reuse');
  });

  it('splitMode tensor + tensorSplit 每 GPU 分配', () => {
    const { argv } = buildArgs({ ...BASE, splitMode: 'tensor', tensorSplit: '50,50' }, LOCAL, 59999);
    expect(hasPair(argv, '--split-mode', 'tensor')).toBe(true);
    expect(hasPair(argv, '--tensor-split', '50,50')).toBe(true);
  });

  it('MTP draft KV 量化：--spec-draft-type-k/v', () => {
    const { argv } = buildArgs({ ...BASE, specDraftTypeK: 'q8_0', specDraftTypeV: 'q4_0' }, LOCAL, 59999);
    expect(hasPair(argv, '--spec-draft-type-k', 'q8_0')).toBe(true);
    expect(hasPair(argv, '--spec-draft-type-v', 'q4_0')).toBe(true);
  });

  it('extraArgs shlex appended last, mapped to extraArgs', () => {
    const { argv, argToField } = buildArgs({ ...BASE, extraArgs: '--foo bar --baz "a b"' }, LOCAL, 59999);
    const i = argv.indexOf('--foo');
    expect(argv.slice(i)).toEqual(['--foo', 'bar', '--baz', 'a b']);
    expect(argToField['--foo']).toBe('extraArgs');
    expect(argToField['--baz']).toBe('extraArgs');
  });

  it('throws on incomplete model ref', () => {
    expect(() => buildArgs(BASE, { name: 'x', source: 'local' }, 59999)).toThrow();
    expect(() => buildArgs(BASE, { name: 'x', source: 'hf' }, 59999)).toThrow();
  });
});

describe('shlex', () => {
  it('splits on whitespace, keeps quoted spaces', () => {
    expect(shlex('a  b "c d" \'e f\'')).toEqual(['a', 'b', 'c d', 'e f']);
  });
  it('empty -> []', () => {
    expect(shlex('   ')).toEqual([]);
  });
});