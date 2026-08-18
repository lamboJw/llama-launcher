// config.ts — electron-store 语义的 JSON 配置仓库（自实现：纯 Node 可测，原子写）
// 持久化位置：%APPDATA%/llama-launcher/config.json（规格 §5.2）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FormValues, Settings } from '../shared/types.js';

export const DEFAULT_HF_CACHE = path.join(os.homedir(), '.cache', 'huggingface', 'hub');

export const DEFAULT_FORM: FormValues = {
  // 模型组
  modelFile: '', alias: '', mmproj: '', mmprojUrl: '',
  mmprojAuto: true, mmprojOffload: true,
  imageMinTokens: '', imageMaxTokens: '',
  // 服务组
  visiblePort: 8080, proxyHost: '127.0.0.1', apiKey: '', timeout: '',
  jinja: true, ui: true, ssePingInterval: '',
  corsOrigins: '', corsMethods: '', corsHeaders: '', corsCredentials: false,
  // 硬件组
  nGpuLayers: '', threads: '', threadsBatch: '', splitMode: '',
  device: '', loadMode: '', fit: true,
  cacheTypeK: '', cacheTypeV: '', nCpuMoE: '',
  // 上下文组
  ctxSize: '', parallel: '', batchSize: '', ubatchSize: '',
  cacheRam: '', flashAttn: '', swaFull: false,
  // 采样组
  temperature: '', topK: '', topP: '', minP: '',
  repeatPenalty: '', presencePenalty: '', frequencyPenalty: '',
  repeatLastN: '', seed: '', ignoreEos: false,
  reasoningEffort: '', reasoningPreserve: false,
  // 投机解码 (MTP) 组
  specType: '', specDraftModel: '', specDraftHf: '',
  specDraftNMax: '', specDraftNMin: '', specDraftNgl: '',
  specDraftThreads: '', specDraftPSplit: '', specDraftPMin: '',
  specDefault: false,
  // 高级组
  verbosity: '', warmup: true, contextShift: false, cacheReuse: false,
  perf: false, logPromptsDir: '', mcpServersConfig: '',
  mtmdBatchMaxTokens: '', specDraftBackendSampling: false, extraArgs: '',
  // App 级
  autoSwitch: false, hfCacheDir: DEFAULT_HF_CACHE, recordRounds: false,
  scanDir: '', exeSelection: '', recordsMaxTotalBytes: 1024 * 1024 * 1024,
};

export class JsonStore<T extends object> {
  private file: string;
  private data: T;

  constructor(dir: string, name: string, defaults: T) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, name + '.json');
    this.data = this.load(defaults);
  }

  private load(defaults: T): T {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      return { ...defaults, ...(JSON.parse(raw) as Partial<T>) };
    } catch {
      return { ...defaults };
    }
  }

  get(): T { return this.data; }

  set(patch: Partial<T>): T {
    this.data = { ...this.data, ...patch };
    this.save();
    return this.data;
  }

  save(): void {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}

export function defaultConfigDir(): string {
  const appdata = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appdata, 'llama-launcher');
}

export class AppConfig {
  private store: JsonStore<Settings>;

  constructor(dir?: string) {
    this.store = new JsonStore<Settings>(dir ?? defaultConfigDir(), 'config', { form: { ...DEFAULT_FORM } });
  }

  getSettings(): Settings { return this.store.get(); }

  saveSettings(s: Settings): void { this.store.set({ form: s.form }); }

  updateForm(patch: Partial<FormValues>): FormValues {
    const cur = this.store.get();
    const form = { ...cur.form, ...patch };
    this.store.set({ form });
    return form;
  }
}