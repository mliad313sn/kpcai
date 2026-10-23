import { describe, expect, it } from 'vitest';
import {
  JobSchema,
  PortfolioSchema,
  QueueSchema,
  killList,
  order,
  rateLimited,
  schedule,
  settled,
  started,
  type Job,
} from './scheduler.js';
import { NOW } from './test-helpers/fixtures.js';

const portfolio = (o: Record<string, unknown> = {}) =>
  PortfolioSchema.parse({
    id: 'pf',
    capUsd: 10,
    limits: { total: 4, perProgram: 2, defaultPerProvider: 2, perProvider: { ollama: 1 } },
    ...o,
  });
const job = (id: string, o: Record<string, unknown> = {}): Job =>
  JobSchema.parse({
    id,
    programId: 'p',
    wpId: 'wp',
    priority: 'normal',
    candidates: [{ provider: 'openai', source: 'api' }],
    capUsd: 1,
    enqueuedAt: NOW.toISOString(),
    ...o,
  });
const queue = (pending: Job[], o: Record<string, unknown> = {}) =>
  QueueSchema.parse({ pending, ...o });
const ids = (r: ReturnType<typeof schedule>) => r.start.map((p) => p.job.id);

describe('portfolio scheduling', () => {
  it('orders by priority, then age, and promotes waiting jobs (no starvation)', () => {
    const old = new Date(NOW.getTime() - 2 * 30 * 60_000).toISOString();
    const jobs = [
      job('n'),
      job('u', { priority: 'urgent' }),
      job('l', { priority: 'low', enqueuedAt: old }),
      job('a', { priority: 'normal' }),
    ];
    expect(order(jobs, NOW, 30).map((j) => j.id)).toEqual(['u', 'l', 'a', 'n']);
  });

  it('respects total, per-program and per-provider concurrency', () => {
    const jobs = ['a', 'b', 'c'].map((id) => job(id));
    expect(ids(schedule(portfolio(), queue(jobs), NOW))).toEqual(['a', 'b']);
    const other = [
      job('x', { programId: 'q' }),
      job('y', { programId: 'q', candidates: [{ provider: 'ollama', source: 'local' }] }),
      job('z', { programId: 'q', candidates: [{ provider: 'ollama', source: 'local' }] }),
    ];
    const r = schedule(
      portfolio({
        limits: { total: 3, perProgram: 3, defaultPerProvider: 5, perProvider: { ollama: 1 } },
      }),
      queue([...jobs, ...other]),
      NOW,
    );
    expect(ids(r)).toEqual(['a', 'b', 'c']);
    const r2 = schedule(
      portfolio({
        limits: { total: 9, perProgram: 3, defaultPerProvider: 5, perProvider: { ollama: 1 } },
      }),
      queue(other),
      NOW,
    );
    expect(ids(r2)).toEqual(['x', 'y']);
    expect(r2.held).toEqual([
      { jobId: 'z', reason: 'no candidate free, within limits and policy' },
    ]);
  });

  it('reserves band tops against the portfolio cap and asks the program envelope', () => {
    const q = queue([job('a', { capUsd: 6 }), job('b', { capUsd: 6, programId: 'q' })]);
    expect(schedule(portfolio(), q, NOW).held).toEqual([{ jobId: 'b', reason: 'portfolio cap' }]);
    const r = schedule(portfolio(), q, NOW, (j) =>
      j.id === 'a'
        ? { verdict: 'escalate', rule: 'budget.phase', reason: 'x' }
        : { verdict: 'allow', rule: 'ok', reason: '' },
    );
    expect(r.held[0]).toEqual({ jobId: 'a', reason: 'program envelope: escalate (budget.phase)' });
    expect(ids(r)).toEqual(['b']);
  });

  it('starts nothing under the kill switch and lists what to cancel', () => {
    const q = started(
      queue([job('a'), job('b')]),
      [{ job: job('r'), provider: 'openai', source: 'api' }],
      NOW,
    );
    const r = schedule(portfolio({ killSwitch: true }), q, NOW);
    expect(r.start).toEqual([]);
    expect(r.held.map((h) => h.reason)).toEqual(['kill switch', 'kill switch']);
    expect(killList(q)).toEqual(['r']);
  });

  it('falls back across sources on a rate limit, never outside the policy', () => {
    const cands = [
      { provider: 'anthropic', source: 'subscription' },
      { provider: 'anthropic', source: 'api' },
      { provider: 'ollama', source: 'local' },
    ];
    let q = queue([job('a', { candidates: cands })]);
    let r = schedule(portfolio(), q, NOW);
    expect(r.start[0]).toMatchObject({ provider: 'anthropic', source: 'subscription' });
    q = started(q, r.start, NOW);
    q = rateLimited(q, 'a', 60_000, 0.2, NOW);
    expect(q.spentUsd).toBeCloseTo(0.2);
    expect(q.pending[0]?.attempts).toBe(1);
    r = schedule(portfolio(), q, NOW);
    expect(r.start[0]).toMatchObject({ provider: 'anthropic', source: 'api' });
    // A local-only job never falls back to the cloud.
    const local = job('l', { candidates: cands, policy: { sources: ['local'] } });
    expect(schedule(portfolio(), queue([local]), NOW).start[0]).toMatchObject({ source: 'local' });
    const busy = queue([local], {
      rateLimitedUntil: { 'local:ollama': new Date(NOW.getTime() + 1e6).toISOString() },
    });
    expect(schedule(portfolio(), busy, NOW).start).toEqual([]);
    // The portfolio policy narrows too.
    const denied = schedule(
      portfolio({ sources: { denyProviders: ['anthropic'] } }),
      queue([job('d', { candidates: cands })]),
      NOW,
    );
    expect(denied.start[0]).toMatchObject({ provider: 'ollama' });
    // The limit lifts with time.
    expect(schedule(portfolio(), busy, new Date(NOW.getTime() + 2e6)).start).toHaveLength(1);
    expect(rateLimited(q, 'missing', 1, 1, NOW)).toBe(q);
  });

  it('replaces a reservation by the real cost when a run settles', () => {
    let q = started(
      queue([job('a', { capUsd: 5 })]),
      [{ job: job('a', { capUsd: 5 }), provider: 'openai', source: 'api' }],
      NOW,
    );
    q = settled(q, 'a', 1.5);
    expect(q).toMatchObject({ running: [], spentUsd: 1.5 });
    expect(settled(q, 'a', 9)).toBe(q);
  });
});
