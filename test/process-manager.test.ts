import { describe, it, expect } from 'vitest';
import { ProcessManager, probeFreePort, isPortFree, type ExitInfo } from '../src/main/process-manager.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-server.mjs');

describe('ProcessManager', () => {
  it('start, wait for health, stop', async () => {
    const port = await probeFreePort(59900);
    const pm = new ProcessManager();
    const lines: string[] = [];
    let exitInfo: ExitInfo | null = null;
    await pm.start({
      exe: process.execPath,
      argv: [FAKE],
      env: { FAKE_PORT: String(port), FAKE_HEALTH_DELAY_MS: '300' },
      port,
      onLine: l => lines.push(l),
      onExit: i => { exitInfo = i; },
    });
    await pm.waitForHealth(5000);
    expect(pm.running).toBe(true);
    expect(lines.some(l => l.includes('fake-server ready'))).toBe(true);
    await pm.stop();
    expect(pm.running).toBe(false);
    expect(exitInfo).not.toBeNull();
    expect(exitInfo!.intentional).toBe(true);
  });

  it('early crash -> onExit early with captured stderr', async () => {
    const port = await probeFreePort(59900);
    const pm = new ProcessManager();
    let exitInfo: ExitInfo | null = null;
    await pm.start({
      exe: process.execPath,
      argv: [FAKE],
      env: { FAKE_PORT: String(port), FAKE_CRASH_MS: '200', FAKE_CRASH_MSG: 'error: invalid argument: --fake-flag' },
      port,
      onLine: () => {},
      onExit: i => { exitInfo = i; },
    });
    await new Promise(r => setTimeout(r, 1500));
    expect(exitInfo).not.toBeNull();
    expect(exitInfo!.early).toBe(true);
    expect(exitInfo!.intentional).toBe(false);
    expect(exitInfo!.code).toBe(1);
    expect(exitInfo!.stderr).toContain('error: invalid argument: --fake-flag');
  });

  it('stop force-kills a server that ignores SIGTERM', async () => {
    const port = await probeFreePort(59900);
    const pm = new ProcessManager();
    await pm.start({
      exe: process.execPath,
      argv: [FAKE],
      env: { FAKE_PORT: String(port), FAKE_IGNORE_SIGTERM: '1' },
      port,
      onLine: () => {},
      onExit: () => {},
    });
    await pm.waitForHealth(5000);
    const t0 = Date.now();
    await pm.stop();
    expect(Date.now() - t0).toBeLessThan(15000);
    expect(pm.running).toBe(false);
  });
});

describe('port probe', () => {
  it('probeFreePort returns a free port in range', async () => {
    const p = await probeFreePort(59900, 60999);
    expect(p).toBeGreaterThanOrEqual(59900);
    expect(p).toBeLessThanOrEqual(60999);
    expect(await isPortFree(p)).toBe(true);
  });
});