import { describe, expect, it } from 'vitest';
import type { ScoredCandidate } from '@kernelpai/core';
import { stepBand } from './band.js';
import { NodeBudgets } from './node-budget.js';
import { GraphRunner } from './runner.js';
import { RoleAdapter, friendly, gnode, graph, setup, isNote } from './test-helpers/fakes.js';
import type { OrchestratorOptions } from './types.js';

/** Review P3-F5: a node's `budgetUsd` is a cap, enforced like `maxGraphUsd`. */

const pair = () => [
  new RoleAdapter('a', friendly('A'), { analysis: 0.9, critique: 0.2 }),
  new RoleAdapter('b', friendly('B'), { analysis: 0.3, critique: 0.9 }),
];

function harness(over: Partial<OrchestratorOptions> = {}) {
  const adapters = pair();
  const s = setup(adapters, over);
  const actions = () =>
    s.journal
      .events({ sessionId: s.sessionId })
      .filter(isNote)
      .map((e) => ({ nodeId: e.nodeId, ...e.payload }));
  const calls = () => adapters.reduce((n, a) => n + a.seen.length, 0);
  return { ...s, adapters, actions, calls };
}

const NODE_LABEL =
  /^node x total: up to \$[\d.e-]+ would exceed budgetUsd \$1e-7 \(solo on x: a\/m\)$/;

describe('P3-F5: per-node budget cap', () => {
  it('stops a node over its budget without a hook: no model is called', async () => {
    const h = harness();
    const r = await new GraphRunner(h.options).run(
      graph([gnode({ id: 'x', budgetUsd: 0.0000001 }), gnode({ id: 'y' })]),
    );
    expect(r.states).toEqual({ x: 'failed', y: 'done' });
    expect(r.results['x']?.error).toMatch(/^node budget: node x total: up to .* \(solo on x/);
    expect(h.calls()).toBe(1); // y only
    const reached = h.actions().filter((a) => a.action === 'node budget reached');
    expect(reached).toHaveLength(1);
    expect(reached[0]).toMatchObject({ nodeId: 'x', budgetUsd: 0.0000001, spentUsd: 0 });
  });

  it('asks through the hook with a "node <id> total" label; a refusal fails the node', async () => {
    const labels: string[] = [];
    const h = harness({
      budget: (_c, l) => (labels.push(l), !l.startsWith('node ')),
    });
    const r = await new GraphRunner(h.options).run(
      graph([gnode({ id: 'x', budgetUsd: 0.0000001 })]),
    );
    expect(labels[0]).toMatch(NODE_LABEL);
    expect(r.states).toEqual({ x: 'failed' });
    expect(h.calls()).toBe(0);
    expect(h.actions().map((a) => a.action)).toEqual([
      'node budget reached',
      'step blocked by budget',
    ]);
  });

  it('a yes lets the node go past its budget, asked once per node (journaled)', async () => {
    const labels: string[] = [];
    const h = harness({ budget: (_c, l) => (labels.push(l), true) });
    const r = await new GraphRunner(h.options).run(
      graph([gnode({ id: 'x', protocol: 'author_critic', budgetUsd: 0.0000001 })]),
    );
    expect(r.ok).toBe(true);
    expect(labels.filter((l) => l.startsWith('node x total'))).toHaveLength(1);
    expect(h.actions().filter((a) => a.action === 'node budget override')).toHaveLength(1);
  });

  it('a node within its budget runs without asking', async () => {
    const labels: string[] = [];
    const h = harness({ budget: (_c, l) => (labels.push(l), true) });
    const r = await new GraphRunner(h.options).run(
      graph([gnode({ id: 'x', protocol: 'author_critic', budgetUsd: 10 })]),
    );
    expect(r.ok).toBe(true);
    expect(labels.some((l) => l.startsWith('node '))).toBe(false);
    expect(h.actions().some((a) => String(a.action).startsWith('node budget'))).toBe(false);
  });

  it('counts the node spend so far: a later step that would pass the cap is asked', async () => {
    // First run, roomy budget: the author's and the critic's band tops and the author's cost.
    const seen: { c: ScoredCandidate; l: string }[] = [];
    const probe = harness({ budget: (c, l) => (seen.push({ c, l }), true) });
    const node = { id: 'x', protocol: 'author_critic' as const };
    const p = await new GraphRunner(probe.options).run(graph([gnode({ ...node, budgetUsd: 10 })]));
    const top = (role: string): number => {
      const c = seen.find((s) => s.l.startsWith(`${role} on x`))?.c as ScoredCandidate;
      const card = probe.options.candidates.find((k) => k.ref.provider === c.ref.provider)?.card;
      return stepBand(card, c.estimate, { min: 1, max: 1 }, undefined).perCallHighUsd;
    };
    const authorCost = p.results['x']?.contributions[0]?.costUsd ?? 0;
    // Room for the author's call alone: the critic's call must ask.
    const budgetUsd = top('author');
    expect(authorCost + top('critic')).toBeGreaterThan(budgetUsd);
    const labels: string[] = [];
    const h = harness({ budget: (_c, l) => (labels.push(l), !l.startsWith('node ')) });
    const r = await new GraphRunner(h.options).run(graph([gnode({ ...node, budgetUsd })]));
    const asked = labels.filter((l) => l.startsWith('node x total'));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/\(critic on x: b\/m\)$/);
    expect(r.states).toEqual({ x: 'failed' });
    expect(r.results['x']?.contributions.map((c) => c.role)).toEqual(['author']);
    expect(r.results['x']?.error).toMatch(/^node budget: node x total/);
  });
});

describe('NodeBudgets', () => {
  const c = { ref: { provider: 'a', model: 'm' } } as ScoredCandidate;
  const nodeRun = (budgetUsd: number) => ({
    node: gnode({ id: 'x', budgetUsd }),
    context: '',
    contributions: [],
    costUsd: 0.1,
    priorUsd: 0.2,
  });

  it('counts earlier attempts and other in-flight steps, not the caller’s own claim', async () => {
    const asked: string[] = [];
    const s = setup([]);
    const b = new NodeBudgets(
      (_c, l) => (asked.push(l), Promise.resolve(false)),
      s.journal,
      s.sessionId,
    );
    const run = nodeRun(1);
    const own = b.hold('x', 0.6);
    expect(await b.check(run, c, 0.5, 'next', own)).toBeUndefined(); // 0.3 + 0.5
    own.spend(0.5);
    expect(own.remainingUsd).toBeCloseTo(0.1);
    expect(await b.check(run, c, 0.5, 'other')).toBeUndefined();
    expect(asked).toHaveLength(0); // 0.3 + 0.1 + 0.5 fits
    own.claim(0.6);
    expect(await b.check(run, c, 0.5, 'other')).toMatch(
      /up to \$1\.4 would exceed budgetUsd \$1 \(other\)$/,
    );
    expect(asked).toHaveLength(1);
    own.release();
    expect(await b.check(run, c, 0.1, 'small')).toBeUndefined(); // 0.4 fits
    expect(await b.check(run, c, 0.8, 'after')).toMatch(/^node budget/); // refused, not asked again
    expect(asked).toHaveLength(1);
  });

  it('parallel checks share one question; a throwing hook refuses', async () => {
    let calls = 0;
    const s = setup([]);
    const b = new NodeBudgets(
      () => {
        calls++;
        return Promise.reject(new Error('no'));
      },
      s.journal,
      s.sessionId,
    );
    const run = nodeRun(0.1);
    const both = await Promise.all([b.check(run, c, 1, 'one'), b.check(run, c, 1, 'two')]);
    expect(both.every((r) => r?.startsWith('node budget'))).toBe(true);
    expect(calls).toBe(1);
    b.reset();
    expect(await b.check({ ...run, node: gnode({ id: 'x' }) }, c, 9, 'free')).toBeUndefined();
  });
});
