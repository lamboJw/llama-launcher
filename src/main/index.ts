// index.ts — Electron 主进程：窗口 / IPC / 启动编排（规格 §2/§3/§5/§9/§10）
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AppConfig, defaultConfigDir } from './config.js';
import { scanModels } from './scan.js';
import { scanHfCache, buildModelUnion } from './hf-cache.js';
import { ProfilesStore } from './profiles.js';
import { ProcessManager, isPortFree } from './process-manager.js';
import { ServerController } from './server-controller.js';
import { LauncherProxy } from './proxy.js';
import { RecordsStore } from './records.js';
import { StatsStore } from './stats.js';
import { RoundTracker, parseTimingLine } from './log-parser.js';
import { checkLatestRelease, runUpdate, readManifest, type ReleaseInfo } from './updater.js';
import { parseVersion, versionBanner, BASELINE_BUILD } from './version.js';
import type {
  FormValues, HfModel, InstalledVersion, LocalModel, ModelRef, ParsedVersion,
  RequestStats, RoundStats, UpdateProgress,
} from '../shared/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------- 状态 ----------
let win: BrowserWindow | null = null;
const config = new AppConfig();
const profiles = new ProfilesStore(path.join(defaultConfigDir(), 'profiles'));
const recordsDir = path.join(defaultConfigDir(), 'records');
const pm = new ProcessManager();
const stats = new StatsStore();
const rounds = new RoundTracker();
const ctl = new ServerController(pm, {
  onStateChange: (s) => send('state:change', s),
  onLog: (line) => {
    pushLog(line);
    const ev = parseTimingLine(line);
    if (ev) {
      const ts = Date.now();
      if (ev.kind === 'prompt') rounds.onPrompt(ev, ts);
      else {
        rounds.onEval(ev, ts);
        // 轮次完成（prefill + decode 配对）→ 入库并推送（规格 §7）
        const r = rounds.rounds[rounds.rounds.length - 1];
        if (r && r.prefillMs !== null) {
          stats.addRound(r);
          send('stats:round', { latest: stats.getLatest(), history: stats.getHistory().slice(-20) });
        }
      }
    }
  },
  onExit: (info) => send('exit:crash', info),
  onSwitch: (s) => send('switch:change', s),
});
let proxy: LauncherProxy | null = null;
let records: RecordsStore | null = null;
let localModels: LocalModel[] = [];
let hfModels: HfModel[] = [];
let installed: InstalledVersion[] = [];
let lastRelease: ReleaseInfo | null = null;
let versionInfo: ParsedVersion | null = null;
let versionMsg: string | null = null;
let updateMsg: string | null = null;
let updateProgress: UpdateProgress | null = null;

const appRoot = (): string => (app.isPackaged ? path.dirname(app.getPath('exe')) : process.cwd());
const llamaBaseDir = (): string => path.join(appRoot(), 'llama.cpp');

const send = (channel: string, payload: unknown): void => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

// 日志 100ms 批量发送（避免逐行 IPC 风暴）
let logBuf: string[] = [];
let logTimer: NodeJS.Timeout | null = null;
function pushLog(line: string): void {
  logBuf.push(line);
  if (logTimer) return;
  logTimer = setTimeout(() => {
    logTimer = null;
    const batch = logBuf;
    logBuf = [];
    send('log:lines', batch);
  }, 100);
}

function refreshBanner(): void {
  send('banner:change', { version: versionMsg, update: updateMsg });
}

// ---------- exe 解析（托管版本 / 自定义路径，规格 §9.2） ----------
function managedPath(entry: InstalledVersion): { exe: string; cudaDir: string | null } {
  const exeName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const exe = path.join(llamaBaseDir(), entry.tag, exeName);
  const cudaDir = entry.cudaVersion ? path.join(llamaBaseDir(), 'cuda', `cuda-${entry.cudaVersion}`) : null;
  return { exe, cudaDir };
}

/** 数字版本比较（高版本在前），用于 CUDA 目录排序 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return db - da;
  }
  return 0;
}

/** 扫描托管 CUDA 目录（llama.cpp/cuda/cuda-*），返回含 cudart64_*.dll 的目录（新版本在前） */
function findManagedCudaDirs(): string[] {
  const base = path.join(llamaBaseDir(), 'cuda');
  let entries: string[] = [];
  try { entries = fs.readdirSync(base); } catch { return []; }
  const result: string[] = [];
  for (const d of entries.filter((e) => /^cuda-\d/.test(e)).sort((a, b) => compareVersions(a.slice(5), b.slice(5)))) {
    const full = path.join(base, d);
    try {
      if (fs.readdirSync(full).some((f) => /^cudart64_.*\.dll$/i.test(f))) result.push(full);
    } catch { /* 目录不可读则跳过 */ }
  }
  return result;
}

function resolveExe(form: FormValues): { exe: string; cudaDir: string | null; fallbackCudaDirs: string[] } {
  const sel = form.exeSelection.trim();
  if (sel === '') {
    const entry = installed.find((v) => v.tag === `b${BASELINE_BUILD}` && v.valid !== false);
    if (entry) return { ...managedPath(entry), fallbackCudaDirs: [] };
    throw new Error(`托管基线 b${BASELINE_BUILD} 未安装：请在设置区点「检查更新 / 立即更新」下载 llama.cpp，或在「llama.cpp 版本」下拉框选「自定义路径…」并填写 llama-server.exe 的路径`);
  }
  if (/^b\d+$/.test(sel)) {
    const entry = installed.find((v) => v.tag === sel);
    if (!entry) throw new Error(`托管版本 ${sel} 未安装（点"立即更新"安装）`);
    return { ...managedPath(entry), fallbackCudaDirs: [] };
  }
  // 自定义路径：托管 CUDA 目录存在则作为兜底注入（尽力而为）
  return { exe: sel, cudaDir: null, fallbackCudaDirs: findManagedCudaDirs() };
}

function probeVersion(exe: string): Promise<ParsedVersion> {
  return new Promise((resolve) => {
    execFile(exe, ['--version'], { timeout: 10000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve(parseVersion(err ? (stderr ?? '') : (stdout ?? '') + (stderr ?? '')));
    });
  });
}

// ---------- 模型并集（本地 ∪ HF，规格 §4.1） ----------
async function refreshUnion(): Promise<void> {
  const form = config.getSettings().form;
  try { localModels = form.scanDir ? scanModels(form.scanDir) : []; } catch { localModels = []; }
  // HF 扫描不依赖 autoSwitch（纯本地磁盘操作）；autoSwitch 只控制代理按请求切模型（proxy.ts）
  try { hfModels = form.hfCacheDir ? scanHfCache(form.hfCacheDir) : []; } catch { hfModels = []; }
  ctl.setUnion(buildModelUnion(localModels, hfModels));
  send('models:changed', ctl.union()); // 扫描结果实时推给渲染层（模型下拉刷新）
}

async function refreshInstalled(): Promise<void> {
  try { installed = await readManifest(llamaBaseDir()); } catch { installed = []; }
}

// ---------- 启动 / 停止（规格 §2.2/§2.3） ----------
async function startServer(form: FormValues, model: ModelRef): Promise<void> {
  if (!(await isPortFree(form.visiblePort))) {
    throw new Error(`可见端口 ${form.visiblePort} 已被占用，请在"服务"组更换端口`);
  }
  const { exe, cudaDir, fallbackCudaDirs } = resolveExe(form);
  // 启动即保存 profile（规格 §5.1）
  const key = model.local ? model.local.path : model.name;
  await profiles.save(key, form);
  config.saveSettings({ form });
  // 版本探针 + 横幅（规格 §9.1）
  versionInfo = await probeVersion(exe);
  versionMsg = versionBanner(versionInfo);
  refreshBanner();
  // 起 server（spawn → /health 就绪）
  await ctl.start({ exe, form, model, cudaDir, fallbackCudaDirs });
  // 起 / 重建反向代理（规格 §2.1）
  if (proxy) { await proxy.stop(); proxy = null; }
  records = form.recordRounds ? new RecordsStore(recordsDir, { maxTotalBytes: form.recordsMaxTotalBytes }) : null;
  proxy = new LauncherProxy({
    host: form.proxyHost,
    port: form.visiblePort,
    controller: ctl,
    form: { ...form },
    records,
    onStats: (s: RequestStats) => {
      stats.addRequest(s);
      send('stats:request', { request: s, latest: stats.getLatest(), history: stats.getHistory().slice(-20) });
    },
  });
  await proxy.start();
}

async function stopServer(): Promise<void> {
  if (proxy) { await proxy.stop(); proxy = null; }
  records = null;
  await ctl.stop();
}

// ---------- IPC ----------
function registerIpc(): void {
  ipcMain.handle('app:boot', async () => {
    await refreshInstalled();
    await refreshUnion();
    const form = config.getSettings().form;
    return {
      appRoot: appRoot(),
      form,
      server: ctl.getState(),
      localModels,
      hfModels,
      union: ctl.union(),
      installed,
      version: versionInfo,
      banner: { version: versionMsg, update: updateMsg },
      stats: { latest: stats.getLatest(), history: stats.getHistory().slice(-20) },
      recordsDir,
      updateProgress,
    };
  });

  ipcMain.handle('models:scan', async (_e, dir: string) => {
    const list: LocalModel[] = dir ? scanModels(dir) : [];
    localModels = list;
    config.updateForm({ scanDir: dir });
    await refreshUnion();
    return list;
  });

  ipcMain.handle('hf:scan', async (_e, dir: string) => {
    const list: HfModel[] = dir ? scanHfCache(dir) : [];
    hfModels = list;
    config.updateForm({ hfCacheDir: dir });
    await refreshUnion();
    return list;
  });

  ipcMain.handle('server:start', async (_e, args: { form: FormValues; model: ModelRef }) => {
    await startServer(args.form, args.model);
  });

  ipcMain.handle('server:stop', async () => {
    await stopServer();
  });

  ipcMain.handle('form:save', async (_e, form: FormValues) => {
    const prev = config.getSettings().form;
    config.saveSettings({ form });
    if (proxy) proxy.setForm({ ...form }); // CORS 等立即生效
    if (form.recordRounds !== prev.recordRounds) {
      records = form.recordRounds ? new RecordsStore(recordsDir, { maxTotalBytes: form.recordsMaxTotalBytes }) : null;
      if (proxy) proxy.setRecords(records); // 运行中切换立即生效
    }
    if (form.autoSwitch !== prev.autoSwitch || form.hfCacheDir !== prev.hfCacheDir || form.scanDir !== prev.scanDir) {
      await refreshUnion();
    }
    if (form.exeSelection !== prev.exeSelection) {
      try {
        const { exe } = resolveExe(form);
        versionInfo = await probeVersion(exe);
        versionMsg = versionBanner(versionInfo);
      } catch { versionInfo = null; versionMsg = null; }
      refreshBanner();
    }
  });

  ipcMain.handle('profiles:list', async () => profiles.list());
  ipcMain.handle('profiles:save', async (_e, args: { model: string; params: FormValues }) => profiles.save(args.model, args.params));
  ipcMain.handle('profiles:load', async (_e, model: string) => profiles.load(model));
  ipcMain.handle('profiles:delete', async (_e, model: string) => profiles.delete(model));

  ipcMain.handle('records:files', async () => (records ? records.listFiles() : []));
  ipcMain.handle('records:tail', async (_e, page: number) => {
    const store = records ?? new RecordsStore(recordsDir, { maxTotalBytes: config.getSettings().form.recordsMaxTotalBytes });
    return store.tailPage(page, 50);
  });

  ipcMain.handle('updater:check', async () => {
    await refreshInstalled();
    const latest = await checkLatestRelease();
    lastRelease = latest;
    updateMsg = latest && !installed.some((v) => v.tag === latest.tag_name) ? `发现新版本 ${latest.tag_name}` : null;
    refreshBanner();
    return { latest, installed };
  });

  ipcMain.handle('updater:run', async (_e, tag: string) => {
    let release = lastRelease;
    if (!release || release.tag_name !== tag) release = await checkLatestRelease();
    if (!release || release.tag_name !== tag) throw new Error('获取最新版本信息失败（网络错误？）');
    const form = config.getSettings().form;
    const sel = form.exeSelection.trim();
    const selectedTag = /^b\d+$/.test(sel) ? sel : null;
    updateProgress = { phase: 'check', pct: -1, mbps: 0, message: '开始更新' };
    send('update:progress', updateProgress);
    const res = await runUpdate({
      baseDir: llamaBaseDir(),
      tag: release.tag_name,
      assets: release.assets,
      selectedTag,
      minFreeBytes: 2 * 1024 * 1024 * 1024,
      onProgress: (p) => { updateProgress = p; send('update:progress', p); },
    });
    await refreshInstalled();
    if (res.ok && res.valid) {
      config.updateForm({ exeSelection: release.tag_name }); // 更新后自动选中（规格 §9.2）
      updateMsg = null;
      const entry = installed.find((v) => v.tag === release.tag_name);
      if (entry) {
        const { exe } = managedPath(entry);
        versionInfo = await probeVersion(exe);
        versionMsg = versionBanner(versionInfo);
      }
      refreshBanner();
    }
    return res;
  });

  ipcMain.handle('dialog:dir', async (_e, defaultPath?: string) => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      title: '选择目录',
      defaultPath: defaultPath || appRoot(),
      properties: ['openDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('dialog:file', async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      title: '选择 llama-server.exe',
      defaultPath: appRoot(),
      properties: ['openFile'],
      filters: [{ name: '可执行文件', extensions: ['exe'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('stats:get', async () => ({ latest: stats.getLatest(), history: stats.getHistory().slice(-20) }));
}

// ---------- 窗口 / 生命周期 ----------
function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'llama-server 启动器',
    webPreferences: {
      preload: path.join(here, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(here, '..', 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
  registerIpc();
  createWindow();
  await refreshInstalled();
  await refreshUnion();
  // 异步检查更新（不阻塞启动，规格 §9.2）
  void (async () => {
    try {
      const latest = await checkLatestRelease();
      lastRelease = latest;
      if (latest && !installed.some((v) => v.tag === latest.tag_name)) {
        updateMsg = `发现新版本 ${latest.tag_name}`;
        refreshBanner();
      }
    } catch { /* 网络失败：静默 */ }
  })();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // 退出前停 server 与代理（规格 §2.3）
  void (async () => {
    try {
      if (proxy) await proxy.stop();
      await ctl.stop();
    } catch { /* 忽略退出期错误 */ }
    app.quit();
  })();
});
