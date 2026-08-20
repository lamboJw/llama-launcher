import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppConfig, JsonStore, migrateForm, DEFAULT_FORM } from '../src/main/config.js';
import type { FormValues } from '../shared/types.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llama-cfg-'));
}

describe('JsonStore', () => {
  it('returns defaults when file missing', () => {
    const d = tmpdir();
    const s = new JsonStore(d, 'x', { a: 1, b: 'two' });
    expect(s.get()).toEqual({ a: 1, b: 'two' });
  });

  it('persists set() and merges new defaults on reload', () => {
    const d = tmpdir();
    const s1 = new JsonStore(d, 'x', { a: 1, b: 'two' });
    s1.set({ a: 9 });
    const s2 = new JsonStore(d, 'x', { a: 1, b: 'two', c: 3 });
    expect(s2.get()).toEqual({ a: 9, b: 'two', c: 3 });
  });

  it('ignores corrupt file (falls back to defaults)', () => {
    const d = tmpdir();
    fs.writeFileSync(path.join(d, 'x.json'), '{corrupt');
    const s = new JsonStore(d, 'x', { a: 1 });
    expect(s.get()).toEqual({ a: 1 });
  });
});

describe('AppConfig', () => {
  it('defaults: port 8080, autoSwitch off, recordRounds off, server-default booleans on', () => {
    const c = new AppConfig(tmpdir());
    const f = c.getSettings().form;
    expect(f.visiblePort).toBe(8080);
    expect(f.proxyHost).toBe('127.0.0.1');
    expect(f.autoSwitch).toBe(false);
    expect(f.recordRounds).toBe(false);
    expect(f.mmprojAuto).toBe(true);
    expect(f.mmprojOffload).toBe(true);
    expect(f.jinja).toBe(true);
    expect(f.ui).toBe(true);
    expect(f.fit).toBe('');
    expect(f.warmup).toBe(true);
    expect(f.hfCacheDir.length).toBeGreaterThan(0);
    expect(f.timeout).toBe('');
  });

  it('updateForm patches and persists across instances', () => {
    const d = tmpdir();
    const c1 = new AppConfig(d);
    c1.updateForm({ visiblePort: 9000 });
    const c2 = new AppConfig(d);
    expect(c2.getSettings().form.visiblePort).toBe(9000);
    expect(c2.getSettings().form.proxyHost).toBe('127.0.0.1');
  });
});

describe('migrateForm（旧版布尔配置迁移）', () => {
  it('fit true -> on / false -> off；cacheReuse 布尔 -> 空', () => {
    const f = migrateForm({ ...DEFAULT_FORM, fit: true as never, cacheReuse: true as never } as FormValues);
    expect(f.fit).toBe('on');
    expect(f.cacheReuse).toBe('');
    const f2 = migrateForm({ ...DEFAULT_FORM, fit: false as never } as FormValues);
    expect(f2.fit).toBe('off');
  });

  it('新值形态原样保留', () => {
    const f = migrateForm({ ...DEFAULT_FORM, fit: 'off', cacheReuse: '128', tensorSplit: '3,1' });
    expect(f.fit).toBe('off');
    expect(f.cacheReuse).toBe('128');
    expect(f.tensorSplit).toBe('3,1');
  });

  it('AppConfig 启动时迁移落盘的旧配置并写回', () => {
    const d = tmpdir();
    const c1 = new AppConfig(d);
    c1.updateForm({ visiblePort: 8080 }); // 落盘
    const file = path.join(d, 'config.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.form.fit = true;
    raw.form.cacheReuse = true;
    fs.writeFileSync(file, JSON.stringify(raw));
    const f = new AppConfig(d).getSettings().form;
    expect(f.fit).toBe('on');
    expect(f.cacheReuse).toBe('');
    const raw2 = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw2.form.fit).toBe('on');
    expect(raw2.form.cacheReuse).toBe('');
  });
});