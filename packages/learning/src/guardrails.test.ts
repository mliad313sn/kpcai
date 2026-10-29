/**
 * The six guardrails of the north star from scripted journals, each expectation computed
 * by hand (docs/metrics/NORTH-STAR.md). The Script clock adds one second per event.
 */
import { describe, expect, it } from 'vitest';
import { energyGuardrail } from './guardrails-live.js';
import { median } from './guardrails.js';
import { northStar } from './north-star.js';
import { Script } from './test-helpers/script.js';
import {
  applyImaged,
  at,
  confirmAnswer,
  deliveringRun,
  intent,
  sponsorAnswer,
} from './test-helpers/north-star.js';

const P = { project: '/repo', verify: false };
const DAY = 24 * 3600 * 1000;
const later = (days: number): Date => new Date(Date.parse('2026-10-23T10:00:00Z') + days * DAY);

describe('G1 cost per DVO and band honesty', () => {
  it('divides everything spent by the outcomes; median band top ÷ likely', () => {
    const s = new Script();
    deliveringRun(s, 'r1', { intent: 'a', level: 'V2', costUsd: 0.25 });
    s.apply('r1', 'n1', 0, 'confirmed', false, ['a.ts']);
    deliveringRun(s, 'r2', { intent: 'b', level: 'V2', costUsd: 0.35 });
    s.apply('r2', 'n1', 0, 'confirmed', false, ['b.ts']);
    // A failed attempt that delivered nothing still costs; its plan has cap 0.5 / likely 0.1.
    s.plan([{ id: 'n1', type: 'code_generation' }], { expectedUsd: 0.1, capUsd: 0.5 });
    s.answer('n1', 'alpha/m', 'author', 'diff', { costUsd: 0.3 });
    s.outcome('r3', 'failed');
    const g = northStar(s.j, { ...P, now: later(30) }).guardrails.g1Cost;
    // 0.25 + 0.35 + 0.3 = 0.9 over 2 DVO = 0.45; ratios 3, 3, 5 → median 3.
    expect(g).toMatchObject({
      spentUsd: 0.9,
      outcomes: 2,
      costPerDvoUsd: 0.45,
      capToLikelyMedian: 3,
    });
    expect(median([1, 4, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it('gives null, not zero, without an outcome; a cap over 3× likely is breached', () => {
    const s = new Script();
    s.plan([{ id: 'n1', type: 'code_generation' }], { expectedUsd: 0.1, capUsd: 0.4 });
    s.answer('n1', 'alpha/m', 'author', 'diff', { costUsd: 0.2 });
    s.outcome('r1');
    const n = northStar(s.j, { ...P, now: later(1) });
    expect(n.guardrails.g1Cost.costPerDvoUsd).toBeNull();
    expect(n.guardrails.g2Attention.asksPerDvo).toBeNull();
    expect(n.breached).toContain('G1 cap');
  });
});

describe('G2 attention load and rubber-stamp rate (J2)', () => {
  it('counts asks, their median age and stamped consequential approvals', () => {
    const s = new Script();
    // Sponsor: consequential yes 5 s after opening the evidence (considered).
    sponsorAnswer(s, {
      cls: 'consequential',
      askedAt: at(0),
      viewedAt: at(100),
      answeredAt: at(105),
    });
    // Sponsor: consequential yes, evidence never opened (stamped).
    sponsorAnswer(s, { cls: 'consequential', askedAt: at(0), answeredAt: at(20) });
    // Sponsor: trivial yes and a consequential no: not approvals that count.
    sponsorAnswer(s, { cls: 'trivial', askedAt: at(0), answeredAt: at(1) });
    sponsorAnswer(s, { cls: 'consequential', answer: 'no', askedAt: at(0), answeredAt: at(2) });
    // Interactive: diff shown with the question; yes after 1 s (stamped), after 10 s (not).
    confirmAnswer(s, { yes: true, consequential: true, askedAt: at(0), answeredAt: at(1) });
    confirmAnswer(s, { yes: true, consequential: true, askedAt: at(0), answeredAt: at(10) });
    // Interactive, trivial (a worktree write): not an approval that counts.
    confirmAnswer(s, { yes: true, consequential: false, askedAt: at(0), answeredAt: at(4) });
    s.note({ action: 'question expired', programId: 'p', escalationId: 'e9' });
    // A malformed record (no times) is not an answer.
    s.note({ action: 'sponsor answer', answer: 'yes', class: 'consequential' });
    deliveringRun(s, 'r1', { intent: 'a', level: 'V2' });
    s.apply('r1', 'n1', 0, 'confirmed', false, ['a.ts']);
    const g = northStar(s.j, { ...P, now: later(30) }).guardrails.g2Attention;
    // 7 answered + 1 expired = 8 asks for 1 DVO.
    expect(g.asks).toBe(8);
    expect(g.bySource).toEqual({ interactive: 3, sponsor: 4, expired: 1 });
    expect(g.asksPerDvo).toBe(8);
    // Ages in s: 105, 20, 1, 2, 1, 10, 4 → sorted 1 1 2 4 10 20 105 → median 4 s.
    expect(g.medianAskAgeMs).toBe(4000);
    // Consequential yes: 4 (two Sponsor, two interactive); stamped: unviewed + 1 s → 2.
    expect(g.rubberStamp).toEqual({ consequential: 4, stamped: 2, rate: 0.5 });
  });

  it('an interactive yes with no diff shown is unviewed; a window keeps later asks only', () => {
    const s = new Script();
    confirmAnswer(s, {
      yes: true,
      consequential: true,
      askedAt: at(0),
      answeredAt: at(60),
      diff: false,
    });
    s.advance(DAY);
    confirmAnswer(s, {
      yes: true,
      consequential: true,
      askedAt: at(DAY / 1000),
      answeredAt: at(DAY / 1000 + 60),
    });
    const all = northStar(s.j, { ...P, now: later(3) });
    expect(all.guardrails.g2Attention.rubberStamp).toEqual({
      consequential: 2,
      stamped: 1,
      rate: 0.5,
    });
    expect(all.breached).toContain('G2 rubber-stamp');
    const recent = northStar(s.j, { ...P, since: later(0.5), now: later(3) });
    expect(recent.guardrails.g2Attention.rubberStamp).toEqual({
      consequential: 1,
      stamped: 0,
      rate: 0,
    });
  });
});

describe('G3 silent failures', () => {
  it('a started run with no outcome past the stall timeout is silent; settled ones are not', () => {
    const s = new Script();
    // r-silent starts at 10:00 and goes quiet; r-settled was settled by the daemon's restart.
    s.plan([{ id: 'n1', type: 'code_generation' }]);
    intent(s, 'r-silent', 'a');
    s.answer('n1', 'alpha/m', 'author', 'draft');
    s.session();
    s.plan([{ id: 'n1', type: 'code_generation' }]);
    intent(s, 'r-settled', 'b', 'charter-wp:x', true);
    s.note({ action: 'run interrupted', runId: 'r-settled', costUsd: 0.1, replanned: true });
    s.session();
    s.advance(2 * 3600 * 1000);
    // r-open started 2 h later, 10 minutes before `now`: still within 30 + 15 minutes.
    s.plan([{ id: 'n1', type: 'code_generation' }]);
    intent(s, 'r-open', 'c');
    deliveringRun(s, 'r-done', { intent: 'd', level: 'V2' });
    const now = new Date(Date.parse('2026-10-23T12:10:00Z'));
    const g = northStar(s.j, { ...P, now }).guardrails.g3Silent;
    expect(g).toMatchObject({ started: 4, silent: 1, open: 1, rate: 0.25 });
  });

  it('alerts need a report within 15 minutes; heartbeat gaps over 2× the interval', () => {
    const s = new Script();
    const beat = (intervalSec?: number) =>
      s.note({
        action: 'enterprise heartbeat',
        status: 'ok',
        alerts: [],
        ...(intervalSec ? { intervalSec } : {}),
      });
    beat(5); // t=1 s
    beat(5); // t=2 s: gap 1 s
    s.advance(14_000);
    beat(5); // t=17 s: gap 15 s > 10 s → one gap
    s.note({ action: 'watchdog alert', rule: 'run.silent', runId: 'r1' });
    let g = northStar(s.j, { ...P, now: later(1) }).guardrails.g3Silent;
    // No report or notification exists in this journal: follow-up is not measured.
    expect(g.alerts).toEqual({ count: 1, followed: null, unfollowed: null });
    expect(g.heartbeat).toEqual({ beats: 3, gaps: 1, longestGapSec: 15 });
    s.advance(5 * 60_000);
    s.note({ action: 'notification sent', channel: 'webhook' });
    s.note({ action: 'watchdog alert', rule: 'ask.old' });
    s.advance(20 * 60_000);
    s.note({ action: 'report written', kind: 'digest' });
    beat(); // t=1522 s: 1505 s after the last 5 s beat → a second gap
    beat(5); // after a beat with no interval journaled: that pair is not judged
    g = northStar(s.j, { ...P, now: later(1) }).guardrails.g3Silent;
    // First alert followed after 5 min; the second only after 20 min.
    expect(g.alerts).toEqual({ count: 2, followed: 1, unfollowed: 1 });
    expect(g.heartbeat).toEqual({ beats: 5, gaps: 2, longestGapSec: 1505 });
  });
});

describe('G4 escape rate by assurance', () => {
  it('reports undone deliverables per label', () => {
    const s = new Script();
    deliveringRun(s, 'v1', { intent: 'a', level: 'V1' });
    applyImaged(s, 'v1', 0, { 'a.ts': { pre: 'h0', post: 'h1' } });
    deliveringRun(s, 'v2', { intent: 'b', level: 'V2' });
    applyImaged(s, 'v2', 0, { 'b.ts': { pre: 'x0', post: 'x1' } });
    deliveringRun(s, 'fix', { intent: 'c', level: 'V2' });
    applyImaged(s, 'fix', 0, { 'a.ts': { pre: 'h1', post: 'h0' } });
    const g = northStar(s.j, { ...P, now: later(30) }).guardrails.g4Escape;
    expect(g.byAssurance.V1).toEqual({ accepted: 1, escaped: 1, rate: 1 });
    expect(g.byAssurance.V2).toEqual({ accepted: 2, escaped: 0, rate: 0 });
    expect(g.byAssurance.V0).toEqual({ accepted: 0, escaped: 0, rate: null });
    expect(g).toMatchObject({ accepted: 3, escaped: 1, rate: 0.3333, reverted: 1 });
  });
});

describe('G5 safety invariants', () => {
  it('is 0 on a clean journal and counts each violation', () => {
    const clean = new Script();
    deliveringRun(clean, 'r1', { intent: 'a', level: 'V2' });
    clean.apply('r1', 'n1', 0, 'confirmed', false, ['a.ts']);
    clean.merge('r1', ['a.ts']);
    const ok = northStar(clean.j, { project: '/repo', now: later(1) }).guardrails.g5Safety;
    expect(ok).toEqual({
      writesWithoutCheckpoint: 0,
      unattendedSubscription: 0,
      preAnsweredWithoutAmount: 0,
      journalBroken: 0,
      total: 0,
      ok: true,
    });
    const s = new Script();
    deliveringRun(s, 'r1', { intent: 'a', level: 'V2' });
    // A write with no checkpoint before it, a merge naming none, a refused write (ignored).
    s.tool('n1#patch-0', 'kernel/apply', { tool: 'git.apply', decision: 'confirmed', input: {} });
    s.note({ action: 'merge-back', runId: 'r1', files: ['a.ts'] });
    s.tool('n1#patch-1', 'kernel/apply', { tool: 'git.apply', decision: 'deny', input: {} });
    // An unattended run whose outcome used a subscription, and an agent run in another.
    s.plan([{ id: 'n1', type: 'code_generation' }]);
    intent(s, 'u1', 'p/wp1', 'charter-wp:x', true);
    s.note({ action: 'run outcome', runId: 'u1', status: 'finished', source: 'subscription' });
    s.plan([{ id: 'n1', type: 'code_generation' }]);
    intent(s, 'u2', 'p/wp2', 'charter-wp:x', true);
    s.note({ action: 'agent run', agent: 'claude-code' });
    s.outcome('u2');
    // Spend pre-answered with no amount, and one with an amount (fine).
    s.note({ action: 'pre-answered', kind: 'budget', rule: 'budget.within' });
    s.note({ action: 'pre-answered', kind: 'budget', rule: 'budget.within', amountUsd: 0.2 });
    const n = northStar(s.j, { ...P, now: later(1) });
    expect(n.guardrails.g5Safety).toEqual({
      writesWithoutCheckpoint: 2,
      unattendedSubscription: 2,
      preAnsweredWithoutAmount: 1,
      journalBroken: null,
      total: 5,
      ok: false,
    });
    expect(n.breached).toContain('G5 safety');
  });
});

describe('G6 footprint: never guessed', () => {
  it('is not measured without energyWh, and sums the journaled ranges when present', () => {
    const s = new Script();
    deliveringRun(s, 'r1', { intent: 'a', level: 'V2' });
    s.apply('r1', 'n1', 0, 'confirmed', false, ['a.ts']);
    const none = northStar(s.j, { ...P, now: later(30) });
    expect(none.guardrails.g6Energy).toEqual({
      measured: false,
      responses: 0,
      energyWh: null,
      perDvoWh: null,
    });
    expect(none.notMeasured).toContain('G6 energy: no energyWh journaled (J4)');
    const events = s.j.events({ limit: 1000 });
    const withEnergy = [
      ...events,
      { ...events[2]!, type: 'response' as const, payload: { energyWh: [0.5, 1.5] } },
      { ...events[2]!, type: 'response' as const, payload: { energyWh: [0.25, 0.5] } },
      { ...events[2]!, type: 'response' as const, payload: { energyWh: [2, 1] } },
    ];
    expect(energyGuardrail(withEnergy, 2)).toEqual({
      measured: true,
      responses: 2,
      energyWh: [0.75, 2],
      perDvoWh: [0.375, 1],
    });
    expect(energyGuardrail(withEnergy, 0).perDvoWh).toBeNull();
  });
});
