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
  device: '', loadMode: '', fit: '', tensorSplit: '',
  cacheTypeK: '', cacheTypeV: '', nCpuMoE: '',
  // 上下文组
  ctxSize: '', parallel: '', batchSize: '', ubatchSize: '', ctxCheckpoints: '',
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
  specDraftTypeK: '', specDraftTypeV: '',
  specDefault: false,
  // 高级组
  verbosity: '', warmup: true, contextShift: false, cacheReuse: '',
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

/**
 * 旧版配置迁移：
 * - fit：复选框布尔 → 字符串（true→'on'，false→'off'；llama-server --fit [on|off] 必须带值）
 * - cacheReuse：复选框布尔 → 字符串（--cache-reuse N 必须带数字；布尔无法忠实表达 → 置空=off）
 * 新字段缺失 → 补默认空串
 */
export function migrateForm(f: FormValues): FormValues {
  const o: FormValues = { ...f };
  const any = o as unknown as Record<string, unknown>;
  if (typeof any.fit === 'boolean') any.fit = (any.fit as boolean) ? 'on' : 'off';
  if (typeof any.cacheReuse === 'boolean') any.cacheReuse = '';
  // 旧版 specType 下拉给了 b10488 不存在的值（mtp/draft）→ 真实枚举值
  if (any.specType === 'mtp') any.specType = 'draft-mtp';
  else if (any.specType === 'draft') any.specType = 'draft-simple';
  // flash-attn 文档枚举为 on|off|auto（0/1 虽被强转接受，统一为文档值）
  if (any.flashAttn === '1') any.flashAttn = 'on';
  else if (any.flashAttn === '0') any.flashAttn = 'off';
  for (const k of ['tensorSplit', 'specDraftTypeK', 'specDraftTypeV'] as const) {
    if (typeof any[k] !== 'string') any[k] = '';
  }
  return o;
}

export class AppConfig {
  private store: JsonStore<Settings>;

  constructor(dir?: string) {
    this.store = new JsonStore<Settings>(dir ?? defaultConfigDir(), 'config', { form: { ...DEFAULT_FORM } });
    const cur = this.store.get().form;
    const fixed = migrateForm(cur);
    if (JSON.stringify(fixed) !== JSON.stringify(cur)) this.store.set({ form: fixed });
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