import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppConfig, JsonStore } from '../src/main/config.js';

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
    expect(f.fit).toBe(true);
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