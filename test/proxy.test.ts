// proxy.test.ts — 反向代理与自动模型切换（规格 §2.1/§2.3/§5.4/§7/§8/§11）
// 测试替身：Task 11 的 fake-server.mjs 作真实后端 + FakeController（注入式控制器，解耦 ProcessManager）
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { LauncherProxy, computeCacheHitRate, type SwitchController } from '../src/main/proxy.js';
import { RecordsStore } from '../src/main/records.js';
import { probeFreePort } from '../src/main/process-manager.js';
import { DEFAULT_FORM } from '../src/main/config.js';
import type { ModelRef, RequestStats } from '../src/shared/types.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-server.mjs');

function ref(name: string): ModelRef {
  return {
    name,
    source: 'local',
    local: { name, path: `/models/${name}.gguf`, size: 1, mtime: 0, mmproj: null, mmprojCandidates: [] },
  };
}

class FakeController implements SwitchController {
  port = 0;
  ready = false;
  current: string | null = null;
  models: ModelRef[] = [];
  _switching = false;
  switchImpl: (m: ModelRef) => Promise<void> = async () => { this._switching = false; };
  switchCalls: ModelRef[] = [];
  internalPort(): number | null { return this.port === 0 ? null : this.port; }
  isReady(): boolean { return this.ready; }
  currentModel(): string | null { return this.current; }
  union(): ModelRef[] { return this.models; }
  switching(): boolean { return this._switching; }
  switchTo(m: ModelRef): Promise<void> {
    this._switching = true;
    this.switchCalls.push(m);
    return this.switchImpl(m);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await sleep(50);
  }
}

function probeTcp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
  });
}

async function startFake(port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, [FAKE], {
    env: { ...process.env, FAKE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitFor(() => probeTcp(port), 5000);
  return child;
}

interface Resp { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(port: number, urlPath: string, method: string, body?: string, headers: Record<string, string> = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        agent: false,
        headers: body !== undefined
          ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...headers }
          : { ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const postJson = (port: number, p: string, obj: unknown, h: Record<string, string> = {}): Promise<Resp> =>
  request(port, p, 'POST', JSON.stringify(obj), h);
const doGet = (port: number, p: string, h: Record<string, string> = {}): Promise<Resp> =>
  request(port, p, 'GET', undefined, h);
const doOptions = (port: number, p: string, h: Record<string, string> = {}): Promise<Resp> =>
  request(port, p, 'OPTIONS', undefined, h);

describe('LauncherProxy', () => {
  let child: ChildProcess;
  let proxy: LauncherProxy;
  let ctrl: FakeController;
  let stats: RequestStats[];
  let proxyPort: number;
  let backendPort: number;

  beforeAll(async () => {
    backendPort = await probeFreePort(61500, 61999);
    child = await startFake(backendPort);
    proxyPort = await probeFreePort(61500, 61999);
    ctrl = new FakeController();
    ctrl.models = [ref('fake-model'), ref('other-model')];
    stats = [];
    proxy = new LauncherProxy({
      host: '127.0.0.1',
      port: proxyPort,
      controller: ctrl,
      form: { ...DEFAULT_FORM },
      onStats: (s) => stats.push(s),
    });
    await proxy.start();
  });

  afterAll(async () => {
    await proxy.stop();
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
  });

  beforeEach(() => {
    proxy.setForm({ ...DEFAULT_FORM, autoSwitch: true });
    ctrl.port = backendPort;
    ctrl.ready = true;
    ctrl._switching = false;
    ctrl.current = 'fake-model';
    ctrl.switchCalls.length = 0;
    ctrl.switchImpl = async (m) => { ctrl._switching = false; ctrl.current = m.name; };
    stats.length = 0;
  });

  it('forwards SSE as-is and reports TTFT', async () => {
    const res = await postJson(proxyPort, '/v1/chat/completions', {
      model: 'fake-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/event-stream');
    expect(res.body).toContain('"content":"hel"');
    expect(res.body).toContain('"content":"lo"');
    expect(res.body).toContain('[DONE]');
    expect(stats.length).toBe(1);
    expect(stats[0].model).toBe('fake-model');
    expect(stats[0].ttftMs).toBeGreaterThanOrEqual(0);
    expect(stats[0].ttftMs).toBeLessThan(5000);
    expect(stats[0].cacheHitRate).toBeNull();
  });

  it('serves /v1/models from the union and marks the current model', async () => {
    const res = await doGet(proxyPort, '/v1/models');
    expect(res.status).toBe(200);
    const obj = JSON.parse(res.body) as { data: { id: string; current: boolean }[] };
    expect(obj.data.map((d) => d.id)).toEqual(['fake-model', 'other-model']);
    expect(obj.data[0].current).toBe(true);
    expect(obj.data[1].current).toBe(false);
  });

  it('returns 503 when the server is not ready', async () => {
    ctrl.ready = false;
    const res = await postJson(proxyPort, '/v1/chat/completions', { model: 'fake-model', messages: [] });
    expect(res.status).toBe(503);
    expect(res.body).toContain('not ready');
  });

  it('answers OPTIONS preflight with default CORS headers', async () => {
    const res = await doOptions(proxyPort, '/v1/chat/completions', { origin: 'http://example.com' });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toBe('*');
    expect(res.headers['access-control-allow-headers']).toBe('*');
  });

  it('uses the form CORS origins and reflects the origin when credentials are on', async () => {
    proxy.setForm({ ...DEFAULT_FORM, corsOrigins: 'http://example.com', corsCredentials: true });
    const res = await doOptions(proxyPort, '/v1/chat/completions', { origin: 'http://example.com' });
    expect(res.headers['access-control-allow-origin']).toBe('http://example.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    proxy.setForm({ ...DEFAULT_FORM });
  });

  it('rejects unknown models with 400', async () => {
    const res = await postJson(proxyPort, '/v1/chat/completions', { model: 'nope-model', messages: [] });
    expect(res.status).toBe(400);
    expect(res.body).toContain("model 'nope-model' not found");
  });

  it('auto-switches when the request names another known model', async () => {
    const res = await postJson(proxyPort, '/v1/chat/completions', {
      model: 'other-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('[DONE]');
    expect(ctrl.switchCalls.length).toBe(1);
    expect(ctrl.switchCalls[0].name).toBe('other-model');
    expect(ctrl.current).toBe('other-model');
  });

  it('returns 502 when the switch fails', async () => {
    ctrl.switchImpl = async () => { ctrl._switching = false; throw new Error('boom'); };
    const res = await postJson(proxyPort, '/v1/chat/completions', { model: 'other-model', messages: [] });
    expect(res.status).toBe(502);
    expect(res.body).toContain('failed');
  });

  it('queues requests while switching and forwards them after completion', async () => {
    ctrl.ready = false;
    ctrl._switching = true;
    const p = postJson(proxyPort, '/v1/chat/completions', {
      model: 'fake-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await sleep(400);
    ctrl._switching = false;
    ctrl.ready = true;
    const res = await p;
    expect(res.status).toBe(200);
    expect(res.body).toContain('[DONE]');
  });

  it('rejects with 503 when the switch queue is full', async () => {
    const p2port = await probeFreePort(61500, 61999);
    const p2 = new LauncherProxy({ host: '127.0.0.1', port: p2port, controller: ctrl, form: { ...DEFAULT_FORM }, queueCap: 2 });
    await p2.start();
    ctrl.ready = false;
    ctrl._switching = true;
    const r1 = postJson(p2port, '/v1/chat/completions', { model: 'fake-model', messages: [] });
    const r2 = postJson(p2port, '/v1/chat/completions', { model: 'fake-model', messages: [] });
    const res3 = await postJson(p2port, '/v1/chat/completions', { model: 'fake-model', messages: [] });
    expect(res3.status).toBe(503);
    expect(res3.body).toContain('model switching in progress');
    ctrl._switching = false;
    ctrl.ready = true;
    const [res1, res2] = await Promise.all([r1, r2]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    await p2.stop();
  });

  it('rejects a queued request after the queue timeout', async () => {
    const p2port = await probeFreePort(61500, 61999);
    const p2 = new LauncherProxy({ host: '127.0.0.1', port: p2port, controller: ctrl, form: { ...DEFAULT_FORM }, queueTimeoutMs: 300 });
    await p2.start();
    ctrl.ready = false;
    ctrl._switching = true;
    const res = await postJson(p2port, '/v1/chat/completions', { model: 'fake-model', messages: [] });
    expect(res.status).toBe(503);
    expect(res.body).toContain('model switching in progress');
    ctrl._switching = false;
    ctrl.ready = true;
    await p2.stop();
  });

  it('records prompt and decode when recordRounds is on', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'llama-proxy-rec-'));
    try {
      const records = new RecordsStore(dir, {});
      const p2port = await probeFreePort(61500, 61999);
      const p2 = new LauncherProxy({
        host: '127.0.0.1',
        port: p2port,
        controller: ctrl,
        form: { ...DEFAULT_FORM, recordRounds: true },
        records,
      });
      await p2.start();
      const res = await postJson(p2port, '/v1/chat/completions', {
        model: 'fake-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
      expect(res.status).toBe(200);
      await waitFor(async () => (await records.listFiles()).length > 0);
      const page = await records.tailPage(0);
      expect(page.records.length).toBe(1);
      expect(page.records[0].prompt).toContain('user: hi');
      expect(page.records[0].decode).toBe('hello');
      await p2.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('records reasoning_content as decode for thinking models (empty content)', async () => {
    const backend = http.createServer((req, res) => {
      if (req.url?.startsWith('/v1/chat/completions')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"reasoning_content":"thinking step 1 "}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"reasoning_content":"thinking step 2"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"final answer"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      }
    });
    await new Promise<void>((r) => backend.listen(0, '127.0.0.1', r));
    const bport = (backend.address() as { port: number }).port;
    const dir = await mkdtemp(path.join(os.tmpdir(), 'llama-proxy-reason-'));
    try {
      const records = new RecordsStore(dir, {});
      const p2port = await probeFreePort(61500, 61999);
      const c2 = new FakeController();
      c2.port = bport;
      c2.ready = true;
      c2.current = 'm1';
      c2.models = [ref('m1')];
      const p2 = new LauncherProxy({
        host: '127.0.0.1',
        port: p2port,
        controller: c2,
        form: { ...DEFAULT_FORM, recordRounds: true },
        records,
      });
      await p2.start();
      const res = await postJson(p2port, '/v1/chat/completions', {
        model: 'm1',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
      expect(res.status).toBe(200);
      await waitFor(async () => (await records.listFiles()).length > 0);
      const page = await records.tailPage(0);
      expect(page.records.length).toBe(1);
      expect(page.records[0].decode).toBe('thinking step 1 thinking step 2final answer');
      expect(page.records[0].ttft_ms).not.toBeNull();
      await p2.stop();
    } finally {
      backend.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('parses cached_tokens from the trailing usage chunk (streaming)', async () => {
    const backend = http.createServer((req, res) => {
      if (req.url?.startsWith('/v1/chat/completions')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"A"}}]}\n\n');
        res.write('data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":40}}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      }
    });
    await new Promise<void>((r) => backend.listen(0, '127.0.0.1', r));
    const bport = (backend.address() as { port: number }).port;
    const p2port = await probeFreePort(61500, 61999);
    const c2 = new FakeController();
    c2.port = bport;
    c2.ready = true;
    c2.current = 'm1';
    c2.models = [ref('m1')];
    const s2: RequestStats[] = [];
    const p2 = new LauncherProxy({ host: '127.0.0.1', port: p2port, controller: c2, form: { ...DEFAULT_FORM }, onStats: (s) => s2.push(s) });
    await p2.start();
    const res = await postJson(p2port, '/v1/chat/completions', { model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream: true });
    expect(res.status).toBe(200);
    expect(s2.length).toBe(1);
    expect(s2[0].cacheHitRate).toBeCloseTo(0.4);
    expect(s2[0].ttftMs).toBeGreaterThanOrEqual(0);
    await p2.stop();
    backend.closeAllConnections();
    await new Promise<void>((r) => backend.close(() => r()));
  });

  it('b10488 实测格式：SSE 尾部 chunk 带 timings（无 usage）→ prefill/decode/缓存命中率直读', async () => {
    const backend = http.createServer((req, res) => {
      if (req.url?.startsWith('/v1/chat/completions')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"A"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{}}],"timings":{"cache_n":25,"prompt_n":100,"prompt_ms":5000,"prompt_per_token_ms":50,"prompt_per_second":20,"predicted_n":10,"predicted_ms":700,"predicted_per_token_ms":70,"predicted_per_second":14.3}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      }
    });
    await new Promise<void>((r) => backend.listen(0, '127.0.0.1', r));
    const bport = (backend.address() as { port: number }).port;
    const p2port = await probeFreePort(61500, 61999);
    const c2 = new FakeController();
    c2.port = bport;
    c2.ready = true;
    c2.current = 'm1';
    c2.models = [ref('m1')];
    const s2: RequestStats[] = [];
    const p2 = new LauncherProxy({ host: '127.0.0.1', port: p2port, controller: c2, form: { ...DEFAULT_FORM }, onStats: (s) => s2.push(s) });
    await p2.start();
    const res = await postJson(p2port, '/v1/chat/completions', { model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream: true });
    expect(res.status).toBe(200);
    expect(s2.length).toBe(1);
    expect(s2[0].prefillMs).toBe(5000);
    expect(s2[0].prefillTps).toBe(20);
    expect(s2[0].decodeTps).toBe(14.3);
    expect(s2[0].cacheHitRate).toBeCloseTo(0.25); // timings.cache_n / prompt_n（流式无 usage）
    await p2.stop();
    backend.closeAllConnections();
    await new Promise<void>((r) => backend.close(() => r()));
  });

  it('parses usage and message content from a non-streaming JSON response', async () => {
    const backend = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: 'hi there' } }],
        usage: { prompt_tokens: 50, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 50 } },
      }));
    });
    await new Promise<void>((r) => backend.listen(0, '127.0.0.1', r));
    const bport = (backend.address() as { port: number }).port;
    const p2port = await probeFreePort(61500, 61999);
    const c2 = new FakeController();
    c2.port = bport;
    c2.ready = true;
    c2.current = 'm1';
    c2.models = [ref('m1')];
    const s2: RequestStats[] = [];
    const p2 = new LauncherProxy({ host: '127.0.0.1', port: p2port, controller: c2, form: { ...DEFAULT_FORM }, onStats: (s) => s2.push(s) });
    await p2.start();
    const res = await postJson(p2port, '/v1/chat/completions', { model: 'm1', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    const obj = JSON.parse(res.body) as { choices: { message: { content: string } }[] };
    expect(obj.choices[0].message.content).toBe('hi there');
    expect(s2.length).toBe(1);
    expect(s2[0].cacheHitRate).toBeCloseTo(1);
    expect(s2[0].ttftMs).toBeNull();
    await p2.stop();
    backend.closeAllConnections();
    await new Promise<void>((r) => backend.close(() => r()));
  });

  it('computeCacheHitRate handles missing and zero fields', () => {
    expect(computeCacheHitRate(null)).toBeNull();
    expect(computeCacheHitRate({})).toBeNull();
    expect(computeCacheHitRate({ prompt_tokens: 0, prompt_tokens_details: { cached_tokens: 5 } })).toBeNull();
    expect(computeCacheHitRate({ prompt_tokens: 10 })).toBeNull();
    expect(computeCacheHitRate({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 3 } })).toBeCloseTo(0.3);
  });

  it('autoSwitch off ignores the model field (no switch, no 400)', async () => {
    proxy.setForm({ ...DEFAULT_FORM, autoSwitch: false });
    const res = await postJson(proxyPort, '/v1/chat/completions', {
      model: 'nope-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('"content":"hel"');
    expect(ctrl.switchCalls).toEqual([]);
  });

  it('autoSwitch off: /v1/models lists only the current model', async () => {
    proxy.setForm({ ...DEFAULT_FORM, autoSwitch: false });
    const res = await doGet(proxyPort, '/v1/models');
    expect(res.status).toBe(200);
    const obj = JSON.parse(res.body) as { data: { id: string; current: boolean }[] };
    expect(obj.data).toHaveLength(1);
    expect(obj.data[0].id).toBe('fake-model');
    expect(obj.data[0].current).toBe(true);
  });
});
