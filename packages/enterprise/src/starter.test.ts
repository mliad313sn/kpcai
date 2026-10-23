/** The kernel RunStarter (ADR-0035): every program run is unattended, isolated, intended. */
import { describe, expect, it } from 'vitest';
import type { Kernel } from '@kernelpai/kernel';
import { KernelRunStarter, programContext } from './starter.js';

function fakeKernel() {
  const calls: { plan: unknown[]; start: Array<Record<string, unknown>>; ctx: unknown[] } = {
    plan: [],
    start: [],
    ctx: [],
  };
  const kernel = {
    openSession: () => 'sess-1',
    plan: (request: string, options: unknown) => {
      calls.plan.push(options);
      return Promise.resolve({
        planId: 'plan-1',
        graph: { id: 'g', request, nodes: [], createdBy: 'template', reason: '' },
        estimate: { nodes: [{ ref: { provider: 'mock-beta' } }], capUsd: 1, expectedUsd: 0.5 },
        setup: { registry: { get: () => ({ descriptor: { kind: 'test' } }) } },
      });
    },
    validatePlan: () => ({
      ok: true,
      problems: [],
      estimate: { nodes: [{ ref: { provider: 'mock-delta' } }], capUsd: 0.2, expectedUsd: 0.1 },
    }),
    startRun: (input: Record<string, unknown>) => {
      calls.start.push(input);
      calls.ctx.push(programContext.getStore());
      return Promise.resolve({
        runId: 'run-1',
        planId: 'plan-1',
        sessionId: 'sess-1',
        done: new Promise(() => undefined),
      });
    },
  };
  return { kernel: kernel as unknown as Kernel, calls };
}

const input = {
  programId: 'prog-1',
  wpId: 'wp1',
  request: 'do it',
  packs: [],
  purpose: 'work' as const,
};

describe('KernelRunStarter', () => {
  it('WP7-L13: a run is unattended even when the defaults say otherwise', async () => {
    const { kernel, calls } = fakeKernel();
    const s = new KernelRunStarter({ kernel, options: { allowTest: true, unattended: false } });
    const plan = await s.plan(input);
    expect(plan).toMatchObject({ capUsd: 1, providers: ['mock-beta'], source: 'api' });
    await s.start(plan.planId, { isolated: true });
    const options = calls.start[0]!['options'] as Record<string, unknown>;
    expect(options).toMatchObject({ unattended: true, isolated: true, allowTest: true });
    expect(options['intent']).toMatchObject({ id: 'prog-1/wp1' });
    expect(calls.ctx[0]).toEqual({ programId: 'prog-1', wpId: 'wp1' });
  });

  it('caches a plan per work package and drops it once started', async () => {
    const { kernel, calls } = fakeKernel();
    const s = new KernelRunStarter({ kernel });
    await s.plan(input);
    await s.plan(input);
    expect(calls.plan).toHaveLength(1);
    expect(s.sessionOf('plan-1')).toBe('sess-1');
    await s.start('plan-1', { isolated: true });
    await expect(s.start('plan-1', { isolated: true })).rejects.toThrow(/no program plan/);
  });

  it('a review is one read-only node on providers the builders did not use', async () => {
    const { kernel, calls } = fakeKernel();
    const s = new KernelRunStarter({ kernel, reviewExclude: () => ['mock-beta'] });
    const plan = await s.plan({ ...input, wpId: 'p1', purpose: 'review' });
    expect(plan).toMatchObject({ capUsd: 0.2, providers: ['mock-delta'] });
    expect(calls.plan[0]).toMatchObject({ exclude: ['mock-beta'] });
    await s.start(plan.planId, { isolated: true });
    const graph = calls.start[0]!['graph'] as { nodes: Array<Record<string, unknown>> };
    expect(graph.nodes).toEqual([expect.objectContaining({ protocol: 'solo', type: 'critique' })]);
  });
});
