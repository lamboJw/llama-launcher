// 共享类型：main / preload / renderer 用 import type 引用（编译后擦除，无运行时跨边界依赖）

export interface LocalModel {
  name: string;            // 子目录 → 目录名；散文件 → 去 .gguf 文件名
  path: string;            // 启动用路径（分片 → -00001-of- 首片）
  size: number;            // 字节（分片求和）
  mtime: number;           // 最新修改时间 ms
  mmproj: string | null;   // 同目录恰好 1 个 mmproj.*.gguf 时自动填入
  mmprojCandidates: string[]; // 多个候选（0/1 个时为空）
}

export interface HfModel {
  repo: string;            // <user>/<name>（目录名反解，原始大小写）
  path: string;            // snapshots/<commit>/ 目录
  size: number;            // 全部 gguf 字节和
  quants: string[];        // 可用量化（大写，如 Q4_K_M）
  quant: string | null;    // 默认量化：有 Q4_K_M 用之，否则第一个（与 llama.cpp 一致）
  mmproj: boolean;         // snapshot 内是否有 mmproj.*.gguf
  localPath?: string;      // 启动用 gguf 绝对路径（按 quant 选具体文件；绕过 llama.cpp refs/snapshot 严格解析）
}

export interface ModelRef {
  name: string;            // 列表显示名 / model 字段值（本地=目录名或文件名，HF=repo 名）
  source: 'local' | 'hf';  // 同名冲突时本地优先
  local?: LocalModel;
  hf?: HfModel;
}

export interface FormValues {
  // 模型组
  modelFile: string; alias: string; mmproj: string; mmprojUrl: string;
  mmprojAuto: boolean; mmprojOffload: boolean;
  imageMinTokens: string; imageMaxTokens: string;
  // 服务组（visiblePort/proxyHost 只作用于代理层）
  visiblePort: number; proxyHost: string; apiKey: string; timeout: string;
  jinja: boolean; ui: boolean; ssePingInterval: string;
  corsOrigins: string; corsMethods: string; corsHeaders: string; corsCredentials: boolean;
  // 硬件组
  nGpuLayers: string; threads: string; threadsBatch: string; splitMode: string;
  device: string; loadMode: string; fit: string; tensorSplit: string;
  cacheTypeK: string; cacheTypeV: string; nCpuMoE: string;
  // 上下文组
  ctxSize: string; parallel: string; batchSize: string; ubatchSize: string;
  ctxCheckpoints: string;
  cacheRam: string; flashAttn: string; swaFull: boolean;
  // 采样组
  temperature: string; topK: string; topP: string; minP: string;
  repeatPenalty: string; presencePenalty: string; frequencyPenalty: string;
  repeatLastN: string; seed: string; ignoreEos: boolean;
  reasoningEffort: string; reasoningPreserve: boolean;
  // 投机解码 (MTP) 组
  specType: string; specDraftModel: string; specDraftHf: string;
  specDraftNMax: string; specDraftNMin: string; specDraftNgl: string;
  specDraftThreads: string; specDraftPSplit: string; specDraftPMin: string;
  specDraftTypeK: string; specDraftTypeV: string;
  specDefault: boolean;
  // 高级组
  verbosity: string; warmup: boolean; contextShift: boolean; cacheReuse: string;
  perf: boolean; logPromptsDir: string; mcpServersConfig: string;
  mtmdBatchMaxTokens: string; specDraftBackendSampling: boolean; extraArgs: string;
  // App 级（非 server 参数）
  autoSwitch: boolean; hfCacheDir: string; recordRounds: boolean;
  scanDir: string; exeSelection: string; recordsMaxTotalBytes: number;
}

export interface Settings { form: FormValues; lastModel?: string }

export interface TimingEvent {
  kind: 'prompt' | 'eval';
  ms: number; tokens: number; msPerToken: number; tps: number;
}

export interface RequestStats {
  model: string; ttftMs: number | null; cacheHitRate: number | null; ts: number;
  // b10488 响应自带 timings（SSE 尾部 chunk / 非流式）→ 直读，免日志配对
  prefillMs: number | null; prefillTps: number | null; decodeTps: number | null;
}

export interface RoundStats {
  ts: number; model: string | null;
  ttftMs: number | null; prefillMs: number | null; prefillTps: number | null;
  decodeTps: number | null; cacheHitRate: number | null;
}

export interface RoundRecord {
  ts: number; model: string; prompt: string; decode: string;
  ttft_ms: number | null; usage: unknown;
}

export interface Profile { model: string; params: FormValues; savedAt: number }

export interface InstalledVersion { tag: string; cudaVersion: string | null; installedAt: number; valid?: boolean }

export interface ServerState {
  status: 'stopped' | 'starting' | 'running' | 'switching' | 'crashed';
  port: number | null; model: string | null; exitCode: number | null;
}

export interface SwitchState { switching: boolean; from: string | null; to: string | null }

export interface ParsedVersion { build: number | null; commit: string | null; raw: string }

export interface UpdateProgress {
  phase: 'check' | 'download-main' | 'download-cuda' | 'extract' | 'verify' | 'prune' | 'done' | 'error';
  pct: number;      // 0..1，-1 = 未知
  mbps: number;     // 下载速率
  message: string;
}
