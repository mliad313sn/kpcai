import { describe, expect, it } from 'vitest';
import { answerBlocker, approvalClass, rubberStampRate, type AnswerRecord } from './approvals.js';
import { assuranceOf, withViewed, type NodeFacts } from './assurance.js';
import {
  atLeast,
  effectiveExpiry,
  envelopeExpired,
  noProgress,
  progressOf,
  spendLastHour,
  velocityBlocker,
} from './safeguards.js';
import { deadMan, watchdog } from './watchdog.js';
import { NOW, run, running } from './test-helpers/fixtures.js';
import type { ProgramState } from './schemas.js';

const H = 3_600_000;
const later = (ms: number): Date => new Date(NOW.getTime() + ms);

function withRuns(s: ProgramState, runs: ProgramState['runs']): ProgramState {
  return { ...s, runs };
}

describe('envelope expiry (S10 R3)', () => {
  it('defaults to 14 days after approval when the envelope names none', () => {
    const s = running();
    expect(effectiveExpiry(s)?.toISOString()).toBe(later(14 * 24 * H).toISOString());
    expect(envelopeExpired(s, later(14 * 24 * H - 1))).toBe(false);
    expect(envelopeExpired(s, later(14 * 24 * H))).toBe(true);
  });

  it('uses the envelope expiry when there is one; unapproved has none', () => {
    const expires = later(H).toISOString();
    const s = running({
      envelope: { totalCapUsd: 10, preAnswer: [], expires },
    });
    expect(effectiveExpiry(s)?.toISOString()).toBe(expires);
    expect(
      effectiveExpiry({
        ...s,
        charter: { ...s.charter, envelope: { ...s.charter.envelope, expires: undefined } },
        approval: undefined,
      }),
    ).toBeUndefined();
  });
});

describe('spend-rate cap (S10 R3)', () => {
  it('counts live band tops and runs settled within the hour, across programs', () => {
    const runs = [
      run({ runId: 'a', capUsd: 2, costUsd: 0.5 }),
      run({
        runId: 'b',
        status: 'finished',
        costUsd: 1,
        settledAt: later(-10 * 60_000).toISOString(),
      }),
      run({ runId: 'c', status: 'finished', costUsd: 5, settledAt: later(-2 * H).toISOString() }),
    ];
    expect(spendLastHour(runs, NOW)).toBeCloseTo(3);
    expect(velocityBlocker(runs, 1, 4, NOW)).toBeUndefined();
    expect(velocityBlocker(runs, 1.5, 4, NOW)).toMatch(/spend rate/);
    expect(velocityBlocker(runs, 100, undefined, NOW)).toBeUndefined();
  });
});

describe('progress-gated burn (S10 R3)', () => {
  it('pauses when a quarter of the phase cap is spent with no verified result', () => {
    // Phase p1 cap is 4: one dollar spent is a quarter.
    const s = withRuns(running(), [run({ status: 'finished', costUsd: 1, assurance: 'V0' })]);
    expect(progressOf(s)).toMatchObject({ checkpoint: 1, verified: 0 });
    expect(noProgress(s)?.checkpoint).toBe(1);
    // The Sponsor let checkpoint 1 pass: no pause until the next quarter.
    expect(noProgress(s, 1)).toBeUndefined();
  });

  it('a verified result per quarter keeps it running', () => {
    const s = withRuns(running(), [
      run({ runId: 'a', status: 'finished', costUsd: 1, assurance: 'V1' }),
      run({ runId: 'b', status: 'finished', costUsd: 1, assurance: 'V0' }),
    ]);
    expect(noProgress(s)).toMatchObject({ checkpoint: 2, verified: 1 });
    const two = withRuns(s, [
      ...s.runs.slice(0, 1),
      run({ runId: 'b', status: 'finished', costUsd: 1, assurance: 'V2' }),
    ]);
    expect(noProgress(two)).toBeUndefined();
  });

  it('below a quarter, or not running, never pauses', () => {
    const s = withRuns(running(), [run({ status: 'finished', costUsd: 0.9 })]);
    expect(noProgress(s)).toBeUndefined();
    expect(
      noProgress({ ...s, status: 'paused', runs: [run({ status: 'finished', costUsd: 3 })] }),
    ).toBeUndefined();
  });

  it('ranks labels', () => {
    expect(atLeast(undefined, 'V1')).toBe(false);
    expect(atLeast('V3', 'V2')).toBe(true);
  });
});

describe('approvals (S10 R8)', () => {
  it('only in-envelope writes and budget questions are trivial', () => {
    expect(approvalClass({ rule: 'confirm.write' })).toBe('trivial');
    expect(approvalClass({ rule: 'confirm.budget' })).toBe('trivial');
    for (const rule of [
      'budget.run',
      'merge.default',
      'envelope.widen',
      'gate.pass',
      'confirm.destructive',
      'x',
    ])
      expect(approvalClass({ rule })).toBe('consequential');
  });

  it('consequential answers need the evidence opened and never go in a batch', () => {
    const c = { rule: 'budget.run' };
    expect(answerBlocker(c, { viewed: false, batch: false })).toMatch(/evidence/);
    expect(answerBlocker(c, { viewed: true, batch: true })).toMatch(/batch/);
    expect(answerBlocker(c, { viewed: true, batch: false })).toBeUndefined();
    expect(
      answerBlocker({ rule: 'confirm.write' }, { viewed: false, batch: true }),
    ).toBeUndefined();
  });

  it('computes the rubber-stamp rate on consequential approvals', () => {
    const at = NOW.toISOString();
    const rec = (o: Partial<AnswerRecord>): AnswerRecord => ({
      escalationId: 'e',
      rule: 'budget.run',
      answer: 'yes',
      askedAt: at,
      answeredAt: later(60_000).toISOString(),
      viewed: true,
      ...o,
    });
    const r = rubberStampRate([
      rec({}),
      rec({ viewed: false }),
      rec({ answeredAt: later(1_000).toISOString() }),
      rec({ rule: 'confirm.write', viewed: false }),
      rec({ answer: 'no', viewed: false }),
    ]);
    expect(r).toEqual({ rate: 2 / 3, consequential: 3, stamped: 2 });
    expect(rubberStampRate([]).rate).toBeNull();
  });
});

describe('assurance labels (S10 R5)', () => {
  const node = (o: Partial<NodeFacts> = {}): NodeFacts => ({
    nodeId: 'n1',
    producer: 'mock-beta',
    verdicts: [
      { authorProvider: 'mock-beta', criticProvider: 'mock-delta', approved: true, seq: 2 },
    ],
    ...o,
  });

  it('V1 needs the last verdict to approve, from another provider', () => {
    expect(assuranceOf({ ok: true, nodes: [node()] })).toMatchObject({ label: 'V1' });
    const same = node({
      verdicts: [
        { authorProvider: 'mock-beta', criticProvider: 'mock-beta', approved: true, seq: 1 },
      ],
    });
    expect(assuranceOf({ ok: true, nodes: [same] }).label).toBe('V0');
    const flipped = node({
      verdicts: [
        { authorProvider: 'mock-beta', criticProvider: 'mock-delta', approved: true, seq: 1 },
        { authorProvider: 'mock-beta', criticProvider: 'mock-delta', approved: false, seq: 3 },
      ],
    });
    expect(assuranceOf({ ok: true, nodes: [flipped] }).label).toBe('V0');
    expect(assuranceOf({ ok: false, nodes: [node()] }).label).toBe('V0');
    expect(assuranceOf({ ok: true, nodes: [node({ producer: undefined })] }).label).toBe('V0');
    // A node without a critic step (a solo review, a debate) neither earns nor blocks V1.
    const solo = node({ nodeId: 'review', verdicts: [], reviewable: false });
    expect(assuranceOf({ ok: true, nodes: [node(), solo] }).label).toBe('V1');
    expect(assuranceOf({ ok: true, nodes: [solo] }).label).toBe('V0');
  });

  it('V2 needs passing tests or CI and no failing test; V3 a human look', () => {
    expect(assuranceOf({ ok: true, nodes: [node({ tests: { passed: true } })] })).toMatchObject({
      label: 'V2',
      basis: expect.stringContaining('1 test run(s) passed'),
    });
    const failing = [
      node({ tests: { passed: true } }),
      node({ nodeId: 'n2', tests: { passed: false } }),
    ];
    expect(assuranceOf({ ok: true, nodes: failing }).label).toBe('V1');
    expect(assuranceOf({ ok: true, nodes: [node()], ci: { green: true } }).label).toBe('V2');
    expect(
      assuranceOf({ ok: true, nodes: [node()], ci: { green: true }, viewed: true }).label,
    ).toBe('V3');
    expect(assuranceOf({ ok: true, nodes: [node()], viewed: true }).label).toBe('V1');
    expect(withViewed('V2', true)).toBe('V3');
    expect(withViewed('V1', true)).toBe('V1');
    expect(withViewed(undefined, false)).toBe('V0');
  });
});

describe('watchdog and dead-man (S10 R2)', () => {
  it('alerts a stalled worker, an old ask, a silent program and a blocked queue', () => {
    const s: ProgramState = {
      ...withRuns(running(), [run({ runId: 'live' })]),
      escalations: [{ id: 'e1', at: NOW.toISOString(), rule: 'budget.run', question: 'q?' }],
    };
    const idle = { ...running(), charter: { ...running().charter, programId: 'prog-2' } };
    const alerts = watchdog({
      programs: [s, idle],
      now: later(37 * H),
      queueBlockedSince: later(35 * H).toISOString(),
    });
    expect(alerts.map((a) => a.rule).sort()).toEqual(
      [
        'ask.old',
        'program.stalled',
        'queue.blocked',
        'report.overdue',
        'report.overdue',
        'run.stalled',
      ].sort(),
    );
    // Fresh activity on the run silences the stalled-worker alert.
    const quiet = watchdog({
      programs: [s],
      now: later(37 * H),
      runActivity: { live: later(37 * H - 60_000).toISOString() },
    });
    expect(quiet.some((a) => a.rule === 'run.stalled')).toBe(false);
  });

  it('a heartbeat older than its window is stale; none at all is stale', () => {
    const hb = { at: NOW.toISOString(), staleAfterSec: 120 };
    expect(deadMan(hb, later(60_000)).stale).toBe(false);
    expect(deadMan(hb, later(121_000)).stale).toBe(true);
    expect(deadMan(undefined, NOW)).toEqual({ stale: true, ageSec: null });
  });
});
