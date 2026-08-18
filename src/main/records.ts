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
      const fileLines: string[] = [];
      const fh = await fs.open(file, 'r');
      try {
        while (pos > 0 && lines.length + fileLines.length < target) {
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
          for (const l of parts) if (l !== '') fileLines.push(l);
          pos = start;
        }
        // 读到的行超出所需（小文件一次读完）或文件/更旧文件仍有剩余 → 前面还有
        if (fileLines.length > target - lines.length || (lines.length + fileLines.length >= target && (pos > 0 || fi < files.length - 1))) hasMore = true;
      } finally {
        await fh.close();
      }
      // 本文件行按旧→新顺序读出；倒序为新→旧后追加（文件按新→旧处理）
      for (let i = fileLines.length - 1; i >= 0; i--) lines.push(fileLines[i]);
    }
    const records: RoundRecord[] = [];
    for (const l of lines.slice(0, target)) {
      try { records.push(JSON.parse(l) as RoundRecord); } catch { /* 跳过损坏行 */ }
    }
    return { records: records.slice(page * pageSize, (page + 1) * pageSize), hasMore };
  }
}