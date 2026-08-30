// slot-cache.test.ts — slot 上下文保存/恢复（设计规格 §1/§6）
// 测试替身：fake-server.mjs（真实 spawn，node 二进制充当 llama-server）
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sanitizeModelName, slotFileName, findSlotSaves } from '../src/main/slot-cache.js';

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
