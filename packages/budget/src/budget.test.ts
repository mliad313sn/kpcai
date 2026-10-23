import type { BudgetLimits, SpendContext, SpendLedger } from '@kernelpai/core';
import { Journal } from '@kernelpai/journal';
import { afterEach, describe, expect, it } from 'vitest';
import { Governor } from './governor.js';
import { JournalLedger, startOfMonthUtc, startOfNextMonthUtc } from './ledger.js';

const ctx: SpendContext = {
  sessionId: 's1',
  project: '/repo',
  now: new Date('2026-10-23T12:00:00Z'),
};

function fixedLedger(
  spent: Partial<Record<'session' | 'project' | 'month', number>>,
): SpendLedger & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    spent(scope) {
      calls.push(scope);
      return spent[scope] ?? 0;
    },
  };
}

const limits = (over: Partial<BudgetLimits> = {}): BudgetLimits => ({
  confirmAboveUsd: 0.5,
  ...over,
});

describe('Governor', () => {
  it('allows small estimates without limits', () => {
    const g = new Governor(limits(), fixedLedger({}));
    expect(g.check(0.1, ctx)).toEqual({ action: 'allow', estimateUsd: 0.1 });
    expect(g.check(0.5, ctx).action).toBe('allow');
  });

  it('asks for confirmation above the threshold', () => {
    const v = new Governor(limits(), fixedLedger({})).check(0.75, ctx);
    expect(v).toMatchObject({ action: 'confirm', estimateUsd: 0.75 });
    expect(v.action === 'confirm' && v.reason).toBe(
      'estimated $0.75 is above the $0.50 confirmation threshold',
    );
  });

  it('blocks a task over its own budget without reading the ledger', () => {
    const ledger = fixedLedger({});
    const v = new Governor(limits({ task: 0.2 }), ledger).check(0.3, ctx);
    expect(v).toMatchObject({ action: 'block', scope: 'task', limitUsd: 0.2, projectedUsd: 0.3 });
    expect(v.action === 'block' && v.options).toEqual([
      'reduce_scope',
      'cheaper_models',
      'continue',
    ]);
    expect(ledger.calls).toEqual([]);
  });

  it.each([
    ['session', { session: 1 }, { session: 0.9 }],
    ['project', { project: 5 }, { project: 4.95 }],
    ['month', { month: 20 }, { month: 19.99 }],
  ] as const)('blocks when projected %s spend exceeds the limit', (scope, lim, spent) => {
    const g = new Governor(limits(lim), fixedLedger(spent));
    const v = g.check(0.2, ctx);
    expect(v).toMatchObject({ action: 'block', scope, estimateUsd: 0.2 });
    expect(v.action === 'block' && v.projectedUsd).toBeCloseTo(Object.values(spent)[0]! + 0.2);
    expect(v.action === 'block' && v.reason).toMatch(
      new RegExp(`^${scope} budget .* would be exceeded`),
    );
    expect(g.check(0.01, ctx).action).toBe('allow');
  });

  it('allows spend exactly at the limit and reports the narrowest exceeded scope', () => {
    const ledger = fixedLedger({ session: 0.5, project: 10, month: 100 });
    const g = new Governor(limits({ session: 1, project: 1, month: 1 }), ledger);
    const v = g.check(0.5, ctx);
    expect(v.action === 'block' && v.scope).toBe('project');
    expect(ledger.calls).toEqual(['session', 'project']);
    expect(
      new Governor(limits({ session: 1 }), fixedLedger({ session: 0.5 })).check(0.5, ctx).action,
    ).toBe('allow');
  });

  it('blocks before confirming', () => {
    const v = new Governor(limits({ task: 1 }), fixedLedger({})).check(2, ctx);
    expect(v.action).toBe('block');
  });

  it('rejects invalid estimates', () => {
    const g = new Governor(limits(), fixedLedger({}));
    expect(() => g.check(-1, ctx)).toThrow(RangeError);
    expect(() => g.check(Number.NaN, ctx)).toThrow(RangeError);
  });
});

describe('JournalLedger', () => {
  const open: Journal[] = [];
  afterEach(() => {
    while (open.length) open.pop()?.close();
  });

  function journalAt(times: string[]): Journal {
    const queue = [...times];
    const j = Journal.open(':memory:', {
      now: () => new Date(queue.shift() ?? '2026-10-23T00:00:00Z'),
    });
    open.push(j);
    return j;
  }

  it('reads session, project and calendar-month spend', () => {
    const j = journalAt([
      '2026-09-30T23:00:00Z', // session old (/repo)
      '2026-09-30T23:59:59.999Z', // september spend
      '2026-10-01T00:00:00Z', // session cur (/repo)
      '2026-10-01T00:00:00Z', // october spend, first instant
      '2026-10-02T00:00:00Z', // session other (/elsewhere)
      '2026-10-20T00:00:00Z',
    ]);
    const old = j.startSession('old', '/repo');
    j.append({ sessionId: old, type: 'response', costUsd: 3, payload: {} });
    const cur = j.startSession('cur', '/repo');
    j.append({ sessionId: cur, type: 'response', costUsd: 1, payload: {} });
    const other = j.startSession('other', '/elsewhere');
    j.append({ sessionId: other, type: 'response', costUsd: 0.5, payload: {} });
    const ledger = new JournalLedger(j);
    const c = { sessionId: cur, project: '/repo', now: new Date('2026-10-23T12:00:00Z') };
    expect(ledger.spent('session', c)).toBe(1);
    expect(ledger.spent('project', c)).toBe(4);
    expect(ledger.spent('month', c)).toBe(1.5);
    // September is bounded at 1 October 00:00 UTC: October spend is not counted.
    expect(ledger.spent('month', { ...c, now: new Date('2026-09-15T00:00:00Z') })).toBe(3);
    expect(ledger.spent('month', { ...c, now: new Date('2026-08-15T00:00:00Z') })).toBe(0);
  });

  it('drives the governor end to end', () => {
    const j = journalAt([]);
    const s = j.startSession('t', '/repo');
    j.append({ sessionId: s, type: 'response', costUsd: 0.9, payload: {} });
    const g = new Governor({ session: 1, confirmAboveUsd: 5 }, new JournalLedger(j));
    const c = { sessionId: s, project: '/repo', now: new Date('2026-10-23T00:00:00Z') };
    expect(g.check(0.05, c).action).toBe('allow');
    expect(g.check(0.2, c)).toMatchObject({ action: 'block', scope: 'session', limitUsd: 1 });
  });
});

describe('startOfNextMonthUtc', () => {
  it('rolls over months and years in UTC', () => {
    expect(startOfNextMonthUtc(new Date('2026-12-31T23:59:59.999Z')).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
    expect(startOfNextMonthUtc(new Date('2026-10-01T00:00:00Z')).toISOString()).toBe(
      '2026-11-01T00:00:00.000Z',
    );
  });
});

describe('startOfMonthUtc', () => {
  it('uses the UTC calendar month', () => {
    expect(startOfMonthUtc(new Date('2026-10-31T23:30:00-05:00')).toISOString()).toBe(
      '2026-11-01T00:00:00.000Z',
    );
    expect(startOfMonthUtc(new Date('2026-01-01T00:00:00Z')).toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });
});
