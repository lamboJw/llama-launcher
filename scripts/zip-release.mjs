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
