/**
 * The north star (DVO) from scripted journals in the kernel's shapes. Every expectation is
 * computed by hand in the comments; docs/metrics/NORTH-STAR.md holds the formulas.
 */
import { describe, expect, it } from 'vitest';
import { isoWeek } from './dvo.js';
import { northStar, northStarOf } from './north-star.js';
import { productivity } from './productivity.js';
import { readRuns } from './grades.js';
import { Script } from './test-helpers/script.js';
import { applyImaged, deliveringRun } from './test-helpers/north-star.js';

const P = { project: '/repo', verify: false };
const DAY = 24 * 3600 * 1000;
/** The Script epoch is Friday 2026-10-23 10:00Z: ISO week 2026-W43 (Mon 19 Oct). */
const W43 = '2026-W43';
const later = (days: number): Date => new Date(Date.parse('2026-10-23T10:00:00Z') + days * DAY);

describe('north star: what counts as one DVO', () => {
  it('a verified, accepted and durable code change of one intent is one DVO', () => {
    const s = new Script();
    deliveringRun(s, 'r1', { intent: 'i-1', level: 'V2' });
    s.apply('r1', 'n1', 0, 'confirmed', false, ['src/a.ts']);
    // 30 days later: the week (ends Sun 25 Oct) is 7 days past → final.
    const n = northStar(s.j, { ...P, now: later(30) });
    expect(n).toMatchObject({ dvo: 1, dvoDoc: 0, provisional: 0, intents: 1 });
    expect(n.mix).toEqual({ V1: 0, V2: 1, V3: 0 });
    expect(n.weeks).toEqual([
      {
        week: W43,
        start: '2026-10-19T00:00:00.000Z',
        dvo: 1,
        dvoDoc: 0,
        mix: { V1: 0, V2: 1, V3: 0 },
        final: true,
      },
    ]);
    expect(n.list[0]).toMatchObject({
      intent: 'human-request|i-1',
      origin: 'human-request',
      runKey: 'r1',
    });
    expect(n.v3Share).toBe(0);
  });

  it('splitting one intent into more patches, runs and forks never inflates it', () => {
    const s = new Script();
    // One intent: 2 patches in r1, a retry r2 with 3 patches, a fork r3 of r1 (no intent of its own).
    deliveringRun(s, 'r1', { intent: 'goal', level: 'V2' });
    s.apply('r1', 'n1', 0, 'confirmed', false, ['a.ts']);
    s.apply('r1', 'n1', 1, 'confirmed', false, ['b.ts']);
    deliveringRun(s, 'r2', { intent: 'goal', level: 'V2' });
    for (const i of [0, 1, 2]) s.apply('r2', 'n1', i, 'confirmed', false, [`c${i}.ts`]);
    deliveringRun(s, 'r3', { level: 'V2', parent: 'r1' });
    s.apply('r3', 'n1', 0, 'confirmed', false, ['d.ts']);
    const n = northStar(s.j, { ...P, now: later(30) });
    // Accepted changes rise to 6; the intent and the DVO stay at 1.
    expect(productivity(s.j, P).changes.accepted).toBe(6);
    expect(n.deliverables).toHaveLength(6);
    expect(new Set(n.deliverables.map((d) => d.intent.key))).toEqual(
      new Set(['human-request|goal']),
    );
    expect([n.intents, n.dvo]).toEqual([1, 1]);
    // Facts journaled outside a run (a daemon heartbeat, a program note) are no intent.
    s.session();
    s.note({ action: 'enterprise heartbeat', status: 'ok', intervalSec: 5 });
    s.note({ action: 'run interrupted', runId: 'r9', costUsd: 0 });
    expect(northStar(s.j, { ...P, now: later(30) }).intents).toBe(1);
    // The same work typed as two separate requests is two intents (two DVO).
    const t = new Script();
    deliveringRun(t, 'x1', { intent: 'one', level: 'V2' });
    t.apply('x1', 'n1', 0, 'confirmed', false, ['a.ts']);
    deliveringRun(t, 'x2', { intent: 'two', level: 'V2' });
    t.apply('x2', 'n1', 0, 'confirmed', false, ['b.ts']);
    expect(northStar(t.j, { ...P, now: later(30) }).dvo).toBe(2);
  });

  it('a run journaled before J1 is its own intent (proxy); a program WP is charter-wp', () => {
    const s = new Script();
    deliveringRun(s, 'old', { level: 'V2' });
    s.apply('old', 'n1', 0, 'confirmed', false, ['a.ts']);
    deliveringRun(s, 'wp', { intent: 'prog-1/wp1', origin: 'charter-wp:abcd', level: 'V2' });
    s.apply('wp', 'n1', 0, 'confirmed', false, ['b.ts']);
    const n = northStar(s.j, { ...P, now: later(30) });
    expect(n.list.map((i) => [i.intent, i.origin])).toEqual([
      ['proxy|old', 'proxy'],
      ['charter-wp:abcd|prog-1/wp1', 'charter-wp'],
    ]);
  });
});

describe('north star: verified', () => {
  it('code needs V2, documents V1 and count apart as DVO-doc; V0 never counts', () => {
    const s = new Script();
    deliveringRun(s, 'code-v1', { intent: 'a', level: 'V1' });
    s.apply('code-v1', 'n1', 0, 'confirmed', false, ['src/x.ts']);
    deliveringRun(s, 'doc-v1', { intent: 'b', level: 'V1' });
    s.apply('doc-v1', 'n1', 0, 'confirmed', false, ['docs/guide.md', 'README.md']);
    deliveringRun(s, 'self', { intent: 'c', level: 'V0' });
    s.apply('self', 'n1', 0, 'confirmed', false, ['docs/self.md']);
    deliveringRun(s, 'mixed', { intent: 'd', level: 'V1' });
    s.apply('mixed', 'n1', 0, 'confirmed', false, ['docs/a.md', 'src/a.ts']);
    const n = northStar(s.j, { ...P, now: later(30) });
    // Only doc-v1 qualifies (a doc at V1); code at V1, a V0 doc and a mixed patch at V1 do not.
    expect([n.dvo, n.dvoDoc]).toEqual([0, 1]);
    expect(n.mix).toEqual({ V1: 1, V2: 0, V3: 0 });
    expect(n.deliverables.map((d) => [d.change.runKey, d.cls, d.assurance])).toEqual([
      ['code-v1', 'code', 'V1'],
      ['doc-v1', 'doc', 'V1'],
      ['self', 'doc', 'V0'],
      ['mixed', 'code', 'V1'],
    ]);
  });

  it('a declined or failed write is not accepted; a cancelled run earns V0', () => {
    const s = new Script();
    deliveringRun(s, 'r1', { intent: 'a', level: 'V2' });
    s.apply('r1', 'n1', 0, 'declined', false, ['a.ts']);
    s.apply('r1', 'n1', 1, 'confirmed', true, ['b.ts']);
    s.plan([{ id: 'n1', type: 'code_generation' }]);
    s.answer('n1', 'alpha/m', 'author', 'diff');
    s.critic('n1', 'delta/m', true);
    s.test('n1', 'alpha/m', 0);
    s.outcome('r2', 'finished', true);
    s.apply('r2', 'n1', 0, 'confirmed', false, ['c.ts']);
    const n = northStar(s.j, { ...P, now: later(30) });
    expect(n.deliverables.map((d) => [d.change.runKey, d.assurance])).toEqual([['r2', 'V0']]);
    expect(n.dvo).toBe(0);
  });

  it('a human opening the run’s evidence makes V3 (the diagnostic share)', () => {
    const s = new Script();
    deliveringRun(s, 'r1', { intent: 'a', level: 'V2' });
    s.apply('r1', 'n1', 0, 'confirmed', false, ['a.ts']);
    deliveringRun(s, 'r2', { intent: 'b', level: 'V2' });
    s.apply('r2', 'n1', 0, 'confirmed', false, ['b.ts']);
    s.note({ action: 'evidence viewed', programId: 'p', ref: { kind: 'run', id: 'r2' } });
    const n = northStar(s.j, { ...P, now: later(30) });
    expect(n.mix).toEqual({ V1: 0, V2: 1, V3: 1 });
    // 1 of 2 outcomes at V3.
    expect(n.v3Share).toBe(0.5);
  });
});

describe('north star: durable', () => {
  it('a rollback within 7 days removes it; one after 7 days does not', () => {
    const s = new Script();
    // A restore undoes every change that landed after its checkpoint: `kept` lands first.
    deliveringRun(s, 'kept', { intent: 'b', level: 'V2' });
    const cpKept = s.apply('kept', 'n1', 0, 'confirmed', false, ['b.ts']);
    deliveringRun(s, 'undone', { intent: 'a', level: 'V2' });
    const cpUndone = s.apply('undone', 'n1', 0, 'confirmed', false, ['a.ts']);
    s.advance(2 * DAY);
    s.restore('undone', cpUndone); // 2 days after `undone` landed: inside the window
    s.advance(6 * DAY);
    s.restore('kept', cpKept); // 8 days after `kept` landed: it was durable
    const n = northStar(s.j, { ...P, now: later(40) });
    expect(n.deliverables.map((d) => [d.change.runKey, d.undone?.kind ?? null])).toEqual([
      ['kept', null],
      ['undone', 'rollback'],
    ]);
    expect(n.list.map((i) => i.intent)).toEqual(['human-request|b']);
    expect(n.durability).toBe('rollback-only');
    expect(n.guardrails.g4Escape).toMatchObject({
      accepted: 2,
      escaped: 1,
      rate: 0.5,
      rolledBack: 1,
    });
  });

  it('a later write back to the pre-image is a revert (J3); an extension is not', () => {
    const s = new Script();
    deliveringRun(s, 'r1', { intent: 'a', level: 'V2' });
    applyImaged(s, 'r1', 0, { 'a.ts': { pre: 'h0', post: 'h1' } });
    deliveringRun(s, 'r2', { intent: 'b', level: 'V2' });
    applyImaged(s, 'r2', 0, { 'b.ts': { pre: null, post: 'h2' } });
    s.advance(DAY);
    // r3 puts a.ts back to h0 (revert of r1) and extends b.ts (h2 → h3: not a revert).
    deliveringRun(s, 'r3', { intent: 'c', level: 'V2' });
    applyImaged(s, 'r3', 0, {
      'a.ts': { pre: 'h1', post: 'h0' },
      'b.ts': { pre: 'h2', post: 'h3' },
    });
    const n = northStar(s.j, { ...P, now: later(30) });
    expect(n.durability).toBe('rollback and revert');
    expect(n.deliverables.map((d) => [d.change.runKey, d.undone?.kind ?? null])).toEqual([
      ['r1', 'revert'],
      ['r2', null],
      ['r3', null],
    ]);
    expect(n.list.map((i) => i.runKey)).toEqual(['r2', 'r3']);
    expect(n.guardrails.g4Escape).toMatchObject({ accepted: 3, escaped: 1, reverted: 1 });
  });

  it('inside its 7 days a DVO is provisional, and its week is not final', () => {
    const s = new Script();
    deliveringRun(s, 'r1', { intent: 'a', level: 'V2' });
    s.apply('r1', 'n1', 0, 'confirmed', false, ['a.ts']);
    const n = northStar(s.j, { ...P, now: later(2) });
    expect([n.dvo, n.provisional]).toEqual([1, 1]);
    expect(n.list[0]?.durable).toBe(false);
    expect(n.weeks[0]?.final).toBe(false);
    // 9 days later: durable, but the week (Mon 19 – Sun 25 Oct) only turns final on 2 Nov.
    const m = northStar(s.j, { ...P, now: later(9) });
    expect([m.provisional, m.weeks[0]?.final]).toEqual([0, false]);
    expect(northStar(s.j, { ...P, now: later(10) }).weeks[0]?.final).toBe(true);
  });
});

describe('north star: once per intent, by week', () => {
  it('the first qualifying deliverable dates it; later ones of the intent never count', () => {
    const s = new Script();
    deliveringRun(s, 'try1', { intent: 'goal', level: 'V1' }); // not verified for code
    s.apply('try1', 'n1', 0, 'confirmed', false, ['a.ts']);
    s.advance(7 * DAY);
    deliveringRun(s, 'try2', { intent: 'goal', level: 'V2' }); // qualifies: week 44
    s.apply('try2', 'n1', 0, 'confirmed', false, ['a.ts']);
    s.advance(7 * DAY);
    deliveringRun(s, 'try3', { intent: 'goal', level: 'V2' }); // same intent: never again
    s.apply('try3', 'n1', 0, 'confirmed', false, ['a.ts']);
    const n = northStar(s.j, { ...P, now: later(60) });
    expect(n.list.map((i) => [i.runKey, i.week])).toEqual([['try2', '2026-W44']]);
    expect(n.weeks.map((w) => [w.week, w.dvo])).toEqual([['2026-W44', 1]]);
    // A window that starts after the intent's DVO: it does not count again.
    const since = later(13).toISOString();
    expect(northStar(s.j, { ...P, since, now: later(60) }).dvo).toBe(0);
    expect(() => northStar(s.j, { ...P, since: 'soon' })).toThrow(RangeError);
  });

  it('keeps to the project, and is pure over the journal', () => {
    const s = new Script();
    deliveringRun(s, 'r1', { intent: 'a', level: 'V2' });
    s.apply('r1', 'n1', 0, 'confirmed', false, ['a.ts']);
    s.session('/elsewhere');
    deliveringRun(s, 'r2', { intent: 'b', level: 'V2' });
    s.apply('r2', 'n1', 0, 'confirmed', false, ['a.ts']);
    const runs = readRuns(s.j);
    const now = later(30);
    expect(northStarOf(runs, { ...P, now })).toEqual(northStarOf(runs, { ...P, now }));
    expect(northStarOf(runs, { ...P, now }).dvo).toBe(1);
    expect(northStarOf(runs, { project: '/nowhere', now }).dvo).toBe(0);
  });

  it('ISO weeks follow ISO 8601 across a year end', () => {
    expect(isoWeek(Date.parse('2026-10-23T10:00:00Z')).week).toBe(W43);
    expect(isoWeek(Date.parse('2026-12-31T12:00:00Z')).week).toBe('2026-W53');
    expect(isoWeek(Date.parse('2027-01-04T00:00:00Z')).week).toBe('2027-W01');
    expect(isoWeek(Date.parse('2025-12-29T00:00:00Z')).week).toBe('2026-W01');
  });
});
