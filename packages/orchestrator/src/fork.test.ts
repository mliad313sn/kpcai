import { describe, expect, it } from 'vitest';
import { planFork, runFork } from './fork.js';
import { ReplayError } from './replay.js';
import { readRun } from './run-journal.js';
import { GraphRunner } from './runner.js';
import { RoleAdapter, friendly, gnode, graph, setup, type Script } from './test-helpers/fakes.js';

const task = (prompt: string): string => /Task \((\w+)\)/.exec(prompt)?.[1] ?? '?';

/** Answers `<provider>:<task>`; fails the task named in `failing` while it is set. */
function scripted(name: string, failing: Set<string>): Script {
  return (seen) => {
    if (seen.role !== 'author') return friendly(name)(seen);
    const t = task(seen.prompt);
    return failing.has(t) ? [{ fail: 'unavailable' }] : `${name}:${t}`;
  };
}

// n1 → n2 → n3, and n4 on its own.
const nodes = () => [
  gnode({ id: 'n1', title: 'One' }),
  gnode({ id: 'n2', title: 'Two', dependsOn: ['n1'] }),
  gnode({ id: 'n3', title: 'Three', dependsOn: ['n2'] }),
  gnode({ id: 'n4', title: 'Four' }),
];

async function parent(failing = new Set<string>()) {
  const a = new RoleAdapter('a', scripted('A', failing), { analysis: 0.9 });
  const b = new RoleAdapter('b', scripted('B', failing), { analysis: 0.5 });
  const s = setup([a, b]);
  const result = await new GraphRunner(s.options).run(graph(nodes()), { runId: 'p-1' });
  const tasks = () =>
    [...a.seen, ...b.seen].filter((x) => x.role === 'author').map((x) => task(x.prompt));
  return { a, b, s, result, tasks };
}

describe('fork (spec §3.5)', () => {
  it('reuses finished upstream nodes and re-runs the chosen node and its descendants', async () => {
    const p = await parent();
    expect(p.result.ok).toBe(true);
    const before = p.tasks().length;
    const plan = planFork(
      p.s.journal,
      'p-1',
      'n2',
      { model: { provider: 'b', model: 'm' }, instruction: 'be brief' },
      p.s.options,
    );
    expect(Object.keys(plan.reuse).sort()).toEqual(['n1', 'n4']);
    expect(plan.rerun).toEqual(['n2', 'n3']);
    expect(plan.edits).toEqual(['n2: model routed → b/m', 'n2: instruction added']);
    const r = await runFork(new GraphRunner(p.s.options), plan, { runId: 'f-1' });
    expect(r.ok).toBe(true);
    expect(r.runId).toBe('f-1');
    expect(r.reused).toEqual(['n1', 'n4']);
    // Only n2 and n3 called a model; n2 on the chosen model, with the instruction.
    expect(p.tasks().length - before).toBe(2);
    expect(p.b.seen.map((x) => task(x.prompt))).toContain('Two');
    expect(p.a.seen.filter((x) => task(x.prompt) === 'Three')).toHaveLength(2);
    expect(r.results['n1']?.output).toBe(p.result.results['n1']?.output);
    expect(r.results['n2']?.output).toBe('B:Two');
    const n2 = p.b.seen.find((x) => task(x.prompt) === 'Two');
    expect(n2?.prompt).toContain('be brief');
    expect(n2?.prompt).toContain('A:One');
    // The fork's cost counts what ran only.
    const ran = (r.results['n2']?.costUsd ?? 0) + (r.results['n3']?.costUsd ?? 0);
    expect(r.costUsd).toBeCloseTo(ran, 9);
    expect(r.verification.nodes.map((n) => n.nodeId)).toEqual(['n2', 'n3']);
  });

  it('journals the fork with its parent and marks reused nodes "reused, not re-run"', async () => {
    const p = await parent();
    const plan = planFork(p.s.journal, 'p-1', 'n2', {}, p.s.options);
    await runFork(new GraphRunner(p.s.options), plan, { runId: 'f-2' });
    const fork = readRun(p.s.journal, 'f-2');
    const origin = readRun(p.s.journal, 'p-1');
    expect(fork?.parent).toEqual({ runId: 'p-1', nodeId: 'n2' });
    expect(fork?.reused).toEqual(['n1', 'n4']);
    expect(fork?.nodes['n1']?.reused).toBe(true);
    expect(fork?.nodes['n1']?.reusedFrom).toBe(origin?.nodes['n1']?.eventId);
    expect(fork?.nodes['n2']?.reused).toBeUndefined();
    // The parent's record is unchanged.
    expect(origin?.nodes['n2']?.result.output).toBe('A:Two');
  });

  it('estimates only the nodes that will run', async () => {
    const p = await parent();
    const plan = planFork(p.s.journal, 'p-1', 'n3', {}, p.s.options);
    expect(plan.rerun).toEqual(['n3']);
    expect(plan.estimate.nodes.map((n) => n.nodeId)).toEqual(['n3']);
    const n3 = plan.estimate.nodes[0];
    expect(plan.estimate.totalUsd).toBe(n3?.expectedUsd);
    expect(plan.estimate.band.highUsd).toBe(n3?.band.highUsd);
    const whole = planFork(p.s.journal, 'p-1', 'n1', {}, p.s.options);
    expect(whole.rerun).toEqual(['n1', 'n2', 'n3']);
    expect(whole.estimate.totalUsd).toBeGreaterThan(plan.estimate.totalUsd);
  });

  it('re-runs nodes that never finished in the parent, even outside the chosen branch', async () => {
    const p = await parent(new Set(['Four']));
    expect(p.result.states['n4']).toBe('failed');
    const plan = planFork(p.s.journal, 'p-1', 'n3', {}, p.s.options);
    expect(plan.rerun).toEqual(['n3', 'n4']);
    expect(Object.keys(plan.reuse).sort()).toEqual(['n1', 'n2']);
  });

  it('refuses an unknown run or node and an invalid edit', async () => {
    const p = await parent();
    const plan = (node: string, edit = {}) => planFork(p.s.journal, 'p-1', node, edit, p.s.options);
    expect(() => planFork(p.s.journal, 'zz', 'n1', {}, p.s.options)).toThrow(ReplayError);
    expect(() => plan('n9')).toThrow(/has no node/);
    expect(() => plan('n2', { model: { provider: 'z', model: 'm' } })).toThrow(/not available/);
    expect(() => plan('n2', { protocol: 'relay' })).toThrow(/unknown protocol/);
    expect(() => plan('n2', { instruction: 'x'.repeat(10_001) })).toThrow(/longer than/);
    expect(plan('n2', { protocol: 'author_critic' }).edits).toEqual([
      'n2: protocol solo → author_critic',
    ]);
  });
});
