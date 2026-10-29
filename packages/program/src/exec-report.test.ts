import { describe, expect, it } from 'vitest';
import {
  buildExecutiveReport,
  type ExecInput,
  type PeriodEvent,
  type ResultLabel,
} from './exec-report.js';
import { execText } from './exec-text.js';
import { reportMarkdown, type JournalMetrics } from './report.js';
import type { ProgramState } from './schemas.js';
import { NOW, run, running } from './test-helpers/fixtures.js';

const HEAD = 'c'.repeat(40);
const good: JournalMetrics = {
  headCommit: HEAD,
  ci: { commit: HEAD, status: 'success', evidence: [`ci:${HEAD}:success`] },
  tests: { passed: 12, failed: 0, evidence: ['run:r1'] },
};

const ev = (seq: number, event: unknown, actor = 'kernel'): PeriodEvent => ({
  seq,
  at: NOW.toISOString(),
  actor,
  event,
});

const label = (over: Partial<ResultLabel> = {}): ResultLabel => ({
  runId: 'r1',
  wpId: 'wp1',
  status: 'finished',
  assurance: 'V2',
  basis: 'V2: approved by mock-delta (1 nodes); 1 test run(s) passed',
  ...over,
});

function busy(): ProgramState {
  return {
    ...running(),
    runs: [
      run({ status: 'finished', costUsd: 0.5, settledAt: '2026-10-23T12:00:00.000Z' }),
      run({ runId: 'r2', wpId: 'wp2', capUsd: 2 }),
    ],
    escalations: [
      { id: 'e1', at: NOW.toISOString(), rule: 'budget.phase', question: 'Raise phase 1 to $6?' },
    ],
  };
}

const period: ExecInput = {
  since: NOW.toISOString(),
  events: [
    ev(7, { type: 'run.settled', runId: 'r1', status: 'finished', costUsd: 0.5, evidence: [] }),
    ev(8, { type: 'reported' }, 'po'),
    ev(9, { type: 'run.started', run: run({ runId: 'r2', wpId: 'wp2', capUsd: 2 }) }),
    ev(10, { type: 'escalate', escalation: busy().escalations[0] }, 'po'),
  ],
  results: [label()],
};

describe('executive report v2 (S10 R4)', () => {
  it('keeps the fixed order: asks, changes, forecast, top risk (results after, not in digests)', () => {
    const d = buildExecutiveReport(busy(), period, { kind: 'digest', now: NOW });
    expect(d.sections.map((s) => s.key)).toEqual(['asks', 'changes', 'forecast', 'risk']);
    const g = buildExecutiveReport(busy(), period, { kind: 'gate', now: NOW });
    expect(g.sections.map((s) => s.key)).toEqual([
      'asks',
      'changes',
      'forecast',
      'risk',
      'results',
    ]);
    // The ask is in the first sentence.
    expect(d.headline).toMatch(/^1 decision waits for you\. Running\./);
    expect(d.counts).toEqual({ asks: 1, budgetPct: 25, alerts: 0, changes: 3 });
  });

  it('cites journal evidence for every claim, the log sequence for every change', () => {
    const r = buildExecutiveReport(busy(), period, { kind: 'gate', now: NOW });
    const t = execText('en');
    const nones = [t.noAsks, t.noRisk, t.noResults, t.fcDone];
    for (const sec of r.sections)
      for (const l of sec.lines)
        if (!nones.includes(l.text) && !l.text.startsWith('no change'))
          expect(l.evidence.length, `${sec.key}: ${l.text}`).toBeGreaterThan(0);
    const changes = r.sections.find((s) => s.key === 'changes')!.lines;
    expect(changes.map((l) => l.evidence[0])).toEqual(['event:7', 'event:9', 'event:10']);
    expect(changes[0]!.text).toBe(`wp1: finished, V2 (${label().basis})`);
    const md = reportMarkdown(r);
    expect(md.indexOf('What needs your answer')).toBeLessThan(md.indexOf('What changed'));
    expect(md.indexOf('Forecast')).toBeLessThan(md.indexOf('Top risk'));
    expect(md).toContain('"Raise phase 1 to $6?" (if you say nothing: the work package waits)');
  });

  it('is unchanged when the period holds only bookkeeping', () => {
    const quiet = buildExecutiveReport(
      running(),
      { events: [ev(3, { type: 'reported' }, 'po'), ev(4, { type: 'nonsense' })] },
      { kind: 'digest', now: NOW },
    );
    expect(quiet.changed).toBe(false);
    const alerted = buildExecutiveReport(
      running(),
      {
        events: [],
        alerts: [{ rule: 'run.stalled', text: 'run r9 silent', evidence: ['heartbeat:x'] }],
      },
      { kind: 'digest', now: NOW },
    );
    expect(alerted.changed).toBe(true);
    expect(alerted.sections[3]!.lines[0]).toEqual({
      text: 'the watchdog reports run.stalled',
      evidence: ['heartbeat:x'],
    });
  });

  it('says "verified" for a delivery only with CI green on the exact head and passing tests', () => {
    const done: ProgramState = {
      ...running(),
      status: 'delivered',
      runs: [run({ status: 'finished' })],
    };
    const ok = buildExecutiveReport(
      done,
      { events: [], metrics: good },
      { kind: 'final', now: NOW },
    );
    expect(ok.verified).toBe(true);
    expect(ok.headline).toBe(
      `Delivered, every claim below backed by journal evidence: CI green for ${HEAD.slice(0, 12)}, tests: 12 passed, 0 failed.`,
    );
    const bad: JournalMetrics[] = [
      {},
      { ...good, ci: { ...good.ci!, commit: 'd'.repeat(40) } },
      { ...good, ci: { ...good.ci!, status: 'pending' } },
      { ...good, ci: { ...good.ci!, evidence: [] } },
      { ...good, tests: undefined },
      { ...good, tests: { passed: 3, failed: 1, evidence: ['run:r1'] } },
    ];
    for (const metrics of bad) {
      const r = buildExecutiveReport(done, { events: [], metrics }, { kind: 'final', now: NOW });
      expect(r.verified).toBe(false);
      expect(r.headline).toMatch(/^Delivered\. Not verified: /);
    }
    // P5-F6: a gate closed on the Sponsor's word alone says so.
    const t = execText('fr');
    expect(t.gateClosed('p1', 'pass')).toBe(
      'porte p1 : pass (décision du Sponsor, constats non comptés par une machine)',
    );
    expect(t.gateClosed('p1', 'hold', 2)).toBe('porte p1 : hold (2 Critique/Élevé ouverts)');
    expect(execText('en').gateClosed('p1', 'pass')).toMatch(/the Sponsor decided/);
    // P5-F7: a gate or milestone report is not a delivery: never "verified", even with
    // every piece of evidence there.
    for (const kind of ['gate', 'milestone', 'digest'] as const) {
      const r = buildExecutiveReport(running(), { events: [], metrics: good }, { kind, now: NOW });
      expect(r.verified).toBe(false);
    }
  });

  it('shows assurance labels and flags results below V2 as the top risk', () => {
    const r = buildExecutiveReport(
      { ...running(), runs: [run({ status: 'finished', costUsd: 0.2 })] },
      {
        events: [],
        results: [label({ assurance: 'V1', basis: 'V1: approved by x; no tests or CI' })],
      },
      { kind: 'milestone', now: NOW },
    );
    expect(r.sections[3]!.lines[0]!.text).toBe('1 finished result is below V2 (not verified)');
    expect(r.sections[4]!.lines[0]!.text).toMatch(/^wp1 finished — V1 \(/);
  });

  it('speaks French', () => {
    const r = buildExecutiveReport(busy(), period, { kind: 'digest', now: NOW, locale: 'fr' });
    const md = reportMarkdown(r);
    expect(r.headline).toMatch(/^1 décision vous attend\. En cours\./);
    for (const h of [
      'Ce qui attend votre réponse',
      'Ce qui a changé',
      'Prévision',
      'Risque principal',
    ])
      expect(md).toContain(h);
    expect(md).toContain('« Raise phase 1 to $6? »');
    const fr = buildExecutiveReport(
      { ...running({ locale: 'fr' }), status: 'delivered' },
      { events: [] },
      { kind: 'final', now: NOW },
    );
    expect(fr.headline).toMatch(/^Livré\. Non vérifié/);
  });

  it('ranks the top risk: over the cap, then expiry, then old questions', () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      run({ runId: `x${i}`, wpId: 'wp1', status: 'failed', costUsd: 3, capUsd: 3 }),
    );
    const over = buildExecutiveReport(
      { ...running(), runs: many },
      { events: [] },
      { kind: 'digest', now: NOW },
    );
    expect(over.sections[3]!.lines[0]!.text).toMatch(/above the cap \$10\.00/);
    const soon = running({
      envelope: { totalCapUsd: 10, expires: new Date(NOW.getTime() + 3_600_000).toISOString() },
    });
    const exp = buildExecutiveReport(soon, { events: [] }, { kind: 'digest', now: NOW });
    expect(exp.sections[3]!.lines[0]!.text).toMatch(/envelope expires/);
    const asks = buildExecutiveReport(
      busy(),
      { events: [] },
      { kind: 'digest', now: new Date(NOW.getTime() + 5 * 3_600_000) },
    );
    expect(asks.sections[3]!.lines[0]!.text).toBe('1 question open, the oldest for 5 h');
    const calm = buildExecutiveReport(running(), { events: [] }, { kind: 'digest', now: NOW });
    expect(calm.sections[3]!.lines[0]).toEqual({ text: 'no risk recorded', evidence: [] });
  });

  it('describes every kind of transition', () => {
    const s = { ...busy(), status: 'paused' as const, amendment: busy().charter };
    const gate = {
      phaseId: 'p1',
      verdict: 'pass',
      reviewer: 'rv',
      reviewerProvider: 'google',
      openCriticalOrHigh: 0,
      evidence: ['run:rv1'],
      at: NOW.toISOString(),
    };
    const events = [
      ev(1, { type: 'approve', charterHash: 'h' }, 'sponsor'),
      ev(2, { type: 'start' }, 'po'),
      ev(3, { type: 'gate.open' }, 'po'),
      ev(4, { type: 'gate.close', record: gate }, 'po'),
      ev(5, { type: 'pause' }, 'sponsor'),
      ev(
        6,
        {
          type: 'decide',
          decision: {
            id: 'd1',
            at: NOW.toISOString(),
            actor: 'po',
            text: 'Use M4 screws',
            evidence: [],
          },
        },
        'po',
      ),
      ev(7, { type: 'answer', id: 'e0', answer: 'yes' }, 'sponsor'),
      ev(8, { type: 'amend.reject' }, 'sponsor'),
    ];
    const r = buildExecutiveReport(
      s,
      { events, deadlines: { e1: '2026-10-24T10:00:00.000Z' } },
      { kind: 'digest', now: NOW },
    );
    const texts = r.sections[1]!.lines.map((l) => l.text);
    expect(texts).toEqual([
      'you approved the charter',
      'the program started',
      'phase p1 reached its gate',
      'gate p1: pass (0 open Critical/High)',
      'pause by sponsor',
      'decision by po: "Use M4 screws"',
      'you answered yes to e0',
      'charter amend.reject',
    ]);
    expect(r.sections[1]!.lines[5]!.quoted).toBe(true);
    const asks = r.sections[0]!.lines.map((l) => l.text);
    expect(asks[0]).toBe('a charter amendment waits for your approval');
    expect(asks[1]).toMatch(/if you say nothing: no at 2026-10-24T10:00/);
    expect(r.counts.asks).toBe(2);
  });
});

describe('wording', () => {
  it('has every message in English and French, each one non-empty', () => {
    const en = execText('en') as unknown as Record<string, unknown>;
    const fr = execText('fr') as unknown as Record<string, unknown>;
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
    const counts = { asks: 1, budgetPct: 5, alerts: 0, changes: 2 };
    const call = (v: unknown, k: string): string => {
      if (typeof v === 'string') return v;
      if (typeof v !== 'function') return Object.values(v as object).join(' ');
      const f = v as (...a: unknown[]) => unknown;
      return String(k === 'alertBody' ? f(['a']) : f('x', 'y', true));
    };
    for (const k of Object.keys(en)) {
      if (k === 'counts') continue;
      expect(call(en[k], k), `en.${k}`).not.toBe('');
      expect(call(fr[k], k), `fr.${k}`).not.toBe(call(en[k], k));
    }
    expect(execText('fr').counts(counts)).toBe(
      '1 décision en attente, 5 % du budget utilisé, 0 alerte, 2 changements.',
    );
    expect(execText('fr').asksLead(0)).toBe('');
    expect(execText('en').riskUnverified(1)).toMatch(/^1 finished result is/);
    expect(execText('fr').riskUnverified(2)).toMatch(/^2 résultats terminés sont/);
  });
});
