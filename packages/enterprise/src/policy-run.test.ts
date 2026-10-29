/**
 * P5-F3 (D-035): a work package's source policy reaches the kernel run (local-only, every
 * provider outside it excluded, so in-run fallback stays inside), the daemon plans and
 * queues within it, and a run that still used a provider outside it fails closed at
 * settlement and asks the Sponsor.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Kernel } from '@kernelpai/kernel';
import { DEFAULT_CONFIG } from './config.js';
import { KernelRunStarter, policyOptions } from './starter.js';
import { FINISHED, fakeStarter } from './test-helpers/fake.js';
import { world, type World } from './test-helpers/world.js';

const KINDS: Record<string, string> = { ollama: 'local', openai: 'api', 'mock-beta': 'test' };

function kernelWithRegistry() {
  const seen: Array<Record<string, unknown>> = [];
  const registry = {
    get: (id: string) => ({ descriptor: { kind: KINDS[id] } }),
    list: () => Object.entries(KINDS).map(([id, kind]) => ({ descriptor: { id, kind } })),
  };
  const kernel = {
    openSession: () => 's1',
    plan: (_req: string, options: Record<string, unknown>) => {
      seen.push(options);
      const provider = options['localOnly'] ? 'ollama' : 'openai';
      return Promise.resolve({
        planId: `p${seen.length}`,
        estimate: { capUsd: 1, expectedUsd: 0.5, nodes: [{ ref: { provider } }] },
        setup: { registry },
      });
    },
    startRun: (r: { options: Record<string, unknown> }) => {
      seen.push(r.options);
      return Promise.resolve({ runId: 'r1', done: new Promise(() => undefined) });
    },
  } as unknown as Kernel;
  return { kernel, seen };
}

const input = { programId: 'prog', wpId: 'sec', request: 'threat model', packs: [] };

describe('the policy in the kernel run options (P5-F3)', () => {
  it('a local-only work package plans and starts local-only, every other provider excluded', async () => {
    const { kernel, seen } = kernelWithRegistry();
    const s = new KernelRunStarter({ kernel, options: { exclude: ['x'] } });
    const policy = { sources: ['local' as const], deny: [] };
    const p = await s.plan({ ...input, purpose: 'work', policy });
    expect(p).toMatchObject({ source: 'local', providers: ['ollama'] });
    await s.start(p.planId, { isolated: true });
    // Planned once with what was known (nothing), again once the registry was learnt.
    expect(seen).toHaveLength(3);
    for (const o of seen) expect(o['localOnly']).toBe(true);
    expect(seen[1]!['exclude']).toEqual(['x', 'mock-beta', 'openai']);
    expect(seen[2]).toMatchObject({ exclude: ['x', 'mock-beta', 'openai'], unattended: true });
    // The next work package knows the registry: one plan.
    await s.plan({ ...input, wpId: 'sec2', purpose: 'work', policy });
    expect(seen).toHaveLength(4);
    // The same request under another policy is planned again (no stale cache).
    await s.plan({ ...input, wpId: 'sec2', purpose: 'work' });
    expect(seen).toHaveLength(5);
    expect(seen[4]).toEqual(expect.objectContaining({ exclude: ['x'] }));
    expect(seen[4]!['localOnly']).toBeUndefined();
  });

  it('allow-lists and deny-lists become exclusions', () => {
    const known = new Map(Object.entries(KINDS));
    const api = { sources: ['api' as const, 'local' as const], providers: ['openai'], deny: [] };
    expect(policyOptions(api, known)).toEqual({ exclude: ['mock-beta', 'ollama'] });
    const deny = { sources: ['api' as const], deny: ['openai'] };
    expect(policyOptions(deny, new Map())).toEqual({ exclude: ['openai'] });
    expect(policyOptions(undefined, known)).toEqual({});
  });
});

let w: World | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

async function approved(x: World): Promise<string> {
  const d = await x.rt.create({ goal: 'Two parts:\n- one\n- two', budgetUsd: 10, critic: false });
  await x.rt.sponsor.act(d.programId, { type: 'approve', charterHash: d.charterHash });
  return d.programId;
}

describe('the daemon holds a run to its policy (P5-F3)', () => {
  it('plans and queues within the portfolio policy; a run that used the cloud fails closed', async () => {
    w = world();
    const local = { sources: ['local' as const], denyProviders: [] };
    w.config({ portfolio: { ...DEFAULT_CONFIG.portfolio, sources: local } });
    const fake = fakeStarter(w.rt);
    fake.figures = { capUsd: 1, providers: ['ollama'], source: 'local' };
    const plan = vi.spyOn(fake, 'plan');
    const id = await approved(w);
    await w.rt.daemon.tick();
    await w.rt.idle();
    expect(fake.runs).toHaveLength(2);
    for (const [arg] of plan.mock.calls) expect(arg.policy?.sources).toEqual(['local']);
    expect(w.rt.store.queue().running[0]!.job.policy).toMatchObject({ sources: ['local'] });
    // The first run fell back to a cloud provider inside the kernel.
    const cloud = [
      { provider: 'ollama', source: 'local' as const },
      { provider: 'openai', source: 'api' as const },
    ];
    fake.runs[0]!.finish({ ...FINISHED, providers: ['ollama', 'openai'], sources: cloud });
    fake.runs[1]!.finish({ ...FINISHED, sources: [cloud[0]!] });
    await w.rt.idle();
    const s = w.rt.get(id);
    const [bad, good] = [s.runs[0]!, s.runs[1]!];
    expect(bad).toMatchObject({ status: 'failed', providers: ['ollama', 'openai'] });
    expect(bad.evidence).toContain('policy-breach:api:openai');
    expect(good.status).toBe('finished');
    // The gate review excludes the providers the builders actually used, fallbacks included.
    const builders = (w.rt as unknown as { builders(id: string): string[] }).builders(id);
    expect(builders.sort()).toEqual(['ollama', 'openai']);
    expect(s.status).toBe('paused');
    const q = s.escalations.find((e) => e.rule === 'source.policy.breach')!;
    expect(q.question).toMatch(/used api:openai, outside its source policy/);
    // The Sponsor's yes resumes the program; the failed run is planned again.
    await w.rt.sponsor.viewed(id, { kind: 'escalation', id: q.id }, q.id);
    await w.rt.sponsor.answer(id, q.id, 'yes');
    await w.rt.daemon.tick();
    expect(w.rt.get(id).status).toBe('running');
    fake.runs.forEach((r) => r.finish());
  });
});
