/** The store: tamper-evident transition log, strict settings, cross-call locking. */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newProgram, smallTeamCharter } from '@kernelpai/program';
import { configFrom } from './config.js';
import { withLock } from './lock.js';
import { newMeta } from './meta.js';
import { EnterpriseStore } from './store.js';

const NOW = new Date('2026-10-23T10:00:00.000Z');

function store(): EnterpriseStore {
  return new EnterpriseStore(mkdtempSync(join(tmpdir(), 'kpai-ent-')));
}

function seed(s: EnterpriseStore): string {
  const charter = smallTeamCharter({
    programId: 'prog-1',
    goal: 'g',
    locale: 'en',
    totalCapUsd: 5,
    workPackages: [{ title: 't', request: 'r' }],
    now: NOW,
  });
  s.create('prog-1', { state: newProgram(charter, NOW), meta: newMeta(NOW) });
  return 'prog-1';
}

describe('EnterpriseStore', () => {
  it('logs every transition, refused ones too, in a hash chain that shows tampering', async () => {
    const s = store();
    const id = seed(s);
    const charter = s.read(id).state.charter;
    expect((await s.apply(id, { type: 'propose', charter }, 'po', NOW)).ok).toBe(true);
    expect((await s.apply(id, { type: 'approve', charterHash: 'x' }, 'po', NOW)).ok).toBe(false);
    const h = s.history(id);
    expect(h.ok).toBe(true);
    expect(h.entries.map((e) => [e['type'], e['ok']])).toEqual([
      ['created', true],
      ['propose', true],
      ['approve', false],
    ]);
    const path = s.file(id, 'events.jsonl');
    writeFileSync(path, readFileSync(path, 'utf8').replace('"po"', '"sponsor"'));
    expect(s.history(id).ok).toBe(false);
  });

  it('refuses a second program with the same id and ids that are not ids', () => {
    const s = store();
    seed(s);
    expect(() => seed(s)).toThrow(/exists/);
    expect(() => s.file('../x', 'state.json')).toThrow(/not a program id/);
    expect(s.has('../x')).toBe(false);
    expect(s.ids()).toEqual(['prog-1']);
  });

  it('settings are strict; defaults fill the gaps', () => {
    expect(configFrom({}).portfolio.limits.total).toBe(2);
    expect(configFrom({ usdPerHour: 2 }).usdPerHour).toBe(2);
    expect(() => configFrom({ usdPerHour: 2, typo: 1 })).toThrow();
  });

  it('a lock serializes writers and is taken over from a dead owner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kpai-lock-'));
    const path = join(dir, '.lock');
    const order: string[] = [];
    await Promise.all([
      withLock(path, async () => {
        order.push('a1');
        await new Promise((r) => setTimeout(r, 20));
        order.push('a2');
      }),
      withLock(path, () => void order.push('b')),
    ]);
    expect(order).toEqual(['a1', 'a2', 'b']);
    writeFileSync(path, '999999999');
    expect(await withLock(path, () => 'taken')).toBe('taken');
    writeFileSync(path, String(process.ppid));
    await expect(withLock(path, () => 'x', { timeoutMs: 50 })).rejects.toThrow(/locked/);
  });
});
