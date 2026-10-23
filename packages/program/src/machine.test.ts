import { describe, expect, it } from 'vitest';
import { charterHash } from './ledger.js';
import { newProgram, transition } from './machine.js';
import { CharterSchema, type ProgramState } from './schemas.js';
import { NOW, charter, drive, run, running } from './test-helpers/fixtures.js';

const gate = (o: Record<string, unknown> = {}) => ({
  type: 'gate.close',
  record: {
    phaseId: 'p1',
    verdict: 'pass',
    reviewer: 'rv',
    reviewerProvider: 'google',
    openCriticalOrHigh: 0,
    evidence: ['event:42', 'ci:abc:success'],
    at: NOW.toISOString(),
    ...o,
  },
});
const settle = (runId: string, o: Record<string, unknown> = {}) => ({
  type: 'run.settled',
  runId,
  status: 'finished',
  costUsd: 0.5,
  evidence: [`event:${runId}`],
  ...o,
});

/** Phase 1 built (wp1 on openai, wp2 local) and at its gate with a review run done. */
function atGate(): ProgramState {
  const s = drive(running(), [
    [{ type: 'run.started', run: run() }, 'kernel'],
    [
      {
        type: 'run.started',
        run: run({ runId: 'r2', wpId: 'wp2', source: 'local', providers: ['ollama'] }),
      },
      'kernel',
    ],
    [settle('r1', { testsPassed: true, hours: 0.1 }), 'kernel'],
    [settle('r2'), 'kernel'],
    [{ type: 'gate.open' }, 'po'],
  ]);
  return drive(s, [
    [
      {
        type: 'run.started',
        run: run({ runId: 'rv1', wpId: 'p1', purpose: 'review', providers: ['google'] }),
      },
      'kernel',
    ],
    [settle('rv1'), 'kernel'],
  ]);
}

describe('charter', () => {
  it('rejects incoherent org charts', () => {
    const bad = (o: Record<string, unknown>) => CharterSchema.safeParse(charter(o)).success;
    const c = charter();
    expect(bad({})).toBe(true);
    expect(bad({ seats: c.seats.filter((s) => s.kind !== 'reviewer') })).toBe(false);
    expect(bad({ seats: [...c.seats, { ...c.seats[0]! }] })).toBe(false);
    expect(bad({ departments: [...c.departments, { ...c.departments[0]! }] })).toBe(false);
    expect(bad({ envelope: { totalCapUsd: 5 } })).toBe(false); // phase caps 8 > 5
    const reviewerInEng = c.seats.map((s) => (s.id === 'rv' ? { ...s, department: 'eng' } : s));
    expect(bad({ seats: reviewerInEng })).toBe(false);
    const leadByReviewer = structuredClone(c.phases);
    leadByReviewer[0]!.workPackages[0]!.lead = 'rv';
    expect(bad({ phases: leadByReviewer })).toBe(false);
    const unknownLead = structuredClone(c.phases);
    unknownLead[0]!.workPackages[0]!.lead = 'nobody';
    expect(bad({ phases: unknownLead })).toBe(false);
    const dup = structuredClone(c.phases);
    dup[1]!.id = 'p1';
    dup[1]!.workPackages[0]!.id = 'wp1';
    expect(bad({ phases: dup })).toBe(false);
    const loop = c.departments.map((d) => ({
      ...d,
      escalatesTo: d.id === 'eng' ? 'sec' : d.id === 'sec' ? 'eng' : 'sponsor',
    }));
    expect(bad({ departments: loop })).toBe(false);
    expect(
      bad({
        departments: [...c.departments, { id: 'x', kind: 'data', title: 'X', escalatesTo: 'nope' }],
      }),
    ).toBe(false);
    expect(
      bad({ departments: [...c.departments, { id: 'y', kind: 'data', title: 'Y', capUsd: 99 }] }),
    ).toBe(false);
    expect(
      bad({
        seats: [...c.seats, { id: 'z', kind: 'qa', department: 'none', title: 'Z', mandate: 'm' }],
      }),
    ).toBe(false);
    expect(bad({ extra: true })).toBe(false);
  });
});

describe('lifecycle', () => {
  it('goes draft → proposed → approved → running → gate → … → delivered', () => {
    let s = atGate();
    expect(s.status).toBe('gate');
    s = drive(s, [[gate(), 'po']]);
    expect(s).toMatchObject({ status: 'running', phaseIndex: 1 });
    s = drive(s, [
      [{ type: 'run.started', run: run({ runId: 'r3', wpId: 'wp3', phaseId: 'p2' }) }, 'kernel'],
      [settle('r3'), 'kernel'],
      [{ type: 'gate.open' }, 'po'],
      [
        {
          type: 'run.started',
          run: run({
            runId: 'rv2',
            wpId: 'p2',
            phaseId: 'p2',
            purpose: 'review',
            providers: ['google'],
          }),
        },
        'kernel',
      ],
      [settle('rv2'), 'kernel'],
      [gate({ phaseId: 'p2' }), 'po'],
    ]);
    expect(s.status).toBe('delivered');
    expect(transition(s, { type: 'stop', reason: 'x' }, 'sponsor', NOW).ok).toBe(false);
  });

  it('binds approval to the exact charter and lets only the Sponsor approve', () => {
    const s = drive(newProgram(charter(), NOW), [[{ type: 'propose', charter: charter() }, 'po']]);
    const hash = charterHash(s.charter);
    expect(transition(s, { type: 'approve', charterHash: hash }, 'po', NOW)).toMatchObject({
      ok: false,
    });
    expect(transition(s, { type: 'approve', charterHash: 'other' }, 'sponsor', NOW)).toMatchObject({
      ok: false,
    });
    expect(transition(s, { type: 'reject', reason: 'no' }, 'sponsor', NOW)).toMatchObject({
      ok: true,
      state: { status: 'draft' },
    });
    expect(transition(s, { type: 'start' }, 'po', NOW).ok).toBe(false);
    expect(transition(s, { type: 'propose', charter: { bad: 1 } }, 'po', NOW).ok).toBe(false);
    const approved = drive(s, [[{ type: 'approve', charterHash: hash }, 'sponsor']]);
    expect(transition(approved, { type: 'approve', charterHash: hash }, 'sponsor', NOW).ok).toBe(
      false,
    );
    expect(transition(approved, { type: 'propose', charter: charter() }, 'po', NOW).ok).toBe(false);
    expect(transition(approved, { type: 'reject', reason: '' }, 'sponsor', NOW).ok).toBe(false);
    expect(transition(s, { type: 'nope' }, 'po', NOW)).toMatchObject({
      ok: false,
      reason: 'the event does not parse',
    });
  });

  it('accepts kernel facts only from the kernel, and only runs the envelope allows', () => {
    const s = running();
    expect(transition(s, { type: 'run.started', run: run() }, 'po', NOW).ok).toBe(false);
    expect(
      transition(s, { type: 'run.started', run: run({ status: 'finished' }) }, 'kernel', NOW).ok,
    ).toBe(false);
    expect(
      transition(s, { type: 'run.started', run: run({ capUsd: 99 }) }, 'kernel', NOW),
    ).toMatchObject({ ok: false });
    expect(
      transition(s, { type: 'run.started', run: run({ wpId: 'wp3' }) }, 'kernel', NOW).ok,
    ).toBe(false);
    expect(
      transition(s, { type: 'run.started', run: run({ phaseId: 'p2' }) }, 'kernel', NOW).ok,
    ).toBe(false);
    const one = drive(s, [[{ type: 'run.started', run: run() }, 'kernel']]);
    expect(transition(one, { type: 'run.started', run: run() }, 'kernel', NOW).ok).toBe(false);
    expect(transition(one, settle('zz'), 'kernel', NOW).ok).toBe(false);
    expect(transition(one, settle('r1'), 'po', NOW).ok).toBe(false);
  });

  it('starts an over-envelope run once, on the Sponsor yes for that exact run', () => {
    const esc = {
      type: 'escalate',
      escalation: {
        id: 'e1',
        at: NOW.toISOString(),
        rule: 'budget.phase',
        question: 'Start wp1 up to $4.50?',
        subject: { wpId: 'wp1', capUsd: 4.5 },
      },
    };
    let s = drive(running(), [[esc, 'po']]);
    const big = { type: 'run.started', run: run({ capUsd: 4.5 }) };
    expect(transition(s, big, 'kernel', NOW).ok).toBe(false);
    expect(transition(s, { type: 'answer', id: 'e1', answer: 'yes' }, 'po', NOW).ok).toBe(false);
    s = drive(s, [[{ type: 'answer', id: 'e1', answer: 'yes' }, 'sponsor']]);
    expect(transition(s, { type: 'answer', id: 'e1', answer: 'no' }, 'sponsor', NOW).ok).toBe(
      false,
    );
    s = drive(s, [[big, 'kernel']]);
    expect(s.escalations[0]?.consumed).toBe(true);
    const again = { type: 'run.started', run: run({ runId: 'r9', capUsd: 4.5 }) };
    expect(transition(s, again, 'kernel', NOW).ok).toBe(false);
    expect(transition(s, esc, 'po', NOW).ok).toBe(false); // duplicate id
    const forged = { ...esc, escalation: { ...esc.escalation, id: 'e2', answer: 'yes' } };
    expect(transition(s, forged, 'po', NOW)).toMatchObject({
      ok: false,
      reason: 'only the Sponsor answers',
    });
  });
});

describe('gates', () => {
  it('opens only when every work package finished and nothing is live', () => {
    const s = running();
    expect(transition(s, { type: 'gate.open' }, 'po', NOW)).toMatchObject({
      ok: false,
      reason: 'unfinished: wp1, wp2',
    });
    const live = drive(s, [
      [{ type: 'run.started', run: run() }, 'kernel'],
      [settle('r1'), 'kernel'],
      [
        {
          type: 'run.started',
          run: run({ runId: 'r2', wpId: 'wp2', source: 'local', providers: ['ollama'] }),
        },
        'kernel',
      ],
      [settle('r2'), 'kernel'],
      [{ type: 'run.started', run: run({ runId: 'r3', capUsd: 0.1 }) }, 'kernel'],
    ]);
    expect(transition(live, { type: 'gate.open' }, 'po', NOW)).toMatchObject({
      ok: false,
      reason: 'runs are still live',
    });
    expect(transition({ ...live, status: 'gate' }, { type: 'gate.open' }, 'po', NOW).ok).toBe(
      false,
    );
  });

  it('refuses a pass without evidence, with open High findings, or a same-provider reviewer', () => {
    const s = atGate();
    const reason = (e: unknown) => (transition(s, e, 'po', NOW) as { reason?: string }).reason;
    expect(reason(gate({ evidence: [] }))).toBe('a pass needs journal evidence');
    expect(reason(gate({ openCriticalOrHigh: 1 }))).toMatch(/still open/);
    expect(reason(gate({ reviewerProvider: 'openai' }))).toMatch(/shares a provider/);
    expect(reason(gate({ reviewer: 'cad' }))).toMatch(/not a reviewer seat/);
    expect(reason(gate({ phaseId: 'p2' }))).toMatch(/another phase/);
    const noReview = { ...s, runs: s.runs.filter((r) => r.purpose === 'work') };
    expect(transition(noReview, gate(), 'po', NOW)).toMatchObject({ ok: false });
    expect(transition(running(), gate(), 'po', NOW).ok).toBe(false);
  });

  it('a subscription builder counts as its provider for reviewer diversity', () => {
    const s = atGate();
    const sub = {
      ...s,
      runs: s.runs.map((r) =>
        r.runId === 'r1' ? { ...r, source: 'subscription' as const, providers: ['anthropic'] } : r,
      ),
    };
    expect(transition(sub, gate({ reviewerProvider: 'anthropic' }), 'po', NOW).ok).toBe(false);
  });

  it('a hold sends the phase back to work', () => {
    const s = drive(atGate(), [
      [gate({ verdict: 'hold', openCriticalOrHigh: 2, evidence: [] }), 'po'],
    ]);
    expect(s).toMatchObject({ status: 'running', phaseIndex: 0 });
  });
});

describe('interruptibility', () => {
  it('pauses and resumes; a Sponsor pause is lifted only by the Sponsor', () => {
    const s = drive(running(), [[{ type: 'pause' }, 'sponsor']]);
    expect(s).toMatchObject({ status: 'paused', pausedFrom: 'running', pausedBy: 'sponsor' });
    expect(transition(s, { type: 'resume' }, 'po', NOW).ok).toBe(false);
    expect(transition(s, { type: 'pause' }, 'po', NOW).ok).toBe(false);
    expect(drive(s, [[{ type: 'resume' }, 'sponsor']]).status).toBe('running');
    const po = drive(running(), [
      [{ type: 'pause' }, 'po'],
      [{ type: 'resume' }, 'po'],
    ]);
    expect(po.status).toBe('running');
    expect(transition(running(), { type: 'resume' }, 'sponsor', NOW).ok).toBe(false);
  });
  it('stops from any live state, for good', () => {
    const s = drive(running(), [[{ type: 'stop', reason: 'enough' }, 'sponsor']]);
    expect(s.status).toBe('stopped');
    expect(transition(s, { type: 'start' }, 'po', NOW).ok).toBe(false);
    expect(transition(s, { type: 'stop', reason: '' }, 'po', NOW).ok).toBe(false);
  });
});

describe('amendments and the decision log', () => {
  it('keeps the approved charter in force until the Sponsor approves an amendment', () => {
    const s = running();
    const wider = charter({ envelope: { totalCapUsd: 100 } });
    const pending = drive(s, [[{ type: 'amend', charter: wider }, 'po']]);
    expect(pending.charter.envelope.totalCapUsd).toBe(10);
    expect(
      transition(
        pending,
        { type: 'amend.approve', charterHash: charterHash(pending.amendment!) },
        'po',
        NOW,
      ).ok,
    ).toBe(false);
    expect(
      transition(pending, { type: 'amend.approve', charterHash: 'x' }, 'sponsor', NOW).ok,
    ).toBe(false);
    const done = drive(pending, [
      [{ type: 'amend.approve', charterHash: charterHash(pending.amendment!) }, 'sponsor'],
    ]);
    expect(done.charter.envelope.totalCapUsd).toBe(100);
    expect(done.amendment).toBeUndefined();
    expect(drive(pending, [[{ type: 'amend.reject' }, 'sponsor']]).amendment).toBeUndefined();
    expect(transition(s, { type: 'amend.reject' }, 'sponsor', NOW).ok).toBe(false);
    expect(transition(s, { type: 'amend.approve', charterHash: 'x' }, 'sponsor', NOW).ok).toBe(
      false,
    );
    expect(
      transition(s, { type: 'amend', charter: charter({ programId: 'other' }) }, 'po', NOW).ok,
    ).toBe(false);
    expect(transition(s, { type: 'amend', charter: {} }, 'po', NOW).ok).toBe(false);
    expect(
      transition(newProgram(charter(), NOW), { type: 'amend', charter: wider }, 'po', NOW).ok,
    ).toBe(false);
  });
  it('refuses an amendment that drops the current phase', () => {
    const s = drive(atGate(), [[gate(), 'po']]);
    const short = charter({ phases: charter().phases.slice(0, 1) });
    const pending = drive(s, [[{ type: 'amend', charter: short }, 'po']]);
    expect(
      transition(
        pending,
        { type: 'amend.approve', charterHash: charterHash(pending.amendment!) },
        'sponsor',
        NOW,
      ),
    ).toMatchObject({ ok: false });
  });
  it('signs decisions with who sent them', () => {
    const d = { id: 'd1', at: NOW.toISOString(), actor: 'po', text: 'Use OpenSCAD', evidence: [] };
    const s = drive(running(), [[{ type: 'decide', decision: d }, 'po']]);
    expect(s.decisions).toHaveLength(1);
    expect(transition(s, { type: 'decide', decision: d }, 'po', NOW).ok).toBe(false);
    expect(transition(s, { type: 'decide', decision: { ...d, id: 'd2' } }, 'sponsor', NOW).ok).toBe(
      false,
    );
    expect(drive(s, [[{ type: 'reported' }, 'po']]).lastReportAt).toBe(NOW.toISOString());
  });
});
