import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProfilesStore, profileFileFor } from '../src/main/profiles.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FormValues } from '../src/shared/types.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prof-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const PARAMS: FormValues = {
  modelFile: 'C:/models/m.gguf', alias: '', mmproj: '', mmprojUrl: '',
  mmprojAuto: true, mmprojOffload: true, imageMinTokens: '', imageMaxTokens: '',
  visiblePort: 8080, proxyHost: '127.0.0.1', apiKey: '', timeout: '',
  jinja: true, ui: true, ssePingInterval: '',
  corsOrigins: '', corsMethods: '', corsHeaders: '', corsCredentials: false,
  nGpuLayers: '99', threads: '', threadsBatch: '', splitMode: '',
  device: '', loadMode: '', fit: true, cacheTypeK: '', cacheTypeV: '', nCpuMoE: '',
  ctxSize: '4096', parallel: '', batchSize: '', ubatchSize: '',
  cacheRam: '', flashAttn: '', swaFull: false,
  temperature: '', topK: '', topP: '', minP: '',
  repeatPenalty: '', presencePenalty: '', frequencyPenalty: '',
  repeatLastN: '', seed: '', ignoreEos: false,
  reasoningEffort: '', reasoningPreserve: false,
  specType: '', specDraftModel: '', specDraftHf: '',
  specDraftNMax: '', specDraftNMin: '', specDraftNgl: '',
  specDraftThreads: '', specDraftPSplit: '', specDraftPMin: '', specDefault: false,
  verbosity: '', warmup: true, contextShift: false, cacheReuse: false,
  perf: false, logPromptsDir: '', mcpServersConfig: '',
  mtmdBatchMaxTokens: '', specDraftBackendSampling: false, extraArgs: '--foo bar',
  autoSwitch: false, hfCacheDir: '', recordRounds: false,
  scanDir: '', exeSelection: '', recordsMaxTotalBytes: 1073741824,
};

describe('ProfilesStore', () => {
  it('save/load round-trip', async () => {
    const s = new ProfilesStore(dir);
    await s.save('user/model-a', PARAMS);
    const p = await s.load('user/model-a');
    expect(p).not.toBeNull();
    expect(p!.model).toBe('user/model-a');
    expect(p!.params.nGpuLayers).toBe('99');
    expect(p!.params.extraArgs).toBe('--foo bar');
  });

  it('load missing -> null', async () => {
    expect(await new ProfilesStore(dir).load('nope')).toBeNull();
  });

  it('corrupt profile -> null', async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(profileFileFor(dir, 'bad'), '{oops', 'utf8');
    expect(await new ProfilesStore(dir).load('bad')).toBeNull();
  });

  it('list sorted by savedAt desc, skips corrupt', async () => {
    const s = new ProfilesStore(dir);
    await s.save('m1', PARAMS);
    await new Promise(r => setTimeout(r, 5));
    await s.save('m2', { ...PARAMS, nGpuLayers: '1' });
    await fs.writeFile(profileFileFor(dir, 'bad'), '{oops', 'utf8');
    const list = await s.list();
    expect(list.map(p => p.model)).toEqual(['m2', 'm1']);
  });

  it('delete removes profile', async () => {
    const s = new ProfilesStore(dir);
    await s.save('m1', PARAMS);
    await s.delete('m1');
    expect(await s.load('m1')).toBeNull();
  });
});