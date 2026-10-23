/**
 * `nodeConstraints` (ADR-0027 §6, review P4-F3): per-node routing constraints asked before
 * every step. Routed steps meet them, fixed decisions are filtered by them, and a step none
 * can serve fails closed with the hook's reason.
 */
import { describe, expect, it } from 'vitest';
import { constrainDecision, routeDiverse } from './routing.js';
import { GraphRunner } from './runner.js';
import { RoleAdapter, gnode, graph, setup, verdict, type Script } from './test-helpers/fakes.js';
import type { NodeConstraint } from './types.js';

const answer: Script = ({ role }) => (role === 'critic' ? verdict(true) : 'done');
const deny =
  (nodes: string[], providers: string[]) =>
  (nodeId: string): NodeConstraint | undefined =>
    nodes.includes(nodeId)
      ? { constraints: { deniedProviders: providers }, reason: `node ${nodeId} is held` }
      : undefined;

describe('nodeConstraints', () => {
  it('routes every step of a constrained node under the constraints', async () => {
    const [x, y, z] = ['x', 'y', 'z'].map((id) => new RoleAdapter(id, answer));
    const s = setup([x!, y!, z!], { nodeConstraints: deny(['a'], ['x', 'y']) });
    const r = await new GraphRunner(s.options).run(
      graph([gnode({ id: 'a', protocol: 'author_critic' }), gnode({ id: 'b' })]),
    );
    expect(r.results['a']!.contributions.map((c) => c.ref.provider)).toEqual(['z']);
    expect(r.results['a']!.ok).toBe(false);
    expect(r.results['a']!.error).toMatch(/^node a is held: /);
    expect(r.results['b']!.ok).toBe(true);
  });

  it('fails closed with the reason when nothing meets them', async () => {
    const x = new RoleAdapter('x', answer);
    const s = setup([x], { nodeConstraints: deny(['a'], ['x']) });
    const r = await new GraphRunner(s.options).run(graph([gnode({ id: 'a' })]));
    expect(r.results['a']!.ok).toBe(false);
    expect(r.results['a']!.error).toMatch(/^node a is held: /);
    expect(x.seen).toHaveLength(0);
  });

  it('filters a fixed decision, keeps it when allowed, and refuses it when nothing is left', () => {
    const [x, y] = ['x', 'y'].map((id) => new RoleAdapter(id, answer));
    const s = setup([x!, y!]);
    const node = gnode({ id: 'a' });
    const d = routeDiverse(s.options, node, { role: 'solo', prompt: 'Role: solo' }).decision;
    expect(constrainDecision(s.options, node, d)).toBe(d);
    const first = d.chosen.ref.provider;
    const held = { ...s.options, nodeConstraints: deny(['a'], [first]) };
    const kept = constrainDecision(held, node, d);
    expect(kept.chosen.ref.provider).not.toBe(first);
    expect(kept.fallbacks).toHaveLength(0);
    const all = { ...s.options, nodeConstraints: deny(['a'], ['x', 'y']) };
    expect(() => constrainDecision(all, node, d)).toThrow(/node a is held: .* not allowed/);
  });
});
