// slot-cache.test.ts — slot 上下文保存/恢复（设计规格 §1/§6）
// 测试替身：fake-server.mjs（真实 spawn，node 二进制充当 llama-server）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { probeFreePort } from '../src/main/process-manager.js';
import { sanitizeModelName, slotFileName, findSlotSaves, SlotCache } from '../src/main/slot-cache.js';

describe('sanitizeModelName', () => {
  it('Windows 非法字符替换为 _', () => {
    expect(sanitizeModelName('a/b:c*d?e"f<g>h|i')).toBe('a_b_c_d_e_f_g_h_i');
  });

  it('去尾部点号与空白', () => {
    expect(sanitizeModelName('model. ')).toBe('model');
    expect(sanitizeModelName('model...')).toBe('model');
  });

  it('净化后为空 → model', () => {
    expect(sanitizeModelName('')).toBe('model');
    // 仅替换非法字符（空白不在其中）；'///' → '___' 非空，不触发回退
    expect(sanitizeModelName('///')).toBe('___');
  });

  it('点保留（HF repo 名含 .）', () => {
    expect(sanitizeModelName('unsloth/Qwen3.8-27B-GGUF')).toBe('unsloth_Qwen3.8-27B-GGUF');
  });
});

describe('slotFileName', () => {
  it('<净化名>_<slotId>.bin', () => {
    expect(slotFileName('unsloth/Qwen3.8-27B-GGUF', 0)).toBe('unsloth_Qwen3.8-27B-GGUF_0.bin');
    // 空白是合法文件名字符，不替换
    expect(slotFileName('my model', 3)).toBe('my model_3.bin');
  });
});

describe('findSlotSaves', () => {
  it('匹配 <净化名>_<id>.bin；无关文件忽略', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-saves-'));
    try {
      fs.writeFileSync(path.join(dir, 'm_0.bin'), 'x');
      fs.writeFileSync(path.join(dir, 'm_1.bin'), 'x');
      fs.writeFileSync(path.join(dir, 'm_2.txt'), 'x');      // 后缀错
      fs.writeFileSync(path.join(dir, 'other_0.bin'), 'x');  // 模型名不同
      fs.writeFileSync(path.join(dir, 'm_.bin'), 'x');       // 无 id
      fs.writeFileSync(path.join(dir, 'm_-1.bin'), 'x');     // 负数
      const m = findSlotSaves(dir, 'm');
      expect([...m.keys()].sort((a, b) => a - b)).toEqual([0, 1]);
      expect(m.get(0)).toBe(path.join(dir, 'm_0.bin'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('目录不存在 → 空 Map', () => {
    expect(findSlotSaves(path.join(os.tmpdir(), 'no-such-dir-xyz-123'), 'm').size).toBe(0);
  });
});

const FAKE = fileURLToPath(new URL('./fake-server.mjs', import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface FakeServer { port: number; stop: () => Promise<void> }

async function startFakeServer(env: Record<string, string> = {}): Promise<FakeServer> {
  const port = await probeFreePort();
  const proc: ChildProcess = spawn(process.execPath, [FAKE], {
    env: { ...process.env, FAKE_PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error('fake-server 启动超时')), 5000);
    proc.stdout?.on('data', (c: Buffer) => {
      out += c.toString();
      if (out.includes(`fake-server ready on ${port}`)) { clearTimeout(t); resolve(); }
    });
    proc.on('exit', (code) => { clearTimeout(t); reject(new Error(`fake-server 提前退出 code=${code}`)); });
  });
  return {
    port,
    stop: async () => {
      proc.kill();
      await sleep(300);
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      await sleep(100);
    },
  };
}

describe('SlotCache（fake-server 真实 spawn）', () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-cache-test-'));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('saveAll：2 slot → 2 个标记文件（名称正确）', async () => {
    const fake = await startFakeServer({ FAKE_SLOT_DIR: dir });
    try {
      const sc = new SlotCache({ dir, timeoutMs: 5000 });
      await sc.saveAll(fake.port, 'unsloth/Qwen3.8-27B-GGUF');
      expect(fs.existsSync(path.join(dir, 'unsloth_Qwen3.8-27B-GGUF_0.bin'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'unsloth_Qwen3.8-27B-GGUF_1.bin'))).toBe(true);
    } finally {
      await fake.stop();
    }
  });

  it('saveAll：FAKE_SLOT_FAIL → 抛错（全部失败）', async () => {
    const fake = await startFakeServer({ FAKE_SLOT_DIR: dir, FAKE_SLOT_FAIL: '1' });
    try {
      const sc = new SlotCache({ dir, timeoutMs: 5000 });
      await expect(sc.saveAll(fake.port, 'm')).rejects.toThrow(/全部 2 个 slot 保存失败/);
    } finally {
      await fake.stop();
    }
  });

  it('restoreAll：无存档 → 无请求', async () => {
    const reqLog = path.join(dir, 'reqlog-1.txt');
    fs.writeFileSync(reqLog, ''); // 预创建：无请求时 fake-server 不会建文件
    const fake = await startFakeServer({ FAKE_SLOT_DIR: dir, FAKE_REQ_LOG: reqLog });
    try {
      const sc = new SlotCache({ dir, timeoutMs: 5000 });
      await sc.restoreAll(fake.port, 'no-such-model');
      expect(fs.readFileSync(reqLog, 'utf8')).not.toContain('/slots');
    } finally {
      await fake.stop();
    }
  });

  it('restoreAll：有存档 → 成功（不抛错）', async () => {
    const fake = await startFakeServer({ FAKE_SLOT_DIR: dir });
    try {
      const sc = new SlotCache({ dir, timeoutMs: 5000 });
      await sc.saveAll(fake.port, 'restore-m');
      await sc.restoreAll(fake.port, 'restore-m');
    } finally {
      await fake.stop();
    }
  });

  it('restoreAll：slot 不存在的存档 → 跳过（无请求）', async () => {
    const reqLog = path.join(dir, 'reqlog-2.txt');
    const fake = await startFakeServer({ FAKE_SLOT_DIR: dir, FAKE_SLOTS_N: '1', FAKE_REQ_LOG: reqLog });
    try {
      fs.writeFileSync(path.join(dir, 'skip-m_0.bin'), 'x');
      fs.writeFileSync(path.join(dir, 'skip-m_1.bin'), 'x');
      const logs: string[] = [];
      const sc = new SlotCache({ dir, timeoutMs: 5000, onLog: (l) => logs.push(l) });
      await sc.restoreAll(fake.port, 'skip-m');
      const log = fs.readFileSync(reqLog, 'utf8');
      expect(log).toContain('/slots/0?action=restore');
      expect(log).not.toContain('/slots/1?action=restore');
      expect(logs.some((l) => l.includes('跳过 slot 1'))).toBe(true);
    } finally {
      await fake.stop();
    }
  });

  it('restoreAll：全部失败 → 抛错', async () => {
    const fake = await startFakeServer({ FAKE_SLOT_DIR: dir, FAKE_SLOT_FAIL: '1' });
    try {
      fs.writeFileSync(path.join(dir, 'fail-all_0.bin'), 'x');
      fs.writeFileSync(path.join(dir, 'fail-all_1.bin'), 'x');
      const sc = new SlotCache({ dir, timeoutMs: 5000 });
      await expect(sc.restoreAll(fake.port, 'fail-all')).rejects.toThrow(/全部 2 个 slot 恢复失败/);
    } finally {
      await fake.stop();
    }
  });
});
