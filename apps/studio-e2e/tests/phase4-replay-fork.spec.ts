/**
 * R-403 end to end: replay a node with another model beside the original and compare;
 * fork a run from a node, reusing the finished upstream work as recorded and paying only
 * for the node and its descendants. Spend is read back from the journal, not trusted.
 */
import { CODE, expect, journal, planAndRun, test, type JournalEvent } from '../fixtures/phase4.js';

interface Attempt {
  protocol: string;
  ok: boolean;
  output: string;
  costUsd: number;
  durationMs: number;
  models: Array<{ provider: string; model: string }>;
}

interface Replay {
  replayId: string;
  runId: string;
  nodeId: string;
  original: Attempt;
  replay: Attempt;
  comparison: { sameOutput: boolean; costDeltaUsd: number; durationDeltaMs: number };
}

const after = (events: readonly JournalEvent[], seq: number): JournalEvent[] =>
  events.filter((e) => e.seq > seq);
const billed = (events: readonly JournalEvent[]): number =>
  events.reduce((a, e) => a + (e.costUsd ?? 0), 0);

test('replay a node with another model and compare it side by side', async ({ c }) => {
  const run = await planAndRun(c, CODE);
  expect(run.done.result.ok).toBe(true);
  const original = run.done.result.results['architecture']!;
  const mark = (await journal(c)).at(-1)!.seq;

  const r = await c.call<Replay>('run.replay', {
    runId: run.runId,
    nodeId: 'architecture',
    model: { provider: 'mock-beta', model: 'm1' },
  });
  expect(r).toMatchObject({ runId: run.runId, nodeId: 'architecture' });
  expect(r.original.models[0]!.provider).toBe('mock-alpha');
  expect(r.replay.models[0]).toEqual({ provider: 'mock-beta', model: 'm1' });
  expect(r.original.output).toBe(original.output);
  expect(r.original.costUsd).toBeCloseTo(original.costUsd, 9);
  expect(r.replay.ok).toBe(true);
  expect(r.replay.output.length).toBeGreaterThan(0);
  expect(r.comparison.costDeltaUsd).toBeCloseTo(r.replay.costUsd - r.original.costUsd, 9);
  expect(r.comparison.sameOutput).toBe(r.replay.output === r.original.output);

  // The replay ran once, on that node only, its first step on the model it named (the
  // node's protocol keeps its other steps); it was billed once; the original is unchanged.
  const spent = after(await journal(c), mark).filter((e) => e.type === 'response');
  expect(spent[0]!.provider).toBe('mock-beta');
  expect(spent.every((e) => e.nodeId === 'architecture')).toBe(true);
  expect(r.replay.protocol).toBe(r.original.protocol);
  expect(billed(spent)).toBeCloseTo(r.replay.costUsd, 9);
  const { runs } = await c.call<{ runs: Array<{ runId: string; costUsd: number }> }>('runs.list');
  expect(runs.find((x) => x.runId === run.runId)!.costUsd).toBeCloseTo(run.done.result.costUsd, 9);
});

test('fork from a node: upstream reused as recorded, only descendants run and are paid', async ({
  c,
}) => {
  const parent = await planAndRun(c, CODE);
  expect(parent.done.result.ok).toBe(true);
  const fork = await c.call<{
    planId: string;
    rerun: string[];
    reused: string[];
    edits: string[];
    estimate: { expectedUsd: number; capUsd: number; band: { highUsd: number } };
  }>('run.forkPlan', {
    runId: parent.runId,
    nodeId: 'tests',
    edit: { instruction: 'cover the empty state' },
  });
  expect([...fork.rerun].sort()).toEqual(['review', 'tests']);
  expect([...fork.reused].sort()).toEqual(['architecture', 'implementation']);
  expect(fork.estimate.capUsd).toBe(fork.estimate.band.highUsd);
  expect(fork.estimate.expectedUsd).toBeLessThan(parent.plan.estimate.expectedUsd);

  const mark = (await journal(c)).at(-1)!.seq;
  const { runId } = await c.call<{ runId: string }>('run.fork', { planId: fork.planId });
  const done = (await c.waitFor((n) => n.method === 'run.done' && n.params['runId'] === runId))
    .params as unknown as typeof parent.done;
  expect(done.result.ok).toBe(true);
  // Reused nodes carry the parent's output as recorded.
  for (const id of fork.reused)
    expect(done.result.results[id]!.output).toBe(parent.done.result.results[id]!.output);

  const spent = after(await journal(c), mark);
  const called = new Set(spent.filter((e) => e.type === 'call').map((e) => e.nodeId));
  expect([...called].sort()).toEqual(['review', 'tests']);
  // Only the rerun nodes were billed, and the fork cost less than its parent.
  const fresh = fork.rerun.reduce((a, id) => a + done.result.results[id]!.costUsd, 0);
  expect(billed(spent)).toBeCloseTo(fresh, 9);
  expect(billed(spent)).toBeLessThan(parent.done.result.costUsd);
  expect(billed(spent)).toBeLessThanOrEqual(fork.estimate.capUsd);
});
