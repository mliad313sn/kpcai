/**
 * D-028 (ADR-0031, ADR-0033): structured facts on confirmations and run outcomes, and a
 * program's envelope checker consuming them.
 */
import { describe, expect, it } from 'vitest';
import { ProposedActionSchema, checkAction } from '@kernelpai/program';
// The program's own fixture: a charter approved and running, envelope pre-answering both.
import { NOW, running } from '../../program/src/test-helpers/fixtures.js';
import { Kernel } from './kernel.js';
import { openJournal } from './env.js';
import {
  confirmFacts,
  inWorktree,
  physicalPacks,
  plannedSources,
  runSources,
  sourceOf,
} from './sources.js';
import { REQ, TEST_OPTIONS, recordingHost } from './test-helpers/fixture.js';

describe('sources', () => {
  it('claims local only for a local provider; agents are subscription; the rest api', () => {
    expect(sourceOf('local')).toBe('local');
    expect(sourceOf('subscription')).toBe('subscription');
    expect(sourceOf('agent')).toBe('subscription');
    for (const k of ['cloud', 'aggregator', 'test', undefined]) expect(sourceOf(k)).toBe('api');
  });

  it('lists the providers that served, their source and the run’s source', () => {
    const kinds: Record<string, string> = { ollama: 'local', openai: 'cloud' };
    const result = (providers: string[]) => ({
      results: {
        a: {
          contributions: providers.map((provider) => ({ ref: { provider, model: 'm' } })),
        },
      },
    });
    const kindOf = (p: string) => kinds[p];
    expect(runSources(result(['ollama']) as never, kindOf)).toEqual({
      providers: ['ollama'],
      sources: [{ provider: 'ollama', source: 'local' }],
      source: 'local',
    });
    expect(runSources(result(['openai', 'ollama', 'openai']) as never, kindOf).source).toBe(
      'mixed',
    );
    expect(runSources({ results: {} }, kindOf)).toEqual({ providers: [], sources: [] });
    const planned = plannedSources(
      { nodes: [{ ref: { provider: 'openai' }, steps: [{ ref: { provider: 'ollama' } }] }] },
      kindOf,
    );
    expect(planned.providers).toEqual(['ollama', 'openai']);
  });

  it('tells a worktree from the workspace and spots a physical pack', () => {
    expect(inWorktree('/w/x', '/w/x/')).toBe(false);
    expect(inWorktree('/home/u/.kernelpai/worktrees/r1', '/w/x')).toBe(true);
    expect(physicalPacks([{ safety: { physicalEffects: true } } as never])).toBe(true);
    expect(physicalPacks([])).toBe(false);
  });
});

describe('a program envelope consumes the confirmation facts', () => {
  it('maps a confirmation to a confirm action that parses; missing facts escalate', () => {
    const budget = confirmFacts({ kind: 'budget', question: 'q', amountUsd: 0.5, physical: false });
    expect(ProposedActionSchema.safeParse(budget).success).toBe(true);
    const s = running();
    expect(checkAction(s, budget, NOW).verdict).toBe('allow');
    const noAmount = confirmFacts({ kind: 'budget', question: 'q', physical: false });
    expect(checkAction(s, noAmount, NOW).verdict).toBe('escalate');
    const inWt = confirmFacts({
      kind: 'patch',
      question: 'q',
      inWorktree: true,
      risk: 'write',
      physical: false,
    });
    expect(checkAction(s, inWt, NOW).verdict).toBe('allow');
    const userTree = confirmFacts({ kind: 'patch', question: 'q', risk: 'write' });
    expect(checkAction(s, userTree, NOW).verdict).toBe('escalate');
    const device = confirmFacts({ kind: 'tool', question: 'q', inWorktree: true, physical: true });
    expect(checkAction(s, device, NOW)).toMatchObject({
      verdict: 'escalate',
      reserved: 'physical-device',
    });
  });

  it('WP7-L3: an unstated physical fact escalates (ADR-0033 §7)', () => {
    const unstated = confirmFacts({
      kind: 'patch',
      question: 'q',
      inWorktree: true,
      risk: 'write',
    });
    expect(unstated.physical).toBe(true);
    expect(checkAction(running(), unstated, NOW)).toMatchObject({
      verdict: 'escalate',
      reserved: 'physical-device',
    });
    expect(confirmFacts({ kind: 'budget', question: 'q', physical: false }).physical).toBe(false);
  });
});

describe('the kernel fills the facts (D-028)', () => {
  it('a budget question carries the cap; a run outcome its providers and source', async () => {
    const h = recordingHost({ KPAI_CONFIRM_ABOVE_USD: '0' });
    h.fallback = true;
    const k = new Kernel(h);
    const p = await k.plan(REQ, TEST_OPTIONS);
    const handle = await k.startRun({ request: REQ, planId: p.planId });
    const o = await handle.done;
    const budget = h.asked.find((q) => q.kind === 'budget');
    expect(budget?.amountUsd).toBe(p.estimate.capUsd);
    expect(budget?.physical).toBe(false);
    expect(o.status).toBe('finished');
    if (o.status !== 'finished') return;
    expect(o.providers?.length).toBeGreaterThan(0);
    expect(o.source).toBe('api');
    expect(o.sources?.every((s) => s.source === 'api')).toBe(true);
    await k.applyPatches(handle.runId);
    const patch = h.asked.find((q) => q.kind === 'patch');
    expect(patch).toMatchObject({ inWorktree: false, physical: false });
    await k.close();
    const j = openJournal(h.env);
    const rec = j
      .sessions(10)
      .flatMap((s) => j.events({ sessionId: s.id, limit: 10_000 }))
      .find((e) => e.payload.action === 'run outcome' && e.payload.runId === handle.runId);
    j.close();
    expect(rec?.payload).toMatchObject({ providers: o.providers, source: 'api' });
  });

  it('a patch to a control file says so; a plain one does not (D-035, P5-F2)', async () => {
    const h = recordingHost({ KPAI_CONFIRM_ABOVE_USD: '100' });
    h.fallback = true;
    const k = new Kernel(h);
    const request =
      'add an OAuth state validator with tests [[diff:src/s.ts]] [[testdiff:vitest.config.ts]]';
    const handle = await k.startRun({ request, options: { ...TEST_OPTIONS, isolated: true } });
    await handle.done;
    await k.applyPatches(handle.runId);
    const asked = h.asked.filter((q) => q.kind === 'patch');
    const control = asked.filter((q) => q.patch?.includes('vitest.config.ts'));
    expect(control.length).toBeGreaterThan(0);
    for (const q of asked) expect(q.control).toBe(control.includes(q));
    await k.close();
  });

  it('an isolated run’s writes are said to land in its worktree', async () => {
    const h = recordingHost({ KPAI_CONFIRM_ABOVE_USD: '100' });
    h.fallback = true;
    const k = new Kernel(h);
    const handle = await k.startRun({ request: REQ, options: { ...TEST_OPTIONS, isolated: true } });
    await handle.done;
    await k.applyPatches(handle.runId);
    expect(h.asked.find((q) => q.kind === 'patch')).toMatchObject({ inWorktree: true });
    await k.merge(handle.runId);
    expect(h.asked.filter((q) => q.kind === 'patch').at(-1)).toMatchObject({ inWorktree: false });
    await k.close();
  });
});
