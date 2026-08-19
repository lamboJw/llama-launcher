// proxy.ts — 反向代理（可见端口 → 内部端口）+ 自动模型切换（规格 §2.1/§2.3/§5.4/§7/§8）
// CORS 四件套只在代理层处理（计划有意偏差 3）：不给上游 server 传 --cors-origins 等参数
import http from 'node:http';
import type { FormValues, ModelRef, RequestStats } from '../shared/types.js';
import { resolveModelRef } from './hf-cache.js';
import type { RecordsStore } from './records.js';

/** 代理驱动 llama-server 生命周期的接口（注入式，测试可用假控制器解耦 ProcessManager） */
export interface SwitchController {
  /** 转发目标内部端口；server 未运行返回 null */
  internalPort(): number | null;
  /** 后端是否就绪（/health 200） */
  isReady(): boolean;
  /** 当前已加载模型名（原始大小写）；未运行返回 null */
  currentModel(): string | null;
  /** 全部已知模型（本地 ∪ HF） */
  union(): ModelRef[];
  /** 是否正在切换模型 */
  switching(): boolean;
  /** 切换到指定模型；新 server 就绪后 resolve，失败 reject */
  switchTo(ref: ModelRef): Promise<void>;
}

export interface ProxyOptions {
  host: string;
  port: number;
  controller: SwitchController;
  form: FormValues;
  records?: RecordsStore | null;
  onStats?: (s: RequestStats) => void;
  /** 切换期间排队请求上限（默认 10） */
  queueCap?: number;
  /** 排队请求最长等待（默认 5 分钟） */
  queueTimeoutMs?: number;
}

interface QueuedRequest {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  path: string;
  body: Buffer;
  timer: ReturnType<typeof setTimeout>;
}

/** 把原始 SSE 字节流切成完整事件的 data 载荷（处理 \r\n 与跨 chunk 分割） */
class SseParser {
  private buf = '';
  feed(chunk: string): string[] {
    this.buf += chunk.replace(/\r\n/g, '\n');
    const events: string[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf('\n\n')) !== -1) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      const data = raw
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data !== '') events.push(data);
    }
    return events;
  }
}

/** usage.prompt_tokens_details.cached_tokens / prompt_tokens → 命中率（不可计算返回 null） */
export function computeCacheHitRate(usage: unknown): number | null {
  if (usage === null || typeof usage !== 'object') return null;
  const u = usage as { prompt_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } };
  if (typeof u.prompt_tokens !== 'number' || u.prompt_tokens <= 0) return null;
  const ct = u.prompt_tokens_details?.cached_tokens;
  if (typeof ct !== 'number') return null;
  return ct / u.prompt_tokens;
}

export class LauncherProxy {
  private server: http.Server | null = null;
  private opts: ProxyOptions;
  private form: FormValues;
  private records: RecordsStore | null;
  private queue: QueuedRequest[] = [];
  private queuePoll: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: ProxyOptions) {
    this.opts = opts;
    this.form = opts.form;
    this.records = opts.records ?? null;
  }

  setForm(form: FormValues): void {
    this.form = form;
  }

  setRecords(records: RecordsStore | null): void {
    this.records = records;
  }

  async start(): Promise<void> {
    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error) => reject(e);
      server.once('error', onErr);
      server.listen(this.opts.port, this.opts.host, () => {
        server.removeListener('error', onErr);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.stopQueuePoll();
    for (const q of this.queue) {
      clearTimeout(q.timer);
      if (!q.res.headersSent) {
        q.res.writeHead(503, { 'content-type': 'application/json' });
        q.res.end(JSON.stringify({ error: { message: 'llama-server not ready' } }));
      }
    }
    this.queue = [];
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.applyCors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname + (url.search ?? '');
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      this.respondModels(res);
      return;
    }
    let body: Buffer;
    try {
      body = await this.readBody(req);
    } catch {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'request body too large' } }));
      return;
    }
    const ctrl = this.opts.controller;
    if (!ctrl.isReady()) {
      if (ctrl.switching()) this.enqueue(req, res, path, body);
      else this.notReady(res);
      return;
    }
    const model = this.extractModel(body);
    if (model !== null && this.form.autoSwitch) {
      const current = ctrl.currentModel();
      const sameRaw = current !== null && model.toLowerCase() === current.toLowerCase();
      if (!sameRaw) {
        const ref = resolveModelRef(ctrl.union(), model);
        if (ref === null) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `model '${model}' not found` } }));
          return;
        }
        const sameResolved = current !== null && ref.name.toLowerCase() === current.toLowerCase();
        if (!sameResolved) {
          if (ctrl.switching()) {
            this.enqueue(req, res, path, body);
            return;
          }
          await this.doSwitch(ref, req, res, path, body);
          return;
        }
      }
    }
    this.forward(req, res, path, body);
  }

  /** 自动切换：停旧 → 起新 → 转发触发请求；失败时触发请求 502，队列按未就绪放行（规格 §10） */
  private async doSwitch(ref: ModelRef, req: http.IncomingMessage, res: http.ServerResponse, path: string, body: Buffer): Promise<void> {
    try {
      await this.opts.controller.switchTo(ref);
    } catch {
      this.failQueue();
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `model switch to '${ref.name}' failed` } }));
      }
      return;
    }
    this.forward(req, res, path, body);
    this.drainQueue();
  }

  /** 切换中排队：超限 503；等待超时 503 `model switching in progress`（规格 §5.4） */
  private enqueue(req: http.IncomingMessage, res: http.ServerResponse, path: string, body: Buffer): void {
    const cap = this.opts.queueCap ?? 10;
    const timeoutMs = this.opts.queueTimeoutMs ?? 5 * 60 * 1000;
    if (this.queue.length >= cap) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'model switching in progress' } }));
      return;
    }
    const timer = setTimeout(() => {
      const i = this.queue.findIndex((q) => q.req === req);
      if (i !== -1) this.queue.splice(i, 1);
      if (!res.headersSent) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'model switching in progress' } }));
      }
      if (this.queue.length === 0) this.stopQueuePoll();
    }, timeoutMs);
    timer.unref();
    this.queue.push({ req, res, path, body, timer });
    this.ensureQueuePoll();
  }

  /** 切换完成后按队列顺序放行 */
  private drainQueue(): void {
    const pending = this.queue;
    this.queue = [];
    this.stopQueuePoll();
    for (const q of pending) {
      clearTimeout(q.timer);
      this.forward(q.req, q.res, q.path, q.body);
    }
  }

  private failQueue(): void {
    const pending = this.queue;
    this.queue = [];
    this.stopQueuePoll();
    for (const q of pending) {
      clearTimeout(q.timer);
      if (!q.res.headersSent) this.notReady(q.res);
    }
  }

  private ensureQueuePoll(): void {
    if (this.queuePoll !== null || this.queue.length === 0) return;
    this.queuePoll = setInterval(() => {
      if (!this.opts.controller.switching()) this.drainQueue();
    }, 200);
    this.queuePoll.unref();
  }

  private stopQueuePoll(): void {
    if (this.queuePoll !== null) {
      clearInterval(this.queuePoll);
      this.queuePoll = null;
    }
  }

  private notReady(res: http.ServerResponse): void {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'llama-server not ready' } }));
  }

  /** GET /v1/models → 返回并集列表并标记当前模型（不触发切换，规格 §5.4） */
  private respondModels(res: http.ServerResponse): void {
    const ctrl = this.opts.controller;
    const current = ctrl.currentModel();
    // 自动切换关闭时只暴露当前模型（请求 model 字段被忽略，规格 §5）
    const list = this.form.autoSwitch
      ? ctrl.union()
      : current !== null
        ? [{ name: current, source: 'local' as const }]
        : [];
    const data = list.map((m) => ({
      id: m.name,
      object: 'model',
      owned_by: 'llama-launcher',
      current: current !== null && m.name.toLowerCase() === current.toLowerCase(),
    }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data }));
  }

  /** 转发到内部端口；SSE 原样透传，旁路测量 TTFT / usage / prompt / decode */
  private forward(req: http.IncomingMessage, res: http.ServerResponse, path: string, body: Buffer): void {
    const port = this.opts.controller.internalPort();
    if (port === null) {
      this.notReady(res);
      return;
    }
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: `127.0.0.1:${port}` };
    delete headers['transfer-encoding'];
    headers['content-length'] = body.length;
    const t0 = Date.now();
    const upstream = http.request(
      { host: '127.0.0.1', port, path, method: req.method ?? 'GET', headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        const ct = String(up.headers['content-type'] ?? '');
        if (ct.includes('text/event-stream')) this.handleSse(res, up, body, t0);
        else this.handleJson(res, up, body, t0);
      },
    );
    upstream.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `upstream error: ${err.message}` } }));
      } else {
        res.end();
      }
    });
    res.on('close', () => upstream.destroy());
    if (body.length > 0) upstream.write(body);
    upstream.end();
  }

  /** SSE 透传 + TTFT（首个含 content 的块）+ 尾部 usage 块 + decode 累积（recordRounds 门控） */
  private handleSse(res: http.ServerResponse, up: http.IncomingMessage, body: Buffer, t0: number): void {
    const model = this.extractModel(body) ?? this.opts.controller.currentModel() ?? 'unknown';
    const prompt = this.extractPrompt(body);
    let ttftMs: number | null = null;
    let usage: unknown = null;
    let decode = '';
    const parser = new SseParser();
    up.on('data', (chunk: Buffer) => {
      res.write(chunk);
      for (const data of parser.feed(chunk.toString('utf8'))) {
        if (data === '[DONE]') continue;
        let obj: { choices?: { delta?: { content?: unknown } }[]; usage?: unknown } | null = null;
        try {
          obj = JSON.parse(data);
        } catch {
          continue;
        }
        const content = obj?.choices?.[0]?.delta?.content;
        if (typeof content === 'string' && content.length > 0) {
          if (ttftMs === null) ttftMs = Date.now() - t0;
          decode += content;
        }
        if (obj?.usage !== undefined && obj?.usage !== null) usage = obj.usage;
      }
    });
    const finish = () => {
      this.finishStats(model, ttftMs, usage, decode, prompt);
    };
    up.on('end', () => {
      res.end();
      finish();
    });
    up.on('error', () => {
      res.end();
      finish();
    });
  }

  /** 非流式 JSON 透传 + usage / message.content 解析 */
  private handleJson(res: http.ServerResponse, up: http.IncomingMessage, body: Buffer, t0: number): void {
    const model = this.extractModel(body) ?? this.opts.controller.currentModel() ?? 'unknown';
    const prompt = this.extractPrompt(body);
    const chunks: Buffer[] = [];
    up.on('data', (c: Buffer) => {
      res.write(c);
      chunks.push(c);
    });
    const finish = () => {
      let usage: unknown = null;
      let decode = '';
      try {
        const obj = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          usage?: unknown;
          choices?: { message?: { content?: unknown } }[];
        };
        if (obj?.usage !== undefined && obj?.usage !== null) usage = obj.usage;
        const content = obj?.choices?.[0]?.message?.content;
        if (typeof content === 'string') decode = content;
      } catch {
        /* 非 JSON 上游响应：decode 记空 */
      }
      this.finishStats(model, null, usage, decode, prompt);
    };
    up.on('end', () => {
      res.end();
      finish();
    });
    up.on('error', () => {
      res.end();
    });
  }

  private finishStats(model: string, ttftMs: number | null, usage: unknown, decode: string, prompt: string): void {
    const cacheHitRate = computeCacheHitRate(usage);
    this.opts.onStats?.({ model, ttftMs, cacheHitRate, ts: Date.now() });
    if (this.form.recordRounds && this.records !== null) {
      void this.records.append({ ts: Date.now(), model, prompt, decode, ttft_ms: ttftMs, usage });
    }
  }

  /** CORS 四件套：空值默认 *；credentials 开启时反射请求 Origin（规格 §5 服务组） */
  private applyCors(req: http.IncomingMessage, res: http.ServerResponse): void {
    const f = this.form;
    const origin = f.corsOrigins.trim() || '*';
    const requestOrigin = req.headers.origin;
    if (f.corsCredentials) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin && requestOrigin !== '*' ? requestOrigin : origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', f.corsMethods.trim() || '*');
    res.setHeader('Access-Control-Allow-Headers', f.corsHeaders.trim() || '*');
  }

  private readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 16 * 1024 * 1024) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  private extractModel(body: Buffer): string | null {
    if (body.length === 0) return null;
    try {
      const obj = JSON.parse(body.toString('utf8')) as { model?: unknown };
      if (typeof obj.model === 'string' && obj.model.trim() !== '') return obj.model.trim();
      return null;
    } catch {
      return null;
    }
  }

  /** chat: messages 拼成全量 prompt 文本；completions: prompt（字符串或数组） */
  private extractPrompt(body: Buffer): string {
    if (body.length === 0) return '';
    try {
      const obj = JSON.parse(body.toString('utf8')) as { messages?: unknown; prompt?: unknown };
      if (Array.isArray(obj.messages)) {
        return (obj.messages as { role?: unknown; content?: unknown }[])
          .map((m) => `${typeof m.role === 'string' ? m.role : '?'}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')}`)
          .join('\n');
      }
      if (typeof obj.prompt === 'string') return obj.prompt;
      if (Array.isArray(obj.prompt)) return (obj.prompt as unknown[]).map(String).join('');
      return '';
    } catch {
      return '';
    }
  }
}
