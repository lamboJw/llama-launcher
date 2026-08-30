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

  /** GET /slots → slot id 列表；404 / 错误 → 抛错（调用方记日志并跳过）
   *  真实响应为顶层数组 [{id, ...}]（b10636 实测）；兼容 { slots: [...] } 对象格式 */
  async listSlots(port: number): Promise<number[]> {
    const res = await this.http(`http://127.0.0.1:${port}/slots`);
    if (!res.ok) throw new Error(`GET /slots 失败：HTTP ${res.status} ${await res.text()}`);
    const data: unknown = await res.json();
    const arr: unknown = Array.isArray(data) ? data : (data as { slots?: unknown })?.slots;
    const ids: number[] = [];
    if (Array.isArray(arr)) {
      for (const s of arr) {
        const id = (s as { id?: unknown })?.id;
        if (typeof id === 'number') ids.push(id);
      }
    }
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
