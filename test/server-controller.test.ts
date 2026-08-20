// server-controller.test.ts — server 生命周期与模型切换编排（规格 §2.2/§2.3/§5.4）
// 测试替身：fake-server.mjs（真实 spawn，node 二进制充当 llama-server）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProcessManager, isPortFree, type ExitInfo } from '../src/main/process-manager.js';
import { ServerController, type StartRequest } from '../src/main/server-controller.js';
import { DEFAULT_FORM } from '../src/main/config.js';
import type { ModelRef, SwitchState } from '../shared/types.js';

const FAKE = fileURLToPath(new URL('./fake-server.mjs', import.meta.url));

function ref(name: string): ModelRef {
  return {
    name,
    source: 'local',
    local: { name, path: `/models/${name}.gguf`, size: 1, mtime: Date.now(), mmproj: null, mmprojCandidates: [] },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await sleep(50);
  }
}

describe('ServerController', () => {
  let pm: ProcessManager;
  let ctl: ServerController;

  const req = (model: string, extra: Record<string, string> = {}): StartRequest => ({
    exe: process.execPath,
    form: { ...DEFAULT_FORM, extraArgs: '--fake-flag' },
    model: ref(model),
    cudaDir: null,
    extraEnv: (port: number) => ({ FAKE_PORT: String(port), ...extra }),
    extraArgvPrefix: [FAKE],
  });

  beforeAll(() => {
    pm = new ProcessManager();
    ctl = new ServerController(pm, {}, 3000);
  });

  afterAll(async () => {
    await ctl.stop();
  });

  it('start → running with health-checked internal port; stop releases the port', async () => {
    await ctl.start(req('fake-model'));
    expect(ctl.getState().status).toBe('running');
    expect(ctl.isReady()).toBe(true);
    expect(ctl.currentModel()).toBe('fake-model');
    const port = ctl.internalPort();
    expect(port).toBeGreaterThan(0);
    expect(pm.running).toBe(true);
    await ctl.stop();
    expect(ctl.getState().status).toBe('stopped');
    expect(pm.running).toBe(false);
    expect(await isPortFree(port)).toBe(true);
  });

  it('waits for delayed health (slow model load)', async () => {
    await ctl.start(req('fake-model', { FAKE_HEALTH_DELAY_MS: '400' }));
    expect(ctl.getState().status).toBe('running');
    await ctl.stop();
  });

  it('reports crash with exit code and captured stderr', async () => {
    let exitInfo: ExitInfo | null = null;
    const c2 = new ServerController(new ProcessManager(), { onExit: (i) => { exitInfo = i; } }, 3000);
    await c2.start(req('fake-model', { FAKE_HEALTH_DELAY_MS: '50', FAKE_CRASH_MS: '1200', FAKE_CRASH_MSG: 'error: invalid argument: --fake-flag' }));
    expect(c2.getState().status).toBe('running');
    await waitFor(() => c2.getState().status === 'crashed');
    expect(c2.getState().exitCode).toBe(1);
    expect(c2.isReady()).toBe(false);
    expect(exitInfo).not.toBeNull();
    expect(exitInfo!.early).toBe(true); // 400ms < 10s
    expect(exitInfo!.stderr).toContain('error: invalid argument: --fake-flag');
    await c2.stop();
  });

  it('start with missing cudaDir → friendly error, no spawn', async () => {
    const c3 = new ServerController(new ProcessManager(), {}, 3000);
    const r3 = { ...req('fake-model'), cudaDir: 'F:/definitely-missing-cuda-dir-xyz' };
    await expect(c3.start(r3)).rejects.toThrow(/CUDA 运行时目录/);
    expect(c3.getState().status).toBe('stopped');
  });

  it('start with cudaDir lacking cudart dll → friendly error, no spawn', async () => {
    const dir = path.join(os.tmpdir(), 'llama-launcher-cuda-test-' + Date.now());
    fs.mkdirSync(dir);
    try {
      const c4 = new ServerController(new ProcessManager(), {}, 3000);
      const r4 = { ...req('fake-model'), cudaDir: dir };
      await expect(c4.start(r4)).rejects.toThrow(/cudart64_/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('start failure (health timeout) → stopped, error thrown', async () => {
    await expect(ctl.start(req('fake-model', { FAKE_HEALTH_DELAY_MS: '10000' }))).rejects.toThrow(/health check timed out/);
    expect(ctl.getState().status).toBe('stopped');
    expect(pm.running).toBe(false);
  });

  it('restart while running replaces the process', async () => {
    await ctl.start(req('fake-model'));
    const pid1 = pm.pid;
    await ctl.start(req('fake-model'));
    expect(ctl.getState().status).toBe('running');
    expect(pm.pid).not.toBe(pid1);
    await ctl.stop();
  });

  it('switchTo different model: stop old, start new, update current', async () => {
    const switchEvents: SwitchState[] = [];
    const c2 = new ServerController(new ProcessManager(), { onSwitch: (s) => switchEvents.push(s) }, 3000);
    await c2.start(req('fake-model'));
    const port1 = c2.internalPort();
    await c2.switchTo(ref('other-model'));
    expect(c2.getState().status).toBe('running');
    expect(c2.currentModel()).toBe('other-model');
    expect(c2.isReady()).toBe(true);
    if (port1 !== null && port1 !== c2.internalPort()) expect(await isPortFree(port1)).toBe(true); // 新 server 可能复用了旧端口
    expect(switchEvents.some((s) => s.switching && s.to === 'other-model')).toBe(true);
    await c2.stop();
  });

  it('switchTo same model (case-insensitive) is a no-op', async () => {
    await ctl.start(req('Fake-Model'));
    const pid1 = pm.pid;
    await ctl.switchTo(ref('fake-model'));
    expect(pm.pid).toBe(pid1);
    expect(ctl.getState().status).toBe('running');
    expect(ctl.currentModel()).toBe('Fake-Model');
    await ctl.stop();
  });

  it('switchTo before start throws', async () => {
    const c3 = new ServerController(new ProcessManager(), {}, 3000);
    await expect(c3.switchTo(ref('any-model'))).rejects.toThrow(/not started/);
  });
});
