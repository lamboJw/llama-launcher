// renderer/main.ts — 主 UI（规格 §3：顶栏 / 左栏设置 / 右栏 tabs）；Task 16-17 填充统计/聊天/轮次记录
import { ansiHtml } from './ansi.js';
import type { FormValues, ModelRef, ServerState, Profile, RoundRecord, RoundStats, UpdateProgress, InstalledVersion } from '../shared/types.js';

interface BootState {
  appRoot: string;
  form: FormValues;
  server: ServerState;
  union: ModelRef[];
  installed: InstalledVersion[];
  banner: { version: string | null; update: string | null };
  stats: { latest: RoundStats | null; history: RoundStats[] };
  recordsDir: string;
}

interface ExitInfo { code: number | null; early: boolean; stderr: string; intentional: boolean }

declare global {
  interface Window {
    llama: {
      boot(): Promise<BootState>;
      scanModels(dir: string): Promise<unknown>;
      startServer(form: FormValues, model: ModelRef): Promise<void>;
      stopServer(): Promise<void>;
      saveForm(form: FormValues): Promise<void>;
      listProfiles(): Promise<Profile[]>;
      saveProfile(model: string, params: FormValues): Promise<void>;
      loadProfile(model: string): Promise<Profile | null>;
      deleteProfile(model: string): Promise<void>;
      checkUpdate(): Promise<{ latest: { tag_name: string; assets: unknown[] } | null; installed: InstalledVersion[] }>;
      runUpdate(tag: string): Promise<{ ok: boolean; error?: string }>;
      openDirDialog(defaultPath?: string): Promise<string | null>;
      pickFile(): Promise<string | null>;
      recordFiles(): Promise<string[]>;
      recordsTail(page: number): Promise<{ records: RoundRecord[]; hasMore: boolean }>;
      on(channel: string, cb: (payload: unknown) => void): () => void;
    };
  }
}

// ---------- 表单字段定义 ----------
type FieldSpec = { id: keyof FormValues; label: string; type: 'text' | 'number' | 'checkbox' | 'select'; options?: [string, string][] };

const GROUPS: { title: string; fields: FieldSpec[] }[] = [
  { title: '模型', fields: [
    { id: 'alias', label: '模型别名 (alias)', type: 'text' },
    { id: 'mmprojAuto', label: '自动探测 mmproj（视觉）', type: 'checkbox' },
    { id: 'mmproj', label: 'mmproj 路径（手动）', type: 'text' },
    { id: 'mmprojUrl', label: 'mmproj URL', type: 'text' },
    { id: 'mmprojOffload', label: 'mmproj 放到 GPU', type: 'checkbox' },
    { id: 'imageMinTokens', label: '图像最小 token 数', type: 'text' },
    { id: 'imageMaxTokens', label: '图像最大 token 数', type: 'text' },
  ]},
  { title: '服务', fields: [
    { id: 'visiblePort', label: '可见端口（代理）', type: 'number' },
    { id: 'proxyHost', label: '代理监听地址', type: 'text' },
    { id: 'apiKey', label: 'API Key（空=不鉴权）', type: 'text' },
    { id: 'timeout', label: '超时（秒）', type: 'text' },
    { id: 'jinja', label: 'Jinja 模板', type: 'checkbox' },
    { id: 'ui', label: '内置 WebUI', type: 'checkbox' },
    { id: 'ssePingInterval', label: 'SSE ping 间隔（秒）', type: 'text' },
    { id: 'corsOrigins', label: 'CORS Origins', type: 'text' },
    { id: 'corsMethods', label: 'CORS Methods', type: 'text' },
    { id: 'corsHeaders', label: 'CORS Headers', type: 'text' },
    { id: 'corsCredentials', label: 'CORS withCredentials', type: 'checkbox' },
  ]},
  { title: '硬件', fields: [
    { id: 'nGpuLayers', label: 'GPU 层数 (n-gpu-layers)', type: 'text' },
    { id: 'threads', label: '线程数 (threads)', type: 'text' },
    { id: 'threadsBatch', label: '批处理线程', type: 'text' },
    { id: 'splitMode', label: 'GPU 切分方式', type: 'select', options: [['', '默认'], ['layer', 'layer'], ['row', 'row'], ['tensor', 'tensor']] },
    { id: 'tensorSplit', label: 'Tensor 切分 (tensor-split，如 50,50)', type: 'text' },
    { id: 'device', label: '设备 (device)', type: 'text' },
    { id: 'loadMode', label: '内存 (mlock/mmap)', type: 'text' },
    { id: 'fit', label: '自动适配 (fit)', type: 'select', options: [['', '默认(不传)'], ['on', 'on'], ['off', 'off']] },
    { id: 'cacheTypeK', label: 'K 缓存类型', type: 'text' },
    { id: 'cacheTypeV', label: 'V 缓存类型', type: 'text' },
    { id: 'nCpuMoE', label: 'CPU MoE 专家数', type: 'text' },
  ]},
  { title: '上下文', fields: [
    { id: 'ctxSize', label: '上下文长度 (ctx-size)', type: 'text' },
    { id: 'parallel', label: '并行槽位 (parallel)', type: 'text' },
    { id: 'batchSize', label: 'batch-size', type: 'text' },
    { id: 'ubatchSize', label: 'ubatch-size', type: 'text' },
    { id: 'cacheRam', label: 'KV 缓存内存 (GB)', type: 'text' },
    { id: 'flashAttn', label: 'Flash attention', type: 'select', options: [['', '默认(auto)'], ['on', 'on'], ['off', 'off'], ['auto', 'auto']] },
    { id: 'swaFull', label: 'SWA 全注意力', type: 'checkbox' },
  ]},
  { title: '采样', fields: [
    { id: 'temperature', label: 'temperature', type: 'text' },
    { id: 'topK', label: 'top-k', type: 'text' },
    { id: 'topP', label: 'top-p', type: 'text' },
    { id: 'minP', label: 'min-p', type: 'text' },
    { id: 'repeatPenalty', label: 'repeat-penalty', type: 'text' },
    { id: 'presencePenalty', label: 'presence-penalty', type: 'text' },
    { id: 'frequencyPenalty', label: 'frequency-penalty', type: 'text' },
    { id: 'repeatLastN', label: 'repeat-last-n', type: 'text' },
    { id: 'seed', label: 'seed（-1=随机）', type: 'text' },
    { id: 'ignoreEos', label: 'ignore-eos', type: 'checkbox' },
    { id: 'reasoningEffort', label: 'reasoning-effort', type: 'text' },
    { id: 'reasoningPreserve', label: 'reasoning-preserve', type: 'checkbox' },
  ]},
  { title: '投机解码 (MTP)', fields: [
    { id: 'specDefault', label: '默认启用 (spec-default)', type: 'checkbox' },
    { id: 'specType', label: '方式（spec-type）', type: 'select', options: [['', '无(none)'], ['draft-mtp', 'draft-mtp（MTP）'], ['draft-simple', 'draft-simple（草稿模型）'], ['draft-eagle3', 'draft-eagle3'], ['draft-dflash', 'draft-dflash'], ['draft-dspark', 'draft-dspark'], ['ngram-simple', 'ngram-simple'], ['ngram-map-k', 'ngram-map-k'], ['ngram-map-k4v', 'ngram-map-k4v'], ['ngram-mod', 'ngram-mod'], ['ngram-cache', 'ngram-cache']] },
    { id: 'specDraftModel', label: '草稿模型（本地）', type: 'text' },
    { id: 'specDraftHf', label: '草稿模型（HF）', type: 'text' },
    { id: 'specDraftNMax', label: 'n-max', type: 'text' },
    { id: 'specDraftNMin', label: 'n-min', type: 'text' },
    { id: 'specDraftNgl', label: 'n-gl', type: 'text' },
    { id: 'specDraftThreads', label: 'threads', type: 'text' },
    { id: 'specDraftPSplit', label: 'p-split', type: 'text' },
    { id: 'specDraftPMin', label: 'p-min', type: 'text' },
    { id: 'specDraftTypeK', label: 'draft K 缓存类型 (spec-draft-type-k)', type: 'text' },
    { id: 'specDraftTypeV', label: 'draft V 缓存类型 (spec-draft-type-v)', type: 'text' },
  ]},
  { title: '高级', fields: [
    { id: 'verbosity', label: '日志详细程度', type: 'select', options: [['', '默认(3=INFO)'], ['0', '0（generic output）'], ['1', '1（error）'], ['2', '2（warning）'], ['3', '3（INFO）'], ['4', '4（TRACE）'], ['5', '5（DEBUG）']] },
    { id: 'warmup', label: 'warmup 运行', type: 'checkbox' },
    { id: 'contextShift', label: 'context shift', type: 'checkbox' },
    { id: 'cacheReuse', label: 'KV 缓存复用 (cache-reuse N)', type: 'text' },
    { id: 'perf', label: '性能日志 (perf)', type: 'checkbox' },
    { id: 'logPromptsDir', label: 'prompt 保存目录', type: 'text' },
    { id: 'mcpServersConfig', label: 'MCP 配置', type: 'text' },
    { id: 'mtmdBatchMaxTokens', label: 'mtmd batch 最大 token', type: 'text' },
    { id: 'specDraftBackendSampling', label: 'spec draft 后端采样', type: 'checkbox' },
    { id: 'extraArgs', label: '额外参数（原样追加）', type: 'text' },
  ]},
];

// ---------- 状态 ----------
let form: FormValues | null = null;
let union: ModelRef[] = [];
let installed: InstalledVersion[] = [];
let latestTag: string | null = null;
let serverState: ServerState = { status: 'stopped', port: null, model: null, exitCode: null };
let activeTab = 'logs';
let recordsDir = '';
let recPage = 0;
let recHasMore = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const modelSelect = $<HTMLSelectElement>('model-select');
const autoSwitchBox = $<HTMLInputElement>('auto-switch');
const btnStart = $<HTMLButtonElement>('btn-start');
const btnStop = $<HTMLButtonElement>('btn-stop');

// ---------- 表单构建 ----------
function buildForm(): void {
  const host = $<HTMLDivElement>('form-groups');
  host.textContent = '';
  for (const g of GROUPS) {
    const det = document.createElement('details');
    det.open = g.title === '模型' || g.title === '服务';
    const sum = document.createElement('summary');
    sum.textContent = g.title;
    det.appendChild(sum);
    for (const f of g.fields) det.appendChild(buildField(f));
    host.appendChild(det);
  }
  // App 组（特殊字段）
  const appHost = $<HTMLDivElement>('app-fields');
  appHost.textContent = '';
  appHost.appendChild(buildField({ id: 'autoSwitch', label: '自动切换（代理按请求切模型）', type: 'checkbox' }));
  appHost.appendChild(buildDirField('scanDir', '模型扫描目录'));
  appHost.appendChild(buildDirField('hfCacheDir', 'HF 缓存目录'));
  appHost.appendChild(buildExeField());
  appHost.appendChild(buildField({ id: 'recordRounds', label: '记录每轮 prompt/decode', type: 'checkbox' }));
  appHost.appendChild(buildField({ id: 'recordsMaxTotalBytes', label: '记录总上限 (MB)', type: 'number' }));
}

function buildField(f: FieldSpec): HTMLElement {
  const row = document.createElement('div');
  row.className = 'field';
  const label = document.createElement('label');
  label.textContent = f.label;
  row.appendChild(label);
  let el: HTMLInputElement | HTMLSelectElement;
  if (f.type === 'checkbox') {
    el = document.createElement('input');
    (el as HTMLInputElement).type = 'checkbox';
    (el as HTMLInputElement).addEventListener('change', () => { if (form) { form[f.id] = (el as HTMLInputElement).checked as never; scheduleSave(); } });
  } else if (f.type === 'select') {
    el = document.createElement('select');
    for (const [v, lab] of f.options ?? []) {
      const o = document.createElement('option');
      o.value = v; o.textContent = lab;
      el.appendChild(o);
    }
    el.addEventListener('change', () => { if (form) { form[f.id] = el.value as never; scheduleSave(); } });
  } else {
    el = document.createElement('input');
    (el as HTMLInputElement).type = f.type;
    (el as HTMLInputElement).addEventListener('change', () => {
      if (!form) return;
      const v = (el as HTMLInputElement).value;
      form[f.id] = (f.type === 'number' ? Number(v) : v) as never;
      scheduleSave();
    });
  }
  el.id = `f-${String(f.id)}`;
  row.appendChild(el);
  const spacer = document.createElement('span');
  row.appendChild(spacer);
  if (f.type === 'checkbox') el.style.gridColumn = '2';
  return row;
}

function buildDirField(id: 'scanDir' | 'hfCacheDir', label: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'field';
  const lab = document.createElement('label');
  lab.textContent = label;
  row.appendChild(lab);
  const input = document.createElement('input');
  input.type = 'text';
  input.id = `f-${id}`;
  input.addEventListener('change', () => { if (form) { form[id] = input.value; scheduleSave(); } });
  row.appendChild(input);
  const btn = document.createElement('button');
  btn.textContent = '浏览…';
  btn.style.padding = '3px 8px';
  btn.addEventListener('click', async () => {
    const dir = await window.llama.openDirDialog(input.value);
    if (dir !== null) { input.value = dir; if (form) { form[id] = dir; scheduleSave(); } }
  });
  row.appendChild(btn);
  return row;
}

function buildExeField(): HTMLElement {
  const row = document.createElement('div');
  row.className = 'field';
  const lab = document.createElement('label');
  lab.textContent = 'llama.cpp 版本';
  row.appendChild(lab);
  const sel = document.createElement('select');
  sel.id = 'exe-select';
  row.appendChild(sel);
  const spacer = document.createElement('span');
  row.appendChild(spacer);
  const row2 = document.createElement('div');
  row2.className = 'field';
  row2.style.marginLeft = '8px';
  row2.style.display = 'none';
  const lab2 = document.createElement('label');
  lab2.textContent = '自定义 exe 路径';
  row2.appendChild(lab2);
  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'exe-custom';
  row2.appendChild(input);
  const s2 = document.createElement('span');
  row2.appendChild(s2);
  const sync = (): void => {
    if (!form) return;
    const custom = sel.value === '__custom__';
    row2.style.display = custom ? 'grid' : 'none';
    form.exeSelection = custom ? input.value : sel.value;
    scheduleSave();
  };
  sel.addEventListener('change', sync);
  input.addEventListener('change', sync);
  const btn2 = document.createElement('button');
  btn2.textContent = '浏览…';
  btn2.style.padding = '3px 8px';
  btn2.addEventListener('click', async () => {
    const f = await window.llama.pickFile();
    if (f !== null) { input.value = f; sync(); }
  });
  row2.appendChild(btn2);
  (sel as HTMLSelectElement & { __sync?: () => void }).__sync = sync;
  row.appendChild(row2); // 修复：自定义路径输入行此前未挂载到 DOM，选「自定义路径…」后无处填写
  return row;
}

function fillExeOptions(): void {
  const sel = $<HTMLSelectElement>('exe-select');
  const cur = form ? form.exeSelection : '';
  sel.textContent = '';
  const o0 = document.createElement('option');
  o0.value = '';
  const hasBaseline = installed.some((v) => v.tag === 'b10488' && v.valid !== false);
  o0.textContent = hasBaseline ? '默认（托管基线 b10488）' : '默认（托管基线 b10488，未安装）';
  sel.appendChild(o0);
  for (const v of installed) {
    const o = document.createElement('option');
    o.value = v.tag;
    o.textContent = `${v.tag}${v.valid === false ? '（校验失败）' : ''}${v.cudaVersion ? ` CUDA ${v.cudaVersion}` : ''}（已安装）`;
    sel.appendChild(o);
  }
  const oc = document.createElement('option');
  oc.value = '__custom__'; oc.textContent = '自定义路径…';
  sel.appendChild(oc);
  if (cur === '') sel.value = '';
  else if (installed.some((v) => v.tag === cur)) sel.value = cur;
  else { sel.value = '__custom__'; (document.getElementById('exe-custom') as HTMLInputElement).value = cur; }
}

// ---------- 表单填充 ----------
function populateForm(): void {
  if (!form) return;
  for (const g of GROUPS) {
    for (const f of g.fields) {
      const el = document.getElementById(`f-${String(f.id)}`);
      if (!el) continue;
      const v = form[f.id];
      if (f.type === 'checkbox') (el as HTMLInputElement).checked = v === true;
      else (el as HTMLInputElement | HTMLSelectElement).value = String(v ?? '');
    }
  }
  const set = (id: string, v: unknown): void => {
    const el = document.getElementById(`f-${id}`);
    if (!el) return;
    if ((el as HTMLInputElement).type === 'checkbox') (el as HTMLInputElement).checked = v === true;
    else (el as HTMLInputElement | HTMLSelectElement).value = String(v ?? '');
  };
  set('recordRounds', form.recordRounds);
  const mbEl = document.getElementById('f-recordsMaxTotalBytes') as HTMLInputElement | null;
  if (mbEl) mbEl.value = String(Math.round(form.recordsMaxTotalBytes / 1048576));
  set('scanDir', form.scanDir);
  set('hfCacheDir', form.hfCacheDir);
  const autoEl = document.getElementById('f-autoSwitch') as HTMLInputElement | null;
  if (autoEl) autoEl.checked = form.autoSwitch;
  autoSwitchBox.checked = form.autoSwitch;
  fillExeOptions();
  (document.getElementById('exe-select') as HTMLSelectElement & { __sync?: () => void })?.__sync?.();
}

// ---------- 保存（防抖 600ms，成功后提示「已自动保存」） ----------
let hintTimer: ReturnType<typeof setTimeout> | null = null;
function showSaveHint(): void {
  const el = $<HTMLDivElement>('save-hint');
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  el.textContent = `设置已自动保存 ${t}`;
  el.classList.add('ok');
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    el.textContent = '';
    el.classList.remove('ok');
  }, 3000);
}
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!form) return;
    void window.llama.saveForm(form)
      .then(() => showSaveHint())
      .catch((e) => showTopError(`保存设置失败: ${String(e)}`));
  }, 600);
}

function showTopError(msg: string): void {
  const el = $<HTMLSpanElement>('top-error');
  el.textContent = msg;
  setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 10000);
}

// ---------- 模型下拉 ----------
function buildModelSelect(current: string | null): void {
  modelSelect.textContent = '';
  if (union.length === 0) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = '（无模型：请设置模型扫描目录）';
    modelSelect.appendChild(o);
    return;
  }
  for (const m of union) {
    const o = document.createElement('option');
    o.value = m.name;
    o.textContent = `${m.name}${m.source === 'hf' ? ' [HF]' : ''}${m.local?.mmproj ? ' +mmproj' : ''}`;
    modelSelect.appendChild(o);
  }
  if (current !== null) {
    const hit = union.find((m) => m.name.toLowerCase() === current.toLowerCase());
    if (hit) modelSelect.value = hit.name;
  }
}

// ---------- 状态渲染 ----------
const STATUS_UI: Record<ServerState['status'], [string, string]> = {
  stopped: ['已停止', 'gray'],
  starting: ['启动中…', 'yellow'],
  running: ['运行中', 'green'],
  switching: ['切换模型中…', 'cyan'],
  crashed: ['已崩溃', 'red'],
};

function renderState(s: ServerState): void {
  serverState = s;
  const [text, color] = STATUS_UI[s.status];
  const badge = $<HTMLSpanElement>('status-badge');
  badge.textContent = s.status === 'crashed' && s.exitCode !== null ? `${text} (exit ${s.exitCode})` : text;
  badge.className = `badge ${color}`;
  const info = $<HTMLSpanElement>('port-info');
  const parts: string[] = [];
  if (s.model !== null) parts.push(s.model);
  if (s.port !== null && form) parts.push(`内部 :${s.port} → 可见 :${form.visiblePort}`);
  info.textContent = parts.join('  ');
  const busy = s.status === 'starting' || s.status === 'switching';
  btnStart.disabled = busy;
  btnStart.textContent = s.status === 'running' || s.status === 'switching' ? '重启（新模型）' : '启动';
  btnStop.disabled = s.status === 'stopped' || s.status === 'starting';
}

// ---------- 日志 ----------
const MAX_LOG_LINES = 3000;
function appendLog(lines: string[], cls = ''): void {
  const view = $<HTMLDivElement>('log-view');
  const follow = ($<HTMLInputElement>('log-follow')).checked;
  const nearBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 48;
  for (const line of lines) {
    const div = document.createElement('div');
    div.className = `log-line${cls ? ` ${cls}` : ''}`;
    div.innerHTML = cls === 'crash' ? line.replace(/&/g, '&amp;').replace(/</g, '&lt;') : ansiHtml(line);
    view.appendChild(div);
  }
  while (view.children.length > MAX_LOG_LINES) view.removeChild(view.firstChild!);
  if (follow && nearBottom) view.scrollTop = view.scrollHeight;
}

// ---------- 横幅 ----------
function renderBanner(b: { version: string | null; update: string | null }): void {
  const v = $<HTMLSpanElement>('banner-version');
  v.textContent = b.version ?? '';
  v.className = `banner${b.version && b.version.includes('低于基线') ? ' warn' : ''}`;
  const u = $<HTMLSpanElement>('banner-update');
  u.textContent = b.update ?? '';
  u.className = 'banner info';
}

// ---------- Profiles（选中即应用 / 手动保存，规格 §5.1） ----------
async function refreshProfiles(): Promise<void> {
  const list = await window.llama.listProfiles();
  const sel = $<HTMLSelectElement>('profile-select');
  sel.textContent = '';
  const o0 = document.createElement('option');
  o0.value = ''; o0.textContent = '（已保存的参数组）';
  sel.appendChild(o0);
  for (const p of list) {
    const o = document.createElement('option');
    o.value = p.model;
    o.textContent = `${p.model}  ${new Date(p.savedAt).toLocaleString()}`;
    sel.appendChild(o);
  }
}

function currentModelKey(): string | null {
  const m = union.find((x) => x.name === modelSelect.value);
  if (!m) return null;
  return m.local ? m.local.path : m.name;
}

// ---------- 更新 ----------
async function doCheckUpdate(): Promise<void> {
  const st = $<HTMLDivElement>('update-status');
  st.textContent = '检查中…';
  try {
    const r = await window.llama.checkUpdate();
    installed = r.installed;
    latestTag = r.latest ? r.latest.tag_name : null;
    const run = $<HTMLButtonElement>('btn-update-run');
    run.disabled = latestTag === null;
    st.textContent = latestTag ? `最新版本 ${latestTag}` : '已是最新';
    fillExeOptions();
  } catch (e) {
    st.textContent = `检查失败: ${String(e)}`;
  }
}

// ---------- 统计（规格 §7：5 卡片 + 最近 20 行） ----------
const fmtMs = (v: number | null): string => (v === null ? '-' : v < 1000 ? `${v.toFixed(0)} ms` : `${(v / 1000).toFixed(2)} s`);
const fmtTps = (v: number | null): string => (v === null ? '-' : `${v.toFixed(1)} tok/s`);
const fmtPct = (v: number | null): string => (v === null ? '-' : `${(v * 100).toFixed(1)} %`);

function renderStats(latest: RoundStats | null, history: RoundStats[]): void {
  const set = (id: string, v: string): void => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('st-ttft', fmtMs(latest?.ttftMs ?? null));
  set('st-ptps', fmtTps(latest?.prefillTps ?? null));
  set('st-dtps', fmtTps(latest?.decodeTps ?? null));
  set('st-pms', fmtMs(latest?.prefillMs ?? null));
  set('st-cache', fmtPct(latest?.cacheHitRate ?? null));
  const tbody = document.getElementById('stat-tbody');
  if (!tbody) return;
  tbody.textContent = '';
  for (const r of [...history].slice(-20).reverse()) {
    const tr = document.createElement('tr');
    const cells = [
      new Date(r.ts).toLocaleTimeString(),
      r.model ?? '',
      fmtMs(r.ttftMs),
      fmtMs(r.prefillMs),
      fmtTps(r.prefillTps),
      fmtTps(r.decodeTps),
      fmtPct(r.cacheHitRate),
    ];
    for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); }
    tbody.appendChild(tr);
  }
}

// ---------- 聊天（走可见端口代理，规格 §3） ----------
const chatHistory: { role: 'user' | 'assistant'; content: string }[] = [];

function chatBubble(role: 'user' | 'assistant' | 'sys', text: string): HTMLElement {
  const d = document.createElement('div');
  d.className = `chat-bubble ${role}`;
  d.textContent = text;
  const host = $<HTMLDivElement>('chat-msgs');
  host.appendChild(d);
  host.scrollTop = host.scrollHeight;
  return d;
}

async function chatSend(): Promise<void> {
  const ta = $<HTMLTextAreaElement>('chat-text');
  const text = ta.value.trim();
  if (text === '') return;
  if (!form) return;
  if (serverState.status !== 'running') { chatBubble('sys', '服务器未运行（先点启动）'); return; }
  ta.value = '';
  chatHistory.push({ role: 'user', content: text });
  chatBubble('user', text);
  const bubble = chatBubble('assistant', '…');
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (form.apiKey !== '') headers['authorization'] = `Bearer ${form.apiKey}`;
    const resp = await fetch(`http://${form.proxyHost}:${form.visiblePort}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: modelSelect.value, messages: chatHistory, stream: true }),
    });
    if (!resp.ok || !resp.body) {
      bubble.textContent = `请求失败（HTTP ${resp.status}）：${await resp.text()}`;
      chatHistory.pop();
      return;
    }
    let acc = '';
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        const data = dataLine.slice(5).replace(/^ /, '');
        if (data === '[DONE]') continue;
        try {
          const obj = JSON.parse(data) as { choices?: { delta?: { content?: unknown } }[] };
          const c = obj.choices?.[0]?.delta?.content;
          if (typeof c === 'string') { acc += c; bubble.textContent = acc; };
        } catch { /* 非 JSON 块跳过 */ }
      }
    }
    if (acc === '') bubble.textContent = '（空响应）';
    chatHistory.push({ role: 'assistant', content: acc });
  } catch (e) {
    bubble.textContent = `网络错误: ${String(e)}`;
    chatHistory.pop();
  }
}

// ---------- 轮次记录（规格 §3 勾选项） ----------
async function loadRecords(): Promise<void> {
  const box = $<HTMLDivElement>('records-view');
  const state = $<HTMLSpanElement>('records-state');
  const dirEl = $<HTMLSpanElement>('records-dir');
  box.textContent = '';
  dirEl.textContent = recordsDir !== '' ? `目录: ${recordsDir}` : '';
  if (!form || !form.recordRounds) {
    state.textContent = '未启用（App 组勾选「记录每轮 prompt/decode」；运行中切换立即生效）';
    const d = document.createElement('div');
    d.className = 'placeholder';
    d.textContent = '启用后，每一轮请求的 prompt 与 decode 内容将记录在本地（JSONL 分文件，总量受 App 组上限约束）';
    box.appendChild(d);
    $<HTMLButtonElement>('records-prev').disabled = true;
    $<HTMLButtonElement>('records-next').disabled = true;
    return;
  }
  state.textContent = '已启用';
  const files = await window.llama.recordFiles();
  dirEl.textContent = files.length > 0 ? `${files.length} 个记录文件` : '（暂无记录）';
  const page = await window.llama.recordsTail(recPage);
  recHasMore = page.hasMore;
  for (const r of page.records) box.appendChild(renderRecord(r));
  if (page.records.length === 0) {
    const d = document.createElement('div');
    d.className = 'placeholder';
    d.textContent = '（本页无记录）';
    box.appendChild(d);
  }
  $<HTMLDivElement>('records-view').scrollTop = 0;
  $<HTMLSpanElement>('records-page').textContent = `第 ${recPage} 页（每页 50，第 0 页最新）`;
  $<HTMLButtonElement>('records-prev').disabled = recPage === 0;
  $<HTMLButtonElement>('records-next').disabled = !recHasMore;
}

function renderRecord(r: RoundRecord): HTMLElement {
  const d = document.createElement('div');
  d.className = 'rec';
  const head = document.createElement('div');
  head.className = 'rec-head';
  head.innerHTML = `<span><b>${new Date(r.ts).toLocaleString()}</b></span>`;
  const mEl = document.createElement('span');
  mEl.textContent = `模型: ${r.model}`;
  head.appendChild(mEl);
  if (r.ttft_ms !== null) {
    const t = document.createElement('span');
    t.textContent = `TTFT: ${r.ttft_ms} ms`;
    head.appendChild(t);
  }
  d.appendChild(head);
  const mk = (lbl: string, text: string): void => {
    const l = document.createElement('div');
    l.className = 'lbl';
    l.textContent = lbl;
    d.appendChild(l);
    const pre = document.createElement('pre');
    pre.textContent = text === '' ? '（空）' : text;
    d.appendChild(pre);
  };
  mk('prompt', r.prompt);
  mk('decode', r.decode);
  return d;
}

// ---------- 事件订阅 ----------
function subscribeEvents(): void {
  window.llama.on('state:change', (p) => renderState(p as ServerState));
  window.llama.on('log:lines', (p) => appendLog(p as string[]));
  window.llama.on('banner:change', (p) => renderBanner(p as { version: string | null; update: string | null }));
  window.llama.on('stats:request', (p) => {
    const s = p as { latest: RoundStats | null; history: RoundStats[] };
    renderStats(s.latest, s.history);
  });
  window.llama.on('stats:round', (p) => {
    const s = p as { latest: RoundStats | null; history: RoundStats[] };
    renderStats(s.latest, s.history);
    if (activeTab === 'records' && form?.recordRounds) void loadRecords();
  });
  window.llama.on('update:progress', (p) => {
    const u = p as UpdateProgress;
    const prog = $<HTMLProgressElement>('update-progress');
    prog.value = u.pct >= 0 ? u.pct : 0;
    $<HTMLDivElement>('update-msg').textContent = u.mbps > 0 ? `${u.message}（${u.mbps.toFixed(1)} MB/s）` : u.message;
  });
  window.llama.on('models:changed', (p) => {
    union = p as ModelRef[];
    buildModelSelect(modelSelect.value);
  });
  window.llama.on('exit:crash', (p) => {
    const e = p as ExitInfo;
    appendLog([`进程退出（code ${e.code ?? '?'}${e.early ? '，启动早期' : ''}）—— 上方彩色日志为诊断线索`], 'crash');
  });
}

// ---------- 按钮 ----------
function wireButtons(): void {
  btnStart.addEventListener('click', async () => {
    const m = union.find((x) => x.name === modelSelect.value);
    if (!form) return;
    if (!m) { showTopError('请先扫描模型目录并选择模型'); return; }
    btnStart.disabled = true;
    try {
      await window.llama.saveForm(form); // 启动即保存（规格 §5.1）
      await window.llama.startServer(form, m);
    } catch (e) {
      showTopError(String(e));
      renderState({ status: 'stopped', port: null, model: null, exitCode: null });
    }
  });
  btnStop.addEventListener('click', async () => {
    btnStop.disabled = true;
    try { await window.llama.stopServer(); } catch (e) { showTopError(String(e)); }
  });
  autoSwitchBox.addEventListener('change', () => {
    if (!form) return;
    form.autoSwitch = autoSwitchBox.checked;
    const el = document.getElementById('f-autoSwitch') as HTMLInputElement | null;
    if (el) el.checked = form.autoSwitch;
    scheduleSave();
  });
  $<HTMLButtonElement>('btn-log-clear').addEventListener('click', () => {
    $<HTMLDivElement>('log-view').textContent = '';
  });
  $<HTMLButtonElement>('records-refresh').addEventListener('click', () => void loadRecords());
  $<HTMLButtonElement>('records-prev').addEventListener('click', () => { recPage = Math.max(0, recPage - 1); void loadRecords(); });
  $<HTMLButtonElement>('records-next').addEventListener('click', () => { if (recHasMore) { recPage += 1; void loadRecords(); } });
  $<HTMLButtonElement>('chat-send').addEventListener('click', () => void chatSend());
  $<HTMLButtonElement>('chat-clear').addEventListener('click', () => {
    chatHistory.length = 0;
    $<HTMLDivElement>('chat-msgs').textContent = '';
  });
  $<HTMLTextAreaElement>('chat-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) void chatSend();
  });
  const tabs = document.querySelectorAll('#tabs button');
  for (const t of Array.from(tabs)) {
    t.addEventListener('click', () => {
      for (const x of Array.from(tabs)) x.classList.remove('active');
      t.classList.add('active');
      const name = t.getAttribute('data-tab') ?? 'logs';
      activeTab = name;
      for (const tab of Array.from(document.querySelectorAll('.tab'))) {
        tab.classList.toggle('hidden', `tab-${name}` !== tab.id);
      }
      if (name === 'records') void loadRecords();
    });
  }
  $<HTMLButtonElement>('btn-profile-apply').addEventListener('click', async () => {
    const key = $<HTMLSelectElement>('profile-select').value;
    if (!key || !form) return;
    const p = await window.llama.loadProfile(key);
    if (p && p.params) {
      form = { ...form, ...p.params };
      populateForm();
      scheduleSave();
    }
  });
  $<HTMLButtonElement>('btn-profile-save').addEventListener('click', async () => {
    const key = currentModelKey();
    if (!key || !form) { showTopError('未选择模型：请先在顶部模型下拉框选择模型，再保存参数组'); return; }
    await window.llama.saveProfile(key, form);
    await refreshProfiles();
  });
  $<HTMLButtonElement>('btn-profile-del').addEventListener('click', async () => {
    const key = $<HTMLSelectElement>('profile-select').value;
    if (!key) return;
    await window.llama.deleteProfile(key);
    await refreshProfiles();
  });
  $<HTMLButtonElement>('btn-update-check').addEventListener('click', () => void doCheckUpdate());
  $<HTMLButtonElement>('btn-update-run').addEventListener('click', async () => {
    if (!latestTag) return;
    const run = $<HTMLButtonElement>('btn-update-run');
    run.disabled = true;
    try {
      const res = await window.llama.runUpdate(latestTag);
      $<HTMLDivElement>('update-status').textContent = res.ok ? `更新完成（${latestTag}）` : `更新失败: ${res.error ?? '未知错误'}`;
      run.disabled = false;
      fillExeOptions();
    } catch (e) {
      $<HTMLDivElement>('update-status').textContent = `更新失败: ${String(e)}`;
      run.disabled = false;
    }
  });
}

// ---------- 启动 ----------
async function main(): Promise<void> {
  buildForm();
  wireButtons();
  const s = await window.llama.boot();
  form = s.form;
  union = s.union;
  recordsDir = s.recordsDir;
  installed = s.installed;
  populateForm();
  buildModelSelect(s.server.model);
  renderState(s.server);
  renderBanner(s.banner);
  renderStats(s.stats.latest, s.stats.history);
  await refreshProfiles();
  subscribeEvents();
}
void main();
export {};
