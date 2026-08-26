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

  it('keeps newest-first order when a file spans multiple 2MB read chunks', async () => {
    const s = new RecordsStore(dir);
    // 24 条 × ~160KB ≈ 3.8MB → 至少跨 2 个 2MB 读块
    const pad = 'x'.repeat(160 * 1024);
    for (let i = 1; i <= 24; i++) {
      await s.append({ ts: i, model: 'm', prompt: pad, decode: 'd' + i, ttft_ms: 1, usage: null });
    }
    const p0 = await s.tailPage(0, 10);
    expect(p0.records.map(r => r.ts)).toEqual([24, 23, 22, 21, 20, 19, 18, 17, 16, 15]);
    expect(p0.hasMore).toBe(true);
    const p1 = await s.tailPage(1, 10);
    expect(p1.records.map(r => r.ts)).toEqual([14, 13, 12, 11, 10, 9, 8, 7, 6, 5]);
    expect(p1.hasMore).toBe(true);
    const p2 = await s.tailPage(2, 10);
    expect(p2.records.map(r => r.ts)).toEqual([4, 3, 2, 1]);
    expect(p2.hasMore).toBe(false);
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