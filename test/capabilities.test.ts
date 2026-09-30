// capabilities.test.ts — --help 能力探测与 argv 过滤（kvmem 等 fork 参数面兼容）
import { describe, it, expect } from 'vitest';
import { parseHelpFlags, filterArgv, getSupportedFlags, clearFlagCache } from '../src/main/capabilities.js';

describe('parseHelpFlags', () => {
  it('从 help 文本提取全部长参数名（含短选项行中的长名与描述提及）', () => {
    const help = [
      'Options:',
      '  -m, --model PATH           GGUF path',
      '  -lv, --verbosity N         log level (default: 3)',
      '  -p, --port PORT            port (default: 8080)',
      '      --no-webui             disable web ui',
      'use --kvmem-budget to limit KV bytes',
    ].join('\n');
    const flags = parseHelpFlags(help);
    expect(flags.has('--model')).toBe(true);
    expect(flags.has('--verbosity')).toBe(true);
    expect(flags.has('--port')).toBe(true);
    expect(flags.has('--no-webui')).toBe(true);
    expect(flags.has('--kvmem-budget')).toBe(true);
    expect(flags.has('-m')).toBe(false);
  });
});

describe('filterArgv', () => {
  it('supported 为 null 时原样返回、不移除任何参数', () => {
    const input = ['--model', 'a.gguf', '--metrics', '--warmup'];
    const r = filterArgv(input, null);
    expect(r.argv).toEqual(input);
    expect(r.removed).toEqual([]);
  });

  it('移除不支持的 flag 及其后值，保留支持的 flag 值对', () => {
    const r = filterArgv(
      ['--model', 'a.gguf', '--metrics', '--host', '127.0.0.1', '--port', '12345'],
      new Set(['--model', '--host', '--port']),
    );
    expect(r.argv).toEqual(['--model', 'a.gguf', '--host', '127.0.0.1', '--port', '12345']);
    expect(r.removed).toEqual(['--metrics']);
  });

  it('不支持的 flag 后紧跟 -- 开头 token 时不吞掉下一个 flag', () => {
    const r = filterArgv(
      ['--log-colors', 'on', '--metrics', '--host', '127.0.0.1'],
      new Set(['--host']),
    );
    expect(r.argv).toEqual(['--host', '127.0.0.1']);
    expect(r.removed).toEqual(['--log-colors', '--metrics']);
  });

  it('--flag=value 形式按 flag 名整体判断', () => {
    const r = filterArgv(['--warmup=1', '--port=80'], new Set(['--port']));
    expect(r.argv).toEqual(['--port=80']);
    expect(r.removed).toEqual(['--warmup']);
  });

  it('开头的孤立裸 token 保守保留', () => {
    const r = filterArgv(['bare', '--unknown', 'x'], new Set());
    expect(r.argv).toEqual(['bare']);
    expect(r.removed).toEqual(['--unknown']);
  });

  it('重复出现的不支持 flag 均移除且 removed 去重', () => {
    const r = filterArgv(
      ['--spec-type', 'a', '--spec-type', 'b', '--port', '1'],
      new Set(['--port']),
    );
    expect(r.argv).toEqual(['--port', '1']);
    expect(r.removed).toEqual(['--spec-type']);
  });

  it('负数/短横线值属于前一 flag 的值，不单独按 flag 判断', () => {
    const r = filterArgv(['--n-gpu-layers', '-1'], new Set(['--n-gpu-layers']));
    expect(r.argv).toEqual(['--n-gpu-layers', '-1']);
    expect(r.removed).toEqual([]);
  });
});

describe('getSupportedFlags', () => {
  it('非 server 的 help（无 --port）→ null 且不缓存为可用集合', async () => {
    clearFlagCache();
    const r = await getSupportedFlags(process.execPath); // node --help 不含 --port
    expect(r).toBeNull();
  }, 20000);
});
