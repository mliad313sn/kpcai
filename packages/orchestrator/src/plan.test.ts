import { describe, expect, it } from 'vitest';
import type { GraphNode, TaskGraph } from '@kernelpai/core';
import { planChanges, validatePlan } from './plan.js';
import { GraphRunner } from './runner.js';
import { RoleAdapter, friendly, gnode, graph, setup } from './test-helpers/fakes.js';
import type { PlannedNode } from './types.js';

const A = { provider: 'a', model: 'm' };
const B = { provider: 'b', model: 'm' };

function two() {
  return setup([
    new RoleAdapter('a', friendly('A'), { analysis: 0.9, critique: 0.2 }),
    new RoleAdapter('b', friendly('B'), { analysis: 0.3, critique: 0.9 }),
  ]);
}

const bad = (over: Record<string, unknown>): TaskGraph =>
  graph([{ ...gnode(), ...over } as unknown as GraphNode]);

describe('validatePlan (R-301)', () => {
  it('accepts an edited model, re-estimates on it and lists the edits', () => {
    const original = graph([gnode({ id: 'x' }), gnode({ id: 'y', dependsOn: ['x'] })]);
    const edited = graph([
      { ...gnode({ id: 'x' }), model: B } as PlannedNode,
      gnode({ id: 'y', dependsOn: ['x'], protocol: 'author_critic', criticality: 'critical' }),
    ]);
    const c = validatePlan(edited, { ...two().options, original });
    expect(c.ok).toBe(true);
    expect(c.problems).toEqual([]);
    expect(c.estimate?.nodes[0]?.ref).toEqual(B);
    expect(c.estimate?.nodes[0]?.pinned).toEqual(B);
    expect(c.estimate?.band.highUsd).toBeGreaterThan(0);
    expect(c.changes).toEqual([
      'x: model routed → b/m',
      'y: protocol solo → author_critic',
      'y: criticality normal → critical',
    ]);
  });

  it('reports structural errors: empty plan, duplicates, unknown ids, cycles', () => {
    const o = two().options;
    expect(validatePlan(graph([]), o).problems).toEqual(['the plan has no node']);
    expect(validatePlan(graph([gnode(), gnode()]), o).problems).toEqual(['duplicate node id "n1"']);
    expect(validatePlan(graph([gnode({ dependsOn: ['ghost'] })]), o).problems).toEqual([
      'node "n1" depends on unknown node "ghost"',
    ]);
    const cyc = validatePlan(
      graph([gnode({ id: 'p', dependsOn: ['q'] }), gnode({ id: 'q', dependsOn: ['p'] })]),
      o,
    );
    expect(cyc.ok).toBe(false);
    expect(cyc.problems[0]).toMatch(/^cycle: /);
    expect(cyc.estimate).toBeUndefined();
    expect(validatePlan({} as TaskGraph, o).problems).toEqual(['the plan has no node']);
  });

  it('reports malformed node fields from untrusted JSON', () => {
    const o = two().options;
    const problems = (over: Record<string, unknown>) => validatePlan(bad(over), o).problems;
    expect(problems({ id: '' })).toEqual(['node id must be a string of 1 to 100 characters']);
    expect(problems({ title: 3 })).toEqual(['node "n1": title must be a string']);
    expect(problems({ type: 'poetry' })).toEqual(['node "n1": unknown task type "poetry"']);
    expect(problems({ protocol: 'relay' })).toEqual(['node "n1": unknown protocol "relay"']);
    expect(problems({ criticality: 'max' })).toEqual(['node "n1": unknown criticality "max"']);
    expect(problems({ budgetUsd: -1 })).toEqual(['node "n1": budgetUsd must be a number ≥ 0']);
    expect(problems({ dependsOn: 'x' })).toEqual(['node "n1": dependsOn must list node ids']);
    expect(problems({ tools: [1] })).toEqual(['node "n1": tools must list tool names']);
    expect(problems({ messages: [{ role: 'user', content: ' ' }] })).toEqual([
      'node "n1": needs a non-empty user message',
    ]);
    expect(problems({ model: { provider: 'a' } })).toEqual([
      'node "n1": model must be {provider, model}',
    ]);
    expect(problems({ model: { provider: 'z', model: 'm' } })).toEqual([
      'node "n1": model z/m is not an available candidate',
    ]);
  });

  it('refuses a plan where principle 2 cannot be met', () => {
    const one = setup([new RoleAdapter('a', friendly('A'))]).options;
    const c = validatePlan(graph([gnode({ protocol: 'author_critic' })]), one);
    expect(c.ok).toBe(false);
    expect(c.problems[0]).toMatch(/^n1: critic: no provider other than a \(principle 2/);
    // Pinning a review onto the provider it reviews is refused too.
    const review = graph([
      { ...gnode({ id: 'w' }), model: A } as PlannedNode,
      { ...gnode({ id: 'r', type: 'critique', dependsOn: ['w'] }), model: A } as PlannedNode,
    ]);
    expect(validatePlan(review, two().options).problems).toEqual([
      'r: solo: no provider other than a (principle 2; allowSameProvider waives it)',
    ]);
  });

  it('warns when a node budget or the graph cap is below the low estimate', () => {
    const c = validatePlan(graph([gnode({ budgetUsd: 0 })]), {
      ...two().options,
      maxGraphUsd: 0,
    });
    expect(c.ok).toBe(true);
    expect(c.warnings).toHaveLength(2);
    expect(c.warnings[0]).toMatch(/^node "n1": budget \$0 is below its low estimate/);
    expect(c.warnings[1]).toMatch(/^maxGraphUsd \$0 is below the low estimate/);
  });
});

describe('planChanges', () => {
  it('lists removed, added and edited nodes', () => {
    const before = graph([gnode({ id: 'a' }), gnode({ id: 'b' }), gnode({ id: 'c' })]);
    const after = graph([
      gnode({ id: 'a', title: 'New title', budgetUsd: 0.5, tools: ['read_file'] }),
      gnode({ id: 'b', type: 'code_generation', dependsOn: ['a'] }),
      gnode({ id: 'd' }),
    ]);
    expect(planChanges(before, after)).toEqual([
      'removed node c',
      'a: budgetUsd none → 0.5',
      'a: tools  → read_file',
      'a: prompt edited',
      'b: type analysis → code_generation',
      'b: dependsOn  → a',
      'added node d',
    ]);
  });
});

describe('the edited plan is the one that runs (R-301 acceptance)', () => {
  it('runs the validated graph on the edited model and journals the edits', async () => {
    const s = two();
    const original = graph([gnode()]);
    const edited = graph([{ ...gnode(), model: B } as PlannedNode]);
    const check = validatePlan(edited, { ...s.options, original });
    expect(check.ok).toBe(true);
    const runner = new GraphRunner(s.options);
    const done = runner.run(edited, { edits: check.changes });
    // Later edits to the caller's object do not change the approved run.
    (edited.nodes[0] as PlannedNode).model = A;
    const r = await done;
    expect(r.ok).toBe(true);
    expect(r.results['n1']?.contributions[0]?.ref).toEqual(B);
    const events = s.journal.events({ sessionId: s.sessionId });
    const routing = events.find((e) => e.type === 'routing');
    expect(routing).toMatchObject({ provider: 'b', model: 'm', payload: { pinned: true } });
    expect(String(routing?.payload.reason)).toMatch(/^b\/m chosen by the user; /);
    const plan = events.find((e) => e.type === 'intervention');
    expect(plan?.payload).toEqual({ action: 'plan edited', changes: ['n1: model routed → b/m'] });
  });

  it('rejects a graph pinned to an unknown model before running', async () => {
    const s = two();
    const g = graph([{ ...gnode(), model: { provider: 'z', model: 'q' } } as PlannedNode]);
    await expect(new GraphRunner(s.options).run(g)).rejects.toThrow(
      'invalid graph: node "n1": model z/q is not available',
    );
  });
});
