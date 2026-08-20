// updater.test.ts — llama.cpp 更新检查与自动下载（规格 §9.2）
// 本地 HTTP 服务器（支持 Range）+ adm-zip 夹具；不依赖 GitHub 网络
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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
  autoDiscoverVersions,
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

describe('autoDiscoverVersions（manifest 缺失时自动发现版本目录）', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'llama-ad-'));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('空目录 -> []，不写 manifest', async () => {
    const r = await autoDiscoverVersions({ baseDir: base, verify: async () => 100, exeName: 'llama-server.exe' });
    expect(r).toEqual([]);
    await expect(readFile(path.join(base, 'manifest.json'))).rejects.toBeDefined();
  });

  it('发现含 exe 的 b* 目录；cudaVersion 取最新 cuda-*；写 manifest', async () => {
    await mkdir(path.join(base, 'b10488'), { recursive: true });
    await writeFile(path.join(base, 'b10488', 'llama-server.exe'), 'x');
    await mkdir(path.join(base, 'cuda', 'cuda-13.3'), { recursive: true });
    await writeFile(path.join(base, 'cuda', 'cuda-13.3', 'cudart64_13.dll'), 'x');
    const r = await autoDiscoverVersions({ baseDir: base, verify: async () => 10488, exeName: 'llama-server.exe' });
    expect(r).toHaveLength(1);
    expect(r[0].tag).toBe('b10488');
    expect(r[0].cudaVersion).toBe('13.3');
    expect(r[0].valid).toBe(true);
    const m = await readManifest(base);
    expect(m.map((x) => x.tag)).toEqual(['b10488']);
  });

  it('多版本降序；无 exe 的目录跳过；verify 失败 -> valid false', async () => {
    await mkdir(path.join(base, 'b99999'), { recursive: true }); // 无 exe → 跳过
    await mkdir(path.join(base, 'b88888'), { recursive: true });
    await writeFile(path.join(base, 'b88888', 'llama-server.exe'), 'x');
    await mkdir(path.join(base, 'b77777'), { recursive: true });
    await writeFile(path.join(base, 'b77777', 'llama-server.exe'), 'x');
    const r = await autoDiscoverVersions({
      baseDir: base,
      verify: async (p) => (p.includes('b77777') ? Promise.reject(new Error('bad')) : 77777),
      exeName: 'llama-server.exe',
    });
    expect(r.map((x) => x.tag)).toEqual(['b88888', 'b77777']);
    expect(r[0].valid).toBe(true);
    expect(r[1].valid).toBe(false);
  });

  it('无 cuda 目录 -> cudaVersion null', async () => {
    await mkdir(path.join(base, 'b55555'), { recursive: true });
    await writeFile(path.join(base, 'b55555', 'llama-server.exe'), 'x');
    const r = await autoDiscoverVersions({ baseDir: base, verify: async () => 55555, exeName: 'llama-server.exe' });
    expect(r[0].cudaVersion).toBeNull();
  });

  it('已有 manifest 时原样返回，不覆盖', async () => {
    const existing: InstalledVersion[] = [{ tag: 'b1', cudaVersion: null, installedAt: 1, valid: true }];
    await writeManifest(base, existing);
    const r = await autoDiscoverVersions({ baseDir: base, verify: async () => 1, exeName: 'llama-server.exe' });
    expect(r).toEqual(existing);
  });
});
