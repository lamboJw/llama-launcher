# llama-server 桌面启动器 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按规格 `docs/superpowers/specs/2026-07-25-llama-server-launcher-design.md` 实现 Windows 桌面应用 llama-launcher：Electron + TypeScript，托管 llama-server 进程 + 常开反向代理（TTFT / 缓存命中率 / 轮次记录）、自动模型切换（停旧启新）、HF cache 模型扫描、彩色日志、每模型参数档案、GitHub 版本检查与自动下载、便携 zip 打包。

**Architecture:** 主进程 = 进程管理器（spawn/停止/健康轮询/崩溃恢复）+ 反向代理（HTTP/SSE 透传、TTFT 计时、usage 解析、JSONL 轮次记录、模型切换调度与排队）+ 配置/档案持久化；渲染进程 = 中文 UI（ANSI 彩色日志、统计、聊天、轮次记录）。所有逻辑模块为纯 Node（不 import 'electron'），用 vitest 单元测试；Electron 只出现在 main/index.ts 与 preload。

**Tech Stack:** Electron 43（ESM 主进程，CJS preload）、TypeScript 5 strict、vitest 4、electron-builder 26（dir target + zip = 便携版）、ansi-to-html（渲染进程，vendor 方式引入）、extract-zip、Node 内置 fetch/http/fs/statfs。

## Global Constraints

- 工作目录 `F:\llama_lanucher`（Git Bash 下 `/f/llama_lanucher`）。Node v24.11.1 / npm 11.6.2。
- 全 ESM：package.json 含 `"type": "module"`；**所有相对 import 必须带显式 `.js` 扩展名**（Node ESM 要求，TS 源码里也写 `.js`）。preload 例外：单独 tsconfig 编译为 CommonJS（Electron ESM preload 必须 .mjs，CJS 最稳）。
- TypeScript strict；每个任务结束前 `npm run typecheck` 必须通过。
- 测试：`npx vitest run <file>`（非 watch）。逻辑模块（config/scan/hf-cache/log-parser/stats/records/profiles/version/args/process-manager/proxy/updater）**禁止 import 'electron'**，保证纯 Node 可测。
- 提交身份：`git -c user.name='dsh' -c user.email='dsh@local' commit -m "..."`；每任务完成即提交。CRLF 警告无害，忽略。
- 规格是唯一事实来源（docs/superpowers/specs/2026-07-25-llama-server-launcher-design.md）。本计划在规格 §12 结构之外新增 4 个文件（src/shared/types.ts、src/main/args.ts、src/main/stats.ts、scripts/），理由：共享类型、参数组装+诊断映射（§9.1 要求记录「CLI 参数 ← 来源字段」映射）、日志轮次与代理请求的归并（§7）、构建脚本。
- **有意偏差 1**：config.ts 不用 electron-store 包（v10 在纯 Node 测试环境会因 require('electron') 崩溃）；改为自实现 electron-store 语义的 JSON 仓库（%APPDATA%/llama-launcher/config.json，原子写、默认值合并），持久化行为与规格 §5.2 一致。
- **有意偏差 2**：「便携版 zip」= electron-builder `dir` target 产物再打 zip（portable exe 解压到临时目录，与规格 §9.2 的 `<appRoot>/llama.cpp/` 托管目录布局不兼容）。appRoot = 用户解压 zip 后的目录（打包态 `path.dirname(app.getPath('exe'))`，开发态仓库根）。
- **有意偏差 3**：CORS 四件套作用于**代理层**（server 只绑内部端口，客户端只到得了代理；规格表中的 --cors-* 是 server 参数但实际不可达）：代理按表单值加 CORS 头（默认 `*`）并处理 OPTIONS 预检。
- 「留空 = 不传」（规格 §5）：文本/数字字段默认空，空则不生成 CLI 参数；括号内默认值只作 tooltip 展示，App 不维护默认值。布尔字段始终显式传 `--flag` / `--no-flag`（默认勾选态 = server 默认行为）。
- 表单基线 b10488（build 10488，commit 9d77fa172）；表单「可见端口」与「--host」只作用于代理层，不传给 server（规格 §5.3）。
- 强制参数（规格 §5.3）：`--log-colors on`、`--metrics`、`--host 127.0.0.1 --port <内部端口>`；模型来源：本地 `--model <path>`（+ 自动 `--mmproj`）或 HF cache `--hf-repo <name>[:quant] --offline` + 注入 `HF_HUB_CACHE` 环境变量。
- Windows 杀进程：先 `proc.kill()`（TerminateProcess），超时未退出再 `taskkill /T /F /PID <pid>` 兜底。
- 内部端口：127.0.0.1，从 59999 起探测空闲（占用 +1，最多 20 次）；切换模型时复用同一内部端口。
- 时序日志真实样本（v9222 实测，b10488 格式可能带 `llama_print_timings:` 前缀，正则两种都要容错）：
  `prompt eval time =    5067.55 ms /  2095 tokens (    2.42 ms per token,   413.41 tokens per second)`
  `       eval time =   17836.92 ms /   561 tokens (   31.79 ms per token,    31.45 tokens per second)`
- `--version` 真实输出（双格式，必须都能解析）：
  - b10488: `version: 0.1.2-dev (build 10488, commit 9d77fa172)`
  - v9222: `version: 9222 (9a532ae4b)`

## File Structure

```
F:\llama_lanucher\
├─ package.json                  # Task 1（后续任务按需追加依赖）
├─ tsconfig.json                 # Task 1（main + renderer + shared）
├─ tsconfig.preload.json         # Task 1（preload → CJS）
├─ electron-builder.yml          # Task 1
├─ scripts/
│  ├─ copy-assets.mjs            # Task 1（html/css/vendor → dist/renderer）
│  └─ zip-release.mjs            # Task 18（dir 产物 → 便携 zip）
├─ src/
│  ├─ shared/
│  │  └─ types.ts                # Task 1（共享类型，import type only）
│  ├─ main/
│  │  ├─ index.ts                # Task 1 骨架 → Task 14 完整接线
│  │  ├─ config.ts               # Task 2
│  │  ├─ scan.ts                 # Task 3（本地 .gguf 扫描 + 命名 + mmproj）
│  │  ├─ hf-cache.ts             # Task 4（HF cache 5 步算法 + 并集 + 解析）
│  │  ├─ log-parser.ts           # Task 5（行切分 + 时序正则 + 轮次聚合）
│  │  ├─ stats.ts                # Task 6（日志轮次 × 代理请求 归并）
│  │  ├─ records.ts              # Task 7（JSONL 追加/滚动/总量淘汰/尾部分页）
│  │  ├─ profiles.ts             # Task 8（每模型档案）
│  │  ├─ version.ts              # Task 9（双格式版本解析 + 启动失败诊断）
│  │  ├─ args.ts                 # Task 10（表单 → CLI 参数 + 映射表 + 分词）
│  │  ├─ process-manager.ts      # Task 11（spawn/健康/停止/崩溃）
│  │  ├─ proxy.ts                # Task 12（代理 + TTFT + 缓存 + 记录 + 切换调度）
│  │  └─ updater.ts              # Task 13（GitHub 检查/续传下载/安装/修剪）
│  ├─ preload/
│  │  └─ index.ts                # Task 1 桩 → Task 14 完整 IPC API（编译为 CJS）
│  └─ renderer/
│     ├─ index.html              # Task 1 骨架 → Task 15/16/17
│     ├─ main.ts                 # Task 1 骨架 → Task 15 外壳
│     ├─ styles.css              # Task 15
│     └─ components/             # Task 15-17
│        ├─ topbar.ts
│        ├─ model-scan.ts
│        ├─ form.ts
│        ├─ logs.ts
│        ├─ stats.ts
│        ├─ chat.ts
│        ├─ records.ts
│        └─ versions.ts
├─ test/
│  ├─ smoke.test.ts              # Task 1
│  ├─ config.test.ts             # Task 2
│  ├─ scan.test.ts               # Task 3
│  ├─ hf-cache.test.ts           # Task 4
│  ├─ log-parser.test.ts         # Task 5
│  ├─ stats.test.ts              # Task 6
│  ├─ records.test.ts            # Task 7
│  ├─ profiles.test.ts           # Task 8
│  ├─ version.test.ts            # Task 9
│  ├─ args.test.ts               # Task 10
│  ├─ fake-server.mjs            # Task 11（假 llama-server）
│  ├─ process-manager.test.ts    # Task 11
│  ├─ proxy.test.ts              # Task 12（假后端 + 假控制器）
│  └─ updater.test.ts            # Task 13（本地 HTTP + zip fixture）
└─ docs/                         # 已有规格
```

---

### Task 1: 项目脚手架

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.preload.json`, `electron-builder.yml`, `scripts/copy-assets.mjs`, `src/shared/types.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/main.ts`, `test/smoke.test.ts`

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "llama-launcher",
  "version": "0.1.0",
  "description": "Windows desktop launcher for llama-server: proxy, stats, auto model switching",
  "main": "dist/main/index.js",
  "type": "module",
  "scripts": {
    "build": "tsc && tsc -p tsconfig.preload.json && node scripts/copy-assets.mjs",
    "dev": "npm run build && electron .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "package": "npm run build && electron-builder --win dir && node scripts/zip-release.mjs"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.5.0",
    "vitest": "^4.0.0"
  }
}
```

（electron / electron-builder / ansi-to-html / extract-zip / adm-zip 在需要它们的任务里安装，避免脚手架期下载 Electron。）

- [ ] **Step 2: 写 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "types": ["node"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false
  },
  "include": ["src"],
  "exclude": ["src/preload"]
}
```

- [ ] **Step 3: 写 tsconfig.preload.json（preload 编译为 CJS）**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "module": "CommonJS",
    "moduleResolution": "node10",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/preload"]
}
```

- [ ] **Step 4: 写 electron-builder.yml**

```yaml
appId: com.lambojw.llamalauncher
productName: llama-launcher
directories:
  output: release
files:
  - dist/**
  - package.json
win:
  target: dir
```

- [ ] **Step 5: 写 scripts/copy-assets.mjs**

```js
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'src', 'renderer');
const out = path.join(root, 'dist', 'renderer');

mkdirSync(out, { recursive: true });
for (const f of ['index.html', 'styles.css']) {
  const p = path.join(src, f);
  if (existsSync(p)) cpSync(p, path.join(out, f));
}
const vendor = path.join(out, 'vendor');
mkdirSync(vendor, { recursive: true });
const ansi = path.join(root, 'node_modules', 'ansi-to-html', 'ansi_to_html.min.js');
if (existsSync(ansi)) cpSync(ansi, path.join(vendor, 'ansi-to-html.min.js'));
console.log('assets copied ->', out);
```

- [ ] **Step 6: 写 src/shared/types.ts（完整共享类型）**

```ts
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
  device: string; loadMode: string; fit: boolean;
  cacheTypeK: string; cacheTypeV: string; nCpuMoE: string;
  // 上下文组
  ctxSize: string; parallel: string; batchSize: string; ubatchSize: string;
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
  specDefault: boolean;
  // 高级组
  verbosity: string; warmup: boolean; contextShift: boolean; cacheReuse: boolean;
  perf: boolean; logPromptsDir: string; mcpServersConfig: string;
  mtmdBatchMaxTokens: string; specDraftBackendSampling: boolean; extraArgs: string;
  // App 级（非 server 参数）
  autoSwitch: boolean; hfCacheDir: string; recordRounds: boolean;
  scanDir: string; exeSelection: string; recordsMaxTotalBytes: number;
}

export interface Settings { form: FormValues }

export interface TimingEvent {
  kind: 'prompt' | 'eval';
  ms: number; tokens: number; msPerToken: number; tps: number;
}

export interface RequestStats {
  model: string; ttftMs: number | null; cacheHitRate: number | null; ts: number;
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

export interface InstalledVersion { tag: string; cudaVersion: string | null; installedAt: number }

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
```

- [ ] **Step 7: 写 src/main/index.ts（最小窗口骨架，Task 14 替换为完整接线）**

```ts
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function createWindow(): void {
  const win = new BrowserWindow({
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
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => { app.quit(); });
```

- [ ] **Step 8: 写 src/preload/index.ts（Task 1 桩，Task 14 实现完整 API）**

```ts
// Task 1 桩：Task 14 用 contextBridge 暴露完整 API（编译为 CJS）
export {};
```

- [ ] **Step 9: 写 src/renderer/index.html 与 src/renderer/main.ts（最小骨架）**

`src/renderer/index.html`:
```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>llama-server 启动器</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <div id="app">scaffold ok</div>
  <script type="module" src="./main.js"></script>
</body>
</html>
```

`src/renderer/main.ts`:
```ts
document.getElementById('app')!.textContent = 'llama-launcher scaffold ok';
```

- [ ] **Step 10: 安装核心依赖并验证**

运行：
```bash
cd /f/llama_lanucher && npm install
```
预期：exit 0，生成 node_modules 与 package-lock.json。

- [ ] **Step 11: 写 test/smoke.test.ts 并跑通**

```ts
import { describe, it, expect } from 'vitest';

describe('scaffold', () => {
  it('vitest runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

运行：
```bash
cd /f/llama_lanucher && npx vitest run test/smoke.test.ts
```
预期：`Test Files  1 passed (1)`，`Tests  1 passed (1)`。

- [ ] **Step 12: 类型检查通过**

运行：
```bash
cd /f/llama_lanucher && npm run typecheck
```
预期：exit 0，无输出。

- [ ] **Step 13: 提交**

```bash
cd /f/llama_lanucher && git add -A && git -c user.name='dsh' -c user.email='dsh@local' commit -m "scaffold: electron+ts+vitest skeleton, shared types, build scripts"

---

### Task 2: config.ts — 配置持久化（electron-store 语义 JSON 仓库）

**Files:**
- Create: `src/main/config.ts`, `test/config.test.ts`

- [ ] **Step 1: 写失败测试 test/config.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppConfig, JsonStore } from '../src/main/config.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llama-cfg-'));
}

describe('JsonStore', () => {
  it('returns defaults when file missing', () => {
    const d = tmpdir();
    const s = new JsonStore(d, 'x', { a: 1, b: 'two' });
    expect(s.get()).toEqual({ a: 1, b: 'two' });
  });

  it('persists set() and merges new defaults on reload', () => {
    const d = tmpdir();
    const s1 = new JsonStore(d, 'x', { a: 1, b: 'two' });
    s1.set({ a: 9 });
    const s2 = new JsonStore(d, 'x', { a: 1, b: 'two', c: 3 });
    expect(s2.get()).toEqual({ a: 9, b: 'two', c: 3 });
  });

  it('ignores corrupt file (falls back to defaults)', () => {
    const d = tmpdir();
    fs.writeFileSync(path.join(d, 'x.json'), '{corrupt');
    const s = new JsonStore(d, 'x', { a: 1 });
    expect(s.get()).toEqual({ a: 1 });
  });
});

describe('AppConfig', () => {
  it('defaults: port 8080, autoSwitch off, recordRounds off, server-default booleans on', () => {
    const c = new AppConfig(tmpdir());
    const f = c.getSettings().form;
    expect(f.visiblePort).toBe(8080);
    expect(f.proxyHost).toBe('127.0.0.1');
    expect(f.autoSwitch).toBe(false);
    expect(f.recordRounds).toBe(false);
    expect(f.mmprojAuto).toBe(true);
    expect(f.mmprojOffload).toBe(true);
    expect(f.jinja).toBe(true);
    expect(f.ui).toBe(true);
    expect(f.fit).toBe(true);
    expect(f.warmup).toBe(true);
    expect(f.hfCacheDir.length).toBeGreaterThan(0);
    expect(f.timeout).toBe(''); // 留空 = 不传，server 默认 600
  });

  it('updateForm patches and persists across instances', () => {
    const d = tmpdir();
    const c1 = new AppConfig(d);
    c1.updateForm({ visiblePort: 9000 });
    const c2 = new AppConfig(d);
    expect(c2.getSettings().form.visiblePort).toBe(9000);
    expect(c2.getSettings().form.proxyHost).toBe('127.0.0.1');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

运行：`cd /f/llama_lanucher && npx vitest run test/config.test.ts`
预期：FAIL（Cannot find module '../src/main/config.js'）。

- [ ] **Step 3: 写 src/main/config.ts**

```ts
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
    this.file = path.join(dir, `${name}.json`);
    this.data = this.load(defaults);
  }

  private load(defaults: T): T {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      return { ...defaults, ...JSON.parse(raw) as Partial<T> };
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
```

- [ ] **Step 4: 运行测试确认通过**

运行：`cd /f/llama_lanucher && npx vitest run test/config.test.ts`
预期：`Test Files  1 passed (1)`，`Tests  5 passed (5)`。

- [ ] **Step 5: 类型检查 + 提交**

```bash
cd /f/llama_lanucher && npm run typecheck && git add -A && git -c user.name='dsh' -c user.email='dsh@local' commit -m "config: electron-store-semantics JSON store with spec defaults"
```

---

### Task 3: scan.ts — 本地 .gguf 扫描（命名规则 + mmproj 自动探测）

**Files:**
- Create: `src/main/scan.ts`, `test/scan.test.ts`

- [ ] **Step 1: 写失败测试 test/scan.test.ts**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanModels } from '../src/main/scan.js';

let root: string;

function touch(p: string, mtime?: number): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'gguf');
  if (mtime) fs.utimesSync(p, mtime / 1000, mtime / 1000);
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-scan-'));
  touch(path.join(root, 'qwen3-8b-q4.gguf'), 1_700_000_000_000);
  touch(path.join(root, 'MyModel', 'model-00001-of-00003.gguf'), 1_700_000_100_000);
  touch(path.join(root, 'MyModel', 'model-00002-of-00003.gguf'), 1_700_000_100_000);
  touch(path.join(root, 'MyModel', 'mmproj-F16.gguf'), 1_700_000_100_000);
  touch(path.join(root, 'Multi', 'a.gguf'), 1_700_000_200_000);
  touch(path.join(root, 'Multi', 'mmproj-1.gguf'), 1_700_000_200_000);
  touch(path.join(root, 'Multi', 'mmproj-2.gguf'), 1_700_000_200_000);
  fs.mkdirSync(path.join(root, 'Empty'), { recursive: true });
});

afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('scanModels', () => {
  it('loose file -> filename minus .gguf', () => {
    const m = scanModels(root).find(x => x.name === 'qwen3-8b-q4')!;
    expect(m.path).toBe(path.join(root, 'qwen3-8b-q4.gguf'));
    expect(m.mmproj).toBeNull();
  });

  it('subdir -> dir name, shard first piece as path, size summed (8 bytes = 2 x 4)', () => {
    const m = scanModels(root).find(x => x.name === 'MyModel')!;
    expect(m.path).toBe(path.join(root, 'MyModel', 'model-00001-of-00003.gguf'));
    expect(m.size).toBe(8);
  });

  it('exactly one mmproj in same dir -> auto fill', () => {
    const m = scanModels(root).find(x => x.name === 'MyModel')!;
    expect(m.mmproj).toBe(path.join(root, 'MyModel', 'mmproj-F16.gguf'));
    expect(m.mmprojCandidates).toEqual([]);
  });

  it('multiple mmproj -> no auto fill, candidates listed', () => {
    const m = scanModels(root).find(x => x.name === 'Multi')!;
    expect(m.mmproj).toBeNull();
    expect(m.mmprojCandidates).toHaveLength(2);
  });

  it('sorted by mtime desc; empty dirs not listed', () => {
    const list = scanModels(root);
    expect(list.map(x => x.name)).toEqual(['Multi', 'MyModel', 'qwen3-8b-q4']);
  });

  it('missing dir -> empty list', () => {
    expect(scanModels(path.join(root, 'nope'))).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

运行：`cd /f/llama_lanucher && npx vitest run test/scan.test.ts`
预期：FAIL（Cannot find module '../src/main/scan.js'）。

- [ ] **Step 3: 写 src/main/scan.ts**

```ts
// scan.ts — 递归扫描本地 .gguf（规格 §4）
// 命名规则：子目录 → 目录名（分片取 -00001-of- 首片为启动路径）；散文件 → 去 .gguf 文件名
import fs from 'node:fs';
import path from 'node:path';
import type { LocalModel } from '../shared/types.js';

const GGUF = /\.gguf$/i;
const MMPROJ = /mmproj.*\.gguf$/i;
const SHARD_FIRST = /-00001-of-/i;

export function scanModels(dir: string): LocalModel[] {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const files: string[] = [];
  walk(dir, files);

  const groups = new Map<string, string[]>();
  for (const f of files) {
    const d = path.dirname(f);
    const name = d === dir ? path.basename(f).replace(GGUF, '') : path.basename(d);
    const g = groups.get(name);
    if (g) g.push(f);
    else groups.set(name, [f]);
  }

  const out: LocalModel[] = [];
  for (const [name, fsList] of groups) {
    fsList.sort((a, b) => a.localeCompare(b));
    const dirOf = path.dirname(fsList[0]);
    const shard = fsList.find(f => SHARD_FIRST.test(path.basename(f))) ?? fsList[0];
    const size = fsList.reduce((s, f) => s + fs.statSync(f).size, 0);
    const mtime = Math.max(...fsList.map(f => fs.statSync(f).mtimeMs));
    const mmprojs = fs.readdirSync(dirOf).filter(f => MMPROJ.test(f));
    out.push({
      name,
      path: shard,
      size,
      mtime,
      mmproj: mmprojs.length === 1 ? path.join(dirOf, mmprojs[0]) : null,
      mmprojCandidates: mmprojs.length > 1 ? mmprojs.map(m => path.join(dirOf, m)) : [],
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (GGUF.test(e.name)) out.push(p);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

运行：`cd /f/llama_lanucher && npx vitest run test/scan.test.ts`
预期：`Test Files  1 passed (1)`，`Tests  6 passed (6)`。

- [ ] **Step 5: 类型检查 + 提交**

```bash
cd /f/llama_lanucher && npm run typecheck && git add -A && git -c user.name='dsh' -c user.email='dsh@local' commit -m "scan: recursive .gguf scan with dir-name naming, shard first piece, mmproj auto-detect"
```

---

### Task 4: hf-cache.ts — HF cache 模型枚举（规格 §4.1 五步算法）

**Files:**
- Create: `src/main/hf-cache.ts`, `test/hf-cache.test.ts`

说明：本机 HF cache 为空（`~/.cache/huggingface/hub` 不存在），测试必须用合成 fixture 目录树。

- [ ] **Step 1: 写失败测试 test/hf-cache.test.ts**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  scanHfCache, parseRepoFromDirName, readCommit, extractQuant,
  buildModelUnion, resolveModelRef,
} from '../src/main/hf-cache.js';
import type { LocalModel } from '../src/shared/types.js';

const COMMIT = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'; // 40-hex
let root: string;

function mkRepo(repo: string, commit: string, files: string[], badRefMain?: string): void {
  const dir = path.join(root, 'models--' + repo.replace(///g, '--'));
  fs.mkdirSync(path.join(dir, 'snapshots', commit), { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, 'snapshots', commit, f), 'gguf');
  fs.mkdirSync(path.join(dir, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'refs', 'main'), (badRefMain ?? commit) + '\n');
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-hf-'));
  mkRepo('ggml-org/GLM-4.7-Flash-GGUF', COMMIT,
    ['GLM-4.7-Flash-GGUF-Q4_K_M.gguf', 'GLM-4.7-Flash-GGUF-Q8_0.gguf', 'mmproj-F16.gguf']);
  mkRepo('user/NoQuant', COMMIT, ['model.gguf']);
  mkRepo('user/BadRef', COMMIT, ['a.gguf'], 'not-a-commit');
  mkRepo('user/NoGguf', COMMIT, ['readme.txt']);
  // 有 refs 无 snapshots 目录 → 排除
  const d = path.join(root, 'models--user--NoSnapDir');
  fs.mkdirSync(path.join(d, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(d, 'refs', 'main'), COMMIT + '\n');
});

afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('parseRepoFromDirName', () => {
  it('models--user--name -> user/name', () => {
    expect(parseRepoFromDirName('models--user--name')).toBe('user/name');
  });
  it('all -- become /, but exactly one / required', () => {
    expect(parseRepoFromDirName('models--a--b--c')).toBeNull();
  });
  it('no prefix -> null', () => {
    expect(parseRepoFromDirName('user--name')).toBeNull();
  });
  it('empty -> null', () => {
    expect(parseRepoFromDirName('models--')).toBeNull();
  });
  it('keeps original case', () => {
    expect(parseRepoFromDirName('models--UPPER--Case')).toBe('UPPER/Case');
  });
});

describe('extractQuant', () => {
  it('trailing quant after dash', () => {
    expect(extractQuant('GLM-4.7-Flash-GGUF-Q4_K_M.gguf')).toBe('Q4_K_M');
  });
  it('trailing quant after underscore', () => {
    expect(extractQuant('MyModel_Q8_0.gguf')).toBe('Q8_0');
  });
  it('no quant -> null', () => {
    expect(extractQuant('model.gguf')).toBeNull();
  });
});

describe('readCommit', () => {
  it('refs/main first line 40-hex', () => {
    const dir = path.join(root, 'models--user--NoQuant');
    expect(readCommit(dir)).toBe(COMMIT);
  });
  it('invalid main -> first other valid ref', () => {
    const dir = path.join(root, 'models--user--BadRef');
    fs.writeFileSync(path.join(dir, 'refs', 'other'), COMMIT + '\n');
    expect(readCommit(dir)).toBe(COMMIT);
  });
  it('no valid refs -> null', () => {
    const dir = path.join(root, 'models--user--NoGguf');
    fs.rmSync(path.join(dir, 'refs', 'main'));
    expect(readCommit(dir)).toBeNull();
  });
});

describe('scanHfCache', () => {
  it('valid repo: quants sorted, default Q4_K_M, mmproj detected, size summed', () => {
    const m = scanHfCache(root).find(x => x.repo === 'ggml-org/GLM-4.7-Flash-GGUF')!;
    expect(m.quants).toEqual(['Q4_K_M', 'Q8_0']);
    expect(m.quant).toBe('Q4_K_M');
    expect(m.mmproj).toBe(true);
    expect(m.size).toBe(12); // 3 x 4 bytes
    expect(m.path).toBe(path.join(root, 'models--ggml-org--GLM-4.7-Flash-GGUF', 'snapshots', COMMIT));
  });

  it('no recognizable quant -> quant null (llama.cpp falls back to first file)', () => {
    const m = scanHfCache(root).find(x => x.repo === 'user/NoQuant')!;
    expect(m.quants).toEqual([]);
    expect(m.quant).toBeNull();
    expect(m.mmproj).toBe(false);
  });

  it('excludes: bad ref, no snapshots dir, no gguf', () => {
    const repos = scanHfCache(root).map(x => x.repo);
    expect(repos).toEqual(['ggml-org/GLM-4.7-Flash-GGUF', 'user/NoQuant']);
  });

  it('missing dir -> empty', () => {
    expect(scanHfCache(path.join(root, 'nope'))).toEqual([]);
  });
});

describe('union + resolve', () => {
  const local: LocalModel[] = [{
    name: 'GLM-4.7-Flash-GGUF', path: 'x', size: 1, mtime: 0, mmproj: null, mmprojCandidates: [],
  }];
  const hf = scanHfCache(root);

  it('local wins on case-insensitive name conflict', () => {
    const u = buildModelUnion(local, hf);
    const hit = u.find(r => r.name.toLowerCase() === 'glm-4.7-flash-gguf')!;
    expect(hit.source).toBe('local');
    expect(u).toHaveLength(2); // local GLM + hf user/NoQuant (ggml-org repo shadowed)
  });

  it('resolve: plain name, case-insensitive, quant suffix stripped', () => {
    const u = buildModelUnion([], hf);
    expect(resolveModelRef(u, 'ggml-org/GLM-4.7-Flash-GGUF')!.source).toBe('hf');
    expect(resolveModelRef(u, 'GGML-ORG/glm-4.7-flash-gguf')!.source).toBe('hf');
    expect(resolveModelRef(u, 'ggml-org/GLM-4.7-Flash-GGUF:q4_k_m')!.source).toBe('hf');
    expect(resolveModelRef(u, 'nope/missing')).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

运行：`cd /f/llama_lanucher && npx vitest run test/hf-cache.test.ts`
预期：FAIL（Cannot find module '../src/main/hf-cache.js'）。

- [ ] **Step 3: 写 src/main/hf-cache.ts**

```ts
// hf-cache.ts — HF cache 模型枚举（规格 §4.1，逐条对照 b10488 hf-cache.cpp 行为）
// ① 枚举顶层 models--* 目录且含 snapshots/ 子目录
// ② 去前缀后所有 -- 替换为 /，重新校验（非空、≤256、恰好一个 /、字符集 [A-Za-z0-9_.-]）
// ③ refs/ 中第一个 40-hex 首行的常规文件为 commit（refs/main 优先），snapshots/<commit>/ 须存在且含 ≥1 *.gguf
// ④ 请求名可带 :QUANT（匹配前剥离，完整名传给 --hf-repo）
// ⑤ 请求匹配大小写不敏感；启动用目录名反解的原始大小写
import fs from 'node:fs';
import path from 'node:path';
import type { HfModel, LocalModel, ModelRef } from '../shared/types.js';

const REPO_CHARS = /^[A-Za-z0-9_.-]+$/;
const QUANT_RE = /^(.*?)[-_]((?:Q[0-9]+[A-Z0-9_]*|F16|F32|BF16))$/i;

export function isRepoId(s: string): boolean {
  if (s.length === 0 || s.length > 256) return false;
  const parts = s.split('/');
  return parts.length === 2 && parts.every(p => REPO_CHARS.test(p));
}

export function parseRepoFromDirName(dirName: string): string | null {
  if (!dirName.startsWith('models--')) return null;
  const repo = dirName.slice('models--'.length).split('--').join('/');
  return isRepoId(repo) ? repo : null;
}

export function extractQuant(fileName: string): string | null {
  const base = path.basename(fileName, path.extname(fileName));
  const m = base.match(QUANT_RE);
  return m ? m[2].toUpperCase() : null;
}

export function readCommit(repoDir: string): string | null {
  const refsDir = path.join(repoDir, 'refs');
  if (!fs.existsSync(refsDir) || !fs.statSync(refsDir).isDirectory()) return null;
  const files = fs.readdirSync(refsDir).filter(f => fs.statSync(path.join(refsDir, f)).isFile());
  const order = [...files].sort((a, b) => {
    if (a === 'main') return -1;
    if (b === 'main') return 1;
    return a.localeCompare(b);
  });
  for (const f of order) {
    const first = (fs.readFileSync(path.join(refsDir, f), 'utf8').split(/\r?\n/)[0] ?? '').trim();
    if (/^[0-9a-f]{40}$/i.test(first)) return first;
  }
  return null;
}

export function scanHfCache(hfDir: string): HfModel[] {
  if (!hfDir || !fs.existsSync(hfDir) || !fs.statSync(hfDir).isDirectory()) return [];
  const out: HfModel[] = [];
  for (const e of fs.readdirSync(hfDir, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith('models--')) continue;
    const dir = path.join(hfDir, e.name);
    if (!fs.existsSync(path.join(dir, 'snapshots'))) continue;
    const repo = parseRepoFromDirName(e.name);
    if (!repo) continue;
    const commit = readCommit(dir);
    if (!commit) continue;
    const snap = path.join(dir, 'snapshots', commit);
    if (!fs.existsSync(snap) || !fs.statSync(snap).isDirectory()) continue;
    const files = fs.readdirSync(snap).filter(f => /\.gguf$/i.test(f));
    if (files.length === 0) continue;
    const quants = [...new Set(files.map(extractQuant).filter((q): q is string => q !== null))].sort();
    const quant = quants.includes('Q4_K_M') ? 'Q4_K_M' : (quants[0] ?? null);
    const size = files.reduce((s, f) => s + fs.statSync(path.join(snap, f)).size, 0);
    const mmproj = files.some(f => /mmproj/i.test(f));
    out.push({ repo, path: snap, size, quants, quant, mmproj });
  }
  out.sort((a, b) => a.repo.localeCompare(b.repo));
  return out;
}

// 并集：同名（大小写不敏感）冲突时本地优先（规格 §4）
export function buildModelUnion(local: LocalModel[], hf: HfModel[]): ModelRef[] {
  const out: ModelRef[] = [];
  const seen = new Set<string>();
  for (const l of local) {
    const key = l.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: l.name, source: 'local', local: l });
  }
  for (const h of hf) {
    const key = h.repo.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: h.repo, source: 'hf', hf: h });
  }
  return out;
}

// 请求解析：剥离 :QUANT 后按名大小写不敏感匹配（规格 §4.1 ④⑤）
export function resolveModelRef(union: ModelRef[], request: string): ModelRef | null {
  const base = (request.split(':')[0] ?? '').trim();
  if (!base) return null;
  const key = base.toLowerCase();
  return union.find(r => r.name.toLowerCase() === key) ?? null;
}
```

- [ ] **Step 4: 运行测试确认通过**

运行：`cd /f/llama_lanucher && npx vitest run test/hf-cache.test.ts`
预期：`Test Files  1 passed (1)`，`Tests  15 passed (15)`。

- [ ] **Step 5: 类型检查 + 提交**

```bash
cd /f/llama_lanucher && npm run typecheck && git add -A && git -c user.name='dsh' -c user.email='dsh@local' commit -m "hf-cache: spec §4.1 five-step cache enumeration, union, case-insensitive resolve"
```

---

### Task 5: log-parser.ts — 行切分 + 时序正则 + 轮次聚合

**Files:**
- Create: `src/main/log-parser.ts`, `test/log-parser.test.ts`

真实样本（v9222 实测；b10488 可能带 `llama_print_timings:` 前缀；decode 单位可能是 `tokens` 或 `runs`，正则必须全部容错）：
```
prompt eval time =   44009.40 ms / 19417 tokens (    2.27 ms per token,   441.20 tokens per second)
       eval time =    5872.68 ms /   233 tokens (   25.20 ms per token,    39.68 tokens per second)
      total time =   49882.08 ms / 19650 tokens
```

- [ ] **Step 1: 写失败测试 test/log-parser.test.ts**

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

运行：`cd /f/llama_lanucher && npx vitest run test/log-parser.test.ts`
预期：FAIL（Cannot find module '../src/main/log-parser.js'）。

- [ ] **Step 3: 写 src/main/log-parser.ts**

```ts
// log-parser.ts — 日志行切分 + 时序行解析 + 轮次聚合（规格 §7）
// 时序行来源：prompt eval time → prefill 时间/速度；eval time → decode 速度
// 并发 slot 时行交错：eval 行并入最近一个尚未有 decode 的轮次
import type { TimingEvent } from '../shared/types.js';

const ANSI = /\x1b\[[0-9;]*m/g;

// 两种单位（tokens/runs）+ 可选 llama_print_timings: 前缀 + 可选 ANSI，全部容错
const PROMPT_RE = /^(?:llama_print_timings:\s*)?prompt eval time =\s+([\d.]+)\s*ms\s*\/\s*(\d+)\s+\S+\s*\(\s*([\d.]+)\s*ms per token,\s*([\d.]+)\s*\S+ per second\)/;
const EVAL_RE = /^(?:llama_print_timings:\s*)?eval time =\s+([\d.]+)\s*ms\s*\/\s*(\d+)\s+\S+\s*\(\s*([\d.]+)\s*ms per token,\s*([\d.]+)\s*\S+ per second\)/;

export function parseTimingLine(raw: string): TimingEvent | null {
  const line = raw.replace(ANSI, '');
  const m = line.match(PROMPT_RE);
  if (m) return { kind: 'prompt', ms: +m[1], tokens: +m[2], msPerToken: +m[3], tps: +m[4] };
  const e = line.match(EVAL_RE);
  if (e) return { kind: 'eval', ms: +e[1], tokens: +e[2], msPerToken: +e[3], tps: +e[4] };
  return null;
}

export function splitLines(buf: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let i = 0;
  for (;;) {
    const idx = buf.indexOf('\n', i);
    if (idx === -1) break;
    lines.push(buf.slice(i, idx).replace(/\r$/, ''));
    i = idx + 1;
  }
  return { lines, rest: buf.slice(i) };
}

export interface LogRound {
  ts: number;
  prefillMs: number | null;
  prefillTps: number | null;
  decodeMs: number | null;
  decodeTps: number | null;
}

export class RoundTracker {
  private list: LogRound[] = [];

  onPrompt(ev: TimingEvent, ts: number): void {
    this.list.push({ ts, prefillMs: ev.ms, prefillTps: ev.tps, decodeMs: null, decodeTps: null });
  }

  onEval(ev: TimingEvent, ts: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (this.list[i].decodeMs === null) {
        this.list[i].decodeMs = ev.ms;
        this.list[i].decodeTps = ev.tps;
        return;
      }
    }
    this.list.push({ ts, prefillMs: null, prefillTps: null, decodeMs: ev.ms, decodeTps: ev.tps });
  }

  get rounds(): LogRound[] { return this.list; }

  clear(): void { this.list = []; }
}
```

- [ ] **Step 4: 运行测试确认通过**

运行：`cd /f/llama_lanucher && npx vitest run test/log-parser.test.ts`
预期：`Test Files  1 passed (1)`，`Tests  12 passed (12)`。

- [ ] **Step 5: 类型检查 + 提交**

```bash
cd /f/llama_lanucher && npm run typecheck && git add -A && git -c user.name='dsh' -c user.email='dsh@local' commit -m "log-parser: defensive timing regexes (tokens/runs, prefix, ANSI), round tracker"
```

---

### Task 6: stats.ts — 代理请求 × 日志轮次归并

**Files:**
- Create: `src/main/stats.ts`, `test/stats.test.ts`

归并规则：请求按 ts 升序，每个请求配对「首个未配对、ts 落在 [req.ts-2000, req.ts+300000] 窗口内、距离最近」的日志轮次（prefill 可能长达数十秒，窗口放宽到 5 分钟）。无请求时「最新」仅取日志轮次（TTFT/缓存为 null）。

- [ ] **Step 1: 写失败测试 test/stats.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { StatsStore } from '../src/main/stats.js';
import type { RequestStats } from '../src/shared/types.js';
import type { LogRound } from '../src/main/log-parser.js';

const REQ: RequestStats = { model: 'm', ttftMs: 120, cacheHitRate: 0.5, ts: 1000 };
const ROUND: LogRound = { ts: 1500, prefillMs: 44009.4, prefillTps: 441.2, decodeMs: 5872.68, decodeTps: 39.68 };

describe('StatsStore', () => {
  it('pairs request with nearest round in window', () => {
    const s = new StatsStore();
    s.addRequest(REQ);
    s.addRound(ROUND);
    expect(s.getLatest()).toEqual({
      ts: 1000, model: 'm', ttftMs: 120, cacheHitRate: 0.5,
      prefillMs: 44009.4, prefillTps: 441.2, decodeTps: 39.68,
    });
  });

  it('round outside window not paired', () => {
    const s = new StatsStore();
    s.addRequest(REQ);
    s.addRound({ ...ROUND, ts: 1000 + 300_001 });
    expect(s.getLatest()!.prefillMs).toBeNull();
    expect(s.getLatest()!.ttftMs).toBe(120);
  });

  it('two requests pair with two rounds in order', () => {
    const s = new StatsStore();
    s.addRequest(REQ);
    s.addRequest({ ...REQ, ts: 5000, ttftMs: 90 });
    s.addRound(ROUND);
    s.addRound({ ...ROUND, ts: 5500, prefillMs: 100 });
    const h = s.getHistory();
    expect(h).toHaveLength(2);
    expect(h[0].prefillMs).toBe(44009.4);
    expect(h[1].prefillMs).toBe(100);
  });

  it('no requests -> latest from round only', () => {
    const s = new StatsStore();
    s.addRound(ROUND);
    expect(s.getLatest()).toEqual({
      ts: 1500, model: null, ttftMs: null, cacheHitRate: null,
      prefillMs: 44009.4, prefillTps: 441.2, decodeTps: 39.68,
    });
  });

  it('empty store -> null', () => {
    expect(new StatsStore().getLatest()).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

运行：`cd /f/llama_lanucher && npx vitest run test/stats.test.ts`
预期：FAIL（Cannot find module '../src/main/stats.js'）。

- [ ] **Step 3: 写 src/main/stats.ts**

```ts
// stats.ts — 代理请求（TTFT/缓存命中率）× 日志轮次（prefill/decode）归并（规格 §7）
import type { RequestStats, RoundStats } from '../shared/types.js';
import type { LogRound } from './log-parser.js';

const WINDOW_BEFORE = 2000;    // 轮次 ts 可早于请求 ts 的上限（时钟抖动）
const WINDOW_AFTER = 300_000;  // prefill 可能长达数十秒
const CAP = 1000;

export class StatsStore {
  private requests: RequestStats[] = [];
  private rounds: LogRound[] = [];

  addRequest(r: RequestStats): void {
    this.requests.push(r);
    if (this.requests.length > CAP) this.requests.shift();
  }

  addRound(r: LogRound): void {
    this.rounds.push(r);
    if (this.rounds.length > CAP) this.rounds.shift();
  }

  merge(): RoundStats[] {
    const used = new Set<LogRound>();
    const out: RoundStats[] = [];
    const reqs = [...this.requests].sort((a, b) => a.ts - b.ts);
    for (const req of reqs) {
      let best: LogRound | null = null;
      let bestD = Infinity;
      for (const r of this.rounds) {
        if (used.has(r)) continue;
        const d = r.ts - req.ts;
        if (d < -WINDOW_BEFORE || d > WINDOW_AFTER) continue;
        if (d < bestD) { bestD = d; best = r; }
      }
      if (best) used.add(best);
      out.push({
        ts: req.ts,
        model: req.model,
        ttftMs: req.ttftMs,
        cacheHitRate: req.cacheHitRate,
        prefillMs: best?.prefillMs ?? null,
        prefillTps: best?.prefillTps ?? null,
        decodeTps: best?.decodeTps ?? null,
      });
    }
    return out;
  }

  getLatest(): RoundStats | null {
    const m = this.merge();
    if (m.length > 0) return m[m.length - 1];
    const r = this.rounds[this.rounds.length - 1];
    if (r) return {
      ts: r.ts, model: null, ttftMs: null, cacheHitRate: null,
      prefillMs: r.prefillMs, prefillTps: r.prefillTps, decodeTps: r.decodeTps,
    };
    return null;
  }

  getHistory(): RoundStats[] { return this.merge(); }
}
```

- [ ] **Step 4: 运行测试确认通过**

运行：`cd /f/llama_lanucher && npx vitest run test/stats.test.ts`
预期：`Test Files  1 passed (1)`，`Tests  5 passed (5)`。

- [ ] **Step 5: 类型检查 + 提交**

```bash
cd /f/llama_lanucher && npm run typecheck && git add -A && git -c user.name='dsh' -c user.email='dsh@local' commit -m "stats: merge proxy request stats with log rounds (windowed nearest pairing)"
```

---

### Task 7: records.ts — 轮次记录 JSONL 存储（大文件性能）

**Files:**
- Create: `src/main/records.ts`, `test/records.test.ts`

写入侧：每条一次 `appendFile`；单文件超 50MB 滚动新文件（`2026-07-25.jsonl` → `-1` → …）；总量超 1GB 上限删最旧文件。读取侧：从文件尾部按 2MB chunk 读（绝不整文件加载），每页 50 条，跳过损坏行，跨天/跨文件倒序；跨 chunk 边界的多字节 UTF-8 字符必须正确拼回（中文对话常见）。

- [ ] **Step 1: 写失败测试 test/records.test.ts**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RecordsStore } from '../src/main/records.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RoundRecord } from '../src/shared/types.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const rec = (i: number): RoundRecord =>
  ({ ts: i, model: 'm', prompt: 'prompt ' + i, decode: 'decode ' + i, ttft_ms: 1, usage: null });

describe('RecordsStore', () => {
  it('append then tailPage returns newest first', async () => {
    const s = new RecordsStore(dir);
    await s.append(rec(1));
    await s.append(rec(2));
    await s.append(rec(3));
    const p = await s.tailPage(0);
    expect(p.records.map(r => r.ts)).toEqual([3, 2, 1]);
    expect(p.hasMore).toBe(false);
  });

  it('rolls to a new file when maxFileBytes exceeded', async () => {
    const s = new RecordsStore(dir, { maxFileBytes: 150 });
    for (let i = 100; i < 110; i++) await s.append(rec(i));
    const files = await s.listFiles();
    expect(files.length).toBeGreaterThanOrEqual(2);
    const p = await s.tailPage(0);
    expect(p.records.length).toBe(10);
    expect(p.records[0].ts).toBe(109);
    expect(p.records[9].ts).toBe(100);
  });

  it('paginates 50 per page', async () => {
    const s = new RecordsStore(dir);
    for (let i = 200; i < 320; i++) await s.append(rec(i));
    const p0 = await s.tailPage(0);
    const p1 = await s.tailPage(1);
    const p2 = await s.tailPage(2);
    expect(p0.records.length).toBe(50);
    expect(p0.records[0].ts).toBe(319);
    expect(p0.hasMore).toBe(true);
    expect(p1.records[0].ts).toBe(269);
    expect(p2.records.length).toBe(20);
    expect(p2.hasMore).toBe(false);
  });

  it('skips corrupt lines without breaking the page', async () => {
    const s = new RecordsStore(dir);
    await s.append(rec(400));
    const files = await s.listFiles();
    await fs.appendFile(files[0], '{corrupt json\n', 'utf8');
    await s.append(rec(401));
    const p = await s.tailPage(0);
    expect(p.records.map(r => r.ts)).toEqual([401, 400]);
  });

  it('enforces total cap by deleting oldest files', async () => {
    const s = new RecordsStore(dir, { maxFileBytes: 150, maxTotalBytes: 400 });
    for (let i = 500; i < 520; i++) await s.append(rec(i));
    const files = await s.listFiles();
    let total = 0;
    for (const f of files) total += (await fs.stat(f)).size;
    expect(total).toBeLessThanOrEqual(400 + 150);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

运行：`cd /f/llama_lanucher && npx vitest run test/records.test.ts`
预期：FAIL（Cannot find module '../src/main/records.js'）。

- [ ] **Step 3: 写 src/main/records.ts**

```ts
// records.ts — 轮次记录 JSONL 存储（规格 §8）
// 写入侧：每条一次 appendFile（O(1)）；单文件超 50MB 滚动新文件；总量超 1GB 上限删最旧文件
// 读取侧：从文件尾部按 2MB chunk 读，绝不整文件加载；每页 50 条；跳过损坏行；跨天/跨文件倒序
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RoundRecord } from '../shared/types.js';

const DEFAULT_MAX_FILE = 50 * 1024 * 1024;     // 50MB
const DEFAULT_MAX_TOTAL = 1024 * 1024 * 1024;  // 1GB
const CHUNK = 2 * 1024 * 1024;                 // 2MB 读块
const FILE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:-(\d+))?\.jsonl$/;

export interface RecordsOptions {
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

/** buf 开头属于不完整 UTF-8 字符（其头部在前一个 chunk）的字节数 */
function utf8HeadLen(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let i = 0;
  while (i < buf.length && (buf[i] & 0xc0) === 0x80) i++;
  if (i >= buf.length) return buf.length;
  const b = buf[i];
  if (b < 0x80) return i;
  const need = b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
  if (i + need > buf.length) return buf.length;
  return i;
}

export class RecordsStore {
  private dir: string;
  private maxFile: number;
  private maxTotal: number;

  constructor(dir: string, opts: RecordsOptions = {}) {
    this.dir = dir;
    this.maxFile = opts.maxFileBytes ?? DEFAULT_MAX_FILE;
    this.maxTotal = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL;
  }

  private fileFor(date: string, seq = 0): string {
    return path.join(this.dir, date + (seq > 0 ? `-${seq}` : '') + '.jsonl');
  }

  private today(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /** 追加一条记录；超单文件上限滚动新文件；超总量上限删最旧文件（至少保留最新文件） */
  async append(rec: RoundRecord): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const line = JSON.stringify(rec) + '\n';
    const bytes = Buffer.byteLength(line, 'utf8');
    const date = this.today();
    let file = this.fileFor(date);
    try {
      const { size } = await fs.stat(file);
      if (size + bytes > this.maxFile) {
        let seq = 1;
        for (;;) {
          const f = this.fileFor(date, seq);
          let exists = true;
          try { await fs.stat(f); } catch { exists = false; }
          if (!exists) { file = f; break; }
          seq++;
        }
      }
    } catch { /* 当日文件尚不存在 */ }
    await fs.appendFile(file, line, 'utf8');
    await this.enforceCap();
  }

  /** 全部记录文件，最新在前（日期降序，同日期序号降序） */
  async listFiles(): Promise<string[]> {
    let entries: string[] = [];
    try { entries = await fs.readdir(this.dir); } catch { return []; }
    const out: { f: string; d: string; s: number }[] = [];
    for (const e of entries) {
      const m = e.match(FILE_RE);
      if (!m) continue;
      out.push({ f: path.join(this.dir, e), d: m[1] + m[2] + m[3], s: m[4] ? +m[4] : 0 });
    }
    out.sort((a, b) => b.d.localeCompare(a.d) || b.s - a.s);
    return out.map(o => o.f);
  }

  private async enforceCap(): Promise<void> {
    const files = await this.listFiles();
    if (files.length === 0) return;
    let total = 0;
    for (const f of files) total += (await fs.stat(f)).size;
    for (let i = files.length - 1; i >= 1 && total > this.maxTotal; i--) {
      total -= (await fs.stat(files[i])).size;
      await fs.unlink(files[i]);
    }
  }

  /** 从尾部读一页：page 0 = 最新 pageSize 条；hasMore = 前面是否还有 */
  async tailPage(page: number, pageSize = 50): Promise<{ records: RoundRecord[]; hasMore: boolean }> {
    const target = (page + 1) * pageSize;
    const files = await this.listFiles();
    const lines: string[] = [];
    let hasMore = false;
    for (let fi = 0; fi < files.length && lines.length < target; fi++) {
      const file = files[fi];
      let size: number;
      try { size = (await fs.stat(file)).size; } catch { continue; }
      let pos = size;
      let held: Buffer = Buffer.alloc(0);
      let rest = '';
      const fh = await fs.open(file, 'r');
      try {
        while (pos > 0 && lines.length < target) {
          const readLen = Math.min(CHUNK, pos);
          const start = pos - readLen;
          const buf = Buffer.alloc(readLen);
          await fh.read(buf, 0, readLen, start);
          let data: Buffer = held.length > 0 ? Buffer.concat([buf, held]) : buf;
          held = Buffer.alloc(0);
          if (start > 0) {
            const h = utf8HeadLen(data);
            if (h > 0) {
              held = data.subarray(h);
              data = data.subarray(0, h);
            }
          }
          const parts = data.toString('utf8').split('\n');
          if (rest !== '') {
            parts[parts.length - 1] += rest;
            rest = '';
          }
          if (start > 0) {
            rest = parts.shift() ?? '';
          }
          for (const l of parts) if (l !== '') lines.push(l);
          pos = start;
        }
        if (lines.length >= target && (pos > 0 || fi < files.length - 1)) hasMore = true;
      } finally {
        await fh.close();
      }
    }
    const records: RoundRecord[] = [];
    for (const l of lines.slice(0, target)) {
      try { records.push(JSON.parse(l) as RoundRecord); } catch { /* 跳过损坏行 */ }
    }
    return { records: records.slice(page * pageSize, (page + 1) * pageSize), hasMore };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

运行：`cd /f/llama_lanucher && npx vitest run test/records.test.ts`
预期：`Test Files  1 passed (1)`，`Tests  5 passed (5)`。

- [ ] **Step 5: 类型检查 + 提交**

```bash
cd /f/llama_lanucher && npm run typecheck && git add -A && git -c user.name='dsh' -c user.email='dsh@local' commit -m "records: JSONL append/roll/tail-page with UTF-8-safe chunking and corrupt-line skip"
```

---

### Task 8: profiles.ts — 每模型参数档案

**Files:**
- Create: `src/main/profiles.ts`, `test/profiles.test.ts`

规格 §5.1：存 App 数据目录 `profiles/`，按模型键（本地路径或 HF repo 名）的 sha256 前 16 位十六进制命名；档案 = 表单全部参数 + 模型键 + savedAt；损坏档案 → 忽略（按无档案处理）；原子写（tmp + rename）。

- [ ] **Step 1: 写失败测试 test/profiles.test.ts**

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

运行：`cd /f/llama_lanucher && npx vitest run test/profiles.test.ts`
预期：FAIL（Cannot find module '../src/main/profiles.js'）。

- [ ] **Step 3: 写 src/main/profiles.ts**

```ts
// profiles.ts — 每模型参数档案（规格 §5.1）
// 存储：<appDataDir>/profiles/<sha256(model).slice(0,16)>.json
// 损坏档案 → 忽略（按无档案处理）；原子写（tmp + rename）
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { FormValues, Profile } from '../shared/types.js';

export function profileFileFor(dir: string, model: string): string {
  const hash = createHash('sha256').update(model).digest('hex').slice(0, 16);
  return path.join(dir, hash + '.json');
}

function isProfile(p: unknown): p is Profile {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  return typeof o.model === 'string' && typeof o.params === 'object' && o.params !== null;
}

export class ProfilesStore {
  constructor(private dir: string) {}

  async save(model: string, params: FormValues): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const p: Profile = { model, params, savedAt: Date.now() };
    const final = profileFileFor(this.dir, model);
    const tmp = final + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(p, null, 2), 'utf8');
    await fs.rename(tmp, final);
  }

  async load(model: string): Promise<Profile | null> {
    try {
      const raw = await fs.readFile(profileFileFor(this.dir, model), 'utf8');
      const p: unknown = JSON.parse(raw);
      return isProfile(p) ? p : null;
    } catch { return null; }
  }

  async delete(model: string): Promise<void> {
    try { await fs.unlink(profileFileFor(this.dir, model)); } catch { /* 不存在 */ }
  }

  /** 全部有效档案，最新在前；损坏文件跳过 */
  async list(): Promise<Profile[]> {
    let entries: string[] = [];
    try { entries = await fs.readdir(this.dir); } catch { return []; }
    const out: Profile[] = [];
    for (const e of entries) {
      if (!e.endsWith('.json')) continue;
      try {
        const p: unknown = JSON.parse(await fs.readFile(path.join(this.dir, e), 'utf8'));
        if (isProfile(p)) out.push(p);
      } catch { /* 损坏 → 忽略 */ }
    }
    out.sort((a, b) => b.savedAt - a.savedAt);
    return out;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

运行：`cd /f/llama_lanucher && npx vitest run test/profiles.test.ts`
预期：`Test Files  1 passed (1)`，`Tests  5 passed (5)`。

- [ ] **Step 5: 类型检查 + 提交**

```bash
cd /f/llama_lanucher && npm run typecheck && git add -A && git -c user.name='dsh' -c user.email='dsh@local' commit -m "profiles: per-model form profiles (hash-named, atomic, corrupt-tolerant)"
```

---

### Task 9: version.ts — 版本解析 + 启动失败诊断

**Files:**
- Create: `src/main/version.ts`, `test/version.test.ts`

规格 §9.1：`--version` 输出两种格式都要解析（旧版 `version: 9222 (9a532ae4b)`、新版
`version: 0.1.2-dev (build 10488, commit 9d77fa172)`，均为本机实测字符串）；
非基线版本 → 非阻塞横幅文案；启动 <10s 非零退出 → 扫 stderr 匹配
`error: invalid argument: --xxx` 或 `the argument ... has been removed`，
反查「CLI 参数 ← 表单字段」映射表生成精准提示（映射表由 args.ts 产出）。

- [ ] **Step 1: 写失败测试 test/version.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { parseVersion, versionBanner, diagnoseStartupFailure, BASELINE_BUILD } from '../src/main/version.js';

const OLD_OUT = 'version: 9222 (9a532ae4b)\nbuilt with Clang 19.1.5 for Windows x86_64\n';
const NEW_OUT = 'version: 0.1.2-dev (build 10488, commit 9d77fa172)\nbuilt with Clang 20.1.8 for Windows x86_64\n';

describe('parseVersion', () => {
  it('parses old format (v9222 real output)', () => {
    const v = parseVersion(OLD_OUT);
    expect(v.build).toBe(9222);
    expect(v.commit).toBe('9a532ae4b');
    expect(v.raw).toContain('version: 9222');
  });

  it('parses new format (b10488 real output)', () => {
    const v = parseVersion(NEW_OUT);
    expect(v.build).toBe(10488);
    expect(v.commit).toBe('9d77fa172');
  });

  it('unparseable -> nulls, raw kept', () => {
    const v = parseVersion('llama-server: unrecognized option\n');
    expect(v.build).toBeNull();
    expect(v.commit).toBeNull();
    expect(v.raw).not.toBe('');
  });
});

describe('versionBanner', () => {
  it('baseline -> no banner', () => {
    expect(versionBanner(parseVersion(NEW_OUT))).toBeNull();
  });

  it('non-baseline -> banner with version and baseline', () => {
    const b = versionBanner(parseVersion(OLD_OUT));
    expect(b).not.toBeNull();
    expect(b!).toContain('9222');
    expect(b!).toContain('b10488');
  });

  it('unparseable -> no banner', () => {
    expect(versionBanner(parseVersion('???'))).toBeNull();
  });
});

describe('diagnoseStartupFailure', () => {
  const MAP: Record<string, string> = {
    '--n-gpu-layers': 'nGpuLayers',
    '--mmap': 'loadMode',
    '--foo': 'extraArgs',
  };

  it('invalid argument -> mapped field', () => {
    const d = diagnoseStartupFailure(
      'llama_model_loader: failed to load model\nerror: invalid argument: --n-gpu-layers\n',
      MAP,
    );
    expect(d).not.toBeNull();
    expect(d!.arg).toBe('--n-gpu-layers');
    expect(d!.field).toBe('nGpuLayers');
    expect(d!.reason).toBe('invalid');
    expect(d!.message).toContain('nGpuLayers');
  });

  it('removed argument -> mapped field', () => {
    const d = diagnoseStartupFailure(
      'error: the argument --mmap has been removed. Use --load-mode instead.\n',
      MAP,
    );
    expect(d).not.toBeNull();
    expect(d!.arg).toBe('--mmap');
    expect(d!.field).toBe('loadMode');
    expect(d!.reason).toBe('removed');
    expect(d!.message).toContain('loadMode');
  });

  it('extra-args token -> extraArgs field', () => {
    const d = diagnoseStartupFailure('error: invalid argument: --foo\n', MAP);
    expect(d!.field).toBe('extraArgs');
    expect(d!.message).toContain('附加参数');
  });

  it('no known pattern -> null', () => {
    expect(diagnoseStartupFailure('some other fatal error\n', MAP)).toBeNull();
  });
});

it('baseline constant', () => {
  expect(BASELINE_BUILD).toBe(10488);
});
```

- [ ] **Step 2: 运行测试确认失败**

运行：`cd /f/llama_lanucher && npx vitest run test/version.test.ts`
预期：FAIL（Cannot find module '../src/main/version.js'）。

- [ ] **Step 3: 写 src/main/version.ts**

```ts
// version.ts — llama.cpp 版本解析与启动失败精准诊断（规格 §9.1）
// 被动兼容 + 精准诊断：不做自动改名，只告诉用户哪个参数坏了、在哪改
import type { ParsedVersion } from '../shared/types.js';

export const BASELINE_BUILD = 10488;

// 旧版（v9222 实测）：version: 9222 (9a532ae4b)
const OLD_RE = /version:\s*(\d+)\s*\(([0-9a-f]{7,40})\)/i;
// 新版（b10488 实测）：version: 0.1.2-dev (build 10488, commit 9d77fa172)
const NEW_RE = /version:.*\(build\s+(\d+),\s*commit\s+([0-9a-f]{7,40})\)/i;

export function parseVersion(output: string): ParsedVersion {
  const line = output.split(/\r?\n/).find(l => /version:/i.test(l)) ?? output.trim();
  const m = line.match(OLD_RE) ?? line.match(NEW_RE);
  if (!m) return { build: null, commit: null, raw: line.trim() };
  return { build: +m[1], commit: m[2], raw: line.trim() };
}

/** 非基线版本 → 黄色横幅文案；基线或解析失败 → null */
export function versionBanner(v: ParsedVersion): string | null {
  if (v.build === null || v.build === BASELINE_BUILD) return null;
  return `检测到 llama.cpp v${v.build}，参数表单基于 b${BASELINE_BUILD} 设计，个别参数可能已改名`;
}

export interface LaunchFailure {
  arg: string;            // 出问题的 CLI 参数（removed 且无法提取时为空串）
  field: string | null;   // 表单字段 key / 'extraArgs' / null（强制参数或未映射）
  reason: 'invalid' | 'removed';
  message: string;        // 直接展示给用户的中文提示
}

const INVALID_RE = /error:\s*invalid argument:\s*(--[A-Za-z0-9][\w-]*)/;
const REMOVED_RE = /the argument\s+((?:--\w[\w-]*)\s+)?has been removed/i;

/** stderr 扫描：启动 <10s 非零退出时调用；argToField 由 buildArgs 产出 */
export function diagnoseStartupFailure(stderr: string, argToField: Record<string, string>): LaunchFailure | null {
  const mi = stderr.match(INVALID_RE);
  const mr = mi ? null : stderr.match(REMOVED_RE);
  if (!mi && !mr) return null;
  const reason: 'invalid' | 'removed' = mi ? 'invalid' : 'removed';
  const arg = mi ? mi[1] : (mr ? (mr[1] ?? '').trim() : '');
  const field = arg !== '' ? (argToField[arg] ?? null) : null;
  const head = reason === 'invalid'
    ? `参数 `${arg}` 未被当前版本识别（可能已改名或移除）`
    : `参数 `${arg}` 在当前版本已被移除`;
  let tail = '';
  if (field !== null) {
    tail = field === 'extraArgs' ? '，请清空『附加参数』' : `，请清空表单字段「${field}」`;
  }
  const message = arg !== ''
    ? `${head}${tail}，或改用『附加参数』填新版本参数`
    : 'llama-server 启动即退出并报告参数已被移除，请检查表单参数与当前版本是否匹配';
  return { arg, field, reason, message };
}
```

- [ ] **Step 4: 运行测试确认通过**

运行：`cd /f/llama_lanucher && npx vitest run test/version.test.ts`
预期：`Test Files  1 passed (1)`，`Tests  11 passed (11)`。

- [ ] **Step 5: 类型检查 + 提交**

```bash
cd /f/llama_lanucher && npm run typecheck && git add -A && git -c user.name='dsh' -c user.email='dsh@local' commit -m "version: dual-format --version parse, baseline banner, stderr launch-failure diagnosis"
```

---

### Task 10: args.ts — 命令行组装（含 参数←字段 映射表）

**Files:**
- Create: `src/main/args.ts`, `test/args.test.ts`

规格 §5/§5.3：表单值 → argv。`留空 = 不传`；布尔恒显式 `--flag`/`--no-flag`；
强制参数 `--log-colors on --metrics --host 127.0.0.1 --port <内部端口>` 追加在尾部
（用户不可改）；模型来源：本地 `--model <path>`，HF cache `--hf-repo <name>[:quant] --offline`
+ 注入 `HF_HUB_CACHE` 环境变量；`--spec-type` 多选 → 重复 flag；`extraArgs` shlex 分词
追加在最后（覆盖一切）。表单的可见端口/`--host`/CORS 四件套**只作用于代理层，绝不传给 server**。
同时产出 `argToField` 映射表（CLI flag → 表单字段 key / 'extraArgs' / 'forced'），供 Task 9 诊断反查。

- [ ] **Step 1: 写失败测试 test/args.test.ts**

```ts
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
  device: '', loadMode: '', fit: true, cacheTypeK: '', cacheTypeV: '', nCpuMoE: '',
  ctxSize: '', parallel: '', batchSize: '', ubatchSize: '',
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
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] === val;
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
    expect(argv).toContain('--no-swa-full');
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
```

- [ ] **Step 2: 运行测试确认失败**

运行：`cd /f/llama_lanucher && npx vitest run test/args.test.ts`
预期：FAIL（Cannot find module '../src/main/args.js'）。

- [ ] **Step 3: 写 src/main/args.ts**

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

运行：`cd /f/llama_lanucher && npx vitest run test/args.test.ts`
预期：`Test Files  1 passed (1)`，`Tests  10 passed (10)`。

- [ ] **Step 5: 类型检查 + 提交**

```bash
cd /f/llama_lanucher && npm run typecheck && git add -A && git -c user.name='dsh' -c user.email='dsh@local' commit -m "args: form-to-argv builder (empty=omit, explicit booleans, forced tail, shlex extraArgs, arg map)"
```

---

### Task 11: process-manager.ts — 进程生命周期（含 fake-server 测试替身）

**Files:**
- Create: `src/main/process-manager.ts`, `test/fake-server.mjs`, `test/process-manager.test.ts`

规格 §5.3/§5.4：spawn（`env` 注入 HF_HUB_CACHE 等）、stdout/stderr 逐行回调
（复用 Task 5 `splitLines`，CRLF 安全）、`/health` 轮询等就绪（模型加载可达数分钟，
默认 5 分钟超时）、stop = `proc.kill()` → 等 10s → Windows `taskkill /T /F /PID` 兜底、
崩溃检测（启动 <10s 非零退出 → `early=true` + 捕获的 stderr 交给 Task 9 诊断）、
内部端口探测（59999 起，逐个试绑 127.0.0.1）。

- [ ] **Step 1: 写 test/fake-server.mjs（测试替身，模拟 llama-server）**

```js
// fake-server.mjs — 测试替身：模拟 llama-server 的 /health、SSE、崩溃与 SIGTERM 行为
// 环境变量：FAKE_PORT、FAKE_HEALTH_DELAY_MS、FAKE_CRASH_MS、FAKE_CRASH_MSG、FAKE_IGNORE_SIGTERM
import http from 'node:http';

const port = Number(process.env.FAKE_PORT || '59900');
const readyAt = Date.now() + Number(process.env.FAKE_HEALTH_DELAY_MS || '0');

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    if (Date.now() < readyAt) { res.writeHead(503); res.end('loading'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":"ok"}');
    return;
  }
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[{"id":"fake-model"}]}');
    return;
  }
  if (req.url === '/v1/chat/completions') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n');
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }, 20);
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`fake-server ready on ${port}`);
});

const crashMs = process.env.FAKE_CRASH_MS ? Number(process.env.FAKE_CRASH_MS) : null;
if (crashMs !== null) {
  setTimeout(() => {
    process.stderr.write((process.env.FAKE_CRASH_MSG || 'error: invalid argument: --fake-flag') + '\n');
    process.exit(1);
  }, crashMs);
}

if (process.env.FAKE_IGNORE_SIGTERM === '1') {
  process.on('SIGTERM', () => { /* 忽略，用于强杀路径测试 */ });
} else {
  process.on('SIGTERM', () => process.exit(0));
}
```

- [ ] **Step 2: 写失败测试 test/process-manager.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { ProcessManager, probeFreePort, isPortFree, type ExitInfo } from '../src/main/process-manager.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-server.mjs');

describe('ProcessManager', () => {
  it('start, wait for health, stop', async () => {
    const port = await probeFreePort(59900);
    const pm = new ProcessManager();
    const lines: string[] = [];
    let exitInfo: ExitInfo | null = null;
    await pm.start({
      exe: process.execPath,
      argv: [FAKE],
      env: { FAKE_PORT: String(port), FAKE_HEALTH_DELAY_MS: '300' },
      port,
      onLine: l => lines.push(l),
      onExit: i => { exitInfo = i; },
    });
    await pm.waitForHealth(5000);
    expect(pm.running).toBe(true);
    expect(lines.some(l => l.includes('fake-server ready'))).toBe(true);
    await pm.stop();
    expect(pm.running).toBe(false);
    expect(exitInfo).not.toBeNull();
    expect(exitInfo!.intentional).toBe(true);
  });

  it('early crash -> onExit early with captured stderr', async () => {
    const port = await probeFreePort(59900);
    const pm = new ProcessManager();
    let exitInfo: ExitInfo | null = null;
    await pm.start({
      exe: process.execPath,
      argv: [FAKE],
      env: { FAKE_PORT: String(port), FAKE_CRASH_MS: '200', FAKE_CRASH_MSG: 'error: invalid argument: --fake-flag' },
      port,
      onLine: () => {},
      onExit: i => { exitInfo = i; },
    });
    await new Promise(r => setTimeout(r, 1500));
    expect(exitInfo).not.toBeNull();
    expect(exitInfo!.early).toBe(true);
    expect(exitInfo!.intentional).toBe(false);
    expect(exitInfo!.code).toBe(1);
    expect(exitInfo!.stderr).toContain('error: invalid argument: --fake-flag');
  });

  it('stop force-kills a server that ignores SIGTERM', async () => {
    const port = await probeFreePort(59900);
    const pm = new ProcessManager();
    await pm.start({
      exe: process.execPath,
      argv: [FAKE],
      env: { FAKE_PORT: String(port), FAKE_IGNORE_SIGTERM: '1' },
      port,
      onLine: () => {},
      onExit: () => {},
    });
    await pm.waitForHealth(5000);
    const t0 = Date.now();
    await pm.stop();
    expect(Date.now() - t0).toBeLessThan(15000);
    expect(pm.running).toBe(false);
  });
});

describe('port probe', () => {
  it('probeFreePort returns a free port in range', async () => {
    const p = await probeFreePort(59900, 60999);
    expect(p).toBeGreaterThanOrEqual(59900);
    expect(p).toBeLessThanOrEqual(60999);
    expect(await isPortFree(p)).toBe(true);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

运行：`cd /f/llama_lanucher && npx vitest run test/process-manager.test.ts`
预期：FAIL（Cannot find module '../src/main/process-manager.js'）。

- [ ] **Step 4: 写 src/main/process-manager.ts**

```ts
// process-manager.ts — llama-server 进程生命周期（规格 §5.3 / §5.4）
// spawn（env 注入）、逐行日志回调（splitLines，CRLF 安全）、/health 轮询、
// stop = kill → 10s → taskkill /T /F 兜底、<10s 非零退出 = early crash（stderr 供诊断）、
// 内部端口探测（59999 起逐个试绑 127.0.0.1）
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import { splitLines } from './log-parser.js';

export interface StartOptions {
  exe: string;
  argv: string[];
  env: Record<string, string>;
  port: number;
  onLine: (line: string) => void;
  onExit: (info: ExitInfo) => void;
}

export interface ExitInfo {
  code: number | null;
  early: boolean;         // 启动后 10s 内退出
  stderr: string;         // 捕获的 stderr（上限 256KB）
  intentional: boolean;   // 是否由 stop() 触发
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export function isPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

export async function probeFreePort(start = 59999, end = 60999): Promise<number> {
  for (let p = start; p <= end; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`no free port in ${start}..${end}`);
}

export class ProcessManager {
  private proc: ChildProcess | null = null;
  private port = 0;
  private startTs = 0;
  private intentional = false;
  private stderrBuf = '';

  get running(): boolean { return this.proc !== null; }
  get pid(): number | null { return this.proc?.pid ?? null; }
  get currentPort(): number { return this.port; }

  async start(opts: StartOptions): Promise<void> {
    if (this.proc) throw new Error('already running');
    this.port = opts.port;
    this.startTs = Date.now();
    this.intentional = false;
    this.stderrBuf = '';

    const proc = spawn(opts.exe, opts.argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...opts.env },
      windowsHide: true,
    });
    this.proc = proc;

    let outRest = '';
    let errRest = '';
    proc.stdout?.on('data', (c: Buffer) => {
      const { lines, rest } = splitLines(outRest + c.toString('utf8'));
      outRest = rest;
      for (const l of lines) opts.onLine(l);
    });
    proc.stderr?.on('data', (c: Buffer) => {
      this.stderrBuf = (this.stderrBuf + c.toString('utf8')).slice(-262144);
      const { lines, rest } = splitLines(errRest + c.toString('utf8'));
      errRest = rest;
      for (const l of lines) opts.onLine(l);
    });

    let done = false;
    const finish = (code: number | null): void => {
      if (done) return;
      done = true;
      this.proc = null;
      opts.onExit({
        code,
        early: Date.now() - this.startTs < 10000,
        stderr: this.stderrBuf,
        intentional: this.intentional,
      });
    };
    proc.on('error', (err) => {
      this.stderrBuf += `\nspawn error: ${err.message}\n`;
      finish(null);
    });
    proc.on('exit', (code) => finish(code));
  }

  /** 轮询 /health 直到 200；进程中途退出或超时 → throw */
  async waitForHealth(timeoutMs = 300000, intervalMs = 500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.proc === null) throw new Error('server exited during startup');
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/health`);
        if (res.status === 200) return;
      } catch { /* 尚未就绪 */ }
      await sleep(intervalMs);
    }
    throw new Error(`health check timed out after ${timeoutMs}ms`);
  }

  /** kill → 等 10s → Windows taskkill /T /F /PID 兜底 */
  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.intentional = true;
    const pid = proc.pid;
    if (pid === undefined) { this.proc = null; return; }
    const exited = new Promise<void>(resolve => {
      if (proc.exitCode !== null || proc.signalCode !== null) resolve();
      else proc.once('exit', () => resolve());
    });
    try { proc.kill(); } catch { /* 已退出 */ }
    const t0 = Date.now();
    while (Date.now() - t0 < 10000) {
      await Promise.race([exited, sleep(200)]);
      if (proc.exitCode !== null || proc.signalCode !== null) break;
    }
    if (proc.exitCode === null && proc.signalCode === null) {
      if (process.platform === 'win32') {
        await new Promise<void>(resolve => {
          execFile('taskkill', ['/T', '/F', '/PID', String(pid)], () => resolve());
        });
      } else {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }
      await Promise.race([exited, sleep(5000)]);
    }
    this.proc = null;
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

运行：`cd /f/llama_lanucher && npx vitest run test/process-manager.test.ts`
预期：`Test Files  1 passed (1)`，`Tests  4 passed (4)`。

- [ ] **Step 6: 类型检查 + 提交**

```bash
cd /f/llama_lanucher && npm run typecheck && git add -A && git -c user.name='dsh' -c user.email='dsh@local' commit -m "process-manager: spawn/health/stop(taskkill fallback)/early-crash capture + fake-server test double"
```
