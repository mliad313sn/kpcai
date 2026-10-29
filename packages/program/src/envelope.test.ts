import { describe, expect, it } from 'vitest';
import { RESERVED_ITEMS, ConfirmKindSchema } from './actions.js';
import { checkAction, widenings } from './envelope.js';
import { EnvelopeSchema, type Envelope, type ProgramState } from './schemas.js';
import { NOW, run, running } from './test-helpers/fixtures.js';

const start = (over: Record<string, unknown> = {}) => ({
  kind: 'run.start',
  wpId: 'wp1',
  capUsd: 1,
  isolated: true,
  providers: ['openai'],
  ...over,
});

/** Envelopes from tight to as wide as the schema allows. */
function envelopes(): Envelope[] {
  const out: Envelope[] = [];
  for (const total of [0, 10, 1e9])
    for (const pre of [
      [],
      ['budget-within-envelope'],
      ['budget-within-envelope', 'write-in-worktree'],
    ])
      for (const write of [
        { mode: 'isolated-only' },
        { mode: 'auto-merge', limits: { maxFiles: 200, maxLines: 20_000 } },
      ])
        out.push(EnvelopeSchema.parse({ totalCapUsd: total, preAnswer: pre, write }));
  return out;
}

function withEnvelope(s: ProgramState, envelope: Envelope): ProgramState {
  return { ...s, charter: { ...s.charter, envelope } };
}

describe('envelope invariants', () => {
  it('never pre-answers a Sponsor-reserved item, whatever the envelope or state', () => {
    const base = running();
    for (const env of envelopes())
      for (const status of ['running', 'gate', 'approved', 'paused', 'draft'] as const)
        for (const item of RESERVED_ITEMS) {
          const v = checkAction(
            { ...withEnvelope(base, env), status },
            { kind: 'reserved', item },
            NOW,
          );
          expect(v.verdict).toBe('escalate');
          expect(v.reserved).toBe(item);
        }
  });

  it('never pre-answers destructive, physical, dispute or memory confirmations', () => {
    const base = running();
    for (const env of envelopes()) {
      const s = withEnvelope(base, env);
      for (const confirm of ConfirmKindSchema.options) {
        for (const a of [
          { kind: 'confirm', confirm, risk: 'destructive', inWorktree: true, amountUsd: 0 },
          { kind: 'confirm', confirm, inWorktree: true, physical: true, amountUsd: 0 },
        ])
          expect(checkAction(s, a, NOW).verdict).toBe('escalate');
      }
      for (const confirm of ['dispute', 'memory', 'restore'])
        expect(checkAction(s, { kind: 'confirm', confirm, inWorktree: true }, NOW).verdict).toBe(
          'escalate',
        );
    }
  });

  it('never grows itself: the state is unchanged and widening escalates', () => {
    const s = running();
    const before = JSON.stringify(s);
    const wide = EnvelopeSchema.parse({
      totalCapUsd: 1e9,
      preAnswer: ['budget-within-envelope', 'write-in-worktree'],
      write: { mode: 'auto-merge', limits: { maxFiles: 200, maxLines: 20_000 } },
      subscriptions: [{ provider: 'anthropic', agent: 'claude-code' }],
    });
    const v = checkAction(s, { kind: 'envelope.change', proposed: wide }, NOW);
    expect(v).toMatchObject({ verdict: 'escalate', reserved: 'widen-envelope' });
    for (const a of [start({ capUsd: 1e6 }), { kind: 'reserved', item: 'publish' }])
      checkAction(s, a, NOW);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('has no schema field that can name a reserved item or extra power', () => {
    for (const bad of [
      { totalCapUsd: 1, preAnswer: ['publish'] },
      { totalCapUsd: 1, preAnswer: ['destructive'] },
      { totalCapUsd: 1, reserved: ['licence'] },
      { totalCapUsd: 1, allowAll: true },
      { totalCapUsd: -1 },
    ])
      expect(EnvelopeSchema.safeParse(bad).success).toBe(false);
  });
});

describe('widenings', () => {
  const env = (o: Record<string, unknown>) => EnvelopeSchema.parse({ totalCapUsd: 10, ...o });
  it('lists every way of widening', () => {
    const cur = env({
      runCapUsd: 2,
      expires: '2026-11-01T00:00:00.000Z',
      write: { mode: 'auto-merge', limits: { maxFiles: 5, maxLines: 100 } },
      subscriptions: [{ provider: 'anthropic', agent: 'claude-code', runs: 3, hours: 2 }],
    });
    const next = env({
      totalCapUsd: 11,
      preAnswer: ['write-in-worktree'],
      write: { mode: 'auto-merge', limits: { maxFiles: 6, maxLines: 100 } },
      subscriptions: [{ provider: 'anthropic', agent: 'claude-code', runs: 4 }],
    });
    expect(widenings(cur, next)).toEqual([
      'total cap',
      'run cap',
      'pre-answers',
      'write policy',
      'subscriptions',
      'expiry',
    ]);
    expect(
      widenings(
        env({}),
        env({ write: { mode: 'auto-merge', limits: { maxFiles: 1, maxLines: 1 } } }),
      ),
    ).toEqual(['write policy']);
  });
  it('accepts a narrowing', () => {
    const cur = env({ preAnswer: ['write-in-worktree'] });
    expect(widenings(cur, env({ totalCapUsd: 5 }))).toEqual([]);
    const v = checkAction(
      running(),
      { kind: 'envelope.change', proposed: env({ totalCapUsd: 5 }) },
      NOW,
    );
    expect(v.verdict).toBe('allow');
  });
});

describe('run.start', () => {
  it('allows a run inside every cap', () => {
    expect(checkAction(running(), start(), NOW)).toMatchObject({
      verdict: 'allow',
      rule: 'budget.within',
    });
  });
  it('refuses bad input and wrong state or scope', () => {
    const s = running();
    expect(checkAction(s, { kind: 'run.start' }, NOW).rule).toBe('action.invalid');
    expect(checkAction(s, start({ wpId: 'wp3' }), NOW).rule).toBe('run.scope');
    expect(checkAction(s, start({ purpose: 'review', wpId: 'p1' }), NOW).rule).toBe('run.state');
    expect(
      checkAction({ ...s, status: 'gate' }, start({ purpose: 'review', wpId: 'p1' }), NOW).verdict,
    ).toBe('allow');
    expect(checkAction({ ...s, approval: undefined }, start(), NOW).rule).toBe(
      'program.unapproved',
    );
    expect(checkAction({ ...s, status: 'paused' }, start(), NOW).verdict).toBe('refuse');
    expect(checkAction({ ...s, status: 'approved' }, start(), NOW).rule).toBe('run.state');
    expect(checkAction(s, start({ providers: [] }), NOW).rule).toBe('source.unknown');
  });
  it('escalates in-place writes and expiry', () => {
    const s = running();
    expect(checkAction(s, start({ isolated: false }), NOW).rule).toBe('write.in-place');
    const expired = running({ envelope: { totalCapUsd: 10, expires: '2026-10-01T00:00:00.000Z' } });
    expect(checkAction(expired, start(), NOW).rule).toBe('envelope.expired');
  });
  it('checks band tops against run, department, phase and total caps, live runs reserved', () => {
    const s = running({ envelope: { totalCapUsd: 10, runCapUsd: 3 } });
    expect(checkAction(s, start({ capUsd: 3.5 }), NOW).rule).toBe('budget.run');
    const busy = { ...s, runs: [run({ capUsd: 3, runId: 'a' })] };
    expect(checkAction(busy, start({ capUsd: 1.5 }), NOW).rule).toBe('budget.phase');
    const dept = { ...s, runs: [run({ phaseId: 'p0', capUsd: 5.5, runId: 'b' })] };
    expect(checkAction(dept, start({ capUsd: 1 }), NOW).rule).toBe('budget.department');
    const total = running({ envelope: { totalCapUsd: 8 } });
    const spent = {
      ...total,
      runs: [run({ wpId: 'x', phaseId: 'px', status: 'finished', costUsd: 7.5, runId: 'c' })],
    };
    expect(checkAction(spent, start({ capUsd: 0.6 }), NOW)).toMatchObject({
      rule: 'budget.total',
      reserved: 'spend-beyond-envelope',
    });
  });
  it('enforces source policy: a local-only department never runs in the cloud', () => {
    const s = running();
    expect(checkAction(s, start({ wpId: 'wp2' }), NOW).rule).toBe('source.policy');
    expect(
      checkAction(s, start({ wpId: 'wp2', source: 'local', providers: ['ollama'] }), NOW).verdict,
    ).toBe('allow');
    const sub = start({ source: 'subscription', providers: ['anthropic'] });
    expect(checkAction(s, sub, NOW).rule).toBe('budget.subscription');
  });
  it('tracks subscription quotas in runs and hours', () => {
    const s = running({
      envelope: {
        totalCapUsd: 10,
        subscriptions: [
          { provider: 'anthropic', agent: 'claude-code', runs: 1 },
          { provider: 'google', agent: 'gemini-cli', hours: 1 },
        ],
      },
    });
    const sub = start({ source: 'subscription', providers: ['anthropic'], capUsd: 0 });
    expect(checkAction(s, sub, NOW).verdict).toBe('allow');
    const used = {
      ...s,
      runs: [
        run({ source: 'subscription', providers: ['anthropic'], capUsd: 0, status: 'finished' }),
      ],
    };
    expect(checkAction(used, sub, NOW).reason).toMatch(/run quota/);
    const g = start({ source: 'subscription', providers: ['google'], capUsd: 0 });
    const hours = {
      ...s,
      runs: [
        run({
          source: 'subscription',
          providers: ['google'],
          capUsd: 0,
          hours: 1.2,
          status: 'finished',
        }),
      ],
    };
    expect(checkAction(hours, g, NOW).reason).toMatch(/hour quota/);
  });
});

describe('confirmations', () => {
  const c = (o: Record<string, unknown>) => ({ kind: 'confirm', inWorktree: true, ...o });
  it('pre-answers budget within the envelope only, with an amount', () => {
    const s = running();
    expect(checkAction(s, c({ confirm: 'budget', amountUsd: 1 }), NOW).verdict).toBe('allow');
    expect(checkAction(s, c({ confirm: 'budget' }), NOW).rule).toBe('confirm.overcap');
    expect(checkAction(s, c({ confirm: 'budget', amountUsd: 50 }), NOW).verdict).toBe('escalate');
    expect(
      checkAction({ ...s, status: 'approved' }, c({ confirm: 'budget', amountUsd: 1 }), NOW).rule,
    ).toBe('confirm.unbounded');
    const none = running({ envelope: { totalCapUsd: 10 } });
    expect(checkAction(none, c({ confirm: 'budget', amountUsd: 1 }), NOW).verdict).toBe('escalate');
  });
  it('pre-answers writes inside the run worktree only', () => {
    const s = running();
    expect(checkAction(s, c({ confirm: 'patch', risk: 'write' }), NOW).verdict).toBe('allow');
    expect(checkAction(s, c({ confirm: 'patch', inWorktree: false }), NOW).rule).toBe(
      'confirm.outside',
    );
    const none = running({ envelope: { totalCapUsd: 10 } });
    expect(checkAction(none, c({ confirm: 'artifact' }), NOW).verdict).toBe('escalate');
  });
});

describe('confirmation classes (D-035, P5-F2)', () => {
  const c = (o: Record<string, unknown>) => ({ kind: 'confirm', inWorktree: true, ...o });
  const rule = (o: Record<string, unknown>, s = running()) => checkAction(s, c(o), NOW).rule;
  it('spend past the accepted cap or of an unknown amount is over-cap, even pre-answered', () => {
    expect(rule({ confirm: 'budget', amountUsd: 1, overCap: true })).toBe('confirm.overcap');
    expect(rule({ confirm: 'budget' })).toBe('confirm.overcap');
  });
  it('in-envelope spend without the pre-answer stays trivial; above it never is', () => {
    const none = running({ envelope: { totalCapUsd: 10 } });
    expect(rule({ confirm: 'budget', amountUsd: 1 }, none)).toBe('confirm.budget');
    expect(rule({ confirm: 'budget', amountUsd: 50 }, none)).toMatch(/^budget\./);
  });
  it('a tool past the worktree with more than read risk runs code: confirm.exec', () => {
    expect(rule({ confirm: 'tool', risk: 'write', inWorktree: false })).toBe('confirm.exec');
    expect(rule({ confirm: 'tool', inWorktree: false })).toBe('confirm.exec');
    expect(rule({ confirm: 'tool', risk: 'read', inWorktree: false })).toBe('confirm.write');
  });
  it('writes outside a worktree and control-file writes are never pre-answered', () => {
    expect(rule({ confirm: 'artifact', inWorktree: false })).toBe('confirm.outside');
    expect(rule({ confirm: 'tool', risk: 'write', control: true })).toBe('confirm.control');
    expect(rule({ confirm: 'patch', risk: 'write', control: true })).toBe('confirm.control');
    expect(rule({ confirm: 'tool', risk: 'write' })).toBe('confirm.worktree');
  });
});

describe('merge', () => {
  const m = (o: Record<string, unknown> = {}) => ({
    kind: 'merge',
    runId: 'r1',
    testsPassed: true,
    criticApproved: true,
    zonesTouched: false,
    files: 2,
    lines: 30,
    ciGreenForCommit: true,
    targetIsDefaultBranch: false,
    ...o,
  });
  const auto = running({
    envelope: {
      totalCapUsd: 10,
      write: { mode: 'auto-merge', limits: { maxFiles: 5, maxLines: 100 } },
    },
  });
  it('waits for one click by default', () => {
    expect(checkAction(running(), m(), NOW).rule).toBe('merge.approval');
  });
  it('auto-merges only when every condition holds', () => {
    expect(checkAction(auto, m(), NOW).verdict).toBe('allow');
    const v = checkAction(
      auto,
      m({
        testsPassed: false,
        criticApproved: false,
        ciGreenForCommit: false,
        zonesTouched: true,
        files: 9,
        lines: 999,
      }),
      NOW,
    );
    expect(v.reason).toBe(
      'auto-merge needs tests, critic approval, CI for this commit, no zone touched, file limit, line limit',
    );
  });
  it('never merges into the default branch without the Sponsor', () => {
    expect(checkAction(auto, m({ targetIsDefaultBranch: true }), NOW).reserved).toBe(
      'merge-default-branch',
    );
  });
});
