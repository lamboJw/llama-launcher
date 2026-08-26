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

// ---------- 自动发现（手动安装 / 软链进 llama.cpp 目录而 manifest 缺失） ----------
export interface AutoDiscoverOptions {
  baseDir: string;
  exeName?: string;
  verify?: (exePath: string) => Promise<number | void>;
}

/** manifest 缺失时扫描含 llama-server(.exe) 的 b\d+ 版本目录，逐个验证并登记 manifest；
 *  已有 manifest 内容则原样返回；未找到 → []（不写文件） */
export async function autoDiscoverVersions(opts: AutoDiscoverOptions): Promise<InstalledVersion[]> {
  const existing = await readManifest(opts.baseDir);
  if (existing.length > 0) return existing;
  const exeName = opts.exeName ?? (process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
  let dirs: string[] = [];
  try { dirs = await fs.readdir(opts.baseDir); } catch { return []; }
  // cudaVersion：baseDir/cuda/cuda-* 中版本号最高者（无 → null，exe 用自带 DLL）
  let cudaDirs: string[] = [];
  try { cudaDirs = (await fs.readdir(path.join(opts.baseDir, 'cuda'))).filter((d) => /^cuda-\d/.test(d)); } catch { cudaDirs = []; }
  const cudaVersion = cudaDirs.sort((a, b) => cmpVer(b.slice(5), a.slice(5)))[0]?.slice(5) ?? null;
  const out: InstalledVersion[] = [];
  const builds = dirs
    .map((x) => x.match(/^b(\d+)$/)?.[1] ?? null)
    .filter((x): x is string => x !== null)
    .sort((a, b) => Number(b) - Number(a));
  for (const b of builds) {
    const exePath = path.join(opts.baseDir, `b${b}`, exeName);
    if (!existsSync(exePath)) continue;
    let valid = true;
    try {
      await (opts.verify ?? verifyExe)(exePath);
    } catch {
      valid = false; // 验证失败照登记（valid false → UI 标红，与 runUpdate 语义一致）
    }
    out.push({ tag: `b${b}`, cudaVersion, installedAt: Date.now(), valid });
  }
  if (out.length > 0) await writeManifest(opts.baseDir, out);
  return out;
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
