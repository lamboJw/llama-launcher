// kvmem.test.ts — kvmem 版本发现（规格 §3）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanKvmemVersions, kvmemExePath } from '../src/main/kvmem.js';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kvmem-'));
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const mkdir = (p: string): string => {
  fs.mkdirSync(p, { recursive: true });
  return p;
};

describe('kvmemExePath', () => {
  it('目录内有 llama-kvmem-server.exe → 用它（即使还有别的 exe）', () => {
    const d = mkdir(path.join(root, 'exe-canonical'));
    fs.writeFileSync(path.join(d, 'llama-kvmem-server.exe'), '');
    fs.writeFileSync(path.join(d, 'other.exe'), '');
    expect(kvmemExePath(d)).toBe(path.join(d, 'llama-kvmem-server.exe'));
  });

  it('无标准名但恰好 1 个 .exe → 用它', () => {
    const d = mkdir(path.join(root, 'exe-single'));
    fs.writeFileSync(path.join(d, 'server-custom.exe'), '');
    expect(kvmemExePath(d)).toBe(path.join(d, 'server-custom.exe'));
  });

  it('0 个 .exe → null', () => {
    const d = mkdir(path.join(root, 'exe-none'));
    expect(kvmemExePath(d)).toBeNull();
  });

  it('≥2 个 .exe（无标准名）→ null', () => {
    const d = mkdir(path.join(root, 'exe-many'));
    fs.writeFileSync(path.join(d, 'a.exe'), '');
    fs.writeFileSync(path.join(d, 'b.exe'), '');
    expect(kvmemExePath(d)).toBeNull();
  });

  it('目录不存在 → null', () => {
    expect(kvmemExePath(path.join(root, 'nope'))).toBeNull();
  });
});

describe('scanKvmemVersions', () => {
  it('kvmem/<段>/llama-kvmem-server.exe → tag = kvmem-<段>', () => {
    const base = mkdir(path.join(root, 'scan1'));
    const d = mkdir(path.join(base, 'kvmem', 'v0.17.0'));
    const exe = path.join(d, 'llama-kvmem-server.exe');
    fs.writeFileSync(exe, '');
    expect(scanKvmemVersions(base)).toEqual([{ tag: 'kvmem-v0.17.0', exe }]);
  });

  it('子目录无 exe → 跳过；非目录项 → 跳过', () => {
    const base = mkdir(path.join(root, 'scan2'));
    mkdir(path.join(base, 'kvmem', 'empty-v1'));
    fs.writeFileSync(path.join(base, 'kvmem', 'loose-file'), '');
    const d = mkdir(path.join(base, 'kvmem', 'good-v2'));
    const exe = path.join(d, 'server.exe');
    fs.writeFileSync(exe, '');
    expect(scanKvmemVersions(base)).toEqual([{ tag: 'kvmem-good-v2', exe }]);
  });

  it('kvmem 目录缺失 → []', () => {
    expect(scanKvmemVersions(path.join(root, 'no-base'))).toEqual([]);
  });

  it('kvmem 路径是文件（fs 失败）→ 不抛，返回 []', () => {
    const base = mkdir(path.join(root, 'scan3'));
    fs.writeFileSync(path.join(base, 'kvmem'), '');
    expect(scanKvmemVersions(base)).toEqual([]);
  });

  it('多个版本 → 全部收录', () => {
    const base = mkdir(path.join(root, 'scan4'));
    const a = mkdir(path.join(base, 'kvmem', 'v0.17.0'));
    const b = mkdir(path.join(base, 'kvmem', 'v0.18.1'));
    const exeA = path.join(a, 'llama-kvmem-server.exe');
    const exeB = path.join(b, 'llama-kvmem-server.exe');
    fs.writeFileSync(exeA, '');
    fs.writeFileSync(exeB, '');
    const got = scanKvmemVersions(base).sort((x, y) => x.tag.localeCompare(y.tag));
    expect(got).toEqual([
      { tag: 'kvmem-v0.17.0', exe: exeA },
      { tag: 'kvmem-v0.18.1', exe: exeB },
    ]);
  });
});
