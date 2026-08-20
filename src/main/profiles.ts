// profiles.ts — 每模型参数档案（规格 §5.1）
// 存储：<appDataDir>/profiles/<sha256(model).slice(0,16)>.json
// 损坏档案 → 忽略（按无档案处理）；原子写（tmp + rename）
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { FormValues, Profile } from '../shared/types.js';
import { migrateForm } from './config.js';

export function profileFileFor(dir: string, model: string): string {
  const hash = createHash('sha256').update(model).digest('hex').slice(0, 16);
  return path.join(dir, hash + '.json');
}

function isProfile(p: unknown): p is Profile {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  return typeof o.model === 'string' && typeof o.params === 'object' && o.params !== null;
}

export class ProfilesStore {
  constructor(private dir: string) {}

  async save(model: string, params: FormValues): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const p: Profile = { model, params, savedAt: Date.now() };
    const final = profileFileFor(this.dir, model);
    const tmp = final + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(p, null, 2), 'utf8');
    await fs.rename(tmp, final);
  }

  async load(model: string): Promise<Profile | null> {
    try {
      const raw = await fs.readFile(profileFileFor(this.dir, model), 'utf8');
      const p: unknown = JSON.parse(raw);
      return isProfile(p) ? { ...p, params: migrateForm(p.params) } : null;
    } catch { return null; }
  }

  async delete(model: string): Promise<void> {
    try { await fs.unlink(profileFileFor(this.dir, model)); } catch { /* 不存在 */ }
  }

  /** 全部有效档案，最新在前；损坏文件跳过 */
  async list(): Promise<Profile[]> {
    let entries: string[] = [];
    try { entries = await fs.readdir(this.dir); } catch { return []; }
    const out: Profile[] = [];
    for (const e of entries) {
      if (!e.endsWith('.json')) continue;
      try {
        const p: unknown = JSON.parse(await fs.readFile(path.join(this.dir, e), 'utf8'));
        if (isProfile(p)) out.push({ ...p, params: migrateForm(p.params) });
      } catch { /* 损坏 → 忽略 */ }
    }
    out.sort((a, b) => b.savedAt - a.savedAt);
    return out;
  }
}