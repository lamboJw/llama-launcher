# Slot 上下文自动保存 / 恢复 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 停止 / 退出 / 模型切换前自动保存全部 slot 的 KV 缓存（文件名 `<模型名>_<slotId>.bin`），启动后若存在当前模型存档则自动恢复到对应 slot，顶栏显示阶段状态并置灰按钮。

**Architecture:** 新纯 Node 模块 `src/main/slot-cache.ts`（文件名工具 + SlotCache HTTP 客户端，用 `test/fake-server.mjs` 真实 spawn 单测）；`ServerController` 注入 SlotCache —— stop() 先 save 后 kill、start() 健康检查通过后 restore（状态仍为 starting，代理未起无并发）；`index.ts` 按 `form.slotSavePath` 门控启用并拦截关窗；渲染端经 `slot:phase` 事件显示顶栏状态。

**Tech Stack:** Electron + TypeScript（strict）+ vitest（`npm run test` / `npm run typecheck`）

**规格:** `docs/superpowers/specs/2026-08-30-slot-cache-design.md`

**背景（给零上下文工程师）:** 本应用是 llama-server 的桌面启动器：主进程 spawn llama-server 绑定 127.0.0.1 内部随机端口，另起一个反向代理监听用户可见端口。单测不依赖 Electron：`test/fake-server.mjs` 是一个 Node http server 测试替身，测试里用 `process.execPath`（node 二进制）spawn 它充当 llama-server，通过 `FAKE_PORT` 等环境变量配置行为。llama-server（b10636 级别构建起）提供 slots API：`POST /slots/{id}?action=save|restore` + JSON body `{"filename": ...}`，文件落在 `--slot-save-path` 目录；本功能把「保存全部 slot / 恢复当前模型存档」自动化。

## Global Constraints

- 存档文件后缀 `.bin`（用户指定）；文件名 `<sanitize(模型名)>_<slotId>.bin`，sanitize 规则：`\/:*?"<>|` → `_`，去尾部点号与空白，净化后为空 → `model`
- API 格式：`GET /slots`；`POST /slots/<id>?action=save|restore`，`Content-Type: application/json`，body `{"filename": "<basename>"}`；action 走 query 参数
- `form.slotSavePath` 原样使用（不自动设默认目录）；**为空 = 功能禁用**：无 HTTP 调用、无关窗拦截、无状态显示
- 单请求超时默认 10 分钟（AbortController）；`apiKey` 非空时请求带 `Authorization: Bearer <apiKey>`
- save / restore 失败**只记日志，绝不阻塞停止 / 启动**
- 日志行统一 `[launcher]` 前缀，中文文案（沿用现有风格）
- slots action API 需 llama.cpp b10636 级别构建；旧版本 / 未开 `--slots` → 404 → 记日志跳过，不报错
- 新模块必须纯 Node（无 Electron import），才能用 fake-server.mjs 单测
- TypeScript strict（tsconfig `strict: true`）；每任务结束 commit（中文 message，`feat:`/`test:` 前缀）

## 文件结构

| 文件 | 责任 |
|---|---|
| `src/main/slot-cache.ts`（新建） | 文件名工具（sanitizeModelName / slotFileName / findSlotSaves）+ SlotCache HTTP 客户端（listSlots / saveAll / restoreAll）；纯 Node |
| `test/fake-server.mjs`（改） | 新增 `/slots` 端点；env：`FAKE_SLOTS_N`（默认 2）、`FAKE_SLOT_DIR`（标记文件目录）、`FAKE_SLOT_FAIL=1`（500）、`FAKE_REQ_LOG`（请求日志） |
| `test/slot-cache.test.ts`（新建） | 文件名工具 + SlotCache 单测（真实 spawn fake-server） |
| `src/main/server-controller.ts`（改） | `setSlotCache` 注入；stop() 先 save 后 kill；start() 健康检查后 restore；`onSlotPhase` 事件 |
| `test/server-controller.test.ts`（改） | 保存先于 kill / 恢复触发 / 失败不阻塞 / 禁用无请求 |
| `src/main/index.ts`（改） | startServer 按 slotSavePath 启用；关窗拦截状态机；onSlotPhase → `send('slot:phase')` |
| `src/shared/types.ts`（改） | `SlotPhaseEvent` 接口 |
| `src/preload/index.ts`（改） | EVENTS 白名单加 `'slot:phase'` |
| `src/renderer/main.ts`（改） | 顶栏 badge 阶段显示（1s 计时）+ 按钮置灰 + slotSavePath 标签说明 |

---

### Task 1: 文件名工具（sanitizeModelName / slotFileName / findSlotSaves）

**Files:**
- Create: `src/main/slot-cache.ts`
- Test: `test/slot-cache.test.ts`

**Interfaces:**
- Produces（Task 2 的 SlotCache 类与 Task 3 的恢复检查依赖）:
  - `sanitizeModelName(name: string): string`
  - `slotFileName(model: string, slotId: number): string` → `<净化名>_<slotId>.bin`
  - `findSlotSaves(dir: string, model: string): Map<number, string>`（slotId → 绝对路径；目录不存在 → 空 Map）

- [ ] **Step 1: 写失败测试**

创建 `test/slot-cache.test.ts`：

```ts
// slot-cache.test.ts — slot 上下文保存/恢复（设计规格 §1/§6）
// 测试替身：fake-server.mjs（真实 spawn，node 二进制充当 llama-server）
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sanitizeModelName, slotFileName, findSlotSaves } from '../src/main/slot-cache.js';

describe('sanitizeModelName', () => {
  it('Windows 非法字符替换为 _', () => {
    expect(sanitizeModelName('a/b:c*d?e"f<g>h|i')).toBe('a_b_c_d_e_f_g_h_i');
  });

  it('去尾部点号与空白', () => {
    expect(sanitizeModelName('model. ')).toBe('model');
    expect(sanitizeModelName('model...')).toBe('model');
  });

  it('净化后为空 → model', () => {
    expect(sanitizeModelName('')).toBe('model');
    // 仅替换非法字符（空白不在其中）；'///' → '___' 非空，不触发回退
    expect(sanitizeModelName('///')).toBe('___');
  });

  it('点保留（HF repo 名含 .）', () => {
    expect(sanitizeModelName('unsloth/Qwen3.8-27B-GGUF')).toBe('unsloth_Qwen3.8-27B-GGUF');
  });
});

describe('slotFileName', () => {
  it('<净化名>_<slotId>.bin', () => {
    expect(slotFileName('unsloth/Qwen3.8-27B-GGUF', 0)).toBe('unsloth_Qwen3.8-27B-GGUF_0.bin');
    // 空白是合法文件名字符，不替换
    expect(slotFileName('my model', 3)).toBe('my model_3.bin');
  });
});

describe('findSlotSaves', () => {
  it('匹配 <净化名>_<id>.bin；无关文件忽略', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-saves-'));
    try {
      fs.writeFileSync(path.join(dir, 'm_0.bin'), 'x');
      fs.writeFileSync(path.join(dir, 'm_1.bin'), 'x');
      fs.writeFileSync(path.join(dir, 'm_2.txt'), 'x');      // 后缀错
      fs.writeFileSync(path.join(dir, 'other_0.bin'), 'x');  // 模型名不同
      fs.writeFileSync(path.join(dir, 'm_.bin'), 'x');       // 无 id
      fs.writeFileSync(path.join(dir, 'm_-1.bin'), 'x');     // 负数
      const m = findSlotSaves(dir, 'm');
      expect([...m.keys()].sort((a, b) => a - b)).toEqual([0, 1]);
      expect(m.get(0)).toBe(path.join(dir, 'm_0.bin'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('目录不存在 → 空 Map', () => {
    expect(findSlotSaves(path.join(os.tmpdir(), 'no-such-dir-xyz-123'), 'm').size).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/slot-cache.test.ts`
Expected: FAIL（整个文件加载失败：`Failed to resolve import "../src/main/slot-cache.js"` — 模块不存在）

- [ ] **Step 3: 实现**

创建 `src/main/slot-cache.ts`：

```ts
// slot-cache.ts — llama-server slots API 的 slot 上下文（KV 缓存）保存 / 恢复
// 设计规格：docs/superpowers/specs/2026-08-30-slot-cache-design.md §1
// 纯 Node（无 Electron 依赖），fake-server.mjs 可单测
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Windows 非法字符替换为 _；去尾部点号与空白；净化后为空 → 'model' */
export function sanitizeModelName(name: string): string {
  const s = name.replace(/[\/:*?"<>|]/g, '_').replace(/[.\s]+$/, '');
  return s === '' ? 'model' : s;
}

/** 存档文件名：<净化名>_<slotId>.bin */
export function slotFileName(model: string, slotId: number): string {
  return `${sanitizeModelName(model)}_${slotId}.bin`;
}

/** 扫描 dir 下 <净化名>_<id>.bin（id 为非负整数）→ Map(slotId → 绝对路径)；目录不存在 → 空 Map */
export function findSlotSaves(dir: string, model: string): Map<number, string> {
  const map = new Map<number, string>();
  let files: string[] = [];
  try { files = fs.readdirSync(dir); } catch { return map; }
  const prefix = `${sanitizeModelName(model)}_`;
  for (const f of files) {
    if (!f.startsWith(prefix)) continue;
    const m = /^(\d+)\.bin$/.exec(f.slice(prefix.length));
    if (!m) continue;
    const id = Number(m[1]);
    if (!Number.isSafeInteger(id)) continue;
    map.set(id, path.join(dir, f));
  }
  return map;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/slot-cache.test.ts`
Expected: PASS（7 个测试全过）

- [ ] **Step 5: Commit**

```bash
git add src/main/slot-cache.ts test/slot-cache.test.ts
git commit -m "feat: slot 存档文件名工具（sanitize/slotFileName/findSlotSaves）"
```

---

### Task 2: fake-server slots 端点 + SlotCache 类

**Files:**
- Modify: `test/fake-server.mjs`（新增 /slots 端点）
- Modify: `src/main/slot-cache.ts`（追加 SlotCache 类）
- Test: `test/slot-cache.test.ts`（追加 SlotCache describe 块）

**Interfaces:**
- Consumes: Task 1 的 `slotFileName` / `findSlotSaves`
- Produces（Task 3 的 ServerController 与其测试依赖）:
  - `interface SlotCacheOpts { dir: string; apiKey?: string; timeoutMs?: number; onLog?: (line: string) => void }`
  - `class SlotCache { readonly dir: string; constructor(opts: SlotCacheOpts); listSlots(port: number): Promise<number[]>; saveAll(port: number, model: string): Promise<void>; restoreAll(port: number, model: string): Promise<void> }`
  - saveAll：单 slot 失败记日志继续，**全部失败抛错**；listSlots 失败（404 等）→ 记日志跳过（不抛）
  - restoreAll：仅恢复当前 server 存在的 slot，缺失跳过记日志；无存档 → 无操作；尝试过的全部失败 → 抛错
  - fake-server 新 env：`FAKE_SLOTS_N`（默认 2）、`FAKE_SLOT_DIR`、`FAKE_SLOT_FAIL=1`、`FAKE_REQ_LOG`

- [ ] **Step 1: 扩展 fake-server.mjs**

`test/fake-server.mjs` 头部注释与 import 改为：

```js
// fake-server.mjs — 测试替身：模拟 llama-server 的 /health、SSE、崩溃与 SIGTERM 行为
// 环境变量：FAKE_PORT、FAKE_HEALTH_DELAY_MS、FAKE_CRASH_MS、FAKE_CRASH_MSG、FAKE_IGNORE_SIGTERM
// slots API（设计规格 §6）：FAKE_SLOTS_N（默认 2）、FAKE_SLOT_DIR（标记文件目录）、
// FAKE_SLOT_FAIL=1（save/restore → 500）、FAKE_REQ_LOG（每请求追加一行 "METHOD url"）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
```

`const port = Number(process.env.FAKE_PORT || '59900');` 行之后新增：

```js
const slotsN = Number(process.env.FAKE_SLOTS_N || '2');
const slotIds = Array.from({ length: slotsN }, (_, i) => i);
```

`http.createServer` 回调第一行（`if (req.url === '/health')` 之前）插入请求日志：

```js
  if (process.env.FAKE_REQ_LOG) fs.appendFileSync(process.env.FAKE_REQ_LOG, `${req.method} ${req.url}\n`);
```

`/v1/chat/completions` 分支之后、兜底 `res.writeHead(404)` 之前插入：

```js
  if (req.url === '/slots') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ default: 0, slots: slotIds.map((id) => ({ id })) }));
    return;
  }
  const slotAction = /^\/slots\/(\d+)\?action=(save|restore)$/.exec(req.url);
  if (slotAction) {
    if (process.env.FAKE_SLOT_FAIL === '1') { res.writeHead(500); res.end('fake slot action failed'); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let filename = '';
      try { filename = JSON.parse(body).filename ?? ''; } catch { /* 非法 JSON → 按缺失处理 */ }
      if (typeof filename !== 'string' || filename === '') { res.writeHead(400); res.end('missing filename'); return; }
      if (process.env.FAKE_SLOT_DIR) {
        const marker = path.join(process.env.FAKE_SLOT_DIR, filename);
        if (slotAction[2] === 'save') {
          fs.mkdirSync(process.env.FAKE_SLOT_DIR, { recursive: true });
          fs.writeFileSync(marker, 'saved');
        } else if (!fs.existsSync(marker)) {
          res.writeHead(400); res.end('no such save'); return;
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
    });
    return;
  }
```

- [ ] **Step 2: 写失败测试**

`test/slot-cache.test.ts` 头部 import 改为：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { probeFreePort } from '../src/main/process-manager.js';
import { sanitizeModelName, slotFileName, findSlotSaves, SlotCache } from '../src/main/slot-cache.js';
```

文件末尾（`findSlotSaves` describe 之后）追加：

```ts
const FAKE = fileURLToPath(new URL('./fake-server.mjs', import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface FakeServer { port: number; stop: () => Promise<void> }

async function startFakeServer(env: Record<string, string> = {}): Promise<FakeServer> {
  const port = await probeFreePort();
  const proc: ChildProcess = spawn(process.execPath, [FAKE], {
    env: { ...process.env, FAKE_PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error('fake-server 启动超时')), 5000);
    proc.stdout?.on('data', (c: Buffer) => {
      out += c.toString();
      if (out.includes(`fake-server ready on ${port}`)) { clearTimeout(t); resolve(); }
    });
    proc.on('exit', (code) => { clearTimeout(t); reject(new Error(`fake-server 提前退出 code=${code}`)); });
  });
  return {
    port,
    stop: async () => {
      proc.kill();
      await sleep(300);
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      await sleep(100);
    },
  };
}

describe('SlotCache（fake-server 真实 spawn）', () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-cache-test-'));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('saveAll：2 slot → 2 个标记文件（名称正确）', async () => {
    const fake = await startFakeServer({ FAKE_SLOT_DIR: dir });
    try {
      const sc = new SlotCache({ dir, timeoutMs: 5000 });
      await sc.saveAll(fake.port, 'unsloth/Qwen3.8-27B-GGUF');
      expect(fs.existsSync(path.join(dir, 'unsloth_Qwen3.8-27B-GGUF_0.bin'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'unsloth_Qwen3.8-27B-GGUF_1.bin'))).toBe(true);
    } finally {
      await fake.stop();
    }
  });

  it('saveAll：FAKE_SLOT_FAIL → 抛错（全部失败）', async () => {
    const fake = await startFakeServer({ FAKE_SLOT_DIR: dir, FAKE_SLOT_FAIL: '1' });
    try {
      const sc = new SlotCache({ dir, timeoutMs: 5000 });
      await expect(sc.saveAll(fake.port, 'm')).rejects.toThrow(/全部 2 个 slot 保存失败/);
    } finally {
      await fake.stop();
    }
  });

  it('restoreAll：无存档 → 无请求', async () => {
    const reqLog = path.join(dir, 'reqlog-1.txt');
    fs.writeFileSync(reqLog, ''); // 预创建：无请求时 fake-server 不会建文件
    const fake = await startFakeServer({ FAKE_SLOT_DIR: dir, FAKE_REQ_LOG: reqLog });
    try {
      const sc = new SlotCache({ dir, timeoutMs: 5000 });
      await sc.restoreAll(fake.port, 'no-such-model');
      expect(fs.readFileSync(reqLog, 'utf8')).not.toContain('/slots');
    } finally {
      await fake.stop();
    }
  });

  it('restoreAll：有存档 → 成功（不抛错）', async () => {
    const fake = await startFakeServer({ FAKE_SLOT_DIR: dir });
    try {
      const sc = new SlotCache({ dir, timeoutMs: 5000 });
      await sc.saveAll(fake.port, 'restore-m');
      await sc.restoreAll(fake.port, 'restore-m');
    } finally {
      await fake.stop();
    }
  });

  it('restoreAll：slot 不存在的存档 → 跳过（无请求）', async () => {
    const reqLog = path.join(dir, 'reqlog-2.txt');
    const fake = await startFakeServer({ FAKE_SLOT_DIR: dir, FAKE_SLOTS_N: '1', FAKE_REQ_LOG: reqLog });
    try {
      fs.writeFileSync(path.join(dir, 'skip-m_0.bin'), 'x');
      fs.writeFileSync(path.join(dir, 'skip-m_1.bin'), 'x');
      const logs: string[] = [];
      const sc = new SlotCache({ dir, timeoutMs: 5000, onLog: (l) => logs.push(l) });
      await sc.restoreAll(fake.port, 'skip-m');
      const log = fs.readFileSync(reqLog, 'utf8');
      expect(log).toContain('/slots/0?action=restore');
      expect(log).not.toContain('/slots/1?action=restore');
      expect(logs.some((l) => l.includes('跳过 slot 1'))).toBe(true);
    } finally {
      await fake.stop();
    }
  });

  it('restoreAll：全部失败 → 抛错', async () => {
    const fake = await startFakeServer({ FAKE_SLOT_DIR: dir, FAKE_SLOT_FAIL: '1' });
    try {
      fs.writeFileSync(path.join(dir, 'fail-all_0.bin'), 'x');
      fs.writeFileSync(path.join(dir, 'fail-all_1.bin'), 'x');
      const sc = new SlotCache({ dir, timeoutMs: 5000 });
      await expect(sc.restoreAll(fake.port, 'fail-all')).rejects.toThrow(/全部 2 个 slot 恢复失败/);
    } finally {
      await fake.stop();
    }
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run test/slot-cache.test.ts`
Expected: FAIL（整个文件加载失败：`does not provide an export named 'SlotCache'`）

- [ ] **Step 4: 实现 SlotCache 类**

`src/main/slot-cache.ts` 末尾追加：

```ts
export interface SlotCacheOpts {
  dir: string;        // --slot-save-path 目录（非空）
  apiKey?: string;    // form.apiKey；非空时请求带 Authorization: Bearer
  timeoutMs?: number; // 单请求超时，默认 10 分钟
  onLog?: (line: string) => void;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // save 为同步阻塞，大上下文耗时长

export class SlotCache {
  readonly dir: string;
  private apiKey: string;
  private timeoutMs: number;
  private onLog: (line: string) => void;

  constructor(opts: SlotCacheOpts) {
    this.dir = opts.dir;
    this.apiKey = opts.apiKey ?? '';
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onLog = opts.onLog ?? (() => { /* 无日志回调 */ });
  }

  /** GET /slots → slot id 列表；404 / 错误 → 抛错（调用方记日志并跳过） */
  async listSlots(port: number): Promise<number[]> {
    const res = await this.http(`http://127.0.0.1:${port}/slots`);
    if (!res.ok) throw new Error(`GET /slots 失败：HTTP ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { slots?: { id?: unknown }[] };
    const ids: number[] = [];
    for (const s of data.slots ?? []) if (typeof s.id === 'number') ids.push(s.id);
    return ids;
  }

  /** 保存全部 slot：逐 slot save；单 slot 失败 → 记日志继续；全部失败 → 抛错 */
  async saveAll(port: number, model: string): Promise<void> {
    const t0 = Date.now();
    this.onLog(`[launcher] 保存 slot 上下文：模型「${model}」→ ${this.dir}`);
    let ids: number[];
    try {
      ids = await this.listSlots(port);
    } catch (e) {
      this.onLog(`[launcher] 读取 slot 列表失败（${String(e)}）→ 跳过保存`);
      return;
    }
    if (ids.length === 0) {
      this.onLog('[launcher] 无 slot 可保存');
      return;
    }
    let ok = 0;
    let totalBytes = 0;
    for (const id of ids) {
      const file = slotFileName(model, id);
      try {
        await this.action(port, id, 'save', file);
        ok++;
        this.onLog(`[launcher] 已保存 slot ${id} → ${file}`);
      } catch (e) {
        this.onLog(`[launcher] 保存 slot ${id} 失败：${String(e)}`);
        continue;
      }
      try { totalBytes += fs.statSync(path.join(this.dir, file)).size; } catch { /* 大小读取失败不影响汇总 */ }
    }
    if (ok === 0) throw new Error(`全部 ${ids.length} 个 slot 保存失败`);
    this.onLog(`[launcher] 保存完成：${ok}/${ids.length} 个文件，${totalBytes} 字节，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  /** 恢复全部：仅恢复当前 server 存在的 slot；slot 缺失跳过并记日志；无存档 → 无操作；尝试过的全部失败 → 抛错 */
  async restoreAll(port: number, model: string): Promise<void> {
    const saves = findSlotSaves(this.dir, model);
    if (saves.size === 0) {
      this.onLog(`[launcher] 无「${model}」的 slot 存档 → 跳过恢复`);
      return;
    }
    const t0 = Date.now();
    this.onLog(`[launcher] 恢复 slot 上下文：模型「${model}」，${saves.size} 个存档`);
    let ids: number[];
    try {
      ids = await this.listSlots(port);
    } catch (e) {
      this.onLog(`[launcher] 读取 slot 列表失败（${String(e)}）→ 跳过恢复`);
      return;
    }
    const live = new Set(ids);
    let ok = 0;
    let attempted = 0;
    let skipped = 0;
    for (const [id, file] of saves) {
      if (!live.has(id)) {
        skipped++;
        this.onLog(`[launcher] 跳过 slot ${id}：当前 server 无此 slot（存档 ${path.basename(file)}）`);
        continue;
      }
      attempted++;
      try {
        await this.action(port, id, 'restore', path.basename(file));
        ok++;
        this.onLog(`[launcher] 已恢复 slot ${id} ← ${path.basename(file)}`);
      } catch (e) {
        this.onLog(`[launcher] 恢复 slot ${id} 失败：${String(e)}`);
      }
    }
    if (attempted > 0 && ok === 0) throw new Error(`全部 ${attempted} 个 slot 恢复失败`);
    this.onLog(`[launcher] 恢复完成：${ok} 个成功，${skipped} 个跳过，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  /** POST /slots/<id>?action=save|restore，body {"filename": <basename>}；非 2xx → 抛错（含响应体） */
  private async action(port: number, id: number, action: 'save' | 'restore', filename: string): Promise<void> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey !== '') headers.authorization = `Bearer ${this.apiKey}`;
    const res = await this.http(`http://127.0.0.1:${port}/slots/${id}?action=${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ filename }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}${body !== '' ? `：${body}` : ''}`);
    }
  }

  /** fetch + 每请求 AbortController 超时（超时按失败处理） */
  private async http(url: string, init?: RequestInit): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } catch (e) {
      if (ctrl.signal.aborted) throw new Error(`请求超时（${this.timeoutMs}ms）：${url}`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run test/slot-cache.test.ts`
Expected: PASS（13 个测试全过）

- [ ] **Step 6: 全量测试 + typecheck**

Run: `npm run test` 和 `npm run typecheck`
Expected: 全部 PASS（fake-server 新增端点不影响既有测试）

- [ ] **Step 7: Commit**

```bash
git add test/fake-server.mjs src/main/slot-cache.ts test/slot-cache.test.ts
git commit -m "feat: SlotCache 类（save/restore 全部 slot）与 fake-server slots 端点"
```

---

### Task 3: ServerController 集成（stop 前保存 / start 后恢复）

**Files:**
- Modify: `src/main/server-controller.ts`（ControllerEvents、setSlotCache、start、stop）
- Test: `test/server-controller.test.ts`（追加 describe 块）

**Interfaces:**
- Consumes: Task 2 的 `SlotCache`（`dir` / `saveAll` / `restoreAll`）、Task 1 的 `findSlotSaves`
- Produces（Task 4 的 index.ts 依赖）:
  - `ControllerEvents.onSlotPhase?: (phase: 'saving' | 'restoring' | null, model: string | null) => void`
  - `ServerController.setSlotCache(sc: SlotCache | null): void`（null = 功能禁用，默认即 null）

- [ ] **Step 1: 写失败测试**

`test/server-controller.test.ts` 头部 import 加一行（`import { ServerController, type StartRequest } ...` 之后）：

```ts
import { SlotCache } from '../src/main/slot-cache.js';
```

文件末尾（最后一个 `});` 之后）追加：

```ts
describe('ServerController + slot cache（设计规格 §2）', () => {
  let dir: string;

  const reqSlot = (model: string, extra: Record<string, string> = {}): StartRequest => ({
    exe: process.execPath,
    form: { ...DEFAULT_FORM, extraArgs: '--fake-flag' },
    model: ref(model),
    cudaDir: null,
    extraEnv: (port: number) => ({ FAKE_PORT: String(port), FAKE_SLOT_DIR: dir, ...extra }),
    extraArgvPrefix: [FAKE],
  });

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-slot-cache-'));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stop 前保存：标记文件在进程退出前生成；onSlotPhase saving→null', async () => {
    const pm = new ProcessManager();
    const phases: (string | null)[] = [];
    const ctl = new ServerController(pm, { onSlotPhase: (p) => phases.push(p) }, 3000);
    ctl.setSlotCache(new SlotCache({ dir, timeoutMs: 5000 }));
    await ctl.start(reqSlot('save-model'));
    expect(ctl.getState().status).toBe('running');
    await ctl.stop();
    expect(ctl.getState().status).toBe('stopped');
    expect(pm.running).toBe(false);
    // fake-server 在响应前同步写标记文件 → 文件存在即证明保存先于 kill
    expect(fs.existsSync(path.join(dir, 'save-model_0.bin'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'save-model_1.bin'))).toBe(true);
    expect(phases).toEqual(['saving', null]);
  });

  it('start 后恢复：存在存档 → 触发 restore，状态 running', async () => {
    const pm = new ProcessManager();
    const phases: (string | null)[] = [];
    const ctl = new ServerController(pm, { onSlotPhase: (p) => phases.push(p) }, 3000);
    fs.writeFileSync(path.join(dir, 'restore-model_0.bin'), 'x');
    fs.writeFileSync(path.join(dir, 'restore-model_1.bin'), 'x');
    ctl.setSlotCache(new SlotCache({ dir, timeoutMs: 5000 }));
    await ctl.start(reqSlot('restore-model'));
    expect(ctl.getState().status).toBe('running');
    expect(phases).toEqual(['restoring', null]);
    await ctl.stop();
  });

  it('restore 失败（FAKE_SLOT_FAIL）→ 启动仍成功', async () => {
    const pm = new ProcessManager();
    const logs: string[] = [];
    const ctl = new ServerController(pm, { onLog: (l) => logs.push(l) }, 3000);
    fs.writeFileSync(path.join(dir, 'fail-restore-model_0.bin'), 'x');
    ctl.setSlotCache(new SlotCache({ dir, timeoutMs: 5000 }));
    await ctl.start(reqSlot('fail-restore-model', { FAKE_SLOT_FAIL: '1' }));
    expect(ctl.getState().status).toBe('running');
    expect(logs.some((l) => l.includes('恢复 slot 上下文失败'))).toBe(true);
    await ctl.stop();
  });

  it('save 失败（FAKE_SLOT_FAIL）→ 停止仍完成', async () => {
    const pm = new ProcessManager();
    const logs: string[] = [];
    const ctl = new ServerController(pm, { onLog: (l) => logs.push(l) }, 3000);
    ctl.setSlotCache(new SlotCache({ dir, timeoutMs: 5000 }));
    // FAKE_SLOT_FAIL 在 start 时注入（env 随进程固定）→ stop 时的 save 全部 500
    await ctl.start(reqSlot('fail-save-model', { FAKE_SLOT_FAIL: '1' }));
    await ctl.stop(); // saveAll 抛错（全部 500）→ 记日志继续停止
    expect(ctl.getState().status).toBe('stopped');
    expect(pm.running).toBe(false);
    expect(logs.some((l) => l.includes('保存 slot 上下文失败'))).toBe(true);
  });

  it('slot cache 禁用（未 setSlotCache）→ fake-server 收不到 /slots 请求', async () => {
    const pm = new ProcessManager();
    const reqLog = path.join(dir, 'reqlog-ctl.txt');
    const ctl = new ServerController(pm, {}, 3000);
    await ctl.start(reqSlot('no-cache-model', { FAKE_REQ_LOG: reqLog }));
    await ctl.stop();
    expect(fs.readFileSync(reqLog, 'utf8')).not.toContain('/slots');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/server-controller.test.ts`
Expected: 新增 4 个测试 FAIL（`ctl.setSlotCache is not a function`）；「slot cache 禁用」测试 PASS（守卫：默认无 /slots 请求）；既有 13 个测试仍 PASS

- [ ] **Step 3: 实现**

`src/main/server-controller.ts` 改动：

(a) import（`import type { FormValues, ... }` 之前）加：

```ts
import { findSlotSaves, type SlotCache } from './slot-cache.js';
```

(b) `ControllerEvents` 加字段（`onSwitch` 之后）：

```ts
  /** slot 上下文保存/恢复阶段（null = 结束）；顶栏状态与按钮置灰用 */
  onSlotPhase?: (phase: 'saving' | 'restoring' | null, model: string | null) => void;
```

(c) 类字段与 setter（`private unionList: ModelRef[] = [];` 之后）：

```ts
  private slotCache: SlotCache | null = null;

  /** 注入 slot 上下文保存/恢复器（null = 功能禁用） */
  setSlotCache(sc: SlotCache | null): void { this.slotCache = sc; }
```

(d) `start()`：`await this.pm.waitForHealth(this.healthTimeoutMs);` 与 `this.setState({ status: 'running', ... })` 之间插入：

```ts
      // slot 上下文恢复（设计规格 §2）：仅当存在当前模型存档；期间状态仍为 starting（代理未起，无并发）
      if (this.slotCache && findSlotSaves(this.slotCache.dir, req.model.name).size > 0) {
        this.events.onSlotPhase?.('restoring', req.model.name);
        try {
          await this.slotCache.restoreAll(this.port, req.model.name);
        } catch (e) {
          this.events.onLog?.(`[launcher] 恢复 slot 上下文失败：${String(e)}（空上下文继续）`);
        } finally {
          this.events.onSlotPhase?.(null, null);
        }
      }
```

(e) `stop()` 整体改为：

```ts
  /** 停止（规格 §2.3）；切换期间停止 = 取消切换（杀掉新 server，回到 stopped） */
  async stop(): Promise<void> {
    // slot 上下文保存（设计规格 §2）：仅 running/switching 时保存（starting=启动失败路径，不保存）
    if (this.slotCache && this.pm.running && (this.state.status === 'running' || this.state.status === 'switching')) {
      this.events.onSlotPhase?.('saving', this.state.model);
      try {
        await this.slotCache.saveAll(this.port, this.state.model ?? '');
      } catch (e) {
        this.events.onLog?.(`[launcher] 保存 slot 上下文失败：${String(e)}（继续停止）`);
      } finally {
        this.events.onSlotPhase?.(null, null);
      }
    }
    if (this.pm.running) await this.pm.stop();
    this.setState({ status: 'stopped', port: null, exitCode: null });
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/server-controller.test.ts`
Expected: PASS（全部 18 个测试）

- [ ] **Step 5: 全量测试 + typecheck**

Run: `npm run test` 和 `npm run typecheck`
Expected: 全部 PASS（既有 controller 测试无回归：默认 slotCache=null 行为不变）

- [ ] **Step 6: Commit**

```bash
git add src/main/server-controller.ts test/server-controller.test.ts
git commit -m "feat: ServerController 集成 slot 上下文（stop 前保存 / start 后恢复）"
```

---

### Task 4: index.ts 编排（启用功能 + 关窗拦截 + 事件转发）

**Files:**
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: Task 2 的 `SlotCache`；Task 3 的 `ctl.setSlotCache` / `onSlotPhase`
- Produces: 渲染端可经 `slot:phase` 通道收到 `{ phase: 'saving' | 'restoring' | null, model: string | null }`（Task 5 消费）

- [ ] **Step 1: import 与模块状态**

`src/main/index.ts`：

(a) import（`import { ServerController } from './server-controller.js';` 之后）加：

```ts
import { SlotCache } from './slot-cache.js';
```

(b) 模块状态（`let proxy: LauncherProxy | null = null;` 之后）加：

```ts
let slotCache: SlotCache | null = null;
```

- [ ] **Step 2: ctl 构造加 onSlotPhase**

`const ctl = new ServerController(pm, { ... })` 的 `onSwitch: (s) => send('switch:change', s),` 行之后加：

```ts
  onSlotPhase: (phase, model) => send('slot:phase', { phase, model }),
```

- [ ] **Step 3: startServer 启用功能**

`startServer()` 内，`await ctl.start({ exe, form, model, cudaDir, fallbackCudaDirs });` 之前插入：

```ts
  // slot 上下文自动保存/恢复（设计规格 §3）：slotSavePath 非空且目录可创建才启用
  {
    const dir = form.slotSavePath.trim();
    if (dir !== '') {
      try {
        fs.mkdirSync(dir, { recursive: true });
        slotCache = new SlotCache({ dir, apiKey: form.apiKey, onLog: pushLog });
        ctl.setSlotCache(slotCache);
      } catch (e) {
        slotCache = null;
        ctl.setSlotCache(null);
        pushLog(`[launcher] slot-save-path 目录不可用（${String(e)}）：slot 上下文自动保存/恢复已禁用`);
      }
    } else {
      slotCache = null;
      ctl.setSlotCache(null);
      pushLog('[launcher] 未设置 slot-save-path：slot 上下文自动保存/恢复已禁用');
    }
  }
```

（`--slot-save-path` 已由 args.ts 按 form.slotSavePath 透传，无需改动。注意顺序：startServer 开头的 `stopServer()` 用的是**上一次**启动设置的 slotCache —— 即旧模型存到旧目录，正确。）

- [ ] **Step 4: 关窗拦截**

`createWindow()` 内，`win.on('closed', () => { win = null; });` 之后加：

```ts
  // 关窗拦截（设计规格 §3）：保存 slot 上下文期间不退出；保存完成/失败后才放行
  let quitPhase: 'idle' | 'saving' | 'final' = 'idle';
  win.on('close', (e) => {
    if (quitPhase === 'final') return; // 放行（app.quit 触发的二次 close）
    if (quitPhase === 'saving') { e.preventDefault(); return; } // 保存期间忽略重复点 X
    const st = ctl.getState().status;
    if (slotCache !== null && (st === 'running' || st === 'switching')) {
      e.preventDefault();
      quitPhase = 'saving';
      void (async () => {
        try { await stopServer(); } catch { /* 停止/保存失败不阻塞退出 */ }
        quitPhase = 'final';
        app.quit();
      })();
    }
  });
```

（`window-all-closed` 现有逻辑保留不动：功能禁用 / server 未运行时由它兜底 stop + quit。）

- [ ] **Step 5: typecheck + 全量测试**

Run: `npm run typecheck` 和 `npm run test`
Expected: 全部 PASS

- [ ] **Step 6: 手动验证（真实应用，需本机有可用模型）**

Run: `npm run dev`
1. 在「上下文」组填 `slotSavePath`（如 `F:\llama_launcher\app_data\slot_save`），选一个模型，点「启动」
2. 运行中点窗口右上角 X
3. Expected: 窗口不立即关闭；日志面板出现 `[launcher] 保存 slot 上下文：模型「...」→ ...` 与逐 slot 行；slotSavePath 目录生成 `<模型名>_0.bin`（parallel>1 时多个）；保存完成后应用自动退出
4. 再启动一次（同模型）：Expected: 日志出现 `[launcher] 恢复 slot 上下文：...` 与 `已恢复 slot 0 ← ...`
5. 清空 `slotSavePath`（保存参数组）后重启应用并启动：Expected: 日志出现「未设置 slot-save-path：...已禁用」，点 X 直接退出（无拦截）

- [ ] **Step 7: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: 主进程启用 slot 上下文保存/恢复（slotSavePath 门控 + 关窗拦截）"
```

---

### Task 5: UI（slot:phase 事件 + 顶栏状态 + 按钮置灰）

**Files:**
- Modify: `src/shared/types.ts`（SlotPhaseEvent）
- Modify: `src/preload/index.ts`（EVENTS 白名单）
- Modify: `src/renderer/main.ts`（状态、renderState、事件订阅、字段标签）

**Interfaces:**
- Consumes: Task 4 的 `slot:phase` 通道（payload `{ phase, model }`）
- Produces: 顶栏 badge 显示「保存/恢复 slot 上下文中…（Xs）」（saving=yellow / restoring=cyan，Xs 渲染端 1s 计时）；期间启动/停止按钮置灰；phase=null 恢复正常状态显示

- [ ] **Step 1: 共享类型**

`src/shared/types.ts` 的 `SwitchState` 接口之后加：

```ts
export interface SlotPhaseEvent { phase: 'saving' | 'restoring' | null; model: string | null }
```

- [ ] **Step 2: preload 白名单**

`src/preload/index.ts` 的 EVENTS 数组末尾（`'models:changed'` 之后）加 `'slot:phase'`：

```ts
const EVENTS = ['state:change', 'log:lines', 'switch:change', 'stats:request', 'stats:round', 'update:progress', 'banner:change', 'exit:crash', 'models:changed', 'slot:phase'] as const;
```

- [ ] **Step 3: 渲染端**

`src/renderer/main.ts` 改动：

(a) 第 3 行类型 import 加 `SlotPhaseEvent`：

```ts
import type { FormValues, ModelRef, ServerState, Profile, RoundRecord, RoundStats, UpdateProgress, InstalledVersion, SlotPhaseEvent } from '../shared/types.js';
```

(b) 状态（`let serverState: ServerState = { status: 'stopped', ... };` 之后）加：

```ts
let slotPhase: SlotPhaseEvent = { phase: null, model: null };
let slotPhaseStart = 0;
let slotPhaseTimer: ReturnType<typeof setInterval> | null = null;
```

(c) `renderState()` 整体替换为：

```ts
function renderState(s: ServerState): void {
  serverState = s;
  const [text, color] = STATUS_UI[s.status];
  const badge = $<HTMLSpanElement>('status-badge');
  // slot 上下文阶段优先显示（设计规格 §4）：saving=yellow / restoring=cyan，Xs 为已用时秒数
  const phaseText = slotPhase.phase === null ? null
    : `${slotPhase.phase === 'saving' ? '保存 slot 上下文中…' : '恢复 slot 上下文中…'}（${Math.floor((Date.now() - slotPhaseStart) / 1000)}s）`;
  if (phaseText !== null) {
    badge.textContent = phaseText;
    badge.className = `badge ${slotPhase.phase === 'saving' ? 'yellow' : 'cyan'}`;
  } else {
    badge.textContent = s.status === 'crashed' && s.exitCode !== null ? `${text} (exit ${s.exitCode})` : text;
    badge.className = `badge ${color}`;
  }
  const info = $<HTMLSpanElement>('port-info');
  const parts: string[] = [];
  if (s.model !== null) parts.push(s.model);
  if (s.port !== null && form) parts.push(`内部 :${s.port} → 可见 :${form.visiblePort}`);
  info.textContent = parts.join('  ');
  const busy = s.status === 'starting' || s.status === 'switching' || slotPhase.phase !== null;
  btnStart.disabled = busy;
  btnStart.textContent = s.status === 'running' || s.status === 'switching' ? '重启（新模型）' : '启动';
  btnStop.disabled = s.status === 'stopped' || s.status === 'starting' || slotPhase.phase !== null;
}
```

(d) `subscribeEvents()` 内，`window.llama.on('state:change', ...)` 之后加：

```ts
  window.llama.on('slot:phase', (p) => {
    slotPhase = p as SlotPhaseEvent;
    if (slotPhase.phase !== null) slotPhaseStart = Date.now();
    if (slotPhaseTimer !== null) { clearInterval(slotPhaseTimer); slotPhaseTimer = null; }
    if (slotPhase.phase !== null) slotPhaseTimer = setInterval(() => renderState(serverState), 1000);
    renderState(serverState);
  });
```

(e) GROUPS「上下文」组的 `slotSavePath` 字段标签改为：

```ts
    { id: 'slotSavePath', label: 'Slot KV 缓存保存路径 (slot-save-path，slot 上下文自动保存/恢复需设置)', type: 'text' },
```

- [ ] **Step 4: typecheck + 构建**

Run: `npm run typecheck` 和 `npm run build`
Expected: 全部 PASS

- [ ] **Step 5: 手动验证（真实应用）**

Run: `npm run dev`
1. 设 `slotSavePath`，启动模型，运行中点 X
2. Expected: 顶栏 badge 变黄显示「保存 slot 上下文中…（0s）」并每秒 +1；启动/停止按钮置灰；保存完成后应用退出
3. 重新启动（存在存档）：Expected: 启动阶段 badge 变青色「恢复 slot 上下文中…（Xs）」，恢复完成后变绿「运行中」，按钮恢复可用

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/preload/index.ts src/renderer/main.ts
git commit -m "feat: 顶栏 slot 上下文保存/恢复状态显示（slot:phase 事件 + 按钮置灰）"
```

---

### 收尾：全量验证

- [ ] **Step 1: 全量测试 + typecheck + 构建**

Run: `npm run test`、`npm run typecheck`、`npm run build`
Expected: 全部 PASS

- [ ] **Step 2: 归档本计划并 commit**

```bash
git add docs/superpowers/plans/2026-08-30-slot-cache.md
git commit -m "docs: slot 上下文自动保存/恢复实施计划归档"
```

（若工作区有其他未提交改动，先 `git status --short` 确认后再决定。）

---

## 非目标（不实现）

- 保存进度百分比（llama-server save 为同步阻塞，只能显示已用时秒数）
- 过期存档自动清理（用户自行管理 slot_save 目录）
- 崩溃时保存（server 已死，API 不可用）
- 文件名按量化区分（HF repo 名不含量化；过期存档由 server 拒绝兜底）
- 手动保存 / 恢复的 UI 按钮（全自动，无手动入口）

## 边界行为备忘（实现时对照；除标注外均已被 Task 2/3 代码与测试覆盖，无需额外代码）

| 场景 | 行为 | 覆盖 |
|---|---|---|
| save / restore 失败（server 报错 / 超时 / 网络） | 只记日志，不阻塞停止 / 启动 | Task 3 测试 |
| `slotSavePath` 为空 | 功能禁用：无 HTTP 调用、无关窗拦截、无状态显示 | Task 4 Step 3/4 |
| 未勾选 `slots` 端点（server 无 --slots） | `GET /slots` 404 → 跳过保存 / 恢复 + 日志提示 | Task 2 listSlots 失败路径 |
| 保存的 slot 数 > 当前 slot 数 | 只恢复当前 server 存在的 slot，跳过项记日志 | Task 2 测试 |
| 保存被强杀中断（残留半截 .bin） | 下次 restore 被 server 拒绝（Invalid tokens）→ 记日志，空上下文继续 | 逐 slot 失败处理 |
| slot 忙（生成进行中）时保存 | server 拒绝则记日志继续 | 逐 slot 失败处理 |
| llama.cpp 版本过旧无 slots action API | 请求 404 / 报错 → 记日志继续（功能需 b10636 级别构建） | listSlots 失败路径 |
| 同名模型不同量化（HF repo 名不含量化） | 可能恢复到过期存档 → server 拒绝（安全失败），不自动清理 | 逐 slot 失败处理 |
| autoSwitch 排队 | 保存耗时计入排队等待（默认 5 分钟上限），超时走现有 503 逻辑 | proxy.ts 现有逻辑，无需改动 |
