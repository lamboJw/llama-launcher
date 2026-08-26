// fake-server.mjs — 测试替身：模拟 llama-server 的 /health、SSE、崩溃与 SIGTERM 行为
// 环境变量：FAKE_PORT、FAKE_HEALTH_DELAY_MS、FAKE_CRASH_MS、FAKE_CRASH_MSG、FAKE_IGNORE_SIGTERM
import http from 'node:http';

if (process.env.FAKE_DUMP_ENV === '1') {
  console.log(`FAKE_PATH=${process.env.PATH ?? ''}`);
}

const port = Number(process.env.FAKE_PORT || '59900');
const readyAt = Date.now() + Number(process.env.FAKE_HEALTH_DELAY_MS || '0');

const server = http.createServer((req, res) => {
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