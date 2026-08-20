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

---

### Task 12: proxy.ts — 反向代理与自动模型切换（CORS/TTFT/usage/排队）

**Files:**
- Create: `src/main/proxy.ts`, `test/proxy.test.ts`

规格 §2.1/§2.3/§5.4/§7/§8/§10：代理监听可见端口（proxyHost:visiblePort）并
转发到内部端口；SSE 原样透传；TTFT = 请求体收到 → 首个含 content 的 SSE 块；
usage/cached_tokens 解析（流式取 [DONE] 前最后一个 usage 块，非流式取 JSON usage）；
recordRounds 开启时记录 prompt/decode 到 RecordsStore（关闭零开销）；
CORS 四件套只在代理层处理（空值默认 *，OPTIONS 预检 204）；
server 未就绪（stopped/crashed/starting）→ 503；切换进行中 → 排队（上限 10、
等待 5 分钟，超时 503 `model switching in progress`）；POST 带 model 字段且与当前不同 → 自动切换
（resolveModelRef 解析，不在并集 400 `model '<name>' not found`，切换失败 502）；
GET /v1/models 返回并集列表并标记当前模型；切换完成后按队列顺序放行。
测试替身：Task 11 的 fake-server.mjs 作真实后端 + 注入 SwitchController 接口（假启动/停止/就绪状态，
解耦 ProcessManager）。

- [ ] **Step 1: 写失败测试 test/proxy.test.ts**

```ts
// proxy.test.ts — 反向代理与自动模型切换（规格 §2.1/§2.3/§5.4/§7/§8/§11）
// 测试替身：Task 11 的 fake-server.mjs 作真实后端 + FakeController（注入式控制器，解耦 ProcessManager）
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { LauncherProxy, computeCacheHitRate, type SwitchController } from '../src/main/proxy.js';
import { RecordsStore } from '../src/main/records.js';
import { probeFreePort } from '../src/main/process-manager.js';
import { DEFAULT_FORM } from '../src/main/config.js';
import type { ModelRef, RequestStats } from '../src/shared/types.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-server.mjs');

function ref(name: string): ModelRef {
  return {
    name,
    source: 'local',
    local: { name, path: `/models/${name}.gguf`, size: 1, mtime: 0, mmproj: null, mmprojCandidates: [] },
  };
}

class FakeController implements SwitchController {
  port = 0;
  ready = false;
  current: string | null = null;
  models: ModelRef[] = [];
  _switching = false;
  switchImpl: (m: ModelRef) => Promise<void> = async () => { this._switching = false; };
  switchCalls: ModelRef[] = [];
  internalPort(): number | null { return this.port === 0 ? null : this.port; }
  isReady(): boolean { return this.ready; }
  currentModel(): string | null { return this.current; }
  union(): ModelRef[] { return this.models; }
  switching(): boolean { return this._switching; }
  switchTo(m: ModelRef): Promise<void> {
    this._switching = true;
    this.switchCalls.push(m);
    return this.switchImpl(m);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await sleep(50);
  }
}

function probeTcp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
  });
}

async function startFake(port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, [FAKE], {
    env: { ...process.env, FAKE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitFor(() => probeTcp(port), 5000);
  return child;
}

interface Resp { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(port: number, urlPath: string, method: string, body?: string, headers: Record<string, string> = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        agent: false,
        headers: body !== undefined
          ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...headers }
          : { ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const postJson = (port: number, p: string, obj: unknown, h: Record<string, string> = {}): Promise<Resp> =>
  request(port, p, 'POST', JSON.stringify(obj), h);
const doGet = (port: number, p: string, h: Record<string, string> = {}): Promise<Resp> =>
  request(port, p, 'GET', undefined, h);
const doOptions = (port: number, p: string, h: Record<string, string> = {}): Promise<Resp> =>
  request(port, p, 'OPTIONS', undefined, h);

describe('LauncherProxy', () => {
  let child: ChildProcess;
  let proxy: LauncherProxy;
  let ctrl: FakeController;
  let stats: RequestStats[];
  let proxyPort: number;
  let backendPort: number;

  beforeAll(async () => {
    backendPort = await probeFreePort(61500, 61999);
    child = await startFake(backendPort);
    proxyPort = await probeFreePort(61500, 61999);
    ctrl = new FakeController();
    ctrl.models = [ref('fake-model'), ref('other-model')];
    stats = [];
    proxy = new LauncherProxy({
      host: '127.0.0.1',
      port: proxyPort,
      controller: ctrl,
      form: { ...DEFAULT_FORM },
      onStats: (s) => stats.push(s),
    });
    await proxy.start();
  });

  afterAll(async () => {
    await proxy.stop();
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
  });

  beforeEach(() => {
    ctrl.port = backendPort;
    ctrl.ready = true;
    ctrl._switching = false;
    ctrl.current = 'fake-model';
    ctrl.switchCalls.length = 0;
    ctrl.switchImpl = async (m) => { ctrl._switching = false; ctrl.current = m.name; };
    stats.length = 0;
  });

  it('forwards SSE as-is and reports TTFT', async () => {
    const res = await postJson(proxyPort, '/v1/chat/completions', {
      model: 'fake-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/event-stream');
    expect(res.body).toContain('"content":"hel"');
    expect(res.body).toContain('"content":"lo"');
    expect(res.body).toContain('[DONE]');
    expect(stats.length).toBe(1);
    expect(stats[0].model).toBe('fake-model');
    expect(stats[0].ttftMs).toBeGreaterThanOrEqual(0);
    expect(stats[0].ttftMs).toBeLessThan(5000);
    expect(stats[0].cacheHitRate).toBeNull();
  });

  it('serves /v1/models from the union and marks the current model', async () => {
    const res = await doGet(proxyPort, '/v1/models');
    expect(res.status).toBe(200);
    const obj = JSON.parse(res.body) as { data: { id: string; current: boolean }[] };
    expect(obj.data.map((d) => d.id)).toEqual(['fake-model', 'other-model']);
    expect(obj.data[0].current).toBe(true);
    expect(obj.data[1].current).toBe(false);
  });

  it('returns 503 when the server is not ready', async () => {
    ctrl.ready = false;
    const res = await postJson(proxyPort, '/v1/chat/completions', { model: 'fake-model', messages: [] });
    expect(res.status).toBe(503);
    expect(res.body).toContain('not ready');
  });

  it('answers OPTIONS preflight with default CORS headers', async () => {
    const res = await doOptions(proxyPort, '/v1/chat/completions', { origin: 'http://example.com' });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toBe('*');
    expect(res.headers['access-control-allow-headers']).toBe('*');
  });

  it('uses the form CORS origins and reflects the origin when credentials are on', async () => {
    proxy.setForm({ ...DEFAULT_FORM, corsOrigins: 'http://example.com', corsCredentials: true });
    const res = await doOptions(proxyPort, '/v1/chat/completions', { origin: 'http://example.com' });
    expect(res.headers['access-control-allow-origin']).toBe('http://example.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    proxy.setForm({ ...DEFAULT_FORM });
  });

  it('rejects unknown models with 400', async () => {
    const res = await postJson(proxyPort, '/v1/chat/completions', { model: 'nope-model', messages: [] });
    expect(res.status).toBe(400);
    expect(res.body).toContain("model 'nope-model' not found");
  });

  it('auto-switches when the request names another known model', async () => {
    const res = await postJson(proxyPort, '/v1/chat/completions', {
      model: 'other-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('[DONE]');
    expect(ctrl.switchCalls.length).toBe(1);
    expect(ctrl.switchCalls[0].name).toBe('other-model');
    expect(ctrl.current).toBe('other-model');
  });

  it('returns 502 when the switch fails', async () => {
    ctrl.switchImpl = async () => { ctrl._switching = false; throw new Error('boom'); };
    const res = await postJson(proxyPort, '/v1/chat/completions', { model: 'other-model', messages: [] });
    expect(res.status).toBe(502);
    expect(res.body).toContain('failed');
  });

  it('queues requests while switching and forwards them after completion', async () => {
    ctrl.ready = false;
    ctrl._switching = true;
    const p = postJson(proxyPort, '/v1/chat/completions', {
      model: 'fake-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await sleep(400);
    ctrl._switching = false;
    ctrl.ready = true;
    const res = await p;
    expect(res.status).toBe(200);
    expect(res.body).toContain('[DONE]');
  });

  it('rejects with 503 when the switch queue is full', async () => {
    const p2port = await probeFreePort(61500, 61999);
    const p2 = new LauncherProxy({ host: '127.0.0.1', port: p2port, controller: ctrl, form: { ...DEFAULT_FORM }, queueCap: 2 });
    await p2.start();
    ctrl.ready = false;
    ctrl._switching = true;
    const r1 = postJson(p2port, '/v1/chat/completions', { model: 'fake-model', messages: [] });
    const r2 = postJson(p2port, '/v1/chat/completions', { model: 'fake-model', messages: [] });
    const res3 = await postJson(p2port, '/v1/chat/completions', { model: 'fake-model', messages: [] });
    expect(res3.status).toBe(503);
    expect(res3.body).toContain('model switching in progress');
    ctrl._switching = false;
    ctrl.ready = true;
    const [res1, res2] = await Promise.all([r1, r2]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    await p2.stop();
  });

  it('rejects a queued request after the queue timeout', async () => {
    const p2port = await probeFreePort(61500, 61999);
    const p2 = new LauncherProxy({ host: '127.0.0.1', port: p2port, controller: ctrl, form: { ...DEFAULT_FORM }, queueTimeoutMs: 300 });
    await p2.start();
    ctrl.ready = false;
    ctrl._switching = true;
    const res = await postJson(p2port, '/v1/chat/completions', { model: 'fake-model', messages: [] });
    expect(res.status).toBe(503);
    expect(res.body).toContain('model switching in progress');
    ctrl._switching = false;
    ctrl.ready = true;
    await p2.stop();
  });

  it('records prompt and decode when recordRounds is on', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'llama-proxy-rec-'));
    try {
      const records = new RecordsStore(dir, {});
      const p2port = await probeFreePort(61500, 61999);
      const p2 = new LauncherProxy({
        host: '127.0.0.1',
        port: p2port,
        controller: ctrl,
        form: { ...DEFAULT_FORM, recordRounds: true },
        records,
      });
      await p2.start();
      const res = await postJson(p2port, '/v1/chat/completions', {
        model: 'fake-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
      expect(res.status).toBe(200);
      await waitFor(async () => (await records.listFiles()).length > 0);
      const page = await records.tailPage(0);
      expect(page.records.length).toBe(1);
      expect(page.records[0].prompt).toContain('user: hi');
      expect(page.records[0].decode).toBe('hello');
      await p2.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('parses cached_tokens from the trailing usage chunk (streaming)', async () => {
    const backend = http.createServer((req, res) => {
      if (req.url?.startsWith('/v1/chat/completions')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"A"}}]}\n\n');
        res.write('data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":40}}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      }
    });
    await new Promise<void>((r) => backend.listen(0, '127.0.0.1', r));
    const bport = (backend.address() as { port: number }).port;
    const p2port = await probeFreePort(61500, 61999);
    const c2 = new FakeController();
    c2.port = bport;
    c2.ready = true;
    c2.current = 'm1';
    c2.models = [ref('m1')];
    const s2: RequestStats[] = [];
    const p2 = new LauncherProxy({ host: '127.0.0.1', port: p2port, controller: c2, form: { ...DEFAULT_FORM }, onStats: (s) => s2.push(s) });
    await p2.start();
    const res = await postJson(p2port, '/v1/chat/completions', { model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream: true });
    expect(res.status).toBe(200);
    expect(s2.length).toBe(1);
    expect(s2[0].cacheHitRate).toBeCloseTo(0.4);
    expect(s2[0].ttftMs).toBeGreaterThanOrEqual(0);
    await p2.stop();
    backend.closeAllConnections();
    await new Promise<void>((r) => backend.close(() => r()));
  });

  it('parses usage and message content from a non-streaming JSON response', async () => {
    const backend = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: 'hi there' } }],
        usage: { prompt_tokens: 50, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 50 } },
      }));
    });
    await new Promise<void>((r) => backend.listen(0, '127.0.0.1', r));
    const bport = (backend.address() as { port: number }).port;
    const p2port = await probeFreePort(61500, 61999);
    const c2 = new FakeController();
    c2.port = bport;
    c2.ready = true;
    c2.current = 'm1';
    c2.models = [ref('m1')];
    const s2: RequestStats[] = [];
    const p2 = new LauncherProxy({ host: '127.0.0.1', port: p2port, controller: c2, form: { ...DEFAULT_FORM }, onStats: (s) => s2.push(s) });
    await p2.start();
    const res = await postJson(p2port, '/v1/chat/completions', { model: 'm1', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    const obj = JSON.parse(res.body) as { choices: { message: { content: string } }[] };
    expect(obj.choices[0].message.content).toBe('hi there');
    expect(s2.length).toBe(1);
    expect(s2[0].cacheHitRate).toBeCloseTo(1);
    expect(s2[0].ttftMs).toBeNull();
    await p2.stop();
    backend.closeAllConnections();
    await new Promise<void>((r) => backend.close(() => r()));
  });

  it('computeCacheHitRate handles missing and zero fields', () => {
    expect(computeCacheHitRate(null)).toBeNull();
    expect(computeCacheHitRate({})).toBeNull();
    expect(computeCacheHitRate({ prompt_tokens: 0, prompt_tokens_details: { cached_tokens: 5 } })).toBeNull();
    expect(computeCacheHitRate({ prompt_tokens: 10 })).toBeNull();
    expect(computeCacheHitRate({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 3 } })).toBeCloseTo(0.3);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

运行：`cd /f/llama_lanucher && npx vitest run test/proxy.test.ts`
预期：失败，`Cannot find module '../src/main/proxy.js'`。

- [ ] **Step 3: 写 src/main/proxy.ts**

```ts
// proxy.ts — 反向代理（可见端口 → 内部端口）+ 自动模型切换（规格 §2.1/§2.3/§5.4/§7/§8）
// CORS 四件套只在代理层处理（计划有意偏差 3）：不给上游 server 传 --cors-origins 等参数
import http from 'node:http';
import type { FormValues, ModelRef, RequestStats } from '../shared/types.js';
import { resolveModelRef } from './hf-cache.js';
import type { RecordsStore } from './records.js';

/** 代理驱动 llama-server 生命周期的接口（注入式，测试可用假控制器解耦 ProcessManager） */
export interface SwitchController {
  /** 转发目标内部端口；server 未运行返回 null */
  internalPort(): number | null;
  /** 后端是否就绪（/health 200） */
  isReady(): boolean;
  /** 当前已加载模型名（原始大小写）；未运行返回 null */
  currentModel(): string | null;
  /** 全部已知模型（本地 ∪ HF） */
  union(): ModelRef[];
  /** 是否正在切换模型 */
  switching(): boolean;
  /** 切换到指定模型；新 server 就绪后 resolve，失败 reject */
  switchTo(ref: ModelRef): Promise<void>;
}

export interface ProxyOptions {
  host: string;
  port: number;
  controller: SwitchController;
  form: FormValues;
  records?: RecordsStore | null;
  onStats?: (s: RequestStats) => void;
  /** 切换期间排队请求上限（默认 10） */
  queueCap?: number;
  /** 排队请求最长等待（默认 5 分钟） */
  queueTimeoutMs?: number;
}

interface QueuedRequest {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  path: string;
  body: Buffer;
  timer: ReturnType<typeof setTimeout>;
}

/** 把原始 SSE 字节流切成完整事件的 data 载荷（处理 \r\n 与跨 chunk 分割） */
class SseParser {
  private buf = '';
  feed(chunk: string): string[] {
    this.buf += chunk.replace(/\r\n/g, '\n');
    const events: string[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf('\n\n')) !== -1) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      const data = raw
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data !== '') events.push(data);
    }
    return events;
  }
}

/** usage.prompt_tokens_details.cached_tokens / prompt_tokens → 命中率（不可计算返回 null） */
export function computeCacheHitRate(usage: unknown): number | null {
  if (usage === null || typeof usage !== 'object') return null;
  const u = usage as { prompt_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } };
  if (typeof u.prompt_tokens !== 'number' || u.prompt_tokens <= 0) return null;
  const ct = u.prompt_tokens_details?.cached_tokens;
  if (typeof ct !== 'number') return null;
  return ct / u.prompt_tokens;
}

export class LauncherProxy {
  private server: http.Server | null = null;
  private opts: ProxyOptions;
  private form: FormValues;
  private records: RecordsStore | null;
  private queue: QueuedRequest[] = [];
  private queuePoll: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: ProxyOptions) {
    this.opts = opts;
    this.form = opts.form;
    this.records = opts.records ?? null;
  }

  setForm(form: FormValues): void {
    this.form = form;
  }

  setRecords(records: RecordsStore | null): void {
    this.records = records;
  }

  async start(): Promise<void> {
    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error) => reject(e);
      server.once('error', onErr);
      server.listen(this.opts.port, this.opts.host, () => {
        server.removeListener('error', onErr);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.stopQueuePoll();
    for (const q of this.queue) {
      clearTimeout(q.timer);
      if (!q.res.headersSent) {
        q.res.writeHead(503, { 'content-type': 'application/json' });
        q.res.end(JSON.stringify({ error: { message: 'llama-server not ready' } }));
      }
    }
    this.queue = [];
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.applyCors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname + (url.search ?? '');
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      this.respondModels(res);
      return;
    }
    let body: Buffer;
    try {
      body = await this.readBody(req);
    } catch {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'request body too large' } }));
      return;
    }
    const ctrl = this.opts.controller;
    if (!ctrl.isReady()) {
      if (ctrl.switching()) this.enqueue(req, res, path, body);
      else this.notReady(res);
      return;
    }
    const model = this.extractModel(body);
    if (model !== null) {
      const current = ctrl.currentModel();
      const sameRaw = current !== null && model.toLowerCase() === current.toLowerCase();
      if (!sameRaw) {
        const ref = resolveModelRef(ctrl.union(), model);
        if (ref === null) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `model '${model}' not found` } }));
          return;
        }
        const sameResolved = current !== null && ref.name.toLowerCase() === current.toLowerCase();
        if (!sameResolved) {
          if (ctrl.switching()) {
            this.enqueue(req, res, path, body);
            return;
          }
          await this.doSwitch(ref, req, res, path, body);
          return;
        }
      }
    }
    this.forward(req, res, path, body);
  }

  /** 自动切换：停旧 → 起新 → 转发触发请求；失败时触发请求 502，队列按未就绪放行（规格 §10） */
  private async doSwitch(ref: ModelRef, req: http.IncomingMessage, res: http.ServerResponse, path: string, body: Buffer): Promise<void> {
    try {
      await this.opts.controller.switchTo(ref);
    } catch {
      this.failQueue();
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `model switch to '${ref.name}' failed` } }));
      }
      return;
    }
    this.forward(req, res, path, body);
    this.drainQueue();
  }

  /** 切换中排队：超限 503；等待超时 503 `model switching in progress`（规格 §5.4） */
  private enqueue(req: http.IncomingMessage, res: http.ServerResponse, path: string, body: Buffer): void {
    const cap = this.opts.queueCap ?? 10;
    const timeoutMs = this.opts.queueTimeoutMs ?? 5 * 60 * 1000;
    if (this.queue.length >= cap) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'model switching in progress' } }));
      return;
    }
    const timer = setTimeout(() => {
      const i = this.queue.findIndex((q) => q.req === req);
      if (i !== -1) this.queue.splice(i, 1);
      if (!res.headersSent) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'model switching in progress' } }));
      }
      if (this.queue.length === 0) this.stopQueuePoll();
    }, timeoutMs);
    timer.unref();
    this.queue.push({ req, res, path, body, timer });
    this.ensureQueuePoll();
  }

  /** 切换完成后按队列顺序放行 */
  private drainQueue(): void {
    const pending = this.queue;
    this.queue = [];
    this.stopQueuePoll();
    for (const q of pending) {
      clearTimeout(q.timer);
      this.forward(q.req, q.res, q.path, q.body);
    }
  }

  private failQueue(): void {
    const pending = this.queue;
    this.queue = [];
    this.stopQueuePoll();
    for (const q of pending) {
      clearTimeout(q.timer);
      if (!q.res.headersSent) this.notReady(q.res);
    }
  }

  private ensureQueuePoll(): void {
    if (this.queuePoll !== null || this.queue.length === 0) return;
    this.queuePoll = setInterval(() => {
      if (!this.opts.controller.switching()) this.drainQueue();
    }, 200);
    this.queuePoll.unref();
  }

  private stopQueuePoll(): void {
    if (this.queuePoll !== null) {
      clearInterval(this.queuePoll);
      this.queuePoll = null;
    }
  }

  private notReady(res: http.ServerResponse): void {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'llama-server not ready' } }));
  }

  /** GET /v1/models → 返回并集列表并标记当前模型（不触发切换，规格 §5.4） */
  private respondModels(res: http.ServerResponse): void {
    const ctrl = this.opts.controller;
    const current = ctrl.currentModel();
    const data = ctrl.union().map((m) => ({
      id: m.name,
      object: 'model',
      owned_by: 'llama-launcher',
      current: current !== null && m.name.toLowerCase() === current.toLowerCase(),
    }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data }));
  }

  /** 转发到内部端口；SSE 原样透传，旁路测量 TTFT / usage / prompt / decode */
  private forward(req: http.IncomingMessage, res: http.ServerResponse, path: string, body: Buffer): void {
    const port = this.opts.controller.internalPort();
    if (port === null) {
      this.notReady(res);
      return;
    }
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: `127.0.0.1:${port}` };
    delete headers['transfer-encoding'];
    headers['content-length'] = body.length;
    const t0 = Date.now();
    const upstream = http.request(
      { host: '127.0.0.1', port, path, method: req.method ?? 'GET', headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        const ct = String(up.headers['content-type'] ?? '');
        if (ct.includes('text/event-stream')) this.handleSse(res, up, body, t0);
        else this.handleJson(res, up, body, t0);
      },
    );
    upstream.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `upstream error: ${err.message}` } }));
      } else {
        res.end();
      }
    });
    res.on('close', () => upstream.destroy());
    if (body.length > 0) upstream.write(body);
    upstream.end();
  }

  /** SSE 透传 + TTFT（首个含 content 的块）+ 尾部 usage 块 + decode 累积（recordRounds 门控） */
  private handleSse(res: http.ServerResponse, up: http.IncomingMessage, body: Buffer, t0: number): void {
    const model = this.extractModel(body) ?? this.opts.controller.currentModel() ?? 'unknown';
    const prompt = this.extractPrompt(body);
    let ttftMs: number | null = null;
    let usage: unknown = null;
    let decode = '';
    const parser = new SseParser();
    up.on('data', (chunk: Buffer) => {
      res.write(chunk);
      for (const data of parser.feed(chunk.toString('utf8'))) {
        if (data === '[DONE]') continue;
        let obj: { choices?: { delta?: { content?: unknown } }[]; usage?: unknown } | null = null;
        try {
          obj = JSON.parse(data);
        } catch {
          continue;
        }
        const content = obj?.choices?.[0]?.delta?.content;
        if (typeof content === 'string' && content.length > 0) {
          if (ttftMs === null) ttftMs = Date.now() - t0;
          decode += content;
        }
        if (obj?.usage !== undefined && obj?.usage !== null) usage = obj.usage;
      }
    });
    const finish = () => {
      this.finishStats(model, ttftMs, usage, decode, prompt);
    };
    up.on('end', () => {
      res.end();
      finish();
    });
    up.on('error', () => {
      res.end();
      finish();
    });
  }

  /** 非流式 JSON 透传 + usage / message.content 解析 */
  private handleJson(res: http.ServerResponse, up: http.IncomingMessage, body: Buffer, t0: number): void {
    const model = this.extractModel(body) ?? this.opts.controller.currentModel() ?? 'unknown';
    const prompt = this.extractPrompt(body);
    const chunks: Buffer[] = [];
    up.on('data', (c: Buffer) => {
      res.write(c);
      chunks.push(c);
    });
    const finish = () => {
      let usage: unknown = null;
      let decode = '';
      try {
        const obj = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          usage?: unknown;
          choices?: { message?: { content?: unknown } }[];
        };
        if (obj?.usage !== undefined && obj?.usage !== null) usage = obj.usage;
        const content = obj?.choices?.[0]?.message?.content;
        if (typeof content === 'string') decode = content;
      } catch {
        /* 非 JSON 上游响应：decode 记空 */
      }
      this.finishStats(model, null, usage, decode, prompt);
    };
    up.on('end', () => {
      res.end();
      finish();
    });
    up.on('error', () => {
      res.end();
    });
  }

  private finishStats(model: string, ttftMs: number | null, usage: unknown, decode: string, prompt: string): void {
    const cacheHitRate = computeCacheHitRate(usage);
    this.opts.onStats?.({ model, ttftMs, cacheHitRate, ts: Date.now() });
    if (this.form.recordRounds && this.records !== null) {
      void this.records.append({ ts: Date.now(), model, prompt, decode, ttft_ms: ttftMs, usage });
    }
  }

  /** CORS 四件套：空值默认 *；credentials 开启时反射请求 Origin（规格 §5 服务组） */
  private applyCors(req: http.IncomingMessage, res: http.ServerResponse): void {
    const f = this.form;
    const origin = f.corsOrigins.trim() || '*';
    const requestOrigin = req.headers.origin;
    if (f.corsCredentials) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin && requestOrigin !== '*' ? requestOrigin : origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', f.corsMethods.trim() || '*');
    res.setHeader('Access-Control-Allow-Headers', f.corsHeaders.trim() || '*');
  }

  private readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 16 * 1024 * 1024) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  private extractModel(body: Buffer): string | null {
    if (body.length === 0) return null;
    try {
      const obj = JSON.parse(body.toString('utf8')) as { model?: unknown };
      if (typeof obj.model === 'string' && obj.model.trim() !== '') return obj.model.trim();
      return null;
    } catch {
      return null;
    }
  }

  /** chat: messages 拼成全量 prompt 文本；completions: prompt（字符串或数组） */
  private extractPrompt(body: Buffer): string {
    if (body.length === 0) return '';
    try {
      const obj = JSON.parse(body.toString('utf8')) as { messages?: unknown; prompt?: unknown };
      if (Array.isArray(obj.messages)) {
        return (obj.messages as { role?: unknown; content?: unknown }[])
          .map((m) => `${typeof m.role === 'string' ? m.role : '?'}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')}`)
          .join('\n');
      }
      if (typeof obj.prompt === 'string') return obj.prompt;
      if (Array.isArray(obj.prompt)) return (obj.prompt as unknown[]).map(String).join('');
      return '';
    } catch {
      return '';
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

运行：`cd /f/llama_lanucher && npx vitest run test/proxy.test.ts`
预期：`Test Files  1 passed (1)`，`Tests  15 passed (15)`。

- [ ] **Step 5: 类型检查 + 提交**

```bash
cd /f/llama_lanucher && npm run typecheck && git add -A && git -c user.name='dsh' -c user.email='dsh@local' commit -m "proxy: reverse proxy + SSE passthrough/TTFT/usage + CORS + auto-switch queueing"
```

---

### Task 13: updater.ts — GitHub 更新检查与自动下载（续传/修剪/验证）

**Files:**
- Create: `src/main/updater.ts`, `test/updater.test.ts`
- Modify: `src/shared/types.ts`（InstalledVersion 加 `valid?`）、`tsconfig.json`（esModuleInterop）
- Deps: `npm i adm-zip`、`npm i -D @types/adm-zip`

规格 §9.2：检查 `releases/latest`（网络失败返回 null 不阻塞）；资产匹配优先
`llama-b<NNNN>-bin-win-cuda-13.*-x64.zip`，无 13.x 回退最高 CUDA 版本；CUDA DLLs 取同版本
`cudart-llama-bin-win-cuda-<ver>-x64.zip`，`cuda/cuda-<ver>/cudart64_<主版本>.dll` 已存在则跳过；
下载 `.part` + HTTP Range 断点续传（服务器忽略 Range → 从头重下，失败保留 .part）；
磁盘预检 ≥2GB；解压失败删不完整版本目录；验证跑 `<tag>/llama-server(.exe) --version`
（失败标 `valid:false` 标红、不自动选中）；修剪最多保留 2 个版本目录（删最旧、最旧为选中时改删中间）、
顺带清理无版本引用的 `cuda/` 目录；更新 manifest.json（JSON 数组，独立读写——JsonStore 的
spread 语义不适配数组）。测试替身：本地 HTTP 服务器（支持 Range）+ adm-zip 夹具，不依赖 GitHub 网络。

- [ ] **Step 1: 安装依赖 + 小改动**

```bash
cd /f/llama_lanucher && npm install adm-zip && npm install -D @types/adm-zip
```

`tsconfig.json` 加 `"esModuleInterop": true`；`src/shared/types.ts` 的 `InstalledVersion` 加 `valid?: boolean`。

- [ ] **Step 2: 写失败测试 test/updater.test.ts**

```ts
// updater.test.ts — llama.cpp 更新检查与自动下载（规格 §9.2）
// 本地 HTTP 服务器（支持 Range）+ adm-zip 夹具；不依赖 GitHub 网络
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import {
  pickMainAsset,
  pickCudaAsset,
  checkDiskSpace,
  downloadFile,
  extractZip,
  pruneVersions,
  readManifest,
  writeManifest,
  checkLatestRelease,
  runUpdate,
  type ReleaseAsset,
} from '../src/main/updater.js';
import type { InstalledVersion } from '../shared/types.js';

const A = (name: string, url?: string): ReleaseAsset => ({
  name,
  browser_download_url: url ?? `http://127.0.0.1:1/${name}`,
});

const ASSETS_10488: ReleaseAsset[] = [
  A('llama-b10488-bin-win-cuda-13.3-x64.zip'),
  A('llama-b10488-bin-win-cuda-12.9-x64.zip'),
  A('llama-b10488-bin-win-cpu-avx2-x64.zip'),
  A('cudart-llama-bin-win-cuda-13.3-x64.zip'),
  A('cudart-llama-bin-win-cuda-12.9-x64.zip'),
];

const listen = (server: http.Server): Promise<number> =>
  new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
  );

const closeServer = (server: http.Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

describe('pickMainAsset', () => {
  it('prefers the matching-build win-cuda-13.x asset', () => {
    const r = pickMainAsset('b10488', ASSETS_10488);
    expect(r).not.toBeNull();
    expect(r!.asset.name).toBe('llama-b10488-bin-win-cuda-13.3-x64.zip');
    expect(r!.cudaVersion).toBe('13.3');
    expect(r!.fellBack).toBe(false);
  });

  it('falls back to the highest CUDA version when no 13.x asset exists', () => {
    const r = pickMainAsset('b9999', [
      A('llama-b9999-bin-win-cuda-12.4-x64.zip'),
      A('llama-b9999-bin-win-cuda-11.8-x64.zip'),
    ]);
    expect(r!.asset.name).toBe('llama-b9999-bin-win-cuda-12.4-x64.zip');
    expect(r!.cudaVersion).toBe('12.4');
    expect(r!.fellBack).toBe(true);
  });

  it('returns null when no Windows asset matches the tag', () => {
    expect(pickMainAsset('b10488', [A('llama-b10487-bin-win-cuda-13.3-x64.zip')])).toBeNull();
    expect(pickMainAsset('b10488', [])).toBeNull();
  });
});

describe('pickCudaAsset', () => {
  it('matches the CUDA DLL package of the same version as the main package', () => {
    expect(pickCudaAsset('13.3', ASSETS_10488)!.name).toBe('cudart-llama-bin-win-cuda-13.3-x64.zip');
    expect(pickCudaAsset('14.0', ASSETS_10488)).toBeNull();
  });
});

describe('checkDiskSpace', () => {
  it('reports ok when free space is sufficient and not ok when it is not', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'upd-disk-'));
    try {
      const ok = await checkDiskSpace(dir, 1024 * 1024);
      expect(ok.ok).toBe(true);
      expect(ok.freeBytes).toBeGreaterThan(1024 * 1024);
      const bad = await checkDiskSpace(dir, Number.MAX_SAFE_INTEGER);
      expect(bad.ok).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('downloadFile', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'upd-dl-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const rangeServer = (buf: Buffer, info: { range: number }): http.Server =>
    http.createServer((req, res) => {
      const range = req.headers['range'];
      if (range) {
        info.range++;
        const start = Number(String(range).match(/bytes=(\d+)-/)![1]);
        res.writeHead(206, {
          'content-range': `bytes ${start}-${buf.length - 1}/${buf.length}`,
          'content-length': String(buf.length - start),
        });
        res.end(buf.subarray(start));
      } else {
        res.writeHead(200, { 'content-length': String(buf.length) });
        res.end(buf);
      }
    });

  it('downloads a complete file and reports progress', async () => {
    const buf = Buffer.from('0123456789'.repeat(100)); // 1000 bytes
    const server = rangeServer(buf, { range: 0 });
    const port = await listen(server);
    const dest = path.join(dir, 'a.bin');
    let last = { received: 0, total: 0, pct: -1, mbps: 0 };
    await downloadFile({ url: `http://127.0.0.1:${port}/a.bin`, dest, onProgress: (p) => (last = p) });
    expect(await readFile(dest)).toEqual(buf);
    expect(last.received).toBe(buf.length);
    expect(last.total).toBe(buf.length);
    expect(last.pct).toBe(1);
    await closeServer(server);
  });

  it('resumes an interrupted download via a Range request', async () => {
    const buf = Buffer.from('abcdefghij'.repeat(50)); // 500 bytes
    const info = { range: 0 };
    const server = rangeServer(buf, info);
    const port = await listen(server);
    const dest = path.join(dir, 'b.bin');
    await writeFile(dest + '.part', buf.subarray(0, 120)); // 模拟已下载 120 字节
    await downloadFile({ url: `http://127.0.0.1:${port}/b.bin`, dest });
    expect(info.range).toBe(1);
    expect(await readFile(dest)).toEqual(buf);
    await closeServer(server);
  });

  it('re-downloads from the start when the server ignores Range', async () => {
    const buf = Buffer.from('xyzxyzxyzxyz');
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-length': String(buf.length) });
      res.end(buf);
    });
    const port = await listen(server);
    const dest = path.join(dir, 'c.bin');
    await writeFile(dest + '.part', Buffer.from('stale'));
    await downloadFile({ url: `http://127.0.0.1:${port}/c.bin`, dest });
    expect(await readFile(dest)).toEqual(buf);
    await closeServer(server);
  });

  it('keeps .part on failure (retryable) and throws with the HTTP status', async () => {
    const server = http.createServer((_req, res) => { res.writeHead(500); res.end(); });
    const port = await listen(server);
    const dest = path.join(dir, 'd.bin');
    await expect(downloadFile({ url: `http://127.0.0.1:${port}/d.bin`, dest })).rejects.toThrow('HTTP 500');
    await expect(stat(dest + '.part')).resolves.toBeTruthy();
    await closeServer(server);
  });
});

describe('extractZip', () => {
  it('extracts nested entries into the destination directory', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'upd-zip-'));
    try {
      const zip = new AdmZip();
      zip.addFile('llama-server', Buffer.from('fake-exe'));
      zip.addFile('sub/readme.txt', Buffer.from('hello'));
      const zipPath = path.join(dir, 'm.zip');
      zip.writeZip(zipPath);
      const outDir = path.join(dir, 'out');
      await extractZip(zipPath, outDir);
      expect(await readFile(path.join(outDir, 'llama-server'))).toEqual(Buffer.from('fake-exe'));
      expect(await readFile(path.join(outDir, 'sub/readme.txt'))).toEqual(Buffer.from('hello'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('pruneVersions', () => {
  it('keeps the newest versions and removes unreferenced cuda directories', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'upd-prune-'));
    try {
      const t0 = Date.now() - 4000;
      for (const tag of ['b1', 'b2', 'b3']) await mkdir(path.join(dir, tag), { recursive: true });
      await mkdir(path.join(dir, 'cuda', 'cuda-12.9'), { recursive: true });
      await mkdir(path.join(dir, 'cuda', 'cuda-13.3'), { recursive: true });
      const entries: InstalledVersion[] = [
        { tag: 'b1', cudaVersion: '12.9', installedAt: t0 },
        { tag: 'b2', cudaVersion: '13.3', installedAt: t0 + 1 },
        { tag: 'b3', cudaVersion: '13.3', installedAt: t0 + 2 },
      ];
      const r = await pruneVersions(dir, entries, null, 2);
      expect(r.prunedTags).toEqual(['b1']);
      expect(r.prunedCuda).toEqual(['cuda-12.9']);
      await expect(stat(path.join(dir, 'b1'))).rejects.toThrow();
      await expect(stat(path.join(dir, 'b2'))).resolves.toBeTruthy();
      await expect(stat(path.join(dir, 'cuda', 'cuda-13.3'))).resolves.toBeTruthy();
      await expect(stat(path.join(dir, 'cuda', 'cuda-12.9'))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips the selected version when pruning (removes the middle one instead)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'upd-prune2-'));
    try {
      const t0 = Date.now() - 4000;
      for (const tag of ['b1', 'b2', 'b3', 'b4']) await mkdir(path.join(dir, tag), { recursive: true });
      const entries: InstalledVersion[] = (['b1', 'b2', 'b3', 'b4'] as const).map((tag, i) => ({
        tag,
        cudaVersion: i === 3 ? '13.3' : '12.9',
        installedAt: t0 + i,
      }));
      const r = await pruneVersions(dir, entries, 'b1', 2);
      expect(r.prunedTags).toEqual(['b2', 'b3']);
      await expect(stat(path.join(dir, 'b1'))).resolves.toBeTruthy();
      await expect(stat(path.join(dir, 'b4'))).resolves.toBeTruthy();
      await expect(stat(path.join(dir, 'b2'))).rejects.toThrow();
      await expect(stat(path.join(dir, 'b3'))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('checkLatestRelease', () => {
  it('parses the latest release from the API', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        tag_name: 'b10500',
        assets: [{ name: 'llama-b10500-bin-win-cuda-13.3-x64.zip', browser_download_url: 'http://x/y.zip' }],
      }));
    });
    const port = await listen(server);
    const info = await checkLatestRelease(`http://127.0.0.1:${port}/releases/latest`);
    expect(info).not.toBeNull();
    expect(info!.tag_name).toBe('b10500');
    expect(info!.assets).toHaveLength(1);
    await closeServer(server);
  });

  it('returns null on network failure or non-200', async () => {
    expect(await checkLatestRelease('http://127.0.0.1:1/none', 500)).toBeNull();
    const server = http.createServer((_req, res) => { res.writeHead(500); res.end(); });
    const port = await listen(server);
    expect(await checkLatestRelease(`http://127.0.0.1:${port}/releases/latest`)).toBeNull();
    await closeServer(server);
  });
});

describe('runUpdate', () => {
  function makeFixtures(): { mainBuf: Buffer; cudaBuf: Buffer } {
    const main = new AdmZip();
    main.addFile('llama-server', Buffer.from('new-exe-linux'));
    main.addFile('llama-server.exe', Buffer.from('new-exe-win'));
    const cuda = new AdmZip();
    cuda.addFile('cudart64_13.dll', Buffer.from('cuda-dll-bytes'));
    return { mainBuf: Buffer.from(main.toBuffer()), cudaBuf: Buffer.from(cuda.toBuffer()) };
  }

  const serveFiles = (files: Record<string, Buffer>, hits: Record<string, number>): Promise<{ port: number; server: http.Server }> =>
    new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        const name = (req.url ?? '').split('/').pop() ?? '';
        const buf = files[name];
        if (!buf) { res.writeHead(404); res.end(); return; }
        hits[name] = (hits[name] ?? 0) + 1;
        res.writeHead(200, { 'content-length': String(buf.length) });
        res.end(buf);
      });
      server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as { port: number }).port, server }));
    });

  const exeName = (): string => (process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
  const withUrls = (port: number): ReleaseAsset[] =>
    ASSETS_10488.map((a) => ({ ...a, browser_download_url: `http://127.0.0.1:${port}/${a.name}` }));

  it('refuses without downloading when the disk precheck fails', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'upd-run-'));
    try {
      const res = await runUpdate({
        baseDir: dir,
        tag: 'b10488',
        assets: ASSETS_10488,
        selectedTag: null,
        minFreeBytes: Number.MAX_SAFE_INTEGER,
        verify: async () => {},
      });
      expect(res.ok).toBe(false);
      expect(res.error ?? '').toMatch(/磁盘空间不足/);
      const entries = await readdir(dir);
      expect(entries.filter((f) => f.endsWith('.zip') || f.endsWith('.part'))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('downloads, extracts, reuses CUDA, prunes, and updates the manifest', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'upd-run-'));
    try {
      const { mainBuf, cudaBuf } = makeFixtures();
      const hits: Record<string, number> = {};
      const { port, server } = await serveFiles({
        'llama-b10488-bin-win-cuda-13.3-x64.zip': mainBuf,
        'cudart-llama-bin-win-cuda-13.3-x64.zip': cudaBuf,
      }, hits);
      // 预置：两个旧版本 + 已存在的 CUDA 目录（应复用，不重下）
      const t0 = Date.now() - 9000;
      await mkdir(path.join(dir, 'b8000'), { recursive: true });
      await mkdir(path.join(dir, 'b9000'), { recursive: true });
      await mkdir(path.join(dir, 'cuda', 'cuda-13.3'), { recursive: true });
      await writeFile(path.join(dir, 'cuda', 'cuda-13.3', 'cudart64_13.dll'), Buffer.from('old-dll'));
      await writeManifest(dir, [
        { tag: 'b8000', cudaVersion: '13.3', installedAt: t0 },
        { tag: 'b9000', cudaVersion: '13.3', installedAt: t0 + 1000 },
      ]);
      const phases: string[] = [];
      const res = await runUpdate({
        baseDir: dir,
        tag: 'b10488',
        assets: withUrls(port),
        selectedTag: 'b9000',
        minFreeBytes: 1024 * 1024,
        verify: async (exePath) => { const s = await stat(exePath); if (s.size <= 0) throw new Error('empty exe'); },
        onProgress: (p) => phases.push(p.phase),
      });
      expect(res.ok).toBe(true);
      expect(res.valid).toBe(true);
      expect(res.cudaVersion).toBe('13.3');
      expect(res.mainFellBack).toBe(false);
      // 主包解压、zip 删除
      expect(await readFile(path.join(dir, 'b10488', exeName()))).toEqual(
        process.platform === 'win32' ? Buffer.from('new-exe-win') : Buffer.from('new-exe-linux'),
      );
      const leftovers = await readdir(dir);
      expect(leftovers.some((f) => f.endsWith('.zip') || f.endsWith('.part'))).toBe(false);
      // CUDA 复用：未下载 cudart
      expect(hits['cudart-llama-bin-win-cuda-13.3-x64.zip'] ?? 0).toBe(0);
      expect(phases).not.toContain('download-cuda');
      expect(phases).toContain('download-main');
      expect(phases).toContain('done');
      // 修剪：3 个版本 → 保留 2 个，删最旧 b8000（b9000 选中但非最旧）
      const manifest = await readManifest(dir);
      expect(manifest.map((e) => e.tag).sort()).toEqual(['b10488', 'b9000']);
      await expect(stat(path.join(dir, 'b8000'))).rejects.toThrow();
      const entry = manifest.find((e) => e.tag === 'b10488');
      expect(entry!.cudaVersion).toBe('13.3');
      expect(entry!.valid).toBe(true);
      await closeServer(server);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('marks the version invalid when verification fails', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'upd-run-'));
    try {
      const { mainBuf, cudaBuf } = makeFixtures();
      const hits: Record<string, number> = {};
      const { port, server } = await serveFiles({
        'llama-b10488-bin-win-cuda-13.3-x64.zip': mainBuf,
        'cudart-llama-bin-win-cuda-13.3-x64.zip': cudaBuf,
      }, hits);
      const res = await runUpdate({
        baseDir: dir,
        tag: 'b10488',
        assets: withUrls(port),
        selectedTag: null,
        minFreeBytes: 1024 * 1024,
        verify: async () => { throw new Error('bad exe'); },
      });
      expect(res.ok).toBe(true);
      expect(res.valid).toBe(false);
      const manifest = await readManifest(dir);
      expect(manifest.find((e) => e.tag === 'b10488')!.valid).toBe(false);
      // 无已存在 CUDA 目录 → 应下载 CUDA 包
      expect(hits['cudart-llama-bin-win-cuda-13.3-x64.zip'] ?? 0).toBe(1);
      await closeServer(server);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

运行：`cd /f/llama_lanucher && npx vitest run test/updater.test.ts`
预期：失败，`Cannot find module '../src/main/updater.js'`。

- [ ] **Step 4: 写 src/main/updater.ts**

```ts
// updater.ts — llama.cpp 版本更新（规格 §9.2）：GitHub 检查 + 自动下载
// 纯 Node（无 electron 依赖）；测试用本地 HTTP 服务器 + adm-zip 夹具
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { parseVersion } from './version.js';
import type { InstalledVersion, UpdateProgress } from '../shared/types.js';

export const GITHUB_LATEST_URL = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest';
export const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB（zip + 解压峰值）

export interface ReleaseAsset { name: string; browser_download_url: string; size?: number }
export interface ReleaseInfo { tag_name: string; assets: ReleaseAsset[] }

// ---------- 资产匹配（规格 §9.2：b10488 实测命名） ----------
const MAIN_RE = /^llama-b(\d+)-bin-win-cuda-(\d+\.\d+)-x64\.zip$/;

function cmpVer(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 主包：优先 win-cuda-13.*；无 13.x 时回退最高 CUDA 版本 */
export function pickMainAsset(
  tag: string,
  assets: ReleaseAsset[],
): { asset: ReleaseAsset; cudaVersion: string; fellBack: boolean } | null {
  const tagNum = tag.match(/b(\d+)/)?.[1];
  const matches: { asset: ReleaseAsset; cudaVersion: string }[] = [];
  for (const a of assets) {
    const m = a.name.match(MAIN_RE);
    if (!m) continue;
    if (tagNum && m[1] !== tagNum) continue;
    matches.push({ asset: a, cudaVersion: m[2] });
  }
  if (matches.length === 0) return null;
  const v13 = matches
    .filter((x) => x.cudaVersion.startsWith('13.'))
    .sort((a, b) => cmpVer(b.cudaVersion, a.cudaVersion));
  if (v13.length > 0) return { asset: v13[0].asset, cudaVersion: v13[0].cudaVersion, fellBack: false };
  const best = [...matches].sort((a, b) => cmpVer(b.cudaVersion, a.cudaVersion))[0];
  return { asset: best.asset, cudaVersion: best.cudaVersion, fellBack: true };
}

/** CUDA DLL 包：与主包同 CUDA 版本 */
export function pickCudaAsset(cudaVersion: string, assets: ReleaseAsset[]): ReleaseAsset | null {
  const re = new RegExp(`^cudart-llama-bin-win-cuda-${cudaVersion.replace(/\./g, '\\.')}-x64\\.zip$`);
  return assets.find((a) => re.test(a.name)) ?? null;
}

// ---------- 检查最新版 ----------
async function httpGetText(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(
      {
        protocol: u.protocol,
        host: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        agent: false,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/** 拉取最新 release；网络失败 / 非 200 → null（不阻塞任何功能） */
export async function checkLatestRelease(url: string = GITHUB_LATEST_URL, timeoutMs = 10000): Promise<ReleaseInfo | null> {
  try {
    const body = await httpGetText(url, timeoutMs);
    const info = JSON.parse(body) as ReleaseInfo;
    if (typeof info.tag_name !== 'string' || !Array.isArray(info.assets)) return null;
    return info;
  } catch {
    return null;
  }
}

// ---------- 磁盘预检 ----------
export async function checkDiskSpace(dir: string, requiredBytes: number): Promise<{ ok: boolean; freeBytes: number }> {
  const st = await fs.statfs(dir);
  const freeBytes = st.bavail * st.bsize;
  return { ok: freeBytes >= requiredBytes, freeBytes };
}

// ---------- 下载（.part + HTTP Range 断点续传） ----------
export interface DownloadProgress { received: number; total: number; pct: number; mbps: number }
export interface DownloadOptions {
  url: string;
  dest: string;
  partFile?: string;
  onProgress?: (p: DownloadProgress) => void;
}

class RangeUnsupportedError extends Error {}

async function downloadOnce(
  url: string,
  part: string,
  offset: number,
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const fl = createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' });
    let received = 0;
    let total = 0;
    const startedAt = Date.now();
    const report = () => {
      const secs = Math.max((Date.now() - startedAt) / 1000, 0.001);
      const mbps = received / 1048576 / secs;
      const pct = total > 0 ? Math.min(1, (offset + received) / total) : -1;
      onProgress?.({ received: offset + received, total, pct, mbps });
    };
    const fail = (e: Error) => { fl.close(); reject(e); };
    const req = lib.request(
      {
        protocol: u.protocol,
        host: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        agent: false,
        headers: offset > 0 ? { range: `bytes=${offset}-` } : {},
      },
      (res) => {
        const code = res.statusCode ?? 0;
        if ((code === 200 || code === 416) && offset > 0) {
          // 服务器忽略 Range（或 .part 比远端文件还大）→ 从头重下
          res.resume();
          fail(new RangeUnsupportedError());
          return;
        }
        if (code === 200) {
          total = Number(res.headers['content-length'] ?? 0);
        } else if (code === 206) {
          const m = /\/(\d+)\s*$/.exec(String(res.headers['content-range'] ?? ''));
          total = m ? Number(m[1]) : 0;
        } else {
          res.resume();
          fail(new Error(`download failed: HTTP ${code}`));
          return;
        }
        res.on('data', (c: Buffer) => { fl.write(c); received += c.length; report(); });
        res.on('end', () => { fl.end(() => resolve()); });
        res.on('error', (e) => fail(e));
        fl.on('error', (e) => fail(e));
      },
    );
    req.on('error', (e) => fail(e));
    req.end();
  });
}

/** 下载到 dest：先写 .part，完成后 rename；失败保留 .part 以便续传 */
export async function downloadFile(opts: DownloadOptions): Promise<void> {
  const part = opts.partFile ?? opts.dest + '.part';
  await fs.mkdir(path.dirname(part), { recursive: true });
  let offset = 0;
  try { offset = (await fs.stat(part)).size; } catch { offset = 0; }
  for (;;) {
    try {
      await downloadOnce(opts.url, part, offset, opts.onProgress);
      break;
    } catch (e) {
      if (e instanceof RangeUnsupportedError) { offset = 0; continue; }
      throw e;
    }
  }
  await fs.rename(part, opts.dest);
}

// ---------- 解压 ----------
/** 解压 zip 到 destDir（不存在则创建，覆盖已有） */
export async function extractZip(zipPath: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(destDir, true);
}

// ---------- manifest ----------
const MANIFEST_NAME = 'manifest.json';

export async function readManifest(baseDir: string): Promise<InstalledVersion[]> {
  try {
    const raw = await fs.readFile(path.join(baseDir, MANIFEST_NAME), 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as InstalledVersion[]) : [];
  } catch {
    return [];
  }
}

export async function writeManifest(baseDir: string, entries: InstalledVersion[]): Promise<void> {
  await fs.mkdir(baseDir, { recursive: true });
  const file = path.join(baseDir, MANIFEST_NAME);
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(entries, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

// ---------- 修剪（最多保留 keep 个版本目录） ----------
export interface PruneResult { prunedTags: string[]; prunedCuda: string[] }

/** 删最旧（最旧是选中版本时改删中间那个）；顺带清理无版本引用的 cuda/ 目录 */
export async function pruneVersions(
  baseDir: string,
  entries: InstalledVersion[],
  selectedTag: string | null,
  keep = 2,
): Promise<PruneResult> {
  const prunedTags: string[] = [];
  const prunedCuda: string[] = [];
  const byOld = [...entries].sort((a, b) => a.installedAt - b.installedAt || a.tag.localeCompare(b.tag));
  while (byOld.length > keep) {
    let victim = byOld[0];
    if (victim.tag === selectedTag) {
      const idx = byOld.findIndex((e) => e.tag !== selectedTag);
      if (idx === -1) break; // 只剩选中版本
      victim = byOld[idx];
    }
    byOld.splice(byOld.indexOf(victim), 1);
    try { await fs.rm(path.join(baseDir, victim.tag), { recursive: true, force: true }); } catch { /* 目录可能不存在 */ }
    prunedTags.push(victim.tag);
  }
  const remaining = new Set(byOld.map((e) => e.tag));
  const referenced = new Set(
    entries.filter((e) => remaining.has(e.tag)).map((e) => e.cudaVersion).filter((v): v is string => !!v),
  );
  const cudaDir = path.join(baseDir, 'cuda');
  let dirs: string[] = [];
  try { dirs = await fs.readdir(cudaDir); } catch { dirs = []; }
  for (const d of dirs) {
    if (!d.startsWith('cuda-')) continue;
    if (referenced.has(d.slice('cuda-' .length))) continue;
    try { await fs.rm(path.join(cudaDir, d), { recursive: true, force: true }); } catch { continue; }
    prunedCuda.push(d);
  }
  return { prunedTags, prunedCuda };
}

// ---------- 验证 ----------
/** 跑 <exe> --version 并解析；失败抛错 */
export async function verifyExe(exePath: string): Promise<number> {
  if (!existsSync(exePath)) throw new Error(`executable not found: ${exePath}`);
  const out = await new Promise<string>((resolve, reject) => {
    execFile(exePath, ['--version'], { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`--version failed: ${stderr || err.message}`));
      else resolve((stdout || '') + (stderr || ''));
    });
  });
  const pv = parseVersion(out);
  if (pv.build === null) throw new Error(`cannot parse version: ${out.slice(0, 200)}`);
  return pv.build;
}

// ---------- 完整更新流程（规格 §9.2 更新流程 1-7） ----------
export interface RunUpdateOptions {
  baseDir: string;                 // <appRoot>/llama.cpp
  tag: string;
  assets: ReleaseAsset[];
  selectedTag: string | null;      // 当前选中版本（修剪时豁免）
  onProgress?: (p: UpdateProgress) => void;
  minFreeBytes?: number;           // 默认 MIN_FREE_BYTES（2GB）
  verify?: (exePath: string) => Promise<void>;
}

export interface RunUpdateResult {
  ok: boolean;                   // 流程完成（验证失败也算完成，见 valid）
  valid: boolean;                // 验证通过（false → UI 标红、不自动选中）
  phase: UpdateProgress['phase'];
  error?: string;
  cudaVersion: string | null;
  mainFellBack: boolean;           // 主包回退到非 13.x CUDA 版本
}

const GB = 1024 * 1024 * 1024;
const fmtGB = (n: number) => (n / GB).toFixed(1);

export async function runUpdate(opts: RunUpdateOptions): Promise<RunUpdateResult> {
  const report = (phase: UpdateProgress['phase'], pct: number, mbps: number, message: string) =>
    opts.onProgress?.({ phase, pct, mbps, message });
  const fail = (phase: UpdateProgress['phase'], error: string, cudaVersion: string | null = null, mainFellBack = false): RunUpdateResult =>
    ({ ok: false, valid: false, phase, error, cudaVersion, mainFellBack });
  try {
    // 1. 磁盘预检
    const minFree = opts.minFreeBytes ?? MIN_FREE_BYTES;
    report('check', -1, 0, '磁盘预检');
    const disk = await checkDiskSpace(opts.baseDir, minFree);
    if (!disk.ok) {
      return fail('error', `磁盘空间不足：可用 ${fmtGB(disk.freeBytes)}GB，需要 ${fmtGB(minFree)}GB`);
    }
    // 2. 主包资产
    const main = pickMainAsset(opts.tag, opts.assets);
    if (!main) return fail('error', `未找到匹配的 Windows CUDA 资产（tag ${opts.tag}）`);
    const cudaVersion = main.cudaVersion;
    // 3. 下载主包（断点续传）
    const mainZip = path.join(opts.baseDir, main.asset.name);
    report('download-main', 0, 0, `下载主包 ${main.asset.name}${main.fellBack ? '（无 13.x 资产，回退最高 CUDA 版本）' : ''}`);
    await downloadFile({
      url: main.asset.browser_download_url,
      dest: mainZip,
      onProgress: (p) => report(
        'download-main', p.pct, p.mbps,
        `主包 ${p.pct >= 0 ? (p.pct * 100).toFixed(1) + '%' : ''} ${p.mbps.toFixed(1)}MB/s`,
      ),
    });
    // 4. 解压（失败删不完整目录，旧版本不受影响）
    const versionDir = path.join(opts.baseDir, opts.tag);
    report('extract', -1, 0, '解压主包');
    try {
      await extractZip(mainZip, versionDir);
    } catch (e) {
      await fs.rm(versionDir, { recursive: true, force: true });
      await fs.rm(mainZip, { force: true });
      return fail('error', `解压失败: ${(e as Error).message}`, cudaVersion, main.fellBack);
    }
    await fs.rm(mainZip, { force: true });
    // 5. CUDA DLLs（复用已有 cudart64_<主版本>.dll）
    const cudaDir = path.join(opts.baseDir, 'cuda', `cuda-${cudaVersion}`);
    const dllName = `cudart64_${cudaVersion.split('.')[0]}.dll`;
    let dllOk = false;
    try { await fs.access(path.join(cudaDir, dllName)); dllOk = true; } catch { dllOk = false; }
    if (!dllOk) {
      const cudaAsset = pickCudaAsset(cudaVersion, opts.assets);
      if (cudaAsset) {
        const cudaZip = path.join(opts.baseDir, cudaAsset.name);
        report('download-cuda', 0, 0, `下载 CUDA DLLs ${cudaAsset.name}`);
        await downloadFile({
          url: cudaAsset.browser_download_url,
          dest: cudaZip,
          onProgress: (p) => report(
            'download-cuda', p.pct, p.mbps,
            `CUDA DLLs ${p.pct >= 0 ? (p.pct * 100).toFixed(1) + '%' : ''} ${p.mbps.toFixed(1)}MB/s`,
          ),
        });
        await extractZip(cudaZip, cudaDir);
        await fs.rm(cudaZip, { force: true });
      } else {
        report('download-cuda', -1, 0, `未找到 ${cudaVersion} 的 CUDA DLL 包，跳过（GPU 加速可能不可用）`);
      }
    }
    // 6. 验证
    report('verify', -1, 0, '验证可执行文件');
    const exeName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    const exePath = path.join(versionDir, exeName);
    let valid = true;
    try {
      await (opts.verify ?? verifyExe)(exePath);
    } catch {
      valid = false; // 规格 §9.2：标红该版本，不自动选中
    }
    // 7. 修剪 + manifest
    report('prune', -1, 0, '修剪旧版本');
    const entries = (await readManifest(opts.baseDir)).filter((e) => e.tag !== opts.tag);
    const entry: InstalledVersion = { tag: opts.tag, cudaVersion, installedAt: Date.now(), valid };
    const pruned = await pruneVersions(opts.baseDir, [...entries, entry], opts.selectedTag, 2);
    const prunedSet = new Set(pruned.prunedTags);
    const manifest = [...entries, entry].filter((e) => !prunedSet.has(e.tag));
    await writeManifest(opts.baseDir, manifest);
    report('done', 1, 0, valid ? `更新完成 ${opts.tag}` : `更新完成，但 ${opts.tag} 验证失败（已标红）`);
    return { ok: true, valid, phase: 'done', cudaVersion, mainFellBack: main.fellBack };
  } catch (e) {
    return fail('error', (e as Error).message ?? String(e));
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

运行：`cd /f/llama_lanucher && npx vitest run test/updater.test.ts`
预期：`Test Files  1 passed (1)`，`Tests  17 passed (17)`。

- [ ] **Step 6: 类型检查 + 提交**

```bash
cd /f/llama_lanucher && npm run typecheck && git add -A && git -c user.name='dsh' -c user.email='dsh@local' commit -m "updater: GitHub check + range-resume download + extract/prune/verify (spec §9.2)"
```

---

### Task 14: server-controller.ts + index.ts — 主进程接线（生命周期/切换/IPC/窗口/更新器）

**Files:**
- Create: `src/main/server-controller.ts`（纯 Node，ProcessManager 注入，fake-server.mjs 可单测）
- Create: `test/server-controller.test.ts`（8 测试）
- Modify: `src/main/proxy.ts`（autoSwitch 门控，2 处）、`test/proxy.test.ts`（beforeEach 复位 + 2 新测试）
- Rewrite: `src/main/index.ts`（Electron 接线：窗口/IPC/启动编排/更新器/版本横幅）、`src/preload/index.ts`（contextBridge API）
- Modify: `src/renderer/main.ts`（占位屏）、`tsconfig.preload.json`（加 `"exclude": []`）

规格 §2.2/§2.3/§5/§5.4/§9.1/§9.2/§3：start 流程 = 可见端口预检 → 启动即存 profile → 版本探针（`--version` + 横幅）→ spawn + /health 就绪 → 起/重建反向代理；stop 在切换期间 = 取消切换（杀新 server，回 stopped）；崩溃（非 intentional 退出）→ `crashed` + exitCode + stderr 捕获（<10s 记 early）；切换 = 停旧 → 起新 → 等健康，失败抛错（代理回 502）；同模型（忽略大小写）不重启。代理门控：`form.autoSwitch` 关闭时 model 字段被忽略（直接转发，不 400 不切换），`/v1/models` 只列当前模型（规格 §5）。exe 解析：`exeSelection` 空 = 托管基线 b10488，`b\d+` = 托管目录 `<appRoot>/llama.cpp/<tag>/`（cudaDir 加入子进程 PATH 前置），其他 = 自定义路径。计划内偏差：`StartRequest.extraEnv(port)` / `extraArgvPrefix` 为测试注入钩子（应用端不用）；`ServerController` 字段改名 `_switching` 避免与接口方法 `switching()` 影子冲突（与 FakeController 同教训）。

- [ ] **Step 1: 写失败测试 test/server-controller.test.ts**

```ts
// server-controller.test.ts — server 生命周期与模型切换编排（规格 §2.2/§2.3/§5.4）
// 测试替身：fake-server.mjs（真实 spawn，node 二进制充当 llama-server）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { ProcessManager, isPortFree, type ExitInfo } from '../src/main/process-manager.js';
import { ServerController, type StartRequest } from '../src/main/server-controller.js';
import { DEFAULT_FORM } from '../src/main/config.js';
import type { ModelRef, SwitchState } from '../shared/types.js';

const FAKE = fileURLToPath(new URL('./fake-server.mjs', import.meta.url));

function ref(name: string): ModelRef {
  return {
    name,
    source: 'local',
    local: { name, path: `/models/${name}.gguf`, size: 1, mtime: Date.now(), mmproj: null, mmprojCandidates: [] },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await sleep(50);
  }
}

describe('ServerController', () => {
  let pm: ProcessManager;
  let ctl: ServerController;

  const req = (model: string, extra: Record<string, string> = {}): StartRequest => ({
    exe: process.execPath,
    form: { ...DEFAULT_FORM, extraArgs: '--fake-flag' },
    model: ref(model),
    cudaDir: null,
    extraEnv: (port: number) => ({ FAKE_PORT: String(port), ...extra }),
    extraArgvPrefix: [FAKE],
  });

  beforeAll(() => {
    pm = new ProcessManager();
    ctl = new ServerController(pm, {}, 3000);
  });

  afterAll(async () => {
    await ctl.stop();
  });

  it('start → running with health-checked internal port; stop releases the port', async () => {
    await ctl.start(req('fake-model'));
    expect(ctl.getState().status).toBe('running');
    expect(ctl.isReady()).toBe(true);
    expect(ctl.currentModel()).toBe('fake-model');
    const port = ctl.internalPort();
    expect(port).toBeGreaterThan(0);
    expect(pm.running).toBe(true);
    await ctl.stop();
    expect(ctl.getState().status).toBe('stopped');
    expect(pm.running).toBe(false);
    expect(await isPortFree(port)).toBe(true);
  });

  it('waits for delayed health (slow model load)', async () => {
    await ctl.start(req('fake-model', { FAKE_HEALTH_DELAY_MS: '400' }));
    expect(ctl.getState().status).toBe('running');
    await ctl.stop();
  });

  it('reports crash with exit code and captured stderr', async () => {
    let exitInfo: ExitInfo | null = null;
    const c2 = new ServerController(new ProcessManager(), { onExit: (i) => { exitInfo = i; } }, 3000);
    await c2.start(req('fake-model', { FAKE_HEALTH_DELAY_MS: '50', FAKE_CRASH_MS: '1200', FAKE_CRASH_MSG: 'error: invalid argument: --fake-flag' }));
    expect(c2.getState().status).toBe('running');
    await waitFor(() => c2.getState().status === 'crashed');
    expect(c2.getState().exitCode).toBe(1);
    expect(c2.isReady()).toBe(false);
    expect(exitInfo).not.toBeNull();
    expect(exitInfo!.early).toBe(true); // 400ms < 10s
    expect(exitInfo!.stderr).toContain('error: invalid argument: --fake-flag');
    await c2.stop();
  });

  it('start failure (health timeout) → stopped, error thrown', async () => {
    await expect(ctl.start(req('fake-model', { FAKE_HEALTH_DELAY_MS: '10000' }))).rejects.toThrow(/health check timed out/);
    expect(ctl.getState().status).toBe('stopped');
    expect(pm.running).toBe(false);
  });

  it('restart while running replaces the process', async () => {
    await ctl.start(req('fake-model'));
    const pid1 = pm.pid;
    await ctl.start(req('fake-model'));
    expect(ctl.getState().status).toBe('running');
    expect(pm.pid).not.toBe(pid1);
    await ctl.stop();
  });

  it('switchTo different model: stop old, start new, update current', async () => {
    const switchEvents: SwitchState[] = [];
    const c2 = new ServerController(new ProcessManager(), { onSwitch: (s) => switchEvents.push(s) }, 3000);
    await c2.start(req('fake-model'));
    const port1 = c2.internalPort();
    await c2.switchTo(ref('other-model'));
    expect(c2.getState().status).toBe('running');
    expect(c2.currentModel()).toBe('other-model');
    expect(c2.isReady()).toBe(true);
    if (port1 !== null && port1 !== c2.internalPort()) expect(await isPortFree(port1)).toBe(true); // 新 server 可能复用了旧端口
    expect(switchEvents.some((s) => s.switching && s.to === 'other-model')).toBe(true);
    await c2.stop();
  });

  it('switchTo same model (case-insensitive) is a no-op', async () => {
    await ctl.start(req('Fake-Model'));
    const pid1 = pm.pid;
    await ctl.switchTo(ref('fake-model'));
    expect(pm.pid).toBe(pid1);
    expect(ctl.getState().status).toBe('running');
    expect(ctl.currentModel()).toBe('Fake-Model');
    await ctl.stop();
  });

  it('switchTo before start throws', async () => {
    const c3 = new ServerController(new ProcessManager(), {}, 3000);
    await expect(c3.switchTo(ref('any-model'))).rejects.toThrow(/not started/);
  });
});
```

- [ ] **Step 2: 确认失败**

运行：`npx vitest run test/server-controller.test.ts`
预期：`Cannot find module '../src/main/server-controller.js'`（no tests）

- [ ] **Step 3: 实现 src/main/server-controller.ts**

状态机：stopped → starting → running ⇄ switching；非 intentional onExit 且状态 ∈ {running, starting, switching} → crashed（exitCode 记录）。start 失败 → pm.stop + 状态回 stopped + 抛错。switchTo 复用 lastReq（仅换 model）。

```ts
// server-controller.ts — llama-server 生命周期与模型切换编排（规格 §2.2/§2.3/§5.4）
// 纯 Node（ProcessManager 注入），fake-server.mjs 可单测；实现代理的 SwitchController 接口
import path from 'node:path';
import { buildArgs } from './args.js';
import { probeFreePort, ProcessManager, type ExitInfo } from './process-manager.js';
import type { SwitchController } from './proxy.js';
import type { FormValues, ModelRef, ServerState, SwitchState } from '../shared/types.js';

export interface StartRequest {
  exe: string;
  form: FormValues;
  model: ModelRef;
  /** 托管 CUDA 目录（加入子进程 PATH 前置）；自定义 exe 传 null（规格 §9.2） */
  cudaDir: string | null;
  /** 测试注入：按探测端口追加环境变量（如 FAKE_PORT）；应用端不用 */
  extraEnv?: (port: number) => Record<string, string>;
  /** 测试注入：argv 前缀（如 fake-server 脚本路径）；应用端不用 */
  extraArgvPrefix?: string[];
}

export interface ControllerEvents {
  onStateChange?: (s: ServerState) => void;
  onLog?: (line: string) => void;
  onExit?: (info: ExitInfo) => void;
  onSwitch?: (s: SwitchState) => void;
}

export class ServerController implements SwitchController {
  private pm: ProcessManager;
  private events: ControllerEvents;
  private healthTimeoutMs: number;
  private state: ServerState = { status: 'stopped', port: null, model: null, exitCode: null };
  private port = 0;
  private lastReq: StartRequest | null = null;
  private _switching = false;
  private unionList: ModelRef[] = [];

  constructor(pm: ProcessManager, events: ControllerEvents = {}, healthTimeoutMs = 300000) {
    this.pm = pm;
    this.events = events;
    this.healthTimeoutMs = healthTimeoutMs;
  }

  // ---- SwitchController（代理注入）----
  internalPort(): number | null {
    const s = this.state.status;
    return s === 'running' || s === 'starting' || s === 'switching' ? this.port : null;
  }
  isReady(): boolean { return this.state.status === 'running'; }
  currentModel(): string | null { return this.state.model; }
  union(): ModelRef[] { return this.unionList; }
  switching(): boolean { return this._switching; }
  setUnion(models: ModelRef[]): void { this.unionList = models; }
  getState(): ServerState { return { ...this.state }; }

  private setState(patch: Partial<ServerState>): void {
    this.state = { ...this.state, ...patch };
    this.events.onStateChange?.(this.getState());
  }

  private handleExit(info: ExitInfo): void {
    if (info.intentional) return;
    const s = this.state.status;
    if (s !== 'running' && s !== 'starting' && s !== 'switching') return;
    this.setState({ status: 'crashed', port: null, exitCode: info.code });
    this.events.onExit?.(info);
  }

  /** 启动（运行中则重启）；失败时清理并抛出（规格 §2.2：spawn → 起代理 → /health 就绪） */
  async start(req: StartRequest): Promise<void> {
    const busy = this.state.status === 'starting' || this.state.status === 'running' || this.state.status === 'switching';
    if (busy) await this.stop();
    this.setState({ status: 'starting', port: null, model: req.model.name, exitCode: null });
    try {
      const port = await probeFreePort();
      this.port = port;
      const built = buildArgs(req.form, req.model, port);
      const env: Record<string, string> = { ...built.env, ...(req.extraEnv ? req.extraEnv(port) : {}) };
      if (req.cudaDir) env.PATH = `${req.cudaDir}${path.delimiter}${process.env.PATH ?? ''}`;
      await this.pm.start({
        exe: req.exe,
        argv: [...(req.extraArgvPrefix ?? []), ...built.argv],
        env,
        port,
        onLine: (line) => this.events.onLog?.(line),
        onExit: (info) => this.handleExit(info),
      });
      this.lastReq = req;
      await this.pm.waitForHealth(this.healthTimeoutMs);
      this.setState({ status: 'running', port, model: req.model.name, exitCode: null });
    } catch (e) {
      await this.pm.stop().catch(() => {});
      this.setState({ status: 'stopped', port: null, exitCode: null });
      throw e;
    }
  }

  /** 模型切换（规格 §5.4）：停旧 → 起新 → 等健康；失败抛出（代理回 502，状态回 stopped） */
  async switchTo(model: ModelRef): Promise<void> {
    if (this._switching) throw new Error('switch already in progress');
    const cur = this.state.model;
    if (cur !== null && model.name.toLowerCase() === cur.toLowerCase()) return; // 同模型（忽略大小写）不重启
    const last = this.lastReq;
    if (!last) throw new Error('server not started');
    this._switching = true;
    this.events.onSwitch?.({ switching: true, from: this.state.model, to: model.name });
    this.setState({ status: 'switching', exitCode: null });
    try {
      await this.start({ ...last, model });
    } finally {
      this._switching = false;
      this.events.onSwitch?.({ switching: false, from: null, to: null });
    }
  }

  /** 停止（规格 §2.3）；切换期间停止 = 取消切换（杀掉新 server，回到 stopped） */
  async stop(): Promise<void> {
    if (this.pm.running) await this.pm.stop();
    this.setState({ status: 'stopped', port: null, exitCode: null });
  }
}
```

运行：`npx vitest run test/server-controller.test.ts`
预期：8 passed。踩坑：fake server 以 node 二进制 spawn，argv 需 `extraArgvPrefix: [FAKE]`（否则 node 把模型路径当脚本执行立即退出 → `server exited during startup`）；崩溃测试 CRASH_MS 必须晚于第二次健康轮询（500ms 间隔，取 1200ms）；新 server 可能复用旧端口（probeFreePort 取首个空闲），断言需排除同端口。

- [ ] **Step 4: proxy autoSwitch 门控（规格 §5）+ 2 新测试**

proxy.ts 编辑 1（handle 内 model 检查加门控）：
```ts
    const model = this.extractModel(body);
    if (model !== null && this.form.autoSwitch) {
```
proxy.ts 编辑 2（respondModels：关闭时只列当前模型）：
```ts
    const list = this.form.autoSwitch
      ? ctrl.union()
      : current !== null
        ? [{ name: current, source: 'local' as const }]
        : [];
    const data = list.map((m) => ({
```
test/proxy.test.ts：beforeEach 加 `proxy.setForm({ ...DEFAULT_FORM, autoSwitch: true });`（DEFAULT_FORM.autoSwitch 为 false，旧切换测试需显式开）；文件尾追加 2 测试：
```ts
  it('autoSwitch off ignores the model field (no switch, no 400)', async () => {
    proxy.setForm({ ...DEFAULT_FORM, autoSwitch: false });
    const res = await postJson(proxyPort, '/v1/chat/completions', { model: 'nope-model', messages: [{ role: 'user', content: 'hi' }], stream: true });
    expect(res.status).toBe(200);
    expect(res.body).toContain('"content":"hel"');
    expect(ctrl.switchCalls).toEqual([]);
  });

  it('autoSwitch off: /v1/models lists only the current model', async () => {
    proxy.setForm({ ...DEFAULT_FORM, autoSwitch: false });
    const res = await doGet(proxyPort, '/v1/models');
    const obj = JSON.parse(res.body) as { data: { id: string; current: boolean }[] };
    expect(obj.data).toHaveLength(1);
    expect(obj.data[0].id).toBe('fake-model');
    expect(obj.data[0].current).toBe(true);
  });
```

运行：`npx vitest run test/proxy.test.ts`
预期：17 passed（15 旧 + 2 新）

- [ ] **Step 5: index.ts 完整接线 + preload + 占位 renderer**

index.ts 结构：模块级状态（config/profiles/pm/ctl/stats/rounds/proxy/records/并集缓存/installed/横幅）；`send(channel, payload)` 守护 win；日志 100ms 批量 IPC；`resolveExe(form)`（空=基线托管、`b\d+`=托管目录+cudaDir、其他=自定义）；`probeVersion(exe)`（execFile `--version` → parseVersion）；`refreshUnion()`（scanModels + scanHfCache → buildModelUnion → ctl.setUnion，HF 仅 autoSwitch 开时）；`startServer(form, model)`（端口预检 → profile 存 → 配置存 → 版本横幅 → ctl.start → 起/重建 LauncherProxy）；IPC：app:boot / models:scan / hf:scan / server:start / server:stop / form:save（CORS 经 proxy.setForm 即时生效、并集按字段变化刷新、exeSelection 变则重探版本）/ profiles:* / records:files / records:tail / updater:check / updater:run（runUpdate + 成功后自动选中新版本）/ dialog:dir / stats:get；事件：state:change / log:lines / switch:change / stats:request（含 latest+history 20 条）/ update:progress / banner:change / exit:crash；窗口关闭 → 停 proxy + ctl 后 quit。preload 经 contextBridge 暴露同名 API + `on(channel, cb)` 白名单订阅。

src/main/index.ts（完整）：
```ts
// index.ts — Electron 主进程：窗口 / IPC / 启动编排（规格 §2/§3/§5/§9/§10）
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
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
      else rounds.onEval(ev, ts);
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

function resolveExe(form: FormValues): { exe: string; cudaDir: string | null } {
  const sel = form.exeSelection.trim();
  if (sel === '') {
    const entry = installed.find((v) => v.tag === `b${BASELINE_BUILD}` && v.valid !== false);
    if (entry) return managedPath(entry);
    throw new Error('请在设置区选择 llama.cpp 版本（托管版本或自定义路径）');
  }
  if (/^b\d+$/.test(sel)) {
    const entry = installed.find((v) => v.tag === sel);
    if (!entry) throw new Error(`托管版本 ${sel} 未安装（点"立即更新"安装）`);
    return managedPath(entry);
  }
  return { exe: sel, cudaDir: null }; // 自定义路径
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
  try { hfModels = form.autoSwitch && form.hfCacheDir ? scanHfCache(form.hfCacheDir) : []; } catch { hfModels = []; }
  ctl.setUnion(buildModelUnion(localModels, hfModels));
}

async function refreshInstalled(): Promise<void> {
  try { installed = await readManifest(llamaBaseDir()); } catch { installed = []; }
}

// ---------- 启动 / 停止（规格 §2.2/§2.3） ----------
async function startServer(form: FormValues, model: ModelRef): Promise<void> {
  if (!(await isPortFree(form.visiblePort))) {
    throw new Error(`可见端口 ${form.visiblePort} 已被占用，请在"服务"组更换端口`);
  }
  const { exe, cudaDir } = resolveExe(form);
  // 启动即保存 profile（规格 §5.1）
  const key = model.local ? model.local.path : model.name;
  await profiles.save(key, form);
  config.saveSettings({ form });
  // 版本探针 + 横幅（规格 §9.1）
  versionInfo = await probeVersion(exe);
  versionMsg = versionBanner(versionInfo);
  refreshBanner();
  // 起 server（spawn → /health 就绪）
  await ctl.start({ exe, form, model, cudaDir });
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
```

src/preload/index.ts（完整）：
```ts
// preload/index.ts — contextBridge API（CJS 编译，规格 §3 顶栏/左栏/右栏全部交互）
import { contextBridge, ipcRenderer } from 'electron';

const EVENTS = ['state:change', 'log:lines', 'switch:change', 'stats:request', 'stats:round', 'update:progress', 'banner:change', 'exit:crash'] as const;

contextBridge.exposeInMainWorld('llama', {
  boot: (): Promise<unknown> => ipcRenderer.invoke('app:boot'),
  scanModels: (dir: string): Promise<unknown> => ipcRenderer.invoke('models:scan', dir),
  scanHf: (dir: string): Promise<unknown> => ipcRenderer.invoke('hf:scan', dir),
  startServer: (form: unknown, model: unknown): Promise<void> => ipcRenderer.invoke('server:start', { form, model }),
  stopServer: (): Promise<void> => ipcRenderer.invoke('server:stop'),
  saveForm: (form: unknown): Promise<void> => ipcRenderer.invoke('form:save', form),
  listProfiles: (): Promise<unknown> => ipcRenderer.invoke('profiles:list'),
  saveProfile: (model: string, params: unknown): Promise<void> => ipcRenderer.invoke('profiles:save', { model, params }),
  loadProfile: (model: string): Promise<unknown> => ipcRenderer.invoke('profiles:load', model),
  deleteProfile: (model: string): Promise<void> => ipcRenderer.invoke('profiles:delete', model),
  recordFiles: (): Promise<unknown> => ipcRenderer.invoke('records:files'),
  recordsTail: (page: number): Promise<unknown> => ipcRenderer.invoke('records:tail', page),
  checkUpdate: (): Promise<unknown> => ipcRenderer.invoke('updater:check'),
  runUpdate: (tag: string): Promise<unknown> => ipcRenderer.invoke('updater:run', tag),
  openDirDialog: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('dialog:dir', defaultPath),
  getStats: (): Promise<unknown> => ipcRenderer.invoke('stats:get'),
  on: (channel: string, cb: (payload: unknown) => void): (() => void) => {
    if (!(EVENTS as readonly string[]).includes(channel)) return () => {};
    const listener = (_e: unknown, payload: unknown): void => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => { ipcRenderer.removeListener(channel, listener); };
  },
});
export {};
```

src/renderer/main.ts（占位，Task 15-17 替换）：
```ts
// renderer/main.ts — 占位界面（Task 15-17 替换为完整 UI：布局 §3 / 彩色日志 / 统计 / 聊天 / 轮次记录）
declare global {
  interface Window {
    llama: {
      boot(): Promise<{ server: { status: string; port: number | null; model: string | null }; form: unknown }>;
      startServer(form: unknown, model: unknown): Promise<void>;
      stopServer(): Promise<void>;
      saveForm(form: unknown): Promise<void>;
      on(channel: string, cb: (payload: unknown) => void): () => void;
    };
  }
}

async function main(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) return;
  app.textContent = '正在连接主进程…';
  try {
    const state = await window.llama.boot();
    const srv = state.server;
    app.textContent = `主进程已连接 | server: ${srv.status}${srv.port ? ` :${srv.port}` : ''}${srv.model ? ` ${srv.model}` : ''}`;
    window.llama.on('state:change', (p: unknown) => {
      const s = p as { status: string; port: number | null; model: string | null };
      app.textContent = `state:change → ${s.status}${s.port ? ` :${s.port}` : ''}${s.model ? ` ${s.model}` : ''}`;
    });
  } catch (e) {
    app.textContent = `主进程连接失败: ${String(e)}`;
  }
}
void main();
export {};
```

tsconfig.preload.json 加 `"exclude": []`（基座 exclude src/preload 被继承 → TS18003 no inputs）。

运行：`npm run typecheck && npm run build`
预期：无类型错误；dist/main/server-controller.js、dist/preload/index.js（CJS `require("electron")`）、dist/renderer/main.js 均生成。踩坑：`ServerController` 字段 `switching` 与接口方法 `switching()` 冲突（TS2300 重复标识符）→ 字段改 `_switching`。

- [ ] **Step 6: 全量测试 + 提交**

运行：`npm test`
预期：14 suites / 123 tests 全绿（113 + 8 controller + 2 proxy）。

```bash
git add -A && git commit -m "main: server controller + proxy autoSwitch gate + Electron wiring (IPC/window/updater/version)"
```

---

### Task 15: renderer — 布局 + 设置表单 + 彩色日志 tab（规格 §3/§5）

**Files:**
- Create: `src/renderer/ansi.ts`（极简 SGR→HTML 转换器）
- Rewrite: `src/renderer/index.html`（三栏布局 + tabs）、`src/renderer/main.ts`（表单/状态/日志/profiles/更新 UI）
- Create: `src/renderer/styles.css`（暗色主题）

计划偏差（记录在案）：npm `ansi-to-html@0.7.2` 仅 CJS（`lib/ansi_to_html.js` + `require('entities')`）无浏览器 bundle，vendor 需引入 esbuild 等打包器 → 改为内联极简 SGR 转换器（覆盖 llama.cpp 彩色日志的 SGR 子集：0/1/22、30-37、90-97、38;5;n、38;2;r;g;b；自动转义 `& < >`），并从 dependencies 移除 ansi-to-html。renderer 仍由主 tsc 编译（`import type` 共享类型，无运行时跨目录导入）；`scripts/copy-assets.mjs` 保留 vendor 目录（空，备用）。

布局（规格 §3）：顶栏 = 模型下拉（并集）+ 自动切换开关 + 启动/停止 + 状态徽章（stopped 灰/starting 黄/running 绿/switching 青/crashed 红 + exitCode）+ 端口信息（内部 :P → 可见 :V）+ 版本横幅（低于基线红）+ 更新横幅（蓝）+ 顶栏错误（10s 自清）。左栏 = 7 组折叠表单（模型/服务/硬件/上下文/采样/投机解码/高级，字段 = FormValues 全集）+ App 组（autoSwitch 复选、scanDir/hfCacheDir 目录浏览、exe 选择〔托管版本下拉 + 自定义路径输入〕、recordRounds、记录上限 MB）+ profile 栏（选中即应用/手动保存/删除，key = 本地路径或 HF 名）+ 更新盒（检查/立即更新/进度条/消息）。右栏 = tabs 日志（跟随滚动 + 清空 + 3000 行上限）| 统计 | 聊天 | 轮次记录（后三者 Task 16-17 填充占位）。

表单语义：字段 change → 内存 form 更新 → 600ms 防抖 `saveForm` IPC（配置持久化 + CORS 等经主进程 `proxy.setForm` 即时生效）；number 字段强转；recordsMaxTotalBytes 以 MB 展示（存储为字节）。exeSelection 编码：空 = 托管基线 b10488，`b\d+` = 托管 tag，其他 = 自定义 exe 路径（下拉 `__custom__` 切换显示路径输入）。启动按钮：stopped/crashed = 启动，running/switching = 重启（新模型）；启动前 `saveForm`（规格 §5.1 启动即保存）。事件：state:change / log:lines（批量）/ banner:change / update:progress / exit:crash（红色诊断行）。

- [ ] **Step 1: 写 ansi.ts（内联转换器）**

```ts
// ansi.ts — 极简 SGR(ANSI) → HTML 转换器（覆盖 llama-server --log-colors 输出）
// 计划偏差：npm ansi-to-html@0.7.2 仅 CJS 无浏览器 bundle，引入需额外打包器；llama.cpp 的 SGR 子集很小，内联实现
const PALETTE: Record<number, string> = {
  30: '#5c6370', 31: '#e06c75', 32: '#98c379', 33: '#e5c07b', 34: '#61afef', 35: '#c678dd', 36: '#56b6c2', 37: '#dcdfe4',
  90: '#7f848e', 91: '#ff7b86', 92: '#b8e09a', 93: '#f0d088', 94: '#82c4ff', 95: '#d89af0', 96: '#7fd8e8', 97: '#ffffff',
};

const CUBE = [0, 95, 135, 175, 215, 255];

/** 把一行（可含多段 SGR）原始日志转成 HTML（自动转义 & < >） */
export function ansiHtml(raw: string): string {
  let out = '';
  let buf = '';
  let fg: string | null = null;
  let bold = false;
  const flush = (): void => {
    if (buf === '') return;
    const esc = buf.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const style = (fg ? `color:${fg};` : '') + (bold ? 'font-weight:700;' : '');
    out += style !== '' ? `<span style="${style}">${esc}</span>` : esc;
    buf = '';
  };
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '\u001b' && raw[i + 1] === '[') {
      const end = raw.indexOf('m', i + 2);
      if (end === -1) { buf += raw.slice(i); break; }
      const codes = raw.slice(i + 2, end).split(';').map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));
      flush();
      for (let k = 0; k < codes.length; k++) {
        const c = codes[k];
        if (c === 0) { fg = null; bold = false; }
        else if (c === 1) { bold = true; }
        else if (c === 22) { bold = false; }
        else if (c >= 30 && c <= 37) { fg = PALETTE[c] ?? null; }
        else if (c >= 90 && c <= 97) { fg = PALETTE[c] ?? null; }
        else if (c === 38 || c === 48) {
          if (codes[k + 1] === 5 && codes[k + 2] !== undefined) {
            const n = codes[k + 2];
            if (n >= 16 && n <= 231) {
              const v = n - 16;
              fg = `rgb(${CUBE[Math.floor(v / 36)]},${CUBE[Math.floor((v % 36) / 6)]},${CUBE[v % 6]})`;
            } else if (n >= 232) {
              const x = 8 + (n - 232) * 10;
              fg = `rgb(${x},${x},${x})`;
            } else if (c === 38) { fg = PALETTE[n + 30] ?? null; }
            k += 2;
          } else if (codes[k + 1] === 2 && c === 38) {
            fg = `rgb(${codes[k + 2]},${codes[k + 3]},${codes[k + 4]})`;
            k += 4;
          }
        }
      }
      i = end + 1;
    } else {
      buf += raw[i];
      i++;
    }
  }
  flush();
  return out;
}

export function ansiTestLine(): string {
  return '\u001b[0;32m  prompt eval    time =    100.00 ms /    10 tokens   \u001b[0m | \u001b[0;94m eval count    =    20 tokens  \u001b[0m | \u001b[0;31merror line\u001b[0m';
}
```

- [ ] **Step 2: 写 index.html + styles.css（布局 + 暗色主题）**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>llama-server 启动器</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <div id="topbar">
    <select id="model-select" title="模型（并集：本地 + HF）"></select>
    <label class="chk"><input type="checkbox" id="auto-switch" /> 自动切换</label>
    <button id="btn-start">启动</button>
    <button id="btn-stop" class="stop">停止</button>
    <span id="status-badge" class="badge gray">stopped</span>
    <span id="port-info" class="muted"></span>
    <span id="banner-version" class="banner"></span>
    <span id="banner-update" class="banner info"></span>
    <span id="top-error" class="banner warn"></span>
  </div>
  <div id="main">
    <div id="left">
      <div id="form-groups"></div>
      <details id="app-group"><summary>App 设置</summary><div id="app-fields"></div></details>
      <div id="profile-bar">
        <select id="profile-select"></select>
        <button id="btn-profile-apply">应用</button>
        <button id="btn-profile-save">保存</button>
        <button id="btn-profile-del" class="stop">删除</button>
      </div>
      <div id="update-box">
        <div id="update-status" class="muted">尚未检查更新</div>
        <div class="row">
          <button id="btn-update-check">检查更新</button>
          <button id="btn-update-run" disabled>立即更新</button>
        </div>
        <progress id="update-progress" max="100" value="0"></progress>
        <div id="update-msg" class="muted"></div>
      </div>
    </div>
    <div id="right">
      <div id="tabs">
        <button data-tab="logs" class="active">日志</button>
        <button data-tab="stats">统计</button>
        <button data-tab="chat">聊天</button>
        <button data-tab="records">轮次记录</button>
      </div>
      <div id="tab-logs" class="tab">
        <div class="toolbar">
          <label class="chk"><input type="checkbox" id="log-follow" checked /> 跟随滚动</label>
          <button id="btn-log-clear">清空</button>
        </div>
        <div id="log-view"></div>
      </div>
      <div id="tab-stats" class="tab hidden">
        <div class="placeholder">统计面板（Task 16）</div>
      </div>
      <div id="tab-chat" class="tab hidden">
        <div class="placeholder">内置测试聊天（Task 16）</div>
      </div>
      <div id="tab-records" class="tab hidden">
        <div class="placeholder">轮次记录（Task 17）</div>
      </div>
    </div>
  </div>
  <script type="module" src="./main.js"></script>
</body>
</html>
```

```css
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; font-family: "Segoe UI", system-ui, sans-serif; font-size: 13px; background: #1e1f22; color: #d4d4d4; }
button { background: #3a5b8a; color: #fff; border: none; padding: 5px 12px; border-radius: 4px; cursor: pointer; font-size: 13px; }
button:hover:not(:disabled) { filter: brightness(1.15); }
button:disabled { opacity: 0.45; cursor: default; }
button.stop { background: #8a3a3a; }
select, input[type="text"], input[type="number"] { background: #1a1b1e; border: 1px solid #3a3b40; color: #d4d4d4; padding: 3px 6px; border-radius: 3px; font-size: 13px; }
.muted { color: #7f848e; font-size: 12px; }
.banner { font-size: 12px; padding: 2px 8px; border-radius: 4px; }
.banner:empty { display: none; }
.banner.warn { background: #7a1f24; color: #ffb3b8; }
.banner.info { background: #1a4a6e; color: #a8d4ff; }
.badge { padding: 2px 10px; border-radius: 10px; font-size: 12px; white-space: nowrap; }
.badge.gray { background: #3a3b40; color: #c9c9c9; }
.badge.yellow { background: #6e5a12; color: #ffd75f; }
.badge.green { background: #1d5c2f; color: #7ee2a8; }
.badge.cyan { background: #1a5c66; color: #7fd8e8; }
.badge.red { background: #7a1f24; color: #ff9ba0; }
#topbar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: #25262b; border-bottom: 1px solid #33343a; flex-wrap: wrap; }
#model-select { min-width: 260px; max-width: 420px; }
#main { display: grid; grid-template-columns: 370px 1fr; height: calc(100vh - 47px); }
#left { overflow-y: auto; border-right: 1px solid #33343a; padding: 8px; }
#right { display: flex; flex-direction: column; min-width: 0; }
#tabs { display: flex; gap: 3px; padding: 6px 8px 0; background: #25262b; border-bottom: 1px solid #33343a; }
#tabs button { background: #2a2b31; color: #999; border: 1px solid #33343a; border-bottom: none; border-radius: 6px 6px 0 0; padding: 6px 16px; }
#tabs button.active { background: #16171a; color: #fff; }
.tab { flex: 1; overflow: hidden; display: flex; flex-direction: column; background: #16171a; }
.tab.hidden { display: none; }
.toolbar { display: flex; gap: 12px; align-items: center; padding: 5px 10px; border-bottom: 1px solid #2a2b30; }
.placeholder { padding: 20px; color: #7f848e; }
details { margin-bottom: 4px; }
summary { cursor: pointer; padding: 4px 8px; background: #2a2b31; border-radius: 4px; font-weight: 600; user-select: none; }
.field { display: grid; grid-template-columns: 138px 1fr auto; gap: 6px; align-items: center; padding: 2px 8px; }
.field label { color: #9a9b9f; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.field input[type="text"], .field input[type="number"], .field select { width: 100%; }
.field input[type="checkbox"] { width: 15px; height: 15px; }
.chk { display: inline-flex; gap: 5px; align-items: center; cursor: pointer; white-space: nowrap; }
.row { display: flex; gap: 8px; margin-top: 6px; }
#profile-bar { display: grid; grid-template-columns: 1fr auto; gap: 6px; padding: 6px 2px; border-top: 1px solid #2a2b30; margin-top: 8px; }
#profile-bar .row { margin: 0; }
#update-box { border-top: 1px solid #2a2b30; padding: 8px 2px; }
#update-progress { width: 100%; margin-top: 6px; }
#log-view { flex: 1; overflow-y: auto; padding: 8px 12px; font-family: Consolas, "Cascadia Mono", monospace; font-size: 12px; line-height: 1.5; }
.log-line { white-space: pre-wrap; word-break: break-all; min-height: 1.2em; }
.log-line.crash { color: #ff9ba0; font-weight: 700; }
```

- [ ] **Step 3: 写 main.ts（表单/状态/日志/profiles/更新）**

```ts
// renderer/main.ts — 主 UI（规格 §3：顶栏 / 左栏设置 / 右栏 tabs）；Task 16-17 填充统计/聊天/轮次记录
import { ansiHtml } from './ansi.js';
import type { FormValues, ModelRef, ServerState, Profile, UpdateProgress, InstalledVersion } from '../shared/types.js';

interface BootState {
  appRoot: string;
  form: FormValues;
  server: ServerState;
  union: ModelRef[];
  installed: InstalledVersion[];
  banner: { version: string | null; update: string | null };
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
    { id: 'splitMode', label: 'GPU 切分方式', type: 'select', options: [['', '默认'], ['layer', 'layer'], ['row', 'row']] },
    { id: 'device', label: '设备 (device)', type: 'text' },
    { id: 'loadMode', label: '内存 (mlock/mmap)', type: 'text' },
    { id: 'fit', label: '自动适配 (fit)', type: 'checkbox' },
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
    { id: 'flashAttn', label: 'Flash attention', type: 'select', options: [['', '默认'], ['1', '开'], ['0', '关']] },
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
    { id: 'specType', label: '方式', type: 'select', options: [['', '无'], ['mtp', 'MTP'], ['draft', 'draft']] },
    { id: 'specDraftModel', label: '草稿模型（本地）', type: 'text' },
    { id: 'specDraftHf', label: '草稿模型（HF）', type: 'text' },
    { id: 'specDraftNMax', label: 'n-max', type: 'text' },
    { id: 'specDraftNMin', label: 'n-min', type: 'text' },
    { id: 'specDraftNgl', label: 'n-gl', type: 'text' },
    { id: 'specDraftThreads', label: 'threads', type: 'text' },
    { id: 'specDraftPSplit', label: 'p-split', type: 'text' },
    { id: 'specDraftPMin', label: 'p-min', type: 'text' },
  ]},
  { title: '高级', fields: [
    { id: 'verbosity', label: '日志详细程度', type: 'select', options: [['', '默认'], ['0', '0'], ['1', '1'], ['2', '2']] },
    { id: 'warmup', label: 'warmup 运行', type: 'checkbox' },
    { id: 'contextShift', label: 'context shift', type: 'checkbox' },
    { id: 'cacheReuse', label: 'KV 缓存复用', type: 'checkbox' },
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
  (sel as HTMLSelectElement & { __sync?: () => void }).__sync = sync;
  (sel as HTMLSelectElement & { __fill?: () => void }).__fill = fillExeOptions;
  fillExeOptions();
  return row;
}

function fillExeOptions(): void {
  const sel = $<HTMLSelectElement>('exe-select');
  const cur = form ? form.exeSelection : '';
  sel.textContent = '';
  const o0 = document.createElement('option');
  o0.value = ''; o0.textContent = '默认（托管基线 b10488）';
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

// ---------- 保存（防抖 600ms） ----------
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (form) void window.llama.saveForm(form).catch((e) => showTopError(`保存设置失败: ${String(e)}`));
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
    o.value = ''; o.textContent = '（无模型：请先扫描目录）';
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

// ---------- 事件订阅 ----------
function subscribeEvents(): void {
  window.llama.on('state:change', (p) => renderState(p as ServerState));
  window.llama.on('log:lines', (p) => appendLog(p as string[]));
  window.llama.on('banner:change', (p) => renderBanner(p as { version: string | null; update: string | null }));
  window.llama.on('update:progress', (p) => {
    const u = p as UpdateProgress;
    const prog = $<HTMLProgressElement>('update-progress');
    prog.value = u.pct >= 0 ? u.pct : 0;
    $<HTMLDivElement>('update-msg').textContent = u.mbps > 0 ? `${u.message}（${u.mbps.toFixed(1)} MB/s）` : u.message;
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
  const tabs = document.querySelectorAll('#tabs button');
  for (const t of Array.from(tabs)) {
    t.addEventListener('click', () => {
      for (const x of Array.from(tabs)) x.classList.remove('active');
      t.classList.add('active');
      const name = t.getAttribute('data-tab') ?? 'logs';
      for (const tab of Array.from(document.querySelectorAll('.tab'))) {
        tab.classList.toggle('hidden', `tab-${name}` !== tab.id);
      }
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
    if (!key || !form) { showTopError('未选择模型，无法保存参数组'); return; }
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
  installed = s.installed;
  populateForm();
  buildModelSelect(s.server.model);
  renderState(s.server);
  renderBanner(s.banner);
  await refreshProfiles();
  subscribeEvents();
}
void main();
export {};
```

运行：`npm run typecheck && npm run build`
预期：无类型错误；dist/renderer/{ansi.js,main.js,index.html,styles.css} 生成。

- [ ] **Step 4: 冒烟验证 ansiHtml（node 直接加载编译产物）**

运行：`node -e "import('./dist/renderer/ansi.js').then(m => console.log(m.ansiHtml('\\u001b[0;32mgreen \\\u001b[0m< b>')))"`（实际以 fromCharCode 构造 ESC 字符）
预期：`<span style="color:#98c379;">green </span> + 转义后的 < b>`（颜色 + HTML 转义正确）。

- [ ] **Step 5: 提交**（npm uninstall ansi-to-html 已还原 package.json，无依赖变更）

```bash
git add -A && git commit -m "renderer: layout + settings form + colored log tab (spec §3)"
```

---

### Task 16: renderer — 统计 tab + 聊天 tab（规格 §7/§3）+ 轮次统计入库

**Files:**
- Modify: `src/main/index.ts`（onLog：轮次完成 → StatsStore + `stats:round` 事件）
- Modify: `src/renderer/index.html`（统计 5 卡片 + 20 行表格；聊天气泡区 + 输入框）
- Modify: `src/renderer/styles.css`（卡片/表格/聊天气泡样式）
- Modify: `src/renderer/main.ts`（renderStats + chatSend SSE 客户端 + 事件接线）

统计（规格 §7）：5 卡片 = 首 token 时间 / prefill 速度 / decode 速度 / prefill 时间 / 缓存命中率（最新一轮，`stats.getLatest()` 合并逻辑：proxy usage 轮次与日志解析轮次按 ts 配对）+ 最近 20 行历史表格。事件：`stats:request`（proxy 每请求，含 usage TTFT/命中率）与 `stats:round`（日志解析轮次完成：prompt eval + eval-time 配对后）都推送 `{latest, history}`。index.ts 原先只喂 RoundTracker 未入库 StatsStore → 本任务补上（否则 prefill/decode 卡片永远为 -）。

聊天（规格 §3）：内置测试聊天走可见端口 `http://<proxyHost>:<visiblePort>/v1/chat/completions`（SSE 流式），model = 当前下拉选择，apiKey 非空时带 `Authorization: Bearer`；renderer 直接 fetch（proxy CORS 默认 `*`，file:// 源 Origin: null 兼容）；Ctrl+Enter 发送；请求失败回滚用户消息。

提交：`1bf93e2`（4 files, +164/-4），typecheck 干净，123/123 测试通过。

- [ ] **Step 1-4: 实现（见提交 diff）**

```diff
diff --git a/src/main/index.ts b/src/main/index.ts
index 50158c8..f173452 100644
--- a/src/main/index.ts
+++ b/src/main/index.ts
@@ -38,7 +38,15 @@ const ctl = new ServerController(pm, {
     if (ev) {
       const ts = Date.now();
       if (ev.kind === 'prompt') rounds.onPrompt(ev, ts);
-      else rounds.onEval(ev, ts);
+      else {
+        rounds.onEval(ev, ts);
+        // 轮次完成（prefill + decode 配对）→ 入库并推送（规格 §7）
+        const r = rounds.rounds[rounds.rounds.length - 1];
+        if (r && r.prefillMs !== null) {
+          stats.addRound(r);
+          send('stats:round', { latest: stats.getLatest(), history: stats.getHistory().slice(-20) });
+        }
+      }
     }
   },
   onExit: (info) => send('exit:crash', info),
diff --git a/src/renderer/index.html b/src/renderer/index.html
index 7d312a3..36cc4ae 100644
--- a/src/renderer/index.html
+++ b/src/renderer/index.html
@@ -52,10 +52,29 @@
         <div id="log-view"></div>
       </div>
       <div id="tab-stats" class="tab hidden">
-        <div class="placeholder">统计面板（Task 16）</div>
+        <div id="stat-cards">
+          <div class="card"><div class="card-label">首 token 时间</div><div class="card-value" id="st-ttft">-</div></div>
+          <div class="card"><div class="card-label">prefill 速度</div><div class="card-value" id="st-ptps">-</div></div>
+          <div class="card"><div class="card-label">decode 速度</div><div class="card-value" id="st-dtps">-</div></div>
+          <div class="card"><div class="card-label">prefill 时间</div><div class="card-value" id="st-pms">-</div></div>
+          <div class="card"><div class="card-label">缓存命中率</div><div class="card-value" id="st-cache">-</div></div>
+        </div>
+        <div class="table-wrap">
+          <table id="stat-table">
+            <thead><tr><th>时间</th><th>模型</th><th>TTFT</th><th>prefill</th><th>prefill 速度</th><th>decode 速度</th><th>缓存命中率</th></tr></thead>
+            <tbody id="stat-tbody"></tbody>
+          </table>
+        </div>
       </div>
       <div id="tab-chat" class="tab hidden">
-        <div class="placeholder">内置测试聊天（Task 16）</div>
+        <div id="chat-msgs"><div class="chat-bubble sys">服务器运行中时，消息发送到可见端口的 /v1/chat/completions（SSE 流式）</div></div>
+        <div id="chat-input">
+          <textarea id="chat-text" rows="2" placeholder="发送消息…（Ctrl+Enter 发送）"></textarea>
+          <div class="row">
+            <button id="chat-send">发送</button>
+            <button id="chat-clear" class="stop">清空</button>
+          </div>
+        </div>
       </div>
       <div id="tab-records" class="tab hidden">
         <div class="placeholder">轮次记录（Task 17）</div>
diff --git a/src/renderer/main.ts b/src/renderer/main.ts
index 17e96ff..78df373 100644
--- a/src/renderer/main.ts
+++ b/src/renderer/main.ts
@@ -1,6 +1,6 @@
 // renderer/main.ts — 主 UI（规格 §3：顶栏 / 左栏设置 / 右栏 tabs）；Task 16-17 填充统计/聊天/轮次记录
 import { ansiHtml } from './ansi.js';
-import type { FormValues, ModelRef, ServerState, Profile, UpdateProgress, InstalledVersion } from '../shared/types.js';
+import type { FormValues, ModelRef, ServerState, Profile, RoundStats, UpdateProgress, InstalledVersion } from '../shared/types.js';
 
 interface BootState {
   appRoot: string;
@@ -9,6 +9,7 @@ interface BootState {
   union: ModelRef[];
   installed: InstalledVersion[];
   banner: { version: string | null; update: string | null };
+  stats: { latest: RoundStats | null; history: RoundStats[] };
 }
 
 interface ExitInfo { code: number | null; early: boolean; stderr: string; intentional: boolean }
@@ -125,6 +126,7 @@ let form: FormValues | null = null;
 let union: ModelRef[] = [];
 let installed: InstalledVersion[] = [];
 let latestTag: string | null = null;
+let serverState: ServerState = { status: 'stopped', port: null, model: null, exitCode: null };
 let saveTimer: ReturnType<typeof setTimeout> | null = null;
 
 const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
@@ -352,6 +354,7 @@ const STATUS_UI: Record<ServerState['status'], [string, string]> = {
 };
 
 function renderState(s: ServerState): void {
+  serverState = s;
   const [text, color] = STATUS_UI[s.status];
   const badge = $<HTMLSpanElement>('status-badge');
   badge.textContent = s.status === 'crashed' && s.exitCode !== null ? `${text} (exit ${s.exitCode})` : text;
@@ -432,11 +435,117 @@ async function doCheckUpdate(): Promise<void> {
   }
 }
 
+// ---------- 统计（规格 §7：5 卡片 + 最近 20 行） ----------
+const fmtMs = (v: number | null): string => (v === null ? '-' : v < 1000 ? `${v.toFixed(0)} ms` : `${(v / 1000).toFixed(2)} s`);
+const fmtTps = (v: number | null): string => (v === null ? '-' : `${v.toFixed(1)} tok/s`);
+const fmtPct = (v: number | null): string => (v === null ? '-' : `${(v * 100).toFixed(1)} %`);
+
+function renderStats(latest: RoundStats | null, history: RoundStats[]): void {
+  const set = (id: string, v: string): void => { const el = document.getElementById(id); if (el) el.textContent = v; };
+  set('st-ttft', fmtMs(latest?.ttftMs ?? null));
+  set('st-ptps', fmtTps(latest?.prefillTps ?? null));
+  set('st-dtps', fmtTps(latest?.decodeTps ?? null));
+  set('st-pms', fmtMs(latest?.prefillMs ?? null));
+  set('st-cache', fmtPct(latest?.cacheHitRate ?? null));
+  const tbody = document.getElementById('stat-tbody');
+  if (!tbody) return;
+  tbody.textContent = '';
+  for (const r of [...history].slice(-20).reverse()) {
+    const tr = document.createElement('tr');
+    const cells = [
+      new Date(r.ts).toLocaleTimeString(),
+      r.model ?? '',
+      fmtMs(r.ttftMs),
+      fmtMs(r.prefillMs),
+      fmtTps(r.prefillTps),
+      fmtTps(r.decodeTps),
+      fmtPct(r.cacheHitRate),
+    ];
+    for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); }
+    tbody.appendChild(tr);
+  }
+}
+
+// ---------- 聊天（走可见端口代理，规格 §3） ----------
+const chatHistory: { role: 'user' | 'assistant'; content: string }[] = [];
+
+function chatBubble(role: 'user' | 'assistant' | 'sys', text: string): HTMLElement {
+  const d = document.createElement('div');
+  d.className = `chat-bubble ${role}`;
+  d.textContent = text;
+  const host = $<HTMLDivElement>('chat-msgs');
+  host.appendChild(d);
+  host.scrollTop = host.scrollHeight;
+  return d;
+}
+
+async function chatSend(): Promise<void> {
+  const ta = $<HTMLTextAreaElement>('chat-text');
+  const text = ta.value.trim();
+  if (text === '') return;
+  if (!form) return;
+  if (serverState.status !== 'running') { chatBubble('sys', '服务器未运行（先点启动）'); return; }
+  ta.value = '';
+  chatHistory.push({ role: 'user', content: text });
+  chatBubble('user', text);
+  const bubble = chatBubble('assistant', '…');
+  try {
+    const headers: Record<string, string> = { 'content-type': 'application/json' };
+    if (form.apiKey !== '') headers['authorization'] = `Bearer ${form.apiKey}`;
+    const resp = await fetch(`http://${form.proxyHost}:${form.visiblePort}/v1/chat/completions`, {
+      method: 'POST',
+      headers,
+      body: JSON.stringify({ model: modelSelect.value, messages: chatHistory, stream: true }),
+    });
+    if (!resp.ok || !resp.body) {
+      bubble.textContent = `请求失败（HTTP ${resp.status}）：${await resp.text()}`;
+      chatHistory.pop();
+      return;
+    }
+    let acc = '';
+    const reader = resp.body.getReader();
+    const dec = new TextDecoder();
+    let buf = '';
+    for (;;) {
+      const { done, value } = await reader.read();
+      if (done) break;
+      buf += dec.decode(value, { stream: true });
+      let idx: number;
+      while ((idx = buf.indexOf('\n\n')) !== -1) {
+        const raw = buf.slice(0, idx);
+        buf = buf.slice(idx + 2);
+        const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
+        if (!dataLine) continue;
+        const data = dataLine.slice(5).replace(/^ /, '');
+        if (data === '[DONE]') continue;
+        try {
+          const obj = JSON.parse(data) as { choices?: { delta?: { content?: unknown } }[] };
+          const c = obj.choices?.[0]?.delta?.content;
+          if (typeof c === 'string') { acc += c; bubble.textContent = acc; };
+        } catch { /* 非 JSON 块跳过 */ }
+      }
+    }
+    if (acc === '') bubble.textContent = '（空响应）';
+    chatHistory.push({ role: 'assistant', content: acc });
+  } catch (e) {
+    bubble.textContent = `网络错误: ${String(e)}`;
+    chatHistory.pop();
+  }
+}
+
 // ---------- 事件订阅 ----------
 function subscribeEvents(): void {
   window.llama.on('state:change', (p) => renderState(p as ServerState));
   window.llama.on('log:lines', (p) => appendLog(p as string[]));
   window.llama.on('banner:change', (p) => renderBanner(p as { version: string | null; update: string | null }));
+  window.llama.on('stats:request', (p) => {
+    const s = p as { latest: RoundStats | null; history: RoundStats[] };
+    renderStats(s.latest, s.history);
+  });
+  window.llama.on('stats:round', (p) => {
+    const s = p as { latest: RoundStats | null; history: RoundStats[] };
+    renderStats(s.latest, s.history);
+  });
   window.llama.on('update:progress', (p) => {
     const u = p as UpdateProgress;
     const prog = $<HTMLProgressElement>('update-progress');
@@ -478,6 +587,14 @@ function wireButtons(): void {
   $<HTMLButtonElement>('btn-log-clear').addEventListener('click', () => {
     $<HTMLDivElement>('log-view').textContent = '';
   });
+  $<HTMLButtonElement>('chat-send').addEventListener('click', () => void chatSend());
+  $<HTMLButtonElement>('chat-clear').addEventListener('click', () => {
+    chatHistory.length = 0;
+    $<HTMLDivElement>('chat-msgs').textContent = '';
+  });
+  $<HTMLTextAreaElement>('chat-text').addEventListener('keydown', (e) => {
+    if (e.key === 'Enter' && e.ctrlKey) void chatSend();
+  });
   const tabs = document.querySelectorAll('#tabs button');
   for (const t of Array.from(tabs)) {
     t.addEventListener('click', () => {
@@ -540,6 +657,7 @@ async function main(): Promise<void> {
   buildModelSelect(s.server.model);
   renderState(s.server);
   renderBanner(s.banner);
+  renderStats(s.stats.latest, s.stats.history);
   await refreshProfiles();
   subscribeEvents();
 }
diff --git a/src/renderer/styles.css b/src/renderer/styles.css
index 3facbb8..5c2b1f4 100644
--- a/src/renderer/styles.css
+++ b/src/renderer/styles.css
@@ -43,3 +43,18 @@ summary { cursor: pointer; padding: 4px 8px; background: #2a2b31; border-radius:
 #log-view { flex: 1; overflow-y: auto; padding: 8px 12px; font-family: Consolas, "Cascadia Mono", monospace; font-size: 12px; line-height: 1.5; }
 .log-line { white-space: pre-wrap; word-break: break-all; min-height: 1.2em; }
 .log-line.crash { color: #ff9ba0; font-weight: 700; }
+#stat-cards { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; padding: 10px; }
+.card { background: #1e2024; border: 1px solid #2a2b30; border-radius: 6px; padding: 10px 12px; }
+.card-label { color: #9a9b9f; font-size: 12px; margin-bottom: 6px; }
+.card-value { font-size: 18px; font-weight: 600; color: #e8e8e8; }
+.table-wrap { flex: 1; overflow-y: auto; padding: 0 10px 10px; }
+#stat-table { width: 100%; border-collapse: collapse; font-size: 12px; }
+#stat-table th { position: sticky; top: 0; background: #1e2024; color: #9a9b9f; text-align: left; padding: 6px 8px; border-bottom: 1px solid #2a2b30; }
+#stat-table td { padding: 5px 8px; border-bottom: 1px solid #232428; }
+#chat-msgs { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
+.chat-bubble { max-width: 78%; padding: 8px 12px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
+.chat-bubble.user { align-self: flex-end; background: #2b4a75; }
+.chat-bubble.assistant { align-self: flex-start; background: #26282e; }
+.chat-bubble.sys { align-self: center; color: #7f848e; font-size: 12px; }
+#chat-input { border-top: 1px solid #2a2b30; padding: 8px 10px; }
+#chat-text { width: 100%; background: #1a1b1e; border: 1px solid #3a3b40; color: #d4d4d4; border-radius: 4px; padding: 6px 8px; font-size: 13px; font-family: inherit; resize: vertical; }
```

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "renderer: stats cards/table + chat tab (SSE via proxy) + round stats wiring (spec §7/§3)"
```

---

### Task 17: renderer — 轮次记录 tab（规格 §3 勾选项）+ 运行中切换 recordRounds

**Files:**
- Modify: `src/main/index.ts`（`form:save`：recordRounds 切换 → 重建 RecordsStore + `proxy.setRecords` 立即生效）
- Modify: `src/renderer/index.html`（记录 tab：状态栏/视图/分页器）
- Modify: `src/renderer/styles.css`（.rec 卡片样式）
- Modify: `src/renderer/main.ts`（loadRecords/renderRecord/分页 + 统计事件驱动自动刷新）

语义：每页 50 条（`recordsTail(page)`，page 0 = 最新，JSONL 尾部读取）；「← 更新 / 更早 →」翻页；每轮卡片 = 时间 / 模型 / TTFT + prompt / decode 两个 pre 块（textContent 注入，无 HTML 注入面）。未启用时显示提示（启用入口 = App 组「记录每轮 prompt/decode」复选框；主进程侧现在支持运行中切换：`form:save` 重建 store 并 `proxy.setRecords`，无需重启服务器）。记录事件驱动：`stats:round` 触发且记录 tab 在前台时自动重载当前页。boot payload 已含 `recordsDir`（本任务接入展示）。

提交：`18df377`（4 files, +105/-2），typecheck 干净，123/123 测试通过。

- [ ] **Step 1-4: 实现（见提交 diff）**

```diff
diff --git a/src/main/index.ts b/src/main/index.ts
index f173452..fc24db0 100644
--- a/src/main/index.ts
+++ b/src/main/index.ts
@@ -220,6 +220,10 @@ function registerIpc(): void {
     const prev = config.getSettings().form;
     config.saveSettings({ form });
     if (proxy) proxy.setForm({ ...form }); // CORS 等立即生效
+    if (form.recordRounds !== prev.recordRounds) {
+      records = form.recordRounds ? new RecordsStore(recordsDir, { maxTotalBytes: form.recordsMaxTotalBytes }) : null;
+      if (proxy) proxy.setRecords(records); // 运行中切换立即生效
+    }
     if (form.autoSwitch !== prev.autoSwitch || form.hfCacheDir !== prev.hfCacheDir || form.scanDir !== prev.scanDir) {
       await refreshUnion();
     }
diff --git a/src/renderer/index.html b/src/renderer/index.html
index 36cc4ae..890bf5d 100644
--- a/src/renderer/index.html
+++ b/src/renderer/index.html
@@ -77,7 +77,17 @@
         </div>
       </div>
       <div id="tab-records" class="tab hidden">
-        <div class="placeholder">轮次记录（Task 17）</div>
+        <div id="records-bar">
+          <span id="records-state">…</span>
+          <span id="records-dir"></span>
+          <button id="records-refresh">刷新</button>
+        </div>
+        <div id="records-view"></div>
+        <div id="records-pager">
+          <button id="records-prev">← 更新</button>
+          <span id="records-page">第 0 页</span>
+          <button id="records-next">更早 →</button>
+        </div>
       </div>
     </div>
   </div>
diff --git a/src/renderer/main.ts b/src/renderer/main.ts
index 78df373..e947c2d 100644
--- a/src/renderer/main.ts
+++ b/src/renderer/main.ts
@@ -1,6 +1,6 @@
 // renderer/main.ts — 主 UI（规格 §3：顶栏 / 左栏设置 / 右栏 tabs）；Task 16-17 填充统计/聊天/轮次记录
 import { ansiHtml } from './ansi.js';
-import type { FormValues, ModelRef, ServerState, Profile, RoundStats, UpdateProgress, InstalledVersion } from '../shared/types.js';
+import type { FormValues, ModelRef, ServerState, Profile, RoundRecord, RoundStats, UpdateProgress, InstalledVersion } from '../shared/types.js';
 
 interface BootState {
   appRoot: string;
@@ -10,6 +10,7 @@ interface BootState {
   installed: InstalledVersion[];
   banner: { version: string | null; update: string | null };
   stats: { latest: RoundStats | null; history: RoundStats[] };
+  recordsDir: string;
 }
 
 interface ExitInfo { code: number | null; early: boolean; stderr: string; intentional: boolean }
@@ -29,6 +30,8 @@ declare global {
       checkUpdate(): Promise<{ latest: { tag_name: string; assets: unknown[] } | null; installed: InstalledVersion[] }>;
       runUpdate(tag: string): Promise<{ ok: boolean; error?: string }>;
       openDirDialog(defaultPath?: string): Promise<string | null>;
+      recordFiles(): Promise<string[]>;
+      recordsTail(page: number): Promise<{ records: RoundRecord[]; hasMore: boolean }>;
       on(channel: string, cb: (payload: unknown) => void): () => void;
     };
   }
@@ -127,6 +130,10 @@ let union: ModelRef[] = [];
 let installed: InstalledVersion[] = [];
 let latestTag: string | null = null;
 let serverState: ServerState = { status: 'stopped', port: null, model: null, exitCode: null };
+let activeTab = 'logs';
+let recordsDir = '';
+let recPage = 0;
+let recHasMore = false;
 let saveTimer: ReturnType<typeof setTimeout> | null = null;
 
 const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
@@ -533,6 +540,70 @@ async function chatSend(): Promise<void> {
   }
 }
 
+// ---------- 轮次记录（规格 §3 勾选项） ----------
+async function loadRecords(): Promise<void> {
+  const box = $<HTMLDivElement>('records-view');
+  const state = $<HTMLSpanElement>('records-state');
+  const dirEl = $<HTMLSpanElement>('records-dir');
+  box.textContent = '';
+  dirEl.textContent = recordsDir !== '' ? `目录: ${recordsDir}` : '';
+  if (!form || !form.recordRounds) {
+    state.textContent = '未启用（App 组勾选「记录每轮 prompt/decode」；运行中切换立即生效）';
+    const d = document.createElement('div');
+    d.className = 'placeholder';
+    d.textContent = '启用后，每一轮请求的 prompt 与 decode 内容将记录在本地（JSONL 分文件，总量受 App 组上限约束）';
+    box.appendChild(d);
+    $<HTMLButtonElement>('records-prev').disabled = true;
+    $<HTMLButtonElement>('records-next').disabled = true;
+    return;
+  }
+  state.textContent = '已启用';
+  const files = await window.llama.recordFiles();
+  dirEl.textContent = files.length > 0 ? `${files.length} 个记录文件` : '（暂无记录）';
+  const page = await window.llama.recordsTail(recPage);
+  recHasMore = page.hasMore;
+  for (const r of page.records) box.appendChild(renderRecord(r));
+  if (page.records.length === 0) {
+    const d = document.createElement('div');
+    d.className = 'placeholder';
+    d.textContent = '（本页无记录）';
+    box.appendChild(d);
+  }
+  $<HTMLDivElement>('records-view').scrollTop = 0;
+  $<HTMLSpanElement>('records-page').textContent = `第 ${recPage} 页（每页 50，第 0 页最新）`;
+  $<HTMLButtonElement>('records-prev').disabled = recPage === 0;
+  $<HTMLButtonElement>('records-next').disabled = !recHasMore;
+}
+
+function renderRecord(r: RoundRecord): HTMLElement {
+  const d = document.createElement('div');
+  d.className = 'rec';
+  const head = document.createElement('div');
+  head.className = 'rec-head';
+  head.innerHTML = `<span><b>${new Date(r.ts).toLocaleString()}</b></span>`;
+  const mEl = document.createElement('span');
+  mEl.textContent = `模型: ${r.model}`;
+  head.appendChild(mEl);
+  if (r.ttft_ms !== null) {
+    const t = document.createElement('span');
+    t.textContent = `TTFT: ${r.ttft_ms} ms`;
+    head.appendChild(t);
+  }
+  d.appendChild(head);
+  const mk = (lbl: string, text: string): void => {
+    const l = document.createElement('div');
+    l.className = 'lbl';
+    l.textContent = lbl;
+    d.appendChild(l);
+    const pre = document.createElement('pre');
+    pre.textContent = text === '' ? '（空）' : text;
+    d.appendChild(pre);
+  };
+  mk('prompt', r.prompt);
+  mk('decode', r.decode);
+  return d;
+}
+
 // ---------- 事件订阅 ----------
 function subscribeEvents(): void {
   window.llama.on('state:change', (p) => renderState(p as ServerState));
@@ -545,6 +616,7 @@ function subscribeEvents(): void {
   window.llama.on('stats:round', (p) => {
     const s = p as { latest: RoundStats | null; history: RoundStats[] };
     renderStats(s.latest, s.history);
+    if (activeTab === 'records' && form?.recordRounds) void loadRecords();
   });
   window.llama.on('update:progress', (p) => {
     const u = p as UpdateProgress;
@@ -587,6 +659,9 @@ function wireButtons(): void {
   $<HTMLButtonElement>('btn-log-clear').addEventListener('click', () => {
     $<HTMLDivElement>('log-view').textContent = '';
   });
+  $<HTMLButtonElement>('records-refresh').addEventListener('click', () => void loadRecords());
+  $<HTMLButtonElement>('records-prev').addEventListener('click', () => { recPage = Math.max(0, recPage - 1); void loadRecords(); });
+  $<HTMLButtonElement>('records-next').addEventListener('click', () => { if (recHasMore) { recPage += 1; void loadRecords(); } });
   $<HTMLButtonElement>('chat-send').addEventListener('click', () => void chatSend());
   $<HTMLButtonElement>('chat-clear').addEventListener('click', () => {
     chatHistory.length = 0;
@@ -601,9 +676,11 @@ function wireButtons(): void {
       for (const x of Array.from(tabs)) x.classList.remove('active');
       t.classList.add('active');
       const name = t.getAttribute('data-tab') ?? 'logs';
+      activeTab = name;
       for (const tab of Array.from(document.querySelectorAll('.tab'))) {
         tab.classList.toggle('hidden', `tab-${name}` !== tab.id);
       }
+      if (name === 'records') void loadRecords();
     });
   }
   $<HTMLButtonElement>('btn-profile-apply').addEventListener('click', async () => {
@@ -652,6 +729,7 @@ async function main(): Promise<void> {
   const s = await window.llama.boot();
   form = s.form;
   union = s.union;
+  recordsDir = s.recordsDir;
   installed = s.installed;
   populateForm();
   buildModelSelect(s.server.model);
diff --git a/src/renderer/styles.css b/src/renderer/styles.css
index 5c2b1f4..0d3fc46 100644
--- a/src/renderer/styles.css
+++ b/src/renderer/styles.css
@@ -58,3 +58,14 @@ summary { cursor: pointer; padding: 4px 8px; background: #2a2b31; border-radius:
 .chat-bubble.sys { align-self: center; color: #7f848e; font-size: 12px; }
 #chat-input { border-top: 1px solid #2a2b30; padding: 8px 10px; }
 #chat-text { width: 100%; background: #1a1b1e; border: 1px solid #3a3b40; color: #d4d4d4; border-radius: 4px; padding: 6px 8px; font-size: 13px; font-family: inherit; resize: vertical; }
+#records-bar { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-bottom: 1px solid #2a2b30; color: #9a9b9f; font-size: 12px; }
+#records-bar button { margin-left: auto; padding: 3px 10px; }
+#records-view { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
+.rec { background: #1e2024; border: 1px solid #2a2b30; border-radius: 6px; padding: 8px 10px; }
+.rec-head { display: flex; gap: 12px; color: #9a9b9f; font-size: 12px; margin-bottom: 6px; flex-wrap: wrap; }
+.rec-head b { color: #d4d4d4; font-weight: 600; }
+.rec pre { background: #17181b; border-radius: 4px; padding: 6px 8px; white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow-y: auto; font-size: 12px; margin: 4px 0; }
+.rec .lbl { color: #7f848e; font-size: 11px; }
+#records-pager { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-top: 1px solid #2a2b30; color: #9a9b9f; font-size: 12px; }
+#records-pager button { padding: 3px 10px; }
+#records-pager button:disabled { opacity: .4; }
```

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "renderer: records tab (pagination/refresh) + live recordRounds toggle (spec §3)"
```

---

### Task 18: 打包 — electron-builder dir → 便携 zip（规格 §9.2，计划偏差 2）

**Files:**
- Modify: `electron-builder.yml`（Task 1 已建，本任务验证：dir target、output=release、files=dist/**+package.json）
- Create: `scripts/zip-release.mjs`（dir 产物 → 便携 zip）
- Modify: `package.json`（+ electron-builder devDep、+ author；`package` 脚本 = build → electron-builder --win dir → zip-release.mjs）

流程：`npm run build`（tsc×2 + copy-assets）→ `electron-builder --win dir`（下载 electron 43.4.0 win32-x64 → `release/win-unpacked/`，app.asar 含 dist/{main,preload,renderer} + node_modules/adm-zip + package.json）→ `zip-release.mjs`：校验 `llama-launcher.exe` 存在 → 目录重命名为 `llama-launcher/`（被占用则保持原名）→ 优先 `tar -a`（流式）失败回退 adm-zip → `release/llama-launcher-<version>-portable-win32-x64.zip`。

环境注意（本机实测）：GitHub 资产直连超时（20.205.243.x ETIMEDOUT），electron 运行时经 npmmirror 下载：
`ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/ npm run package`。

冒烟验证（实测）：
- 打包产物：`release/llama-launcher-0.1.0-portable-win32-x64.zip`（140.8 MB，根目录 `llama-launcher/`，exe 225.5 MB + resources/app.asar 268 KB + locales/paks 齐全）。
- 启动冒烟：`llama-launcher.exe --enable-logging` 运行 15s 无渲染层报错，窗口标题「llama-server 启动器」正常（Electron 4 进程组）。
- 冒烟发现并修复 1 个 bug：`buildExeField()` 在 select 未入 DOM 时即调用 `fillExeOptions()` → `Cannot set properties of null`；移除该早期调用（`populateForm` 已在 boot 后调用）。
- asar 内容核验（手工解析 asar 头）：dist/main 14 模块 + dist/preload/index.js + dist/renderer/{ansi.js,index.html,main.js,styles.css} + adm-zip 17 文件 + package.json，共 39 条目。

提交：`1a81271`（4 files，+3628/-215；package-lock 含 electron-builder 依赖树），typecheck 干净，14 套件 123/123 测试通过。

- [ ] **Step 1: electron-builder.yml（已存在，验证）**

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

- [ ] **Step 2: scripts/zip-release.mjs**

```js
// scripts/zip-release.mjs — Task 18：electron-builder dir 产物 → 便携 zip（规格 §9.2，计划偏差 2）
// 用法：npm run package（build → electron-builder --win dir → 本脚本）
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, rm, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const releaseDir = path.join(root, 'release');

const entries = await readdir(releaseDir, { withFileTypes: true });
const folder = entries.find((e) => e.isDirectory() && (e.name === 'win-unpacked' || /-win32-x64$/.test(e.name)));
if (!folder) {
  console.error('[zip-release] 未找到 electron-builder dir 产物（release/win-unpacked 或 release/*-win32-x64/）');
  process.exit(1);
}
let src = path.join(releaseDir, folder.name);
const exe = path.join(src, 'llama-launcher.exe');
if (!(await stat(exe).then(() => true, () => false))) {
  console.error('[zip-release] 产物缺少 llama-launcher.exe：' + exe);
  process.exit(1);
}

// 产物目录重命名为 llama-launcher/（zip 根目录更直观）；被占用时保持原名
let zipRoot = folder.name;
const pretty = path.join(releaseDir, 'llama-launcher');
if (folder.name !== 'llama-launcher') {
  await rm(pretty, { recursive: true, force: true });
  try {
    await (await import('node:fs/promises')).rename(src, pretty);
    src = pretty;
    zipRoot = 'llama-launcher';
  } catch { /* 目录被占用（例如正在运行）→ 保持原名 */ }
}

const zipName = 'llama-launcher-' + pkg.version + '-portable-win32-x64.zip';
const zipPath = path.join(releaseDir, zipName);
await rm(zipPath, { force: true });

// 优先 Windows 10+ 自带 bsdtar（流式、低内存）；失败回退 adm-zip
let used = 'tar';
try {
  await execFileAsync('tar', ['-a', '-c', '-f', zipPath, '-C', releaseDir, zipRoot], { maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  used = 'adm-zip';
  await rm(zipPath, { force: true });
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip();
  zip.addLocalFolder(src, zipRoot);
  zip.writeZip(zipPath);
}

const z = await stat(zipPath);
const mb = (n) => (n / 1048576).toFixed(1);
console.log('[zip-release] ' + zipName + '（' + mb(z.size) + ' MB，' + used + '）根目录 ' + zipRoot + '/');
console.log('[zip-release] 解压即用：llama.cpp 托管目录位于 ' + zipRoot + '/llama.cpp/（首次启动时自动创建）');
```

- [ ] **Step 3: 安装 electron-builder + 打包 + 冒烟**

运行：`npm i -D electron-builder@^26 && ELECTRON_MIRROR=... npm run package`（镜像见上）→ 启动冒烟 → 修复 exe-select 时序 bug → 重新打包。
预期：zip 生成（~141 MB）、app 窗口正常启动无报错。

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "package: electron-builder dir + portable zip script; fix exe-select populate timing (spec §9.2)"
```

## 完成（全部 18 任务）

- 14 测试套件 / 123 测试全绿；typecheck + build + package 通过。
- 便携 zip：`release/llama-launcher-0.1.0-portable-win32-x64.zip`（140.8 MB，解压即用，冒烟通过）。
- 全部提交已推送 origin/main（github.com:lamboJw/llama-launcher）。

### 交付后修正（2026-08-20，均已推送）

- **模型下拉实时刷新**：主进程重扫后新增 `models:changed` 事件，渲染层即时重建下拉并保留选中（此前需重启才生效）。
- **设置自动保存可见化**：改设置 600ms 防抖自动保存（本就不需要手动存），新增「设置已自动保存 HH:MM:SS」提示；「保存」按钮更名「保存参数组」并给出明确引导文案（顶部选模型后才可存参数组）。
- **HF 缓存扫描取消 autoSwitch 门槛（偏差）**：原实现 `autoSwitch && hfCacheDir` 才扫 HF 缓存，导致只填路径不勾选时看不到缓存模型。现改为设置 hfCacheDir 即扫描（纯本地磁盘操作）；autoSwitch 语义不变——仍只控制代理按 API 请求的 model 字段自动切换（proxy.ts）。
- **自定义 exe 自动注入托管 CUDA 目录**：`StartRequest.fallbackCudaDirs`（尽力而为，缺失不报错）；`findManagedCudaDirs` 扫描 `llama.cpp/cuda/cuda-*` 中含 cudart64_*.dll 的目录（版本降序全部注入）。
- **CUDA 目录 spawn 前预检 + cwd 双保险**：`checkCudaDir` 对托管 CUDA 目录严格校验（缺失/无 cudart → 中文报错，不再弹系统对话框）；实测确认 Windows 上 PATH 前置注入与 cwd 均能解析 cudart（`--list-devices` 场景 A/B/C）。
- **zip-release 抗锁**：`release/llama-launcher/` 被运行中实例占用时不再崩溃（rename/rm 容错，回退 adm-zip 在 zip 内重根）。
- **HF 快照回退（refs 与快照目录不匹配）**：实测用户缓存 `H:\models` 中 `unsloth/Qwen3.8-27B-GGUF` 的 `refs/main` 指向 `f1bfb127…` 而 `snapshots/` 实际目录为 `fe1e2a23…`（refs 更新但快照未同步），原实现严格要求 `snapshots/<refs提交>/` 存在导致该模型被跳过。现回退：refs 解析失败时扫描 `snapshots/` 下任意含 .gguf 的子目录；连带行为变化——refs 无效但快照含真实 gguf 的仓库（如 BadRef fixture）也会被列出（原测试期望已同步更新）。另：HF 扫描不再依赖 autoSwitch（见上一条）。
- **参数组装对齐 b10488 真实 CLI（偏差，用户报告 --fit 吞参 bug 后全量审计）**：对照 b10488 --help 审计全部参数，实测 5 个 --no-* 变体均为 invalid argument。修复：
  - --fit [on|off] 必须带值、无 --no-fit → fit 由复选框改为三态下拉（默认(不传)/on/off），旧配置布尔迁移 true→'on'/false→'off'；
  - --swa-full / --ignore-eos / --spec-default 为纯开关（无 --no- 变体）→ 新增 onFlag() 助手：勾选才传 flag，未勾选不传（原 bool() 会输出非法 --no-*）；
  - --cache-reuse N 必须带数字 → cacheReuse 由复选框改为文本框，旧配置布尔迁移置空（=off，llama 默认 0）；
  - bool() 保留用于成对存在且已逐一验证的参数：mmproj-auto、mmproj-offload、jinja、ui、warmup、context-shift、perf、reasoning-preserve、spec-draft-backend-sampling。
- **GPU 参数扩充**：splitMode 选项补 tensor；新增 tensorSplit → --tensor-split（每 GPU 分配比例，如 50,50）。
- **MTP draft KV 量化**：新增 specDraftTypeK / specDraftTypeV → --spec-draft-type-k/v（允许 f32/f16/bf16/q8_0/q4_0/q4_1/iq4_nl/q5_0/q5_1，llama 默认 f16）。
- **配置/档案迁移机制**：config.ts 导出 migrateForm()（AppConfig 构造时迁移并写回落盘配置）；profiles.ts load/list 时对旧档案 params 执行 migrateForm（旧布尔 fit/cacheReuse 不会污染新 UI）。
- **mmproj offload 行为确认（无代码改动）**：恒显式输出——勾选 --mmproj-offload（mmproj 放 GPU），不勾选 --no-mmproj-offload（mmproj 放 CPU 内存）；两参数在 b10488 均存在。--fit 修复前默认表单每次启动必崩（fit=true → 裸 --fit 吞下一个参数），本次审计一并排掉后续 4 个同类雷。test/args.test.ts 新增 7 项（fit 带值/吞参回归/纯开关/cacheReuse 数字/tensor-split/draft-type-kv）、test/config.test.ts +3（migrateForm）、test/profiles.test.ts +1（旧档案迁移），14 套件 138 测试全绿。--no-swa-full 等 5 个非法变体已实证（error: invalid argument）并纳入回归断言。release/llama-launcher/ 被运行中实例占用时改走 staging 输出 + adm-zip 重打包（asar 已验证含新参数）。
- **specType/flashAttn 枚举值对齐 b10488（用户报告 --spec-type mtp 报错）**：specType 下拉原选项 mtp/draft 均非 b10488 合法值（合法：none,draft-simple,draft-eagle3,draft-mtp,draft-dflash,draft-dspark,ngram-simple,ngram-map-k,ngram-map-k4v,ngram-mod,ngram-cache），选了就启动崩。现下拉列出全部合法值（MTP 选 draft-mtp，草稿模型选 draft-simple）；migrateForm 迁移旧值 mtp→draft-mtp、draft→draft-simple。flash-attn 顺带从 0/1 改为文档枚举 on/off/auto（0/1 实测被强转接受，语义不变，补 auto 选项），迁移 1→on、0→off。verbosity 0/1/2 实测合法，不变。test/config.test.ts +2（specType/flashAttn 迁移），14 套件 140 测试全绿。
- **verbosity 下拉补全 0-5（用户指出）**：b10488 help 实测 0=generic output、1=error、2=warning、3=info（默认）、4=trace、5=debug，`--verbosity 5` 接受。下拉原只到 2，现列全 0-5 并带级别名（默认项标注 3=INFO）。test/args.test.ts +1，141 测试全绿。
- **HF 缓存模型改传本地快照路径（用户报告 Qwen3.8 启动 failed to load model ''）**：llama.cpp 的 `--hf-repo --offline` 解析严格要求 `snapshots/<refs提交>/` 存在；用户缓存中 Qwen3.8 的 refs/main 指向 `f1bfb127…` 而实际快照目录为 `fe1e2a23…`（refs 更新快照未同步，与本扫描器的回退问题同源）→ 服务端得到空本地路径 → `exactly one out metadata, path_model, and file must be defined`。现：`scanHfCache` 为每个仓库解析 `HfModel.localPath`（按默认量化选具体 gguf，与 llama.cpp repo:QUANT 语义一致；无量化识别 → 第一个 gguf；mmproj 不参与），`buildArgs` HF 分支有 localPath 时改传 `--model <localPath>`（不再 `--hf-repo/--offline/HF_HUB_CACHE`）；`startServer` 启动前校验 localPath 存在性，缺失/被删 → 重新扫描刷新。实测：真实 llama-server 用解析出的 Qwen3.8 快照路径成功加载模型文件（tensor 解析通过）。
- **启动日志附完整命令行（用户要求）**：`ServerController.start` 在 spawn 前输出 `[launcher] 命令行：<exe> <全部参数>`（含空白/引号的参数加双引号转义），UI 日志区可见。
test/hf-cache.test.ts +2 断言、test/args.test.ts +1、test/server-controller.test.ts +1，14 套件 143 测试全绿。
