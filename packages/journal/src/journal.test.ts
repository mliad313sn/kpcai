import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Journal } from './journal.js';
import { sessionToMarkdown } from './markdown.js';
import { GENESIS_HASH } from './hash.js';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js';

const open: Journal[] = [];
function fresh(path = ':memory:'): Journal {
  let t = Date.parse('2026-10-23T10:00:00Z');
  const j = Journal.open(path, { now: () => new Date((t += 1000)) });
  open.push(j);
  return j;
}
afterEach(() => {
  while (open.length) open.pop()?.close();
});

describe('Journal', () => {
  it('appends hash-chained events and lists them per session', () => {
    const j = fresh();
    const s = j.startSession('first', '/repo');
    const a = j.append({
      sessionId: s,
      type: 'routing',
      provider: 'mock',
      model: 'echo',
      payload: { reason: 'r' },
    });
    const b = j.append({ sessionId: s, type: 'response', costUsd: 0.5, payload: { text: 'hi' } });
    expect(a.prevHash).toBe(GENESIS_HASH);
    expect(b.prevHash).toBe(a.hash);
    expect(b.seq).toBe(a.seq + 1);
    expect(j.events({ sessionId: s }).map((e) => e.type)).toEqual(['routing', 'response']);
    const [row] = j.sessions();
    expect(row).toMatchObject({ id: s, title: 'first', eventCount: 2, costUsd: 0.5 });
    expect(j.findSession(s.slice(0, 6))?.id).toBe(s);
    expect(j.verify()).toEqual({ ok: true, checked: 2 });
  });

  it('returns the most recent events across sessions in order', () => {
    const j = fresh();
    const s1 = j.startSession('a', '/');
    const s2 = j.startSession('b', '/');
    j.append({ sessionId: s1, type: 'call', payload: {} });
    j.append({ sessionId: s2, type: 'call', payload: {} });
    j.append({ sessionId: s2, type: 'error', payload: {} });
    const last2 = j.events({ limit: 2 });
    expect(last2.map((e) => e.sessionId)).toEqual([s2, s2]);
    expect(last2[0]!.seq).toBeLessThan(last2[1]!.seq);
    expect(j.sessions().map((s) => s.id)).toEqual([s2, s1]);
  });

  it('rejects unknown event types and unknown sessions', () => {
    const j = fresh();
    // @ts-expect-error deliberate bad type
    expect(() => j.append({ sessionId: 'x', type: 'bogus', payload: {} })).toThrow(
      /Unknown event type/,
    );
    expect(() => j.append({ sessionId: 'missing', type: 'call', payload: {} })).toThrow();
  });

  it('detects tampering with a stored event', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'kpai-')), 'nested', 'j.db');
    const j = fresh(path);
    const s = j.startSession('t', '/');
    j.append({ sessionId: s, type: 'call', payload: { n: 1 } });
    const victim = j.append({
      sessionId: s,
      type: 'response',
      costUsd: 0.01,
      payload: { text: 'real' },
    });
    j.append({ sessionId: s, type: 'call', payload: { n: 3 } });
    const raw = new DatabaseSync(path);
    raw.prepare('UPDATE events SET payload = ? WHERE seq = ?').run('{"text":"forged"}', victim.seq);
    raw.close();
    expect(j.verify()).toEqual({ ok: false, checked: 1, brokenAt: victim.seq });
  });

  it('reopens an existing file without re-running migrations', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'kpai-')), 'j.db');
    const j1 = Journal.open(path);
    j1.append({ sessionId: j1.startSession('x', '/'), type: 'call', payload: {} });
    j1.close();
    const j2 = fresh(path);
    expect(j2.events()).toHaveLength(1);
    expect(j2.verify().ok).toBe(true);
  });
});

describe('sessionToMarkdown', () => {
  it('renders a readable timeline and the answer', () => {
    const j = fresh();
    const s = j.startSession('md', '/repo');
    j.append({
      sessionId: s,
      type: 'routing',
      provider: 'p',
      model: 'm',
      payload: { reason: 'why' },
    });
    j.append({ sessionId: s, type: 'call', payload: { estimatedInputTokens: 12 } });
    j.append({ sessionId: s, type: 'intervention', payload: { action: 'cancel' } });
    j.append({ sessionId: s, type: 'error', payload: { kind: 'auth', message: 'no key' } });
    j.append({ sessionId: s, type: 'tool', payload: {} });
    j.append({
      sessionId: s,
      type: 'response',
      costUsd: 0.25,
      payload: { text: 'The answer.', outputTokens: 3, stopReason: 'end' },
    });
    const md = sessionToMarkdown(j.findSession(s)!, j.events({ sessionId: s }));
    expect(md).toContain('routed to `p/m` — why');
    expect(md).toContain('call sent (~12 input tokens)');
    expect(md).toContain('human: cancel');
    expect(md).toContain('error (auth): no key');
    expect(md).toContain('response: 3 output tokens, stop=end · $0.250000');
    expect(md).toMatch(/## Answer\n\nThe answer\.\n$/);
  });
});

describe('Journal.spend', () => {
  it('sums cost by session, project and since', () => {
    let t = Date.parse('2026-09-30T23:59:57Z');
    const j = Journal.open(':memory:', { now: () => new Date((t += 1000)) });
    open.push(j);
    const a = j.startSession('a', '/p1');
    const b = j.startSession('b', '/p2');
    j.append({ sessionId: a, type: 'response', costUsd: 1, payload: {} }); // 2026-10-01T00:00:00Z
    j.append({ sessionId: a, type: 'call', payload: {} }); // no cost
    j.append({ sessionId: b, type: 'response', costUsd: 2.5, payload: {} });
    j.append({ sessionId: a, type: 'error', costUsd: 0.25, payload: {} });
    expect(j.spend()).toBe(3.75);
    expect(j.spend({ sessionId: a })).toBe(1.25);
    expect(j.spend({ project: '/p2' })).toBe(2.5);
    expect(j.spend({ project: '/p1', sessionId: b })).toBe(0);
    expect(j.spend({ since: new Date('2026-10-01T00:00:01Z') })).toBe(2.75);
    expect(j.spend({ project: '/none' })).toBe(0);
    expect(j.spend({ until: new Date('2026-10-01T00:00:01Z') })).toBe(1);
    expect(j.spend({ until: new Date('2026-10-01T00:00:00Z') })).toBe(0);
    expect(
      j.spend({ since: new Date('2026-10-01T00:00:01Z'), until: new Date('2026-10-01T00:00:03Z') }),
    ).toBe(2.5);
  });

  it('migrates a v1 journal without touching its chain', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'kpai-')), 'v1.db');
    const raw = new DatabaseSync(path);
    raw.exec(MIGRATIONS[0] as string);
    raw.exec('PRAGMA user_version = 1');
    raw.close();
    const j1 = fresh(path);
    const s = j1.startSession('old', '/repo');
    j1.append({ sessionId: s, type: 'response', costUsd: 0.5, payload: {} });
    const check = new DatabaseSync(path);
    const v = check.prepare('PRAGMA user_version').get() as { user_version: number };
    const idx = check.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all();
    check.close();
    expect(v.user_version).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length);
    expect(idx.map((r) => (r as { name: string }).name)).toEqual(
      expect.arrayContaining(['events_ts', 'sessions_cwd']),
    );
    expect(j1.spend({ project: '/repo' })).toBe(0.5);
    expect(j1.verify().ok).toBe(true);
  });
});

describe('Journal session resumption', () => {
  const MIN = 60_000;
  function clocked(): { j: Journal; at: (iso: string) => void } {
    let next = '2026-10-23T10:00:00Z';
    const j = Journal.open(':memory:', { now: () => new Date(next) });
    open.push(j);
    return { j, at: (iso) => (next = iso) };
  }

  it('reports last activity: last event, else creation', () => {
    const { j, at } = clocked();
    const s = j.startSession('s', '/repo');
    expect(j.lastActivity(s)?.toISOString()).toBe('2026-10-23T10:00:00.000Z');
    at('2026-10-23T10:05:00Z');
    j.append({ sessionId: s, type: 'call', payload: {} });
    expect(j.lastActivity(s)?.toISOString()).toBe('2026-10-23T10:05:00.000Z');
    expect(j.lastActivity('missing')).toBeUndefined();
  });

  it('resumes the most recent session of the cwd within the idle window', () => {
    const { j, at } = clocked();
    const old = j.startSession('old', '/repo');
    at('2026-10-23T10:01:00Z');
    const cur = j.startSession('cur', '/repo');
    at('2026-10-23T10:02:00Z');
    j.append({ sessionId: old, type: 'call', payload: {} }); // old is now the most active
    at('2026-10-23T10:03:00Z');
    j.startSession('other', '/elsewhere');
    const now = new Date('2026-10-23T10:10:00Z');
    expect(j.resumableSession('/repo', 30 * MIN, now)?.id).toBe(old);
    expect(j.resumableSession('/repo', 30 * MIN, now)?.eventCount).toBe(1);
    expect(j.resumableSession('/nowhere', 30 * MIN, now)).toBeUndefined();
    expect(cur).not.toBe(old);
  });

  it('respects the idle boundary (inclusive) and ignores other cwds', () => {
    const { j, at } = clocked();
    const s = j.startSession('s', '/repo');
    at('2026-10-23T10:20:00Z');
    j.append({ sessionId: s, type: 'response', costUsd: 0.1, payload: {} });
    at('2026-10-23T10:50:00Z');
    const other = j.startSession('o', '/other');
    const edge = new Date('2026-10-23T10:50:00Z'); // exactly 30 min after the last event
    expect(j.resumableSession('/repo', 30 * MIN, edge)?.id).toBe(s);
    const past = new Date(edge.getTime() + 1);
    expect(j.resumableSession('/repo', 30 * MIN, past)).toBeUndefined();
    expect(j.resumableSession('/other', 30 * MIN, past)?.id).toBe(other);
    expect(j.resumableSession('/repo', Number.NaN, edge)).toBeUndefined();
  });

  it('uses creation time for a session without events', () => {
    const { j } = clocked();
    const s = j.startSession('empty', '/repo');
    const now = new Date('2026-10-23T10:15:00Z');
    expect(j.resumableSession('/repo', 15 * MIN, now)?.id).toBe(s);
    expect(j.resumableSession('/repo', 15 * MIN - 1, now)).toBeUndefined();
  });
});
