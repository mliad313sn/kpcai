/**
 * R-303 on every planned step (S8 bug 1) and D-021 cost figures (ADR-0026): the plan is
 * explained with the decisions the estimator priced it on, and the run is capped at the
 * band's top, not at the likely cost.
 */
import { describe, expect, it } from 'vitest';
import { CompetenceRouter } from '@kernelpai/router';
import { Kernel } from './kernel.js';
import { REQ, TEST_OPTIONS, recordingHost } from './test-helpers/fixture.js';

const CHEAP = { KPAI_CONFIRM_ABOVE_USD: '100' };

describe('plan explanation (R-303)', () => {
  it('gives every planned step a reason, a score and a runner-up, review node included', async () => {
    const k = new Kernel(recordingHost(CHEAP));
    const p = await k.plan(REQ, TEST_OPTIONS);
    const steps = p.estimate.nodes.flatMap((n) => n.steps.map((s) => ({ node: n.nodeId, ...s })));
    expect(steps.length).toBeGreaterThan(p.estimate.nodes.length);
    for (const s of steps) {
      expect(s.reason, `${s.node}/${s.role}`).toBeTruthy();
      expect(s.score, `${s.node}/${s.role}`).toEqual(expect.any(Number));
      expect(s.runnerUp?.ref, `${s.node}/${s.role}`).toBeTruthy();
    }
    for (const n of p.estimate.nodes) expect(n.reason, n.nodeId).toBe(n.steps[0]?.reason);
    // Principle 2: no critic, judge or review step is offered its author's provider.
    const review = p.estimate.nodes.find((n) => n.nodeId === 'review');
    expect(review?.reason).toMatch(new RegExp(`${review?.ref?.provider}/`));
    const upstream = p.estimate.nodes
      .filter((n) => p.graph.nodes.find((g) => g.id === 'review')?.dependsOn.includes(n.nodeId))
      .flatMap((n) => n.steps.map((s) => s.ref.provider));
    expect(upstream).not.toContain(review?.ref?.provider);
    expect(upstream).not.toContain(review?.runnerUp?.ref.provider);
    // The gap S8 found: an unconstrained route of that node lands elsewhere.
    const node = p.graph.nodes.find((g) => g.id === 'review')!;
    const free = new CompetenceRouter({}).route(node, p.setup.candidates, p.setup.constraints);
    expect(free.chosen.ref.provider).not.toBe(review?.ref?.provider);
    for (const n of p.estimate.nodes) {
      const critic = n.steps.find((s) => s.role === 'critic');
      const author = n.steps.find((s) => s.role === 'author');
      if (critic && author) expect(critic.runnerUp?.ref.provider).not.toBe(author.ref.provider);
    }
    await k.close();
  });

  it('explains a validated edit, the pinned node as the user choice', async () => {
    const k = new Kernel(recordingHost(CHEAP));
    const p = await k.plan(REQ, TEST_OPTIONS);
    const pin = { provider: 'mock-gamma', model: 'm1' };
    const nodes = p.graph.nodes.map((n) => (n.id === 'implementation' ? { ...n, model: pin } : n));
    const c = k.validatePlan(p.planId, { nodes });
    expect(c.ok).toBe(true);
    const impl = c.estimate?.nodes.find((n) => n.nodeId === 'implementation');
    expect(impl?.reason).toMatch(/chosen by the user/);
    expect(impl?.steps[1]?.reason).toBeTruthy();
    expect(c.estimate?.capUsd).toBe(c.estimate?.band.highUsd);
    await k.close();
  });

  it('refuses a pinned test provider when the plan did not allow test providers', async () => {
    const k = new Kernel(recordingHost(CHEAP));
    const p = await k.plan(REQ, {});
    const pin = { provider: 'mock-gamma', model: 'm1' };
    const c = k.validatePlan(p.planId, { nodes: p.graph.nodes.map((n) => ({ ...n, model: pin })) });
    expect(c.ok).toBe(false);
    expect(c.problems.join(' ')).toMatch(/mock-gamma/);
    await k.close();
  });
});

describe('cost figures (D-021)', () => {
  it('exposes the likely cost and the cap, the band top', async () => {
    const k = new Kernel(recordingHost(CHEAP));
    const { estimate: e } = await k.plan(REQ, TEST_OPTIONS);
    expect(e.expectedUsd).toBe(e.totalUsd);
    expect(e.capUsd).toBe(e.band.highUsd);
    expect(e.capUsd).toBeGreaterThan(e.expectedUsd);
    await k.close();
  });

  it('asks before a graph whose cap, not its likely cost, is above the threshold', async () => {
    const host = recordingHost(CHEAP);
    const k = new Kernel(host);
    const p = await k.plan(REQ, TEST_OPTIONS);
    const between = (p.estimate.expectedUsd + p.estimate.capUsd) / 2;
    host.env['KPAI_CONFIRM_ABOVE_USD'] = String(between);
    const h = await k.startRun({ request: REQ, planId: p.planId });
    expect(await h.done).toMatchObject({ status: 'not_run' });
    expect(host.asked[0]?.question).toMatch(/graph estimate up to \$[\d.]+ \(cap; likely \$/);
    await k.close();
  });

  it('caps the run at capUsd: spending past it asks again', async () => {
    const host = recordingHost(CHEAP);
    const k = new Kernel(host);
    const p = await k.plan(REQ, TEST_OPTIONS);
    // The likely figure is no limit; only the cap is (lowered here to force the question).
    p.estimate.expectedUsd = 0;
    p.estimate.capUsd = 1e-9;
    const h = await k.startRun({ request: REQ, planId: p.planId });
    const o = await h.done;
    expect(o.status).toBe('finished');
    const asked = host.asked.find((a) => /graph total/.test(a.question));
    expect(asked?.question).toMatch(/exceed the cap you accepted/);
    await k.close();
  });
});
