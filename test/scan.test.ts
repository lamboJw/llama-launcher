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