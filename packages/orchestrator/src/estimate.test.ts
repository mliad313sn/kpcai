import { describe, expect, it } from 'vitest';
import { PROTOCOL_ROUNDS, estimateGraph } from './estimate.js';
import { RoleAdapter, friendly, gnode, graph, setup } from './test-helpers/fakes.js';

/** a: best author, b: best critic, c: cheap third provider; prices differ per provider. */
function three(n = 3) {
  const all = [
    new RoleAdapter(
      'a',
      friendly('A'),
      { analysis: 0.9, code_generation: 0.9, critique: 0.2, decision: 0.9 },
      { inputPerMTok: 1, outputPerMTok: 2 },
    ),
    new RoleAdapter(
      'b',
      friendly('B'),
      { analysis: 0.3, code_generation: 0.3, critique: 0.9, decision: 0.6 },
      { inputPerMTok: 3, outputPerMTok: 6 },
    ),
    new RoleAdapter(
      'c',
      friendly('C'),
      { analysis: 0.1, code_generation: 0.1, critique: 0.5, decision: 0.3 },
      { inputPerMTok: 5, outputPerMTok: 10 },
    ),
  ];
  return setup(all.slice(0, n)).options;
}

const roles = (e: ReturnType<typeof estimateGraph>, i = 0) =>
  e.nodes[i]?.steps.map((s) => `${s.role}@${s.ref.provider}:${s.calls.min}-${s.calls.max}`);

describe('estimateGraph (review P2-F9/F16/F18)', () => {
  it('prices each author+critic role on the model it would be routed to, with all retries', () => {
    const e = estimateGraph(graph([gnode({ protocol: 'author_critic' })]), three());
    expect(roles(e)).toEqual(['author@a:1-1', 'critic@b:1-4', 'revision@a:0-2']);
    const n = e.nodes[0]!;
    expect(n.rounds).toEqual({ min: 2, max: 7 });
    expect(PROTOCOL_ROUNDS.author_critic).toEqual({ min: 2, max: 7 });
    const [author, critic, revision] = n.steps;
    expect(critic!.perCallUsd).toBeGreaterThan(author!.perCallUsd); // b is pricier than a
    expect(revision!.perCallUsd).toBeGreaterThan(author!.perCallUsd); // revision quotes the work
    expect(n.expectedUsd).toBeCloseTo(
      author!.perCallUsd + 4 * critic!.perCallUsd + 2 * revision!.perCallUsd,
      6,
    );
    expect(n.minUsd).toBeCloseTo(author!.perCallUsd + critic!.perCallUsd, 6);
    expect(e.complete).toBe(true);
    const fewer = estimateGraph(graph([gnode({ protocol: 'author_critic' })]), {
      ...three(),
      maxRevisions: 1,
    });
    expect(fewer.nodes[0]?.rounds).toEqual({ min: 2, max: 5 });
  });

  it('counts dependency context in the input estimate', () => {
    const nodes = [
      gnode({ id: 'x' }),
      gnode({ id: 'y' }),
      gnode({ id: 'z', dependsOn: ['x', 'y'] }),
    ];
    const e = estimateGraph(graph(nodes), three());
    const alone = e.nodes[0]!.perCallUsd;
    const withDeps = e.nodes[2]!.perCallUsd;
    // two dependencies × 4,000 tokens × $1/MTok input on a
    expect(withDeps - alone).toBeGreaterThan(0.008);
    const none = estimateGraph(graph(nodes), { ...three(), dependencyAllowanceTokens: 0 });
    expect(none.nodes[2]!.perCallUsd - alone).toBeLessThan(0.0001);
  });

  it('upgrades code and test nodes and shows who reviews them', () => {
    const nodes = [
      gnode({ id: 'impl', type: 'code_generation', protocol: 'solo' }),
      gnode({ id: 'rev', type: 'critique', dependsOn: ['impl'] }),
    ];
    const e = estimateGraph(graph(nodes), three());
    expect(e.nodes[0]).toMatchObject({
      protocol: 'author_critic',
      upgraded: expect.stringMatching(/code_generation/),
    });
    // the review avoids a (author) and b (critic): only c is left
    expect(roles(e, 1)).toEqual(['solo@c:1-1']);
    const two = estimateGraph(graph(nodes), three(2));
    expect(two.complete).toBe(false);
    expect(two.problems).toEqual([
      'rev: solo: no provider other than a, b (principle 2; allowSameProvider waives it)',
    ]);
    const waived = estimateGraph(graph(nodes), { ...three(2), allowSameProvider: true });
    expect(waived.complete).toBe(true);
    expect(waived.nodes[1]?.steps[0]?.diversityWaived).toBe(true);
  });

  it('routes debaters, rebuttals and a judge from a third provider', () => {
    const e = estimateGraph(graph([gnode({ protocol: 'debate', type: 'decision' })]), three());
    expect(roles(e)).toEqual([
      'debater@a:1-1',
      'debater@b:1-1',
      'debater@a:1-1',
      'debater@b:1-1',
      'judge@c:1-2',
    ]);
    expect(e.nodes[0]?.rounds).toEqual({ min: 5, max: 6 });
    const two = estimateGraph(graph([gnode({ protocol: 'debate', type: 'decision' })]), three(2));
    expect(two.nodes[0]?.error).toMatch(/^judge: no provider other than a, b/);
  });

  it('routes voters from distinct providers and needs at least two', () => {
    const v = gnode({ protocol: 'vote', type: 'decision' });
    expect(roles(estimateGraph(graph([v]), three()))).toEqual([
      'voter@a:1-2',
      'voter@b:1-2',
      'voter@c:1-2',
    ]);
    const two = estimateGraph(graph([v]), three(2));
    expect(two.complete).toBe(true);
    expect(two.nodes[0]?.steps).toHaveLength(2);
    const one = estimateGraph(graph([v]), { ...three(1), allowSameProvider: true });
    expect(one.complete).toBe(false);
    expect(one.nodes[0]?.error).toBe('vote: only 1 distinct provider(s), at least 2 needed');
  });

  it('marks single-provider author+critic and debate nodes incomplete', () => {
    const e = estimateGraph(
      graph([
        gnode({ id: 'ac', protocol: 'author_critic' }),
        gnode({ id: 'd', protocol: 'debate' }),
      ]),
      three(1),
    );
    expect(e.complete).toBe(false);
    expect(e.problems).toEqual([
      'ac: critic: no provider other than a (principle 2; allowSameProvider waives it)',
      'd: debater: no provider other than a (principle 2; allowSameProvider waives it)',
    ]);
    expect(e.nodes[0]?.steps.map((s) => s.role)).toEqual(['author']);
  });

  it('reports nodes that cannot be routed at all', () => {
    const e = estimateGraph(graph([gnode()]), {
      ...three(1),
      constraints: { deniedProviders: ['a'] },
    });
    expect(e.complete).toBe(false);
    expect(e.nodes[0]).toMatchObject({ ref: null, perCallUsd: 0, expectedUsd: 0, steps: [] });
    expect(e.totalUsd).toBe(0);
  });

  it('tolerates dependency cycles and unknown ids (validation is the runner’s job)', () => {
    const nodes = [
      gnode({ id: 'p', dependsOn: ['q', 'ghost'] }),
      gnode({ id: 'q', dependsOn: ['p'] }),
    ];
    expect(estimateGraph(graph(nodes), three()).nodes).toHaveLength(2);
  });
});
