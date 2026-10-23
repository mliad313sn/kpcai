import type { GraphNode } from '@kernelpai/core';
import { describe, expect, it } from 'vitest';
import { estimateGraph } from './estimate.js';
import { validatePlan } from './plan.js';
import {
  SUGGESTED_REVIEW_POLICY,
  applyReviewPolicy,
  isReviewPolicy,
  reviewedNode,
  type ReviewPolicy,
} from './review-policy.js';
import { GraphRunner } from './runner.js';
import { RoleAdapter, friendly, gnode, graph, isNote, setup } from './test-helpers/fakes.js';
import type { PlannedNode } from './types.js';

const at = (criticality: GraphNode['criticality'], over: Partial<PlannedNode> = {}) =>
  gnode({ criticality, ...over }) as PlannedNode;

const deep: ReviewPolicy = { low: 'none', normal: 'critic', critical: 'debate' };

describe('review policy (R-404)', () => {
  it('maps criticality to review depth', () => {
    const p = SUGGESTED_REVIEW_POLICY;
    expect(reviewedNode(at('low', { protocol: 'author_critic' }), p).node.protocol).toBe('solo');
    expect(reviewedNode(at('normal'), p).node.protocol).toBe('author_critic');
    const critical = reviewedNode(at('critical'), p);
    expect(critical.node).toMatchObject({ protocol: 'author_critic', critics: 2 });
    expect(critical.change).toMatchObject({
      depth: 'critics',
      from: { protocol: 'solo' },
      to: { protocol: 'author_critic', critics: 2 },
    });
    expect(reviewedNode(at('critical'), deep).node.protocol).toBe('debate');
  });

  it('never takes code or tests below author+critic (principle 2)', () => {
    for (const type of ['code_generation', 'test'] as const) {
      const low = reviewedNode(at('low', { type, protocol: 'author_critic' }), deep);
      expect(low.node.protocol).toBe('author_critic');
      expect(low.change).toBeUndefined();
      const critical = reviewedNode(at('critical', { type, protocol: 'author_critic' }), deep);
      expect(critical.node).toMatchObject({ protocol: 'author_critic', critics: 2 });
      expect(critical.change?.floor).toMatch(/principle 2/);
    }
    const diff = at('low', { deliverable: 'patch', protocol: 'solo' });
    expect(reviewedNode(diff, { ...deep, low: 'vote' }).node.protocol).toBe('author_critic');
  });

  it('leaves planned debates, votes and critique nodes alone, and is idempotent', () => {
    const vote = at('critical', { protocol: 'vote' });
    expect(reviewedNode(vote, SUGGESTED_REVIEW_POLICY).change).toBeUndefined();
    const critique = at('low', { type: 'critique', protocol: 'author_critic' });
    expect(reviewedNode(critique, SUGGESTED_REVIEW_POLICY).change).toBeUndefined();
    const g = graph([at('low'), at('normal'), at('critical')]);
    const once = applyReviewPolicy(g, SUGGESTED_REVIEW_POLICY);
    expect(once.changes.map((c) => c.nodeId)).toHaveLength(2);
    expect(applyReviewPolicy(once.graph, SUGGESTED_REVIEW_POLICY).changes).toEqual([]);
    expect(applyReviewPolicy(g, undefined).graph).toBe(g);
  });

  it('validates a policy', () => {
    expect(isReviewPolicy(SUGGESTED_REVIEW_POLICY)).toBe(true);
    expect(isReviewPolicy({ low: 'none', normal: 'critic' })).toBe(false);
    expect(isReviewPolicy({ low: 'none', normal: 'x', critical: 'vote' })).toBe(false);
    expect(isReviewPolicy(null)).toBe(false);
  });

  it('changes the protocol the runner chooses, and journals why', async () => {
    const adapters = ['a', 'b', 'c'].map((p) => new RoleAdapter(p, friendly(p.toUpperCase())));
    const s = setup(adapters, { reviewPolicy: SUGGESTED_REVIEW_POLICY });
    const nodes = [
      at('low', { id: 'low', protocol: 'author_critic' }),
      at('critical', { id: 'crit' }),
      at('low', { id: 'code', type: 'code_generation', protocol: 'author_critic' }),
    ];
    const r = await new GraphRunner(s.options).run(graph(nodes));
    expect(r.ok).toBe(true);
    const roles = (id: string) => r.results[id]?.contributions.map((c) => c.role);
    expect(roles('low')).toEqual(['solo']);
    expect(roles('crit')).toEqual(['author', 'critic', 'critic']);
    expect(roles('code')).toEqual(['author', 'critic']);
    const crit = r.results['crit']?.contributions.map((c) => c.ref.provider) ?? [];
    expect(new Set(crit).size).toBe(3);
    const notes = s.journal.events().filter(isNote);
    const set = notes.filter((e) => e.payload['action'] === 'protocol set by review policy');
    expect(set.map((e) => e.nodeId)).toEqual(['low', 'crit']);
  });

  it('is reflected in the estimate and checked in edited plans', () => {
    const adapters = ['a', 'b', 'c'].map((p) => new RoleAdapter(p, friendly(p)));
    const s = setup(adapters);
    const deps = { router: s.options.router, candidates: s.options.candidates };
    const g = graph([at('critical')]);
    const plain = estimateGraph(g, deps).nodes[0];
    const policed = estimateGraph(g, { ...deps, reviewPolicy: SUGGESTED_REVIEW_POLICY }).nodes[0];
    expect(plain?.steps.map((x) => x.role)).toEqual(['author', 'critic', 'revision']);
    expect(policed?.steps.map((x) => x.role)).toEqual(['author', 'critic', 'critic', 'revision']);
    expect(
      new Set(policed?.steps.filter((x) => x.role === 'critic').map((x) => x.ref.provider)).size,
    ).toBe(2);
    const bad = graph([at('normal', { critics: 7 })]);
    expect(validatePlan(bad, deps).problems).toContain('node "n1": critics must be 1, 2 or 3');
  });

  it('estimates fewer critics when providers run out, and extra judges', () => {
    const two = ['a', 'b'].map((p) => new RoleAdapter(p, friendly(p)));
    const s = setup(two);
    const deps = { router: s.options.router, candidates: s.options.candidates };
    const e = estimateGraph(graph([at('normal', { protocol: 'author_critic', critics: 2 })]), deps);
    expect(e.nodes[0]?.steps.filter((x) => x.role === 'critic')).toHaveLength(1);
    const four = ['a', 'b', 'c', 'd'].map((p) => new RoleAdapter(p, friendly(p)));
    const s4 = setup(four);
    const d4 = { router: s4.options.router, candidates: s4.options.candidates, judges: 2 };
    const deb = estimateGraph(graph([at('normal', { protocol: 'debate' })]), d4);
    expect(deb.nodes[0]?.steps.filter((x) => x.role === 'judge')).toHaveLength(2);
  });
});
