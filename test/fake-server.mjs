// fake-server.mjs — 测试替身：模拟 llama-server 的 /health、SSE、崩溃与 SIGTERM 行为
// 环境变量：FAKE_PORT、FAKE_HEALTH_DELAY_MS、FAKE_CRASH_MS、FAKE_CRASH_MSG、FAKE_IGNORE_SIGTERM
// slots API（设计规格 §6）：FAKE_SLOTS_N（默认 2）、FAKE_SLOT_DIR（标记文件目录）、
// FAKE_SLOT_FAIL=1（save/restore → 500）、FAKE_REQ_LOG（每请求追加一行 "METHOD url"）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

if (process.env.FAKE_DUMP_ENV === '1') {
  console.log(`FAKE_PATH=${process.env.PATH ?? ''}`);
}

const port = Number(process.env.FAKE_PORT || '59900');
const slotsN = Number(process.env.FAKE_SLOTS_N || '2');
const slotIds = Array.from({ length: slotsN }, (_, i) => i);
const readyAt = Date.now() + Number(process.env.FAKE_HEALTH_DELAY_MS || '0');

const server = http.createServer((req, res) => {
  if (process.env.FAKE_REQ_LOG) fs.appendFileSync(process.env.FAKE_REQ_LOG, `${req.method} ${req.url}\n`);
  if (req.url === '/health') {
    if (Date.now() < readyAt) { res.writeHead(503); res.end('loading'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":"ok"}');
    return;
  }
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[{"id":"fake-model"}]}');
    return;
  }
  if (req.url === '/v1/chat/completions') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n');
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }, 20);
    return;
  }
  if (req.url === '/slots') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ default: 0, slots: slotIds.map((id) => ({ id })) }));
    return;
  }
  const slotAction = /^\/slots\/(\d+)\?action=(save|restore)$/.exec(req.url);
  if (slotAction) {
    if (process.env.FAKE_SLOT_FAIL === '1') { res.writeHead(500); res.end('fake slot action failed'); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let filename = '';
      try { filename = JSON.parse(body).filename ?? ''; } catch { /* 非法 JSON → 按缺失处理 */ }
      if (typeof filename !== 'string' || filename === '') { res.writeHead(400); res.end('missing filename'); return; }
      if (process.env.FAKE_SLOT_DIR) {
        const marker = path.join(process.env.FAKE_SLOT_DIR, filename);
        if (slotAction[2] === 'save') {
          fs.mkdirSync(process.env.FAKE_SLOT_DIR, { recursive: true });
          fs.writeFileSync(marker, 'saved');
        } else if (!fs.existsSync(marker)) {
          res.writeHead(400); res.end('no such save'); return;
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
    });
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`fake-server ready on ${port}`);
});

const crashMs = process.env.FAKE_CRASH_MS ? Number(process.env.FAKE_CRASH_MS) : null;
if (crashMs !== null) {
  setTimeout(() => {
    process.stderr.write((process.env.FAKE_CRASH_MSG || 'error: invalid argument: --fake-flag') + '\n');
    process.exit(1);
  }, crashMs);
}

if (process.env.FAKE_IGNORE_SIGTERM === '1') {
  process.on('SIGTERM', () => { /* 忽略，用于强杀路径测试 */ });
} else {
  process.on('SIGTERM', () => process.exit(0));
}