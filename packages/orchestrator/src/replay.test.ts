import { describe, expect, it } from 'vitest';
import { replayNode, ReplayError } from './replay.js';
import { readRun } from './run-journal.js';
import { GraphRunner } from './runner.js';
import { RoleAdapter, friendly, gnode, graph, setup, type Script } from './test-helpers/fakes.js';

/** Answers with the provider name and a call counter, so a rerun of n1 would show. */
const counting = (name: string): Script => {
  let calls = 0;
  return (seen) => {
    calls++;
    return seen.role === 'author' ? `${name}#${calls}` : friendly(name)(seen);
  };
};

const rules = { role: 'user' as const, content: 'RULES: tabs, not spaces' };
const nodes = () => [
  gnode({ id: 'n1', title: 'First', messages: [rules, { role: 'user', content: 'one' }] }),
  gnode({
    id: 'n2',
    title: 'Second',
    dependsOn: ['n1'],
    messages: [rules, { role: 'user', content: 'two' }],
  }),
];

async function ran(over: Parameters<typeof setup>[1] = {}) {
  const a = new RoleAdapter('a', counting('A'), { analysis: 0.9, critique: 0.9 });
  const b = new RoleAdapter('b', counting('B'), { analysis: 0.5, critique: 0.5 });
  const s = setup([a, b], over);
  const result = await new GraphRunner(s.options).run(graph(nodes()), { runId: 'run-1' });
  return { a, b, s, result };
}

describe('replayNode (R-403)', () => {
  it('reruns one node on another model from its recorded inputs, keeping the original', async () => {
    const { a, b, s, result } = await ran();
    expect(result.runId).toBe('run-1');
    const original = a.seen.find((x) => x.prompt.includes('Task (Second)'));
    const before = readRun(s.journal, 'run-1');
    const r = await replayNode(
      s.journal,
      'run-1',
      'n2',
      { model: { provider: 'b', model: 'm' } },
      s.options,
    );
    const replayed = b.seen.find((x) => x.prompt.includes('Task (Second)'));
    // Same prompt: n1's output as recorded (n1 is not rerun), rules as recorded.
    expect(replayed?.prompt).toBe(original?.prompt);
    expect(replayed?.req.messages[0]?.content).toBe('RULES: tabs, not spaces');
    expect(a.seen.filter((x) => x.prompt.includes('Task (First)'))).toHaveLength(1);
    expect(r.original.output).toBe(result.results['n2']?.output);
    expect(r.original.models).toEqual([{ provider: 'a', model: 'm' }]);
    expect(r.replay.models).toEqual([{ provider: 'b', model: 'm' }]);
    expect(r.replay.output).toMatch(/^B#/);
    expect(r.comparison.sameOutput).toBe(false);
    expect(r.comparison.costDeltaUsd).toBeCloseTo(r.replay.costUsd - r.original.costUsd, 9);
    expect(typeof r.replay.durationMs).toBe('number');
    // The original record is untouched; the replay is kept beside it.
    const after = readRun(s.journal, 'run-1');
    expect(after?.nodes['n2']).toEqual(before?.nodes['n2']);
    expect(after?.replays.map((x) => x.replayId)).toEqual([r.replayId]);
    expect(r.links).toEqual({
      runStarted: before?.eventId,
      nodeRecord: before?.nodes['n2']?.eventId,
    });
  });

  it('journals the replay with links, and tags its calls with the replay id', async () => {
    const { s } = await ran();
    const r = await replayNode(s.journal, 'run-1', 'n2', {}, s.options);
    const ev = s.journal.events({ sessionId: s.sessionId });
    const started = ev.find((e) => e.payload['action'] === 'replay started');
    expect(started?.payload).toMatchObject({
      runId: 'run-1',
      replayId: r.replayId,
      links: r.links,
    });
    const calls = ev.filter((e) => e.type === 'call' && e.payload['replayId'] === r.replayId);
    expect(calls.length).toBe(1);
    expect(calls[0]?.payload['replayOf']).toBe('run-1');
  });

  it('keeps critic diversity: a replay as author+critic on b gets a critic from a', async () => {
    const { s } = await ran();
    const r = await replayNode(
      s.journal,
      'run-1',
      'n2',
      { model: { provider: 'b', model: 'm' }, protocol: 'author_critic' },
      s.options,
    );
    expect(r.replay.protocol).toBe('author_critic');
    expect(r.replay.models.map((m) => m.provider)).toEqual(['b', 'a']);
    expect(r.replay.verdicts).toEqual([
      { ref: { provider: 'a', model: 'm' }, approve: true, issues: 0, summary: 'fine' },
    ]);
    expect(r.comparison.approved).toEqual({ original: null, replay: true });
  });

  it('goes through the budget hook: a refusal stops the replay before any call', async () => {
    const { a, b, s } = await ran();
    const seen = a.seen.length + b.seen.length;
    const labels: string[] = [];
    const deps = {
      ...s.options,
      budget: (_c: unknown, label: string) => {
        labels.push(label);
        return false;
      },
    };
    const r = await replayNode(s.journal, 'run-1', 'n2', {}, deps);
    expect(labels).toEqual(['solo on n2: a/m']);
    expect(r.replay.ok).toBe(false);
    expect(r.replay.error).toMatch(/budget/);
    expect(a.seen.length + b.seen.length).toBe(seen);
  });

  it('honours routing constraints (an excluded provider is never used)', async () => {
    const { s } = await ran();
    const deps = { ...s.options, constraints: { excludeProviders: ['a'] } };
    const r = await replayNode(s.journal, 'run-1', 'n2', {}, deps);
    expect(r.replay.models).toEqual([{ provider: 'b', model: 'm' }]);
  });

  it('refuses unknown runs, unknown or unfinished nodes, and unknown models', async () => {
    const { s } = await ran();
    const go = (run: string, node: string, model?: { provider: string; model: string }) =>
      replayNode(s.journal, run, node, model ? { model } : {}, s.options);
    await expect(go('nope', 'n2')).rejects.toThrow(ReplayError);
    await expect(go('run-1', 'zz')).rejects.toThrow(/has no node "zz"/);
    await expect(go('run-1', 'n2', { provider: 'z', model: 'm' })).rejects.toThrow(/not available/);
    await expect(
      replayNode(s.journal, 'run-1', 'n2', { protocol: 'relay' as never }, s.options),
    ).rejects.toThrow(/unknown protocol/);
    const one = setup([new RoleAdapter('a', () => [{ fail: 'auth' }])]);
    await new GraphRunner(one.options).run(graph(nodes()), { runId: 'run-2' });
    await expect(replayNode(one.journal, 'run-2', 'n2', {}, one.options)).rejects.toThrow(
      /never finished/,
    );
  });
});
