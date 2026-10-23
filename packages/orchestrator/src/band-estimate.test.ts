import { describe, expect, it } from 'vitest';
import { HEURISTIC_MAX_RATIO, outputSpread } from './band.js';
import { history, type Sample } from './test-helpers/band-history.js';
import { DEFAULT_DEPENDENCY_ALLOWANCE_TOKENS, estimateGraph } from './estimate.js';
import { bandBreaches } from './test-helpers/band-bench.js';
import { RoleAdapter, friendly, gnode, graph, setup } from './test-helpers/fakes.js';

const three = () =>
  setup([
    new RoleAdapter('a', friendly('A'), { analysis: 0.9, writing: 0.9, decision: 0.9 }),
    new RoleAdapter('b', friendly('B'), { critique: 0.9, analysis: 0.5, decision: 0.5 }),
    new RoleAdapter('c', friendly('C'), { analysis: 0.3, decision: 0.3 }),
  ]).options;

/** `n` answers of `out` tokens per (provider, type, role). */
const many = (n: number, x: Sample): Sample[] => Array.from({ length: n }, () => x);
const learned = (...xs: Sample[][]) => outputSpread(history(xs.flat()));

describe('band: dependency context from history (S8 bug 2)', () => {
  // S8's "explain" plan: a writing node, then an analysis node reading its output.
  const explain = () =>
    graph([
      gnode({ id: 'explain', type: 'writing' }),
      gnode({ id: 'step', dependsOn: ['explain'] }),
    ]);

  it('reads the dependency at its learned size, not the 4,000-token allowance', () => {
    const spread = learned(
      many(5, { out: 140, type: 'writing', role: 'solo' }),
      many(5, { out: 300, type: 'analysis', role: 'solo' }),
    );
    const cold = estimateGraph(explain(), three());
    const warm = estimateGraph(explain(), { ...three(), spread });
    const step = warm.nodes[1]!;
    expect(step.band.basis).toBe('calibrated');
    expect(warm.band.basis).toBe('calibrated');
    // one call reads ~140 tokens of context: far below the allowance's $0.004 (a: $1/MTok in)
    expect(step.band.highUsd).toBeLessThan(0.001);
    expect(step.band.lowUsd).toBeGreaterThan(0);
    expect(step.band.lowUsd).toBe(step.band.highUsd); // constant outputs: a point band
    // the expected figure uses the learned median too
    expect(step.expectedUsd).toBeLessThan(cold.nodes[1]!.expectedUsd);
    expect(warm.nodes[0]!.output).toMatchObject({ low: 140, high: 140, calibrated: true });
  });

  it('marks a calibrated step reading a heuristic dependency as mixed', () => {
    const spread = learned(many(5, { out: 300, type: 'analysis', role: 'solo' }));
    const e = estimateGraph(explain(), { ...three(), spread });
    expect(e.nodes[0]!.band.basis).toBe('heuristic');
    expect(e.nodes[1]!.band.basis).toBe('mixed');
    expect(e.nodes[0]!.output).toEqual({
      expected: DEFAULT_DEPENDENCY_ALLOWANCE_TOKENS,
      low: 40,
      high: 8000,
      calibrated: false,
    });
  });

  it('keeps sizing a dependency that already ran on a known provider', () => {
    const spread = learned(
      many(5, { out: 140, type: 'writing', role: 'solo' }),
      many(5, { out: 300, type: 'analysis', role: 'solo' }),
    );
    const known = new Map([['explain', ['a']]]);
    const e = estimateGraph(explain(), { ...three(), spread, known });
    expect(e.nodes[1]!.band.basis).toBe('calibrated');
    expect(e.nodes[1]!.band.highUsd).toBeLessThan(0.001);
  });
});

describe('band: the work a critic, rebuttal or judge reads', () => {
  it("prices the critic and revision on the author's learned output", () => {
    const spread = learned(
      many(5, { out: 100, role: 'author' }),
      many(5, { out: 20, type: 'critique', role: 'critic', provider: 'b' }),
    );
    const g = graph([gnode({ protocol: 'author_critic' })]);
    const e = estimateGraph(g, { ...three(), spread });
    const [, critic, revision] = e.nodes[0]!.steps;
    expect(critic!.band.basis).toBe('calibrated');
    // critic call: prompt + ~100 tokens of work, 20 tokens out (b: $1 in, $2 out per MTok)
    expect(critic!.band.perCallHighUsd).toBeLessThan(0.0005);
    expect(revision!.band.basis).toBe('calibrated'); // author type history, role fallback
    expect(e.nodes[0]!.output).toMatchObject({ low: 100, high: 100 });
  });

  it('sizes debate openings, rebuttals and the judge, and vote outputs', () => {
    const spread = learned(
      many(5, { out: 50, type: 'decision', role: 'debater' }),
      many(5, { out: 60, type: 'decision', role: 'debater', provider: 'b' }),
      many(5, { out: 10, type: 'decision', role: 'judge', provider: 'c' }),
      many(5, { out: 3, type: 'research', role: 'voter' }),
    );
    const d = estimateGraph(graph([gnode({ type: 'decision', protocol: 'debate' })]), {
      ...three(),
      spread,
    });
    expect(d.nodes[0]!.band.basis).toBe('calibrated');
    expect(d.nodes[0]!.output).toMatchObject({ low: 50, high: 60, calibrated: true });
    const v = estimateGraph(graph([gnode({ type: 'research', protocol: 'vote' })]), {
      ...three(),
      spread,
    });
    expect(v.nodes[0]!.band.basis).toBe('mixed'); // only a has research history
    expect(v.nodes[0]!.output.calibrated).toBe(false);
  });
});

describe('band: tool rounds', () => {
  it('counts heuristic rounds for nodes with tools, learned ones once known', () => {
    const plain = graph([gnode()]);
    const tooled = graph([gnode({ tools: ['fs.read'] })]);
    const spread = learned(many(5, { out: 300, role: 'solo' }));
    const without = estimateGraph(plain, { ...three(), spread }).band;
    const coldEstimate = estimateGraph(tooled, { ...three(), spread });
    const cold = coldEstimate.band;
    expect(cold.highUsd).toBeGreaterThan(without.highUsd);
    expect(cold.highUsd).toBeLessThanOrEqual(HEURISTIC_MAX_RATIO * coldEstimate.totalUsd + 1e-6);
    expect(cold.lowUsd).toBe(without.lowUsd);
    expect(cold.basis).toBe('mixed');
    const used = learned(many(5, { out: 300, role: 'solo', tools: true }));
    const warm = estimateGraph(tooled, { ...three(), spread: used }).band;
    expect(warm).toEqual({ ...without, basis: 'calibrated' });
  });
});

describe('band invariant: low ≤ expected ≤ high (D-021)', () => {
  it('holds for every step, node and graph, with and without history', () => {
    const g = graph([
      gnode({ id: 'a', type: 'analysis', protocol: 'debate', tools: ['fs.read'] }),
      gnode({ id: 'b', type: 'code_generation', protocol: 'author_critic', dependsOn: ['a'] }),
      gnode({ id: 'c', type: 'research', protocol: 'vote', dependsOn: ['a'] }),
      gnode({ id: 'd', type: 'critique', dependsOn: ['b', 'c'], tools: ['fs.read'] }),
    ]);
    const spreads = [
      undefined,
      learned(many(5, { out: 300, role: 'solo' })),
      learned(
        many(5, { out: 20, type: 'analysis', role: 'debater' }),
        many(5, { out: 2000, type: 'code_generation', role: 'author' }),
        many(5, { out: 1, type: 'critique', provider: 'b', role: 'critic' }),
        many(5, { out: 900, type: 'critique', provider: 'c', tools: true }),
      ),
    ];
    for (const spread of spreads) {
      for (const maxRevisions of [0, 2]) {
        const e = estimateGraph(g, { ...three(), allowSameProvider: true, maxRevisions, spread });
        expect(e.complete).toBe(true);
        expect(bandBreaches(e)).toEqual([]);
      }
    }
  });
});
