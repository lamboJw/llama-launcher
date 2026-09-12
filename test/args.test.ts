import { describe, it, expect } from 'vitest';
import { buildArgs, shlex } from '../src/main/args.js';
import type { FormValues, ModelRef } from '../src/shared/types.js';

const BASE: FormValues = {
  modelFile: '', alias: '', mmproj: '', mmprojUrl: '',
  mmprojAuto: true, mmprojOffload: true, mmprojDevice: '', imageMinTokens: '', imageMaxTokens: '',
  visiblePort: 8080, proxyHost: '127.0.0.1', apiKey: '', timeout: '',
  jinja: true, ui: true, ssePingInterval: '',
  corsOrigins: '', corsMethods: '', corsHeaders: '', corsCredentials: false,
  nGpuLayers: '', threads: '', threadsBatch: '', splitMode: '',
  device: '', loadMode: '', lazyMode: '', fit: '', tensorSplit: '', cacheTypeK: '', cacheTypeV: '', nCpuMoE: '', nCpuFfn: '',
  ctxSize: '', parallel: '', batchSize: '', ubatchSize: '', ctxCheckpoints: '',
  cacheRam: '', flashAttn: '', kvUnified: '', kvUnifiedPerSlot: '', swaFull: false,
  slotPromptSimilarity: '', slotSavePath: '', slots: true,
  temperature: '', topK: '', topP: '', minP: '',
  repeatPenalty: '', presencePenalty: '', frequencyPenalty: '',
  repeatLastN: '', seed: '', ignoreEos: false,
  reasoningEffort: '', reasoningPreserve: false,
  specType: '', specDraftModel: '', specDraftHf: '',
  specDraftNMax: '', specDraftNMin: '', specDraftNgl: '',
  specDraftThreads: '', specDraftPSplit: '', specDraftPMin: '', specDraftTypeK: '', specDraftTypeV: '',
  specNgramModNMatch: '', specNgramModNMin: '', specNgramModNMax: '', specDefault: false,
  verbosity: '', warmup: true, contextShift: false, cacheReuse: '',
  perf: false, logJsonl: false, logPromptsDir: '', mcpServersConfig: '',
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
  it('ctxCheckpoints → --ctx-checkpoints N（空 → 不传）', () => {
    const { argv } = buildArgs({ ...BASE, ctxCheckpoints: '16' }, LOCAL, 59999);
    expect(hasPair(argv, '--ctx-checkpoints', '16')).toBe(true);
    const none = buildArgs(BASE, LOCAL, 59999);
    expect(none.argv).not.toContain('--ctx-checkpoints');
  });

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

  it('lazyMode → --lazy-mode N（空 → 不传）', () => {
    expect(hasPair(buildArgs({ ...BASE, lazyMode: 'on' }, LOCAL, 59999).argv, '--lazy-mode', 'on')).toBe(true);
    expect(hasPair(buildArgs({ ...BASE, lazyMode: 'auto' }, LOCAL, 59999).argv, '--lazy-mode', 'auto')).toBe(true);
    expect(hasPair(buildArgs({ ...BASE, lazyMode: 'off' }, LOCAL, 59999).argv, '--lazy-mode', 'off')).toBe(true);
    expect(buildArgs(BASE, LOCAL, 59999).argv).not.toContain('--lazy-mode');
  });

  it('nCpuFfn → --n-cpu-ffn N（空 → 不传）', () => {
    expect(hasPair(buildArgs({ ...BASE, nCpuFfn: '3' }, LOCAL, 59999).argv, '--n-cpu-ffn', '3')).toBe(true);
    expect(buildArgs(BASE, LOCAL, 59999).argv).not.toContain('--n-cpu-ffn');
  });

  it('mmprojDevice → --mmproj-device（none/设备名透传，空 → 不传）', () => {
    expect(hasPair(buildArgs({ ...BASE, mmprojDevice: 'none' }, LOCAL, 59999).argv, '--mmproj-device', 'none')).toBe(true);
    expect(hasPair(buildArgs({ ...BASE, mmprojDevice: 'cuda1' }, LOCAL, 59999).argv, '--mmproj-device', 'cuda1')).toBe(true);
    expect(buildArgs(BASE, LOCAL, 59999).argv).not.toContain('--mmproj-device');
  });

  it('kvUnifiedPerSlot → --kv-unified-per-slot N（空 → 不传）', () => {
    expect(hasPair(buildArgs({ ...BASE, kvUnifiedPerSlot: '4096' }, LOCAL, 59999).argv, '--kv-unified-per-slot', '4096')).toBe(true);
    expect(buildArgs(BASE, LOCAL, 59999).argv).not.toContain('--kv-unified-per-slot');
  });

  it('logJsonl → --log-jsonl / --no-log-jsonl 恒显式成对', () => {
    const on = buildArgs({ ...BASE, logJsonl: true }, LOCAL, 59999);
    expect(on.argv).toContain('--log-jsonl');
    expect(on.argv).not.toContain('--no-log-jsonl');
    const off = buildArgs(BASE, LOCAL, 59999);
    expect(off.argv).toContain('--no-log-jsonl');
    expect(off.argv).not.toContain('--log-jsonl');
    expect(off.argToField['--log-jsonl']).toBe('logJsonl');
    expect(off.argToField['--no-log-jsonl']).toBe('logJsonl');
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

  it('hf source 带本地快照路径（localPath）→ --model，不再走 --hf-repo/--offline', () => {
    const model: ModelRef = { name: 'u/n', source: 'hf', hf: { ...HF.hf!, localPath: 'C:/hf/snapshots/abc/m.gguf' } };
    const { argv, env } = buildArgs(BASE, model, 59999);
    expect(hasPair(argv, '--model', 'C:/hf/snapshots/abc/m.gguf')).toBe(true);
    expect(argv).not.toContain('--hf-repo');
    expect(argv).not.toContain('--offline');
    expect(env).toEqual({});
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

  it('kvUnified：on/off 显式传 --kv-unified / --no-kv-unified，空=不传（auto）', () => {
    expect(buildArgs({ ...BASE, kvUnified: 'on' }, LOCAL, 59999).argv).toContain('--kv-unified');
    expect(buildArgs({ ...BASE, kvUnified: 'off' }, LOCAL, 59999).argv).toContain('--no-kv-unified');
    const argv = buildArgs(BASE, LOCAL, 59999).argv;
    expect(argv).not.toContain('--kv-unified');
    expect(argv).not.toContain('--no-kv-unified');
  });

  it('slot 参数：similarity/save-path 带值传（空=不传），slots 恒显式 --slots/--no-slots', () => {
    const on = buildArgs({ ...BASE, slotPromptSimilarity: '0.5', slotSavePath: 'C:/slots', slots: false }, LOCAL, 59999).argv;
    expect(hasPair(on, '--slot-prompt-similarity', '0.5')).toBe(true);
    expect(hasPair(on, '--slot-save-path', 'C:/slots')).toBe(true);
    expect(on).toContain('--no-slots');
    const base = buildArgs(BASE, LOCAL, 59999).argv;
    expect(base).not.toContain('--slot-prompt-similarity');
    expect(base).not.toContain('--slot-save-path');
    expect(base).toContain('--slots');
    expect(base).not.toContain('--no-slots');
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

  it('specType 含 ngram-mod → 传三个 ngram-mod 参数（MTP+N-gram 组合选项）', () => {
    const { argv } = buildArgs({
      ...BASE, specType: 'ngram-mod,draft-mtp',
      specNgramModNMatch: '24', specNgramModNMin: '48', specNgramModNMax: '64',
    }, LOCAL, 59999);
    expect(hasPair(argv, '--spec-type', 'ngram-mod')).toBe(true);
    expect(hasPair(argv, '--spec-type', 'draft-mtp')).toBe(true);
    const i = argv.indexOf('--spec-type');
    expect(argv.slice(i, i + 4)).toEqual(['--spec-type', 'ngram-mod', '--spec-type', 'draft-mtp']);
    expect(hasPair(argv, '--spec-ngram-mod-n-match', '24')).toBe(true);
    expect(hasPair(argv, '--spec-ngram-mod-n-min', '48')).toBe(true);
    expect(hasPair(argv, '--spec-ngram-mod-n-max', '64')).toBe(true);
  });

  it('ngram-mod 参数字段为空 → 不传对应 flag', () => {
    const { argv } = buildArgs({ ...BASE, specType: 'ngram-mod,draft-mtp' }, LOCAL, 59999);
    expect(argv).not.toContain('--spec-ngram-mod-n-match');
    expect(argv).not.toContain('--spec-ngram-mod-n-min');
    expect(argv).not.toContain('--spec-ngram-mod-n-max');
  });

  it('specType 不含 ngram-mod → 即使字段有值也不传 ngram-mod 参数', () => {
    const { argv } = buildArgs({
      ...BASE, specType: 'draft-mtp',
      specNgramModNMatch: '24', specNgramModNMin: '48', specNgramModNMax: '64',
    }, LOCAL, 59999);
    expect(argv).not.toContain('--spec-ngram-mod-n-match');
    expect(argv).not.toContain('--spec-ngram-mod-n-min');
    expect(argv).not.toContain('--spec-ngram-mod-n-max');
  });

  it('verbosity 支持 0-5（3=INFO 默认，4=TRACE，5=DEBUG）', () => {
    expect(hasPair(buildArgs({ ...BASE, verbosity: '5' }, LOCAL, 59999).argv, '--verbosity', '5')).toBe(true);
    expect(hasPair(buildArgs({ ...BASE, verbosity: '4' }, LOCAL, 59999).argv, '--verbosity', '4')).toBe(true);
    expect(buildArgs(BASE, LOCAL, 59999).argv).not.toContain('--verbosity');
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