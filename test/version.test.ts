import { describe, it, expect } from 'vitest';
import { parseVersion, versionBanner, diagnoseStartupFailure, BASELINE_BUILD } from '../src/main/version.js';

const OLD_OUT = 'version: 9222 (9a532ae4b)\nbuilt with Clang 19.1.5 for Windows x86_64\n';
const NEW_OUT = 'version: 0.1.2-dev (build 10488, commit 9d77fa172)\nbuilt with Clang 20.1.8 for Windows x86_64\n';

describe('parseVersion', () => {
  it('parses old format (v9222 real output)', () => {
    const v = parseVersion(OLD_OUT);
    expect(v.build).toBe(9222);
    expect(v.commit).toBe('9a532ae4b');
    expect(v.raw).toContain('version: 9222');
  });

  it('parses new format (b10488 real output)', () => {
    const v = parseVersion(NEW_OUT);
    expect(v.build).toBe(10488);
    expect(v.commit).toBe('9d77fa172');
  });

  it('unparseable -> nulls, raw kept', () => {
    const v = parseVersion('llama-server: unrecognized option\n');
    expect(v.build).toBeNull();
    expect(v.commit).toBeNull();
    expect(v.raw).not.toBe('');
  });
});

describe('versionBanner', () => {
  it('baseline -> no banner', () => {
    expect(versionBanner(parseVersion(NEW_OUT))).toBeNull();
  });

  it('non-baseline -> banner with version and baseline', () => {
    const b = versionBanner(parseVersion(OLD_OUT));
    expect(b).not.toBeNull();
    expect(b!).toContain('9222');
    expect(b!).toContain('b10488');
  });

  it('unparseable -> no banner', () => {
    expect(versionBanner(parseVersion('???'))).toBeNull();
  });
});

describe('diagnoseStartupFailure', () => {
  const MAP: Record<string, string> = {
    '--n-gpu-layers': 'nGpuLayers',
    '--mmap': 'loadMode',
    '--foo': 'extraArgs',
  };

  it('invalid argument -> mapped field', () => {
    const d = diagnoseStartupFailure(
      'llama_model_loader: failed to load model\nerror: invalid argument: --n-gpu-layers\n',
      MAP,
    );
    expect(d).not.toBeNull();
    expect(d!.arg).toBe('--n-gpu-layers');
    expect(d!.field).toBe('nGpuLayers');
    expect(d!.reason).toBe('invalid');
    expect(d!.message).toContain('nGpuLayers');
  });

  it('removed argument -> mapped field', () => {
    const d = diagnoseStartupFailure(
      'error: the argument --mmap has been removed. Use --load-mode instead.\n',
      MAP,
    );
    expect(d).not.toBeNull();
    expect(d!.arg).toBe('--mmap');
    expect(d!.field).toBe('loadMode');
    expect(d!.reason).toBe('removed');
    expect(d!.message).toContain('loadMode');
  });

  it('extra-args token -> extraArgs field', () => {
    const d = diagnoseStartupFailure('error: invalid argument: --foo\n', MAP);
    expect(d!.field).toBe('extraArgs');
    expect(d!.message).toContain('附加参数');
  });

  it('no known pattern -> null', () => {
    expect(diagnoseStartupFailure('some other fatal error\n', MAP)).toBeNull();
  });
});

it('baseline constant', () => {
  expect(BASELINE_BUILD).toBe(10488);
});