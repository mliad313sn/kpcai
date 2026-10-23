import { describe, expect, it } from 'vitest';
import { seat, snapshot } from '../test-helpers/enterprise-fixtures';
import {
  assuranceShares,
  heartbeatStatus,
  matchesFilter,
  orgRows,
  portfolioSpend,
  quotaGauges,
  rateOver,
  seatCounts,
  sortSeats,
  splitInbox,
  summaryCounts,
} from './derive';
import { fromSnapshot } from './state';
import type { Gauge, Heartbeat } from './schemas';

const hb = (over: Partial<Heartbeat> = {}): Heartbeat => ({
  at: new Date(1_000_000).toISOString(),
  intervalSec: 60,
  staleAfterSec: 300,
  status: 'ok',
  alerts: [],
  ...over,
});

describe('heartbeat liveness (S10 R2): silence never looks healthy', () => {
  it('is ok, late, stale, alert, unknown or offline', () => {
    const at = 1_000_000;
    expect(heartbeatStatus(hb(), at + 30_000, true)).toMatchObject({ level: 'ok', ageMs: 30_000 });
    expect(heartbeatStatus(hb(), at + 120_000, true).level).toBe('late');
    expect(heartbeatStatus(hb(), at + 301_000, true).level).toBe('stale');
    expect(heartbeatStatus(hb({ status: 'stale' }), at, true).level).toBe('stale');
    const alerts = [{ rule: 'ask-old', text: 'An ask is 2 days old' }];
    expect(heartbeatStatus(hb({ status: 'alert', alerts }), at, true)).toMatchObject({
      level: 'alert',
      alerts,
    });
    expect(heartbeatStatus(undefined, at, true).level).toBe('unknown');
    expect(heartbeatStatus(hb({ at: 'garbage' }), at, true).level).toBe('unknown');
    expect(heartbeatStatus(hb(), at + 5, false)).toMatchObject({ level: 'offline', ageMs: 5 });
    // A clock behind the daemon's never shows a negative age.
    expect(heartbeatStatus(hb(), at - 5000, true).ageMs).toBe(0);
  });
});

describe('gauges', () => {
  it('reads the portfolio gauge with its reserved band tops and rate', () => {
    const g = portfolioSpend(snapshot().gauges)!;
    expect(g).toMatchObject({ spent: 12.4, committed: 18, cap: 50, over: false });
    expect(g.reserved).toBeCloseTo(5.6);
    expect(g.rate).toEqual({ usdPerHour: 2.1, capUsdPerHour: 5 });
    expect(g.concurrency).toEqual({ inUse: 3, limit: 8 });
    expect(rateOver(g)).toBe(false);
    expect(rateOver({ ...g, rate: { usdPerHour: 9, capUsdPerHour: 5 } })).toBe(true);
    expect(rateOver({ ...g, rate: { usdPerHour: 9 } })).toBe(false);
  });

  it('sums program gauges when there is no portfolio gauge, and flags overspend', () => {
    const progs: Gauge[] = [
      { scope: 'program', id: 'a', usd: { spent: 4, committed: 6, cap: 5 } },
      { scope: 'program', id: 'b', usd: { spent: 1, committed: 1, cap: 5 } },
    ];
    expect(portfolioSpend(progs)).toMatchObject({ spent: 5, committed: 7, cap: 10, over: false });
    const over = portfolioSpend([
      { scope: 'program', id: 'a', usd: { spent: 4, committed: 12, cap: 10 } },
    ])!;
    expect(over).toMatchObject({ over: true, ratio: 1.2 });
    expect(
      portfolioSpend([{ scope: 'program', id: 'a', usd: { spent: 1, committed: 1, cap: 0 } }])!
        .ratio,
    ).toBe(1.5);
    expect(portfolioSpend([])).toBeUndefined();
    expect(quotaGauges(snapshot().gauges).map((g) => g.id)).toEqual(['claude-code', 'ollama']);
  });

  it('turns results into an assurance mix', () => {
    const mix = assuranceShares(snapshot().results!)!;
    expect(mix.map((m) => [m.label, m.count])).toEqual([
      ['V0', 1],
      ['V1', 1],
      ['V2', 1],
      ['V3', 0],
    ]);
    expect(mix[0]!.share).toBeCloseTo(1 / 3);
    expect(assuranceShares([])).toBeUndefined();
  });
});

describe('seats and inbox', () => {
  it('orders the seats that need a human first', () => {
    const seats = [seat(4), seat(5), seat(1), seat(0)];
    expect(sortSeats(seats).map((s) => s.state)).toEqual([
      'waiting_for_you',
      'blocked',
      'writing',
      'idle',
    ]);
    expect(seatCounts(seats)).toEqual({ total: 4, working: 1, waiting: 1, blocked: 1, idle: 1 });
    expect(matchesFilter(seat(1), 'attention')).toBe(true);
    expect(matchesFilter(seat(0), 'working')).toBe(true);
    expect(matchesFilter(seat(2), 'idle')).toBe(true);
    expect(matchesFilter(seat(2), 'all')).toBe(true);
    expect(matchesFilter(seat(2), 'working')).toBe(false);
  });

  it('lays out one team or departments in rows', () => {
    const seats = Array.from({ length: 10 }, (_, i) => seat(i));
    const team = orgRows(seats, 'team', 4);
    expect(team.map((r) => r.kind)).toEqual(['seats', 'seats', 'seats']);
    const depts = orgRows(seats, 'departments', 4);
    const heads = depts.filter((r) => r.kind === 'head');
    expect(heads.map((h) => (h.kind === 'head' ? h.department : ''))).toEqual([
      'data',
      'design',
      'engineering',
      'review',
      'security',
    ]);
    expect(orgRows(seats, 'team', 0)).toHaveLength(10);
  });

  it('batches only trivial asks; unmarked asks are consequential', () => {
    const items = snapshot().inbox;
    const { consequential, trivial } = splitInbox([
      ...items,
      { ...items[1]!, escalationId: 'x', class: undefined },
    ]);
    expect(consequential.map((i) => i.escalationId)).toEqual(['e-merge', 'x']);
    expect(trivial.map((i) => i.escalationId)).toEqual(['e-t1', 'e-t2']);
    expect(summaryCounts(fromSnapshot(snapshot()))).toMatchObject({ programs: 2, asks: 3 });
  });
});
