// process-manager.ts — llama-server 进程生命周期（规格 §5.3 / §5.4）
// spawn（env 注入）、逐行日志回调（splitLines，CRLF 安全）、/health 轮询、
// stop = kill → 10s → taskkill /T /F 兜底、<10s 非零退出 = early crash（stderr 供诊断）、
// 内部端口探测（59999 起逐个试绑 127.0.0.1）
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import { splitLines } from './log-parser.js';

export interface StartOptions {
  exe: string;
  argv: string[];
  env: Record<string, string>;
  cwd?: string;
  port: number;
  onLine: (line: string) => void;
  onExit: (info: ExitInfo) => void;
}

export interface ExitInfo {
  code: number | null;
  early: boolean;         // 启动后 10s 内退出
  stderr: string;         // 捕获的 stderr（上限 256KB）
  intentional: boolean;   // 是否由 stop() 触发
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export function isPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

export async function probeFreePort(start = 59999, end = 60999): Promise<number> {
  for (let p = start; p <= end; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`no free port in ${start}..${end}`);
}

export class ProcessManager {
  private proc: ChildProcess | null = null;
  private port = 0;
  private startTs = 0;
  private intentional = false;
  private stderrBuf = '';

  get running(): boolean { return this.proc !== null; }
  get pid(): number | null { return this.proc?.pid ?? null; }
  get currentPort(): number { return this.port; }

  async start(opts: StartOptions): Promise<void> {
    if (this.proc) throw new Error('already running');
    this.port = opts.port;
    this.startTs = Date.now();
    this.intentional = false;
    this.stderrBuf = '';

    const proc = spawn(opts.exe, opts.argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd,
      windowsHide: true,
    });
    this.proc = proc;

    let outRest = '';
    let errRest = '';
    proc.stdout?.on('data', (c: Buffer) => {
      const { lines, rest } = splitLines(outRest + c.toString('utf8'));
      outRest = rest;
      for (const l of lines) opts.onLine(l);
    });
    proc.stderr?.on('data', (c: Buffer) => {
      this.stderrBuf = (this.stderrBuf + c.toString('utf8')).slice(-262144);
      const { lines, rest } = splitLines(errRest + c.toString('utf8'));
      errRest = rest;
      for (const l of lines) opts.onLine(l);
    });

    let done = false;
    const finish = (code: number | null): void => {
      if (done) return;
      done = true;
      this.proc = null;
      opts.onExit({
        code,
        early: Date.now() - this.startTs < 10000,
        stderr: this.stderrBuf,
        intentional: this.intentional,
      });
    };
    proc.on('error', (err) => {
      this.stderrBuf += `\nspawn error: ${err.message}\n`;
      finish(null);
    });
    proc.on('exit', (code) => finish(code));
  }

  /** 轮询 /health 直到 200；进程中途退出或超时 → throw */
  async waitForHealth(timeoutMs = 300000, intervalMs = 500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.proc === null) throw new Error('server exited during startup');
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/health`);
        if (res.status === 200) return;
      } catch { /* 尚未就绪 */ }
      await sleep(intervalMs);
    }
    throw new Error(`health check timed out after ${timeoutMs}ms`);
  }

  /** kill → 等 10s → Windows taskkill /T /F /PID 兜底 */
  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.intentional = true;
    const pid = proc.pid;
    if (pid === undefined) { this.proc = null; return; }
    const exited = new Promise<void>(resolve => {
      if (proc.exitCode !== null || proc.signalCode !== null) resolve();
      else proc.once('exit', () => resolve());
    });
    try { proc.kill(); } catch { /* 已退出 */ }
    const t0 = Date.now();
    while (Date.now() - t0 < 10000) {
      await Promise.race([exited, sleep(200)]);
      if (proc.exitCode !== null || proc.signalCode !== null) break;
    }
    if (proc.exitCode === null && proc.signalCode === null) {
      if (process.platform === 'win32') {
        await new Promise<void>(resolve => {
          execFile('taskkill', ['/T', '/F', '/PID', String(pid)], () => resolve());
        });
      } else {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }
      await Promise.race([exited, sleep(5000)]);
    }
    this.proc = null;
  }
}