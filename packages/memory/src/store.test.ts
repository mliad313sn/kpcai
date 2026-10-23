import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { zoneSetFromGlobs, DEFAULT_ZONES } from '@kernelpai/tools';
import { KeyedLock, memoryFile, pendingFile, repoHash } from './files.js';
import { cleanText, forbiddenMention, screenFact } from './guard.js';
import { MemoryStore, sameScope } from './store.js';
import { MemoryError, type MemoryScope } from './types.js';

const NOW = () => new Date('2026-10-23T10:00:00Z');
const PROJECT: MemoryScope = { layer: 'project', repo: '/work/repo' };

function store(extra: Partial<ConstructorParameters<typeof MemoryStore>[0]> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'kpai-mem-'));
  return { home, s: new MemoryStore({ home, now: NOW, ...extra }) };
}

describe('memory files', () => {
  it('live under $KPAI_HOME: user, projects/<repo-hash>, sessions', () => {
    expect(memoryFile('/h', { layer: 'user' })).toBe(join('/h', 'memory', 'user.md'));
    expect(memoryFile('/h', PROJECT)).toBe(
      join('/h', 'projects', repoHash('/work/repo'), 'memory.md'),
    );
    expect(repoHash('/work/repo')).toMatch(/^[0-9a-f]{16}$/);
    expect(memoryFile('/h', { layer: 'session', sessionId: 's-1' })).toBe(
      join('/h', 'memory', 'sessions', 's-1.md'),
    );
    expect(() => memoryFile('/h', { layer: 'session', sessionId: '../x' })).toThrow(MemoryError);
    expect(pendingFile('/h')).toBe(join('/h', 'memory', 'pending.json'));
  });

  it('serializes read-modify-write per key, even after a failure', async () => {
    const lock = new KeyedLock();
    const order: number[] = [];
    const a = lock.run('k', async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(1);
      throw new Error('x');
    });
    const b = lock.run('k', () => Promise.resolve(order.push(2)));
    await expect(a).rejects.toThrow('x');
    await b;
    expect(order).toEqual([1, 2]);
  });
});

describe('human facts: list, add, edit, remove', () => {
  it('adds with provenance and keeps a readable Markdown file', async () => {
    const { s } = store();
    const f = await s.add(PROJECT, '  Use pnpm,\n never npm. ', { evidence: ['event:12'] });
    expect(f).toMatchObject({
      layer: 'project',
      text: 'Use pnpm, never npm.',
      provenance: { source: 'human', date: '2026-10-23', evidence: ['event:12'], localOnly: false },
    });
    const g = await s.add(PROJECT, 'Staging is on the VPN', { localOnly: true });
    const l = await s.list(PROJECT);
    expect(l.exists).toBe(true);
    expect(l.facts.map((x) => x.id)).toEqual([f.id, g.id]);
    const text = readFileSync(l.file, 'utf8');
    expect(text).toMatch(/^---\nkpai: memory\nversion: 1\nlayer: project\nrepo: \/work\/repo\n---/);
    expect(text).toContain(
      `- Staging is on the VPN <!-- kpai id=${g.id} source=human date=2026-10-23 local-only -->`,
    );
  });

  it('edits text and flag, keeps source and date, and removes', async () => {
    const { s } = store();
    const f = await s.add({ layer: 'user' }, 'Prefers British English');
    const e = await s.edit({ layer: 'user' }, f.id, {
      text: 'Prefers US English',
      localOnly: true,
    });
    expect(e.text).toBe('Prefers US English');
    expect(e.provenance).toMatchObject({ source: 'human', edited: '2026-10-23', localOnly: true });
    const e2 = await s.edit({ layer: 'user' }, f.id, {});
    expect(e2.text).toBe('Prefers US English');
    await expect(s.edit({ layer: 'user' }, 'm-nope', { text: 'x' })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await s.remove({ layer: 'user' }, f.id)).id).toBe(f.id);
    await expect(s.remove({ layer: 'user' }, f.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await s.list({ layer: 'user' })).facts).toEqual([]);
  });

  it('keeps hand edits and prose when the store writes the file again', async () => {
    const { s } = store();
    const file = memoryFile(s['o'].home, { layer: 'user' });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '# Mine\n\nNotes stay.\n\n- typed by hand\n');
    await s.add({ layer: 'user' }, 'added later');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('Notes stay.');
    expect(text).toMatch(/- typed by hand <!-- kpai id=m-[0-9a-f]{8} source=human -->/);
    const l = await s.list({ layer: 'user' });
    expect(l.facts.map((f) => f.text)).toEqual(['typed by hand', 'added later']);
    expect(l.problems).toEqual([]);
  });
});

describe('screening: redaction and forbidden zones', () => {
  it('redacts secrets before they are stored', async () => {
    const { s } = store({ secrets: ['hunter2-very-secret-value'] });
    const f = await s.add(
      PROJECT,
      'Token is sk-abcdefghijklmnopqrstuvwx and pw hunter2-very-secret-value',
    );
    expect(f.text).toBe('Token is [redacted] and pw [redacted]');
    const text = readFileSync((await s.list(PROJECT)).file, 'utf8');
    expect(text).not.toContain('sk-abc');
    expect(text).not.toContain('hunter2');
  });

  it('refuses a fact naming a path in a forbidden zone', async () => {
    const { s } = store();
    for (const bad of [
      'The deploy key is in ~/.ssh/id_ed25519',
      'Load settings from .env first',
      'see config/secrets.yaml for the values',
      'Creds live in `deploy/my-secret-notes.txt`',
    ]) {
      await expect(s.add(PROJECT, bad)).rejects.toMatchObject({ code: 'refused' });
      await expect(
        s.propose({ scope: PROJECT, text: bad }, { source: 'mock/m1' }),
      ).rejects.toMatchObject({ code: 'refused' });
    }
    expect((await s.list(PROJECT)).facts).toEqual([]);
    expect(await s.pending()).toEqual([]);
    // A word that only looks like a heuristic zone, not a path, is fine.
    await expect(s.add(PROJECT, 'The secret-manager module rotates keys')).resolves.toBeTruthy();
  });

  it('applies the zones it is given (pack additions)', () => {
    const zones = zoneSetFromGlobs([...DEFAULT_ZONES, 'clients/**']);
    expect(forbiddenMention('see clients/acme/brief.md', zones)).toBe('clients/**');
    expect(forbiddenMention('see clients/acme/brief.md')).toBeUndefined();
    expect(forbiddenMention('C:\\Users\\me\\.aws\\credentials')).toBe('**/.aws/**');
  });

  it('cleans text to one line and caps it', () => {
    expect(cleanText('a\u0007b\u202e c <!-- x --> d')).toBe('a b c x d');
    expect(() => screenFact('   ')).toThrow(/needs some text/);
    expect(() => screenFact('x'.repeat(1001))).toThrow(/at most/);
  });
});

describe('model proposals: propose, confirm, reject', () => {
  const from = { source: 'mock-alpha/m1', evidence: ['run:r1', 'node:code'] };

  it('queues a proposal and stores nothing until a human confirms', async () => {
    const { s } = store();
    const p = await s.propose({ scope: PROJECT, text: 'Tests use vitest' }, from);
    expect(p.provenance).toEqual({
      source: 'mock-alpha/m1',
      date: '2026-10-23',
      evidence: ['run:r1', 'node:code'],
      localOnly: false,
    });
    expect((await s.list(PROJECT)).facts).toEqual([]);
    expect((await s.list(PROJECT)).exists).toBe(false);
    expect((await s.pending()).map((x) => x.id)).toEqual([p.id]);
    // The same proposal again is the same pending entry.
    expect((await s.propose({ scope: PROJECT, text: 'Tests use vitest' }, from)).id).toBe(p.id);
    const f = await s.confirm(p.id);
    expect(f).toMatchObject({ id: p.id, text: 'Tests use vitest' });
    expect(f.provenance).toMatchObject({ source: 'mock-alpha/m1', confirmed: '2026-10-23' });
    expect(await s.pending()).toEqual([]);
    expect((await s.list(PROJECT)).facts.map((x) => x.id)).toEqual([p.id]);
    await expect(s.confirm(p.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      s.propose({ scope: PROJECT, text: 'Tests use vitest' }, from),
    ).rejects.toMatchObject({ code: 'refused' });
  });

  it('rejects, refuses human sources and caps the queue', async () => {
    const { s } = store({ maxPending: 2 });
    await expect(s.propose({ scope: PROJECT, text: 'x' }, { source: 'human' })).rejects.toThrow(
      /human adds/,
    );
    const a = await s.propose({ scope: { layer: 'user' }, text: 'a', localOnly: true }, from);
    await s.propose({ scope: { layer: 'session', sessionId: 's1' }, text: 'b' }, from);
    await expect(s.propose({ scope: PROJECT, text: 'c' }, from)).rejects.toThrow(/queue is full/);
    expect((await s.reject(a.id)).text).toBe('a');
    expect((await s.pending()).map((p) => p.text)).toEqual(['b']);
    expect((await s.list({ layer: 'user' })).facts).toEqual([]);
  });

  it('keeps a proposal pending when today’s zones refuse it at confirmation', async () => {
    const { home, s } = store();
    const p = await s.propose({ scope: PROJECT, text: 'Briefs are in clients/acme' }, from);
    const strict = new MemoryStore({
      home,
      now: NOW,
      zones: zoneSetFromGlobs([...DEFAULT_ZONES, 'clients/**']),
    });
    await expect(strict.confirm(p.id)).rejects.toMatchObject({ code: 'refused' });
    expect((await s.pending()).map((x) => x.id)).toEqual([p.id]);
  });

  it('ignores a corrupt or hand-broken pending file', async () => {
    const { home, s } = store();
    mkdirSync(join(home, 'memory'), { recursive: true });
    writeFileSync(pendingFile(home), '{not json');
    expect(await s.pending()).toEqual([]);
    writeFileSync(pendingFile(home), JSON.stringify([{ id: 'x' }, 'y']));
    expect(await s.pending()).toEqual([]);
    writeFileSync(pendingFile(home), JSON.stringify({ id: 'x' }));
    expect(await s.pending()).toEqual([]);
  });

  it('compares scopes', () => {
    expect(sameScope(PROJECT, { layer: 'project', repo: '/other' })).toBe(false);
    expect(sameScope({ layer: 'user' }, { layer: 'user' })).toBe(true);
    expect(sameScope({ layer: 'user' }, PROJECT)).toBe(false);
    expect(
      sameScope({ layer: 'session', sessionId: 'a' }, { layer: 'session', sessionId: 'a' }),
    ).toBe(true);
  });
});
