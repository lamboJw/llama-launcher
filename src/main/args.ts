// args.ts — llama-server 命令行组装（规格 §5 / §5.3）
// 留空 = 不传；布尔恒显式 --flag / --no-flag；强制参数追加尾部；
// 表单可见端口/--host/CORS 四件套只作用于代理层，绝不传给 server
import type { FormValues, ModelRef } from '../shared/types.js';

export interface BuiltArgs {
  argv: string[];                       // exe 之后的全部参数
  env: Record<string, string>;          // 附加环境变量（HF_HUB_CACHE）
  argToField: Record<string, string>;   // '--xxx' -> 表单字段 key / 'extraArgs' / 'forced'
}

/** shell 风格分词：空白分割，单/双引号内保留空白 */
export function shlex(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let inS = false;
  let inD = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inD) { inS = !inS; has = true; continue; }
    if (c === '"' && !inS) { inD = !inD; has = true; continue; }
    if (/\s/.test(c) && !inS && !inD) {
      if (has) { out.push(cur); cur = ''; has = false; }
      continue;
    }
    cur += c;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

export function buildArgs(form: FormValues, model: ModelRef, internalPort: number): BuiltArgs {
  const argv: string[] = [];
  const env: Record<string, string> = {};
  const argToField: Record<string, string> = {};

  const str = (field: keyof FormValues, flag: string): void => {
    const v = form[field];
    if (typeof v === 'string' && v.trim() !== '') {
      argv.push(flag, v.trim());
      argToField[flag] = field;
    }
  };
  const bool = (field: keyof FormValues, flag: string): void => {
    const v = form[field];
    if (typeof v === 'boolean') {
      argv.push(v ? flag : `--no-${flag.slice(2)}`);
      argToField[flag] = field;
      argToField[`--no-${flag.slice(2)}`] = field;
    }
  };

  // 模型来源（规格 §5.3）
  if (model.source === 'local') {
    if (!model.local) throw new Error('local model ref missing path');
    argv.push('--model', model.local.path);
    argToField['--model'] = 'modelFile';
  } else {
    if (!model.hf) throw new Error('hf model ref missing repo');
    const repo = model.hf.quant ? `${model.hf.repo}:${model.hf.quant}` : model.hf.repo;
    argv.push('--hf-repo', repo, '--offline');
    argToField['--hf-repo'] = 'modelFile';
    argToField['--offline'] = 'modelFile';
    if (form.hfCacheDir.trim() !== '') env.HF_HUB_CACHE = form.hfCacheDir.trim();
  }

  // 模型组
  str('alias', '--alias');
  str('mmproj', '--mmproj');
  str('mmprojUrl', '--mmproj-url');
  bool('mmprojAuto', '--mmproj-auto');
  bool('mmprojOffload', '--mmproj-offload');
  str('imageMinTokens', '--image-min-tokens');
  str('imageMaxTokens', '--image-max-tokens');

  // 服务组（仅 server 相关；可见端口/proxyHost/CORS 四件套 → 代理层）
  str('apiKey', '--api-key');
  str('timeout', '--timeout');
  bool('jinja', '--jinja');
  bool('ui', '--ui');
  str('ssePingInterval', '--sse-ping-interval');

  // 硬件组
  str('nGpuLayers', '--n-gpu-layers');
  str('threads', '--threads');
  str('threadsBatch', '--threads-batch');
  str('splitMode', '--split-mode');
  str('device', '--device');
  str('loadMode', '--load-mode');
  bool('fit', '--fit');
  str('cacheTypeK', '--cache-type-k');
  str('cacheTypeV', '--cache-type-v');
  str('nCpuMoE', '--n-cpu-moe');

  // 上下文组
  str('ctxSize', '--ctx-size');
  str('parallel', '--parallel');
  str('batchSize', '--batch-size');
  str('ubatchSize', '--ubatch-size');
  str('cacheRam', '--cache-ram');
  str('flashAttn', '--flash-attn');
  bool('swaFull', '--swa-full');

  // 采样组
  str('temperature', '--temperature');
  str('topK', '--top-k');
  str('topP', '--top-p');
  str('minP', '--min-p');
  str('repeatPenalty', '--repeat-penalty');
  str('presencePenalty', '--presence-penalty');
  str('frequencyPenalty', '--frequency-penalty');
  str('repeatLastN', '--repeat-last-n');
  str('seed', '--seed');
  bool('ignoreEos', '--ignore-eos');
  str('reasoningEffort', '--reasoning-effort');
  bool('reasoningPreserve', '--reasoning-preserve');

  // 投机解码 (MTP) 组
  const specTypes = form.specType.split(',').map(s => s.trim()).filter(s => s !== '');
  if (specTypes.length > 0) {
    for (const t of specTypes) argv.push('--spec-type', t);
    argToField['--spec-type'] = 'specType';
  }
  str('specDraftModel', '--spec-draft-model');
  str('specDraftHf', '--spec-draft-hf');
  str('specDraftNMax', '--spec-draft-n-max');
  str('specDraftNMin', '--spec-draft-n-min');
  str('specDraftNgl', '--spec-draft-ngl');
  str('specDraftThreads', '--spec-draft-threads');
  str('specDraftPSplit', '--spec-draft-p-split');
  str('specDraftPMin', '--spec-draft-p-min');
  bool('specDefault', '--spec-default');

  // 高级组
  str('verbosity', '--verbosity');
  bool('warmup', '--warmup');
  bool('contextShift', '--context-shift');
  bool('cacheReuse', '--cache-reuse');
  bool('perf', '--perf');
  str('logPromptsDir', '--log-prompts-dir');
  str('mcpServersConfig', '--mcp-servers-config');
  str('mtmdBatchMaxTokens', '--mtmd-batch-max-tokens');
  bool('specDraftBackendSampling', '--spec-draft-backend-sampling');

  // 强制参数（用户不可改，追加尾部；server 永远只绑 127.0.0.1 内部端口）
  argv.push('--log-colors', 'on', '--metrics', '--host', '127.0.0.1', '--port', String(internalPort));
  for (const f of ['--log-colors', '--metrics', '--host', '--port']) argToField[f] = 'forced';

  // 附加参数（shlex 分词，最后追加 → 覆盖一切）
  if (form.extraArgs.trim() !== '') {
    for (const t of shlex(form.extraArgs)) {
      argv.push(t);
      if (t.startsWith('--')) argToField[t] = 'extraArgs';
    }
  }

  return { argv, env, argToField };
}