import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  scanHfCache, parseRepoFromDirName, readCommit, extractQuant,
  buildModelUnion, resolveModelRef,
} from '../src/main/hf-cache.js';
import type { LocalModel } from '../shared/types.js';

const COMMIT = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'; // 40-hex
let root: string;

function mkRepo(repo: string, commit: string, files: string[], badRefMain?: string): void {
  const dir = path.join(root, 'models--' + repo.replace(/\//g, '--'));
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
  // refs/main 与 snapshots 目录名不匹配（refs 更新但快照未同步）→ 回退任选含 .gguf 的快照
  const mm = path.join(root, 'models--user--RefMismatch');
  fs.mkdirSync(path.join(mm, 'snapshots', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'), { recursive: true });
  fs.writeFileSync(path.join(mm, 'snapshots', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'model.gguf'), 'gguf');
  fs.mkdirSync(path.join(mm, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(mm, 'refs', 'main'), COMMIT + '\n'); // COMMIT ≠ deadbeef…
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
    // 独立目录，避免污染共享 BadRef fixture（scanHfCache 的 excludes 测试依赖它无效）
    const dir = path.join(root, 'models--user--BadRef2');
    fs.mkdirSync(path.join(dir, 'refs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'refs', 'main'), 'not-a-commit\n');
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
    // localPath：按默认量化 Q4_K_M 选具体 gguf（mmproj 不算）
    expect(m.localPath).toBe(path.join(root, 'models--ggml-org--GLM-4.7-Flash-GGUF', 'snapshots', COMMIT, 'GLM-4.7-Flash-GGUF-Q4_K_M.gguf'));
  });

  it('no recognizable quant -> quant null (llama.cpp falls back to first file)', () => {
    const m = scanHfCache(root).find(x => x.repo === 'user/NoQuant')!;
    expect(m.quants).toEqual([]);
    expect(m.quant).toBeNull();
    expect(m.mmproj).toBe(false);
    // 无量化可识别 → localPath 取第一个 gguf
    expect(m.localPath).toBe(path.join(root, 'models--user--NoQuant', 'snapshots', COMMIT, 'model.gguf'));
  });

  it('refs/snapshots mismatch → falls back to any snapshot with gguf', () => {
    const m = scanHfCache(root).find(x => x.repo === 'user/RefMismatch')!;
    expect(m).toBeTruthy();
    expect(m.path).toContain('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  });

  it('excludes only: no snapshots dir, empty snapshot; fallback rescues bad-ref repo', () => {
    const repos = scanHfCache(root).map(x => x.repo);
    // BadRef：refs 无效但快照含 gguf → 回退后可见（行为变更，见交付后修正）
    expect(repos).toEqual(['ggml-org/GLM-4.7-Flash-GGUF', 'user/BadRef', 'user/NoQuant', 'user/RefMismatch']);
    expect(repos).not.toContain('user/NoSnapDir');
    expect(repos).not.toContain('user/NoGguf');
  });

  it('missing dir -> empty', () => {
    expect(scanHfCache(path.join(root, 'nope'))).toEqual([]);
  });
});

describe('union + resolve', () => {
  const local: LocalModel[] = [{
    name: 'GLM-4.7-Flash-GGUF', path: 'x', size: 1, mtime: 0, mmproj: null, mmprojCandidates: [],
  }];

  it('local wins on case-insensitive name conflict', () => {
    const u = buildModelUnion(local, scanHfCache(root));
    const hit = u.find(r => r.name.toLowerCase() === 'glm-4.7-flash-gguf')!;
    expect(hit.source).toBe('local');
    expect(u).toHaveLength(4); // local GLM + hf user/BadRef + user/NoQuant + user/RefMismatch (ggml-org repo shadowed)
  });

  it('resolve: plain name, case-insensitive, quant suffix stripped', () => {
    const u = buildModelUnion([], scanHfCache(root));
    expect(resolveModelRef(u, 'ggml-org/GLM-4.7-Flash-GGUF')!.source).toBe('hf');
    expect(resolveModelRef(u, 'GGML-ORG/glm-4.7-flash-gguf')!.source).toBe('hf');
    expect(resolveModelRef(u, 'ggml-org/GLM-4.7-Flash-GGUF:q4_k_m')!.source).toBe('hf');
    expect(resolveModelRef(u, 'nope/missing')).toBeNull();
  });
});