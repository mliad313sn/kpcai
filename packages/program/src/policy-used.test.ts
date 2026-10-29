/**
 * P5-F3 (D-035): the source policy reaches the run, the providers a run actually used are
 * recorded at settlement, a run outside its policy fails closed, and the gate's builder
 * exclusion reads the providers actually used. P5-F6: a gate verdict whose findings no
 * machine counted is the Sponsor's decision.
 */
import { describe, expect, it } from 'vitest';
import { delegate, settleEvent, type PlannedRun, type RunStarter } from './driver.js';
import { transition } from './machine.js';
import type { ProgramState } from './schemas.js';
import { policyBreach, policyFor } from './sources.js';
import { NOW, drive, run, running } from './test-helpers/fixtures.js';

function starter(plan: Partial<PlannedRun> = {}) {
  const inputs: Array<Parameters<RunStarter['plan']>[0]> = [];
  const started: string[] = [];
  const kernel: RunStarter = {
    plan(input) {
      inputs.push(input);
      const base = { planId: 'pl1', capUsd: 1, expectedUsd: 0.4 };
      return Promise.resolve({ ...base, providers: ['openai'], source: 'api', ...plan });
    },
    start(planId) {
      started.push(planId);
      return Promise.resolve({ runId: 'run1' });
    },
  };
  return { kernel, inputs, started };
}

const settle = (runId: string, o: Record<string, unknown> = {}) => ({
  type: 'run.settled',
  runId,
  status: 'finished',
  costUsd: 0.5,
  evidence: [`event:${runId}`],
  ...o,
});

const ok = (s: ProgramState, e: unknown, actor: 'po' | 'kernel' = 'kernel'): ProgramState => {
  const t = transition(s, e, actor, NOW);
  if (!t.ok) throw new Error(t.reason);
  return t.state;
};

describe('the policy reaches the run (P5-F3)', () => {
  it('delegate plans within the effective policy, the portfolio’s included', async () => {
    const { kernel, inputs } = starter({ providers: ['ollama'], source: 'local' });
    await delegate(running(), 'wp2', kernel, { now: NOW, escalationId: 'e1' });
    expect(inputs[0]!.policy).toEqual({ sources: ['local'], deny: [] });
    const portfolio = { denyProviders: ['openai'] };
    const b = starter();
    const d = await delegate(running(), 'wp1', b.kernel, {
      now: NOW,
      escalationId: 'e',
      portfolio,
    });
    expect(b.inputs[0]!.policy?.deny).toEqual(['openai']);
    // The charter allows openai; the portfolio does not: refused, nothing started.
    expect(d).toMatchObject({ outcome: 'refused', verdict: { rule: 'source.policy' } });
    expect(b.started).toEqual([]);
  });

  it('settleEvent carries the providers used and the deliverable class', () => {
    const e = settleEvent({
      runId: 'r1',
      status: 'finished',
      costUsd: 0,
      evidence: [],
      sources: [{ provider: 'mistral', source: 'api' }],
      deliverable: 'doc',
    });
    expect(e).toMatchObject({ sources: [{ provider: 'mistral' }], deliverable: 'doc' });
  });
});

describe('settlement records what was used (P5-F3)', () => {
  it('the providers used replace the planned ones; the plan’s are kept beside them', () => {
    const s = ok(running(), { type: 'run.started', run: run() });
    const used = [
      { provider: 'openai', source: 'api' },
      { provider: 'mistral', source: 'api' },
    ];
    const r = ok(s, settle('r1', { sources: used, deliverable: 'code' })).runs[0]!;
    expect(r).toMatchObject({
      status: 'finished',
      providers: ['mistral', 'openai'],
      plannedProviders: ['openai'],
      source: 'api',
      deliverable: 'code',
    });
    const same = ok(s, settle('r1', { sources: [{ provider: 'openai', source: 'api' }] }));
    expect(same.runs[0]!.plannedProviders).toBeUndefined();
    expect(ok(s, settle('r1')).runs[0]!.providers).toEqual(['openai']);
  });

  it('a local-only run that fell back to the cloud fails closed, with the breach as evidence', () => {
    const local = run({ runId: 'r2', wpId: 'wp2', source: 'local', providers: ['ollama'] });
    const s = ok(running(), { type: 'run.started', run: local });
    const used = [
      { provider: 'ollama', source: 'local' },
      { provider: 'openai', source: 'api' },
    ];
    const r = ok(s, settle('r2', { sources: used })).runs[0]!;
    expect(r.status).toBe('failed');
    expect(r.source).toBe('api');
    expect(r.evidence).toContain('policy-breach:api:openai');
    expect(policyBreach(policyFor(s.charter, 'wp2'), { sources: [] })).toEqual([]);
  });
});

describe('the gate reads the providers actually used (P5-F3, P5-F6)', () => {
  /** wp1 planned on openai but served by google (a fallback); wp2 local; review given. */
  function gateWith(review: Partial<Parameters<typeof run>[0]>, used: string): ProgramState {
    let s = ok(running(), { type: 'run.started', run: run() });
    s = ok(s, { type: 'run.started', run: run({ runId: 'r2', wpId: 'wp2', source: 'local' }) });
    s = ok(s, settle('r1', { sources: [{ provider: used, source: 'api' }] }));
    s = ok(s, settle('r2', { sources: [{ provider: 'ollama', source: 'local' }] }));
    s = ok(s, { type: 'gate.open' }, 'po');
    const rv = run({ runId: 'rv1', wpId: 'p1', purpose: 'review', ...review });
    return drive(s, [
      [{ type: 'run.started', run: rv }, 'kernel'],
      [settle('rv1'), 'kernel'],
    ]);
  }
  const pass = (s: ProgramState, provider: string, extra: Record<string, unknown> = {}) =>
    transition(
      s,
      {
        type: 'gate.close',
        record: {
          phaseId: 'p1',
          verdict: 'pass',
          reviewer: 'rv',
          reviewerProvider: provider,
          evidence: ['run:rv1'],
          at: NOW.toISOString(),
          ...extra,
        },
      },
      'po',
      NOW,
    );

  it('a reviewer on the provider a builder fell back to is refused', () => {
    const s = gateWith({ providers: ['google'] }, 'google');
    expect(pass(s, 'google')).toMatchObject({ ok: false, reason: /shares a provider/ });
  });

  it('a review run that used a builder’s provider is refused whatever the record names', () => {
    const s = gateWith({ providers: ['openai'] }, 'openai');
    expect(pass(s, 'google')).toMatchObject({ ok: false, reason: /shares a provider/ });
  });

  it('no machine count of the findings: the Sponsor’s pass stands; a count above 0 blocks', () => {
    const s = gateWith({ providers: ['google'] }, 'openai');
    expect(pass(s, 'google')).toMatchObject({ ok: true });
    const t = pass(s, 'google');
    expect(t.ok && t.state.gates[0]!.openCriticalOrHigh).toBeUndefined();
    expect(pass(s, 'google', { openCriticalOrHigh: 1 })).toMatchObject({ ok: false });
  });
});
