import { describe, expect, it } from 'vitest';
import { forbiddenContent, packProblems, planProblems } from './validate.js';
import { PackSchema, type Pack, type PlanHint } from './schema.js';

/** Parses with the schema only, so packProblems does not reject the negative fixtures. */
function parse(extra: Record<string, unknown> = {}): Pack {
  return PackSchema.parse({
    id: 't',
    name: 'T',
    description: 'a test pack',
    profiles: ['tester'],
    ...extra,
  });
}

describe('forbiddenContent', () => {
  it('flags a model id, a price and a token limit in pack text', () => {
    const p = parse({ tips: ['use claude-opus-5-5', 'costs $4.00 per MTok', 'fits 200k tokens'] });
    const found = forbiddenContent(p);
    expect(found.some((f) => f.includes('model id'))).toBe(true);
    expect(found.some((f) => f.includes('price'))).toBe(true);
    expect(found.some((f) => f.includes('token limit'))).toBe(true);
  });

  it('passes a pack that talks about capabilities', () => {
    expect(forbiddenContent(parse({ tips: ['prefer a local model for private data'] }))).toEqual(
      [],
    );
  });
});

describe('planProblems', () => {
  const plan = (nodes: PlanHint['nodes']): PlanHint => ({
    id: 'p',
    title: 'P',
    when: ['x'],
    nodes,
  });
  const node = (id: string, dependsOn: string[] = []) => ({
    id,
    title: id,
    type: 'analysis' as const,
    protocol: 'solo' as const,
    dependsOn,
    tools: [],
    deliverable: 'answer' as const,
  });

  it('detects an unknown dependency', () => {
    expect(planProblems(plan([node('a', ['missing'])]))[0]).toContain('unknown node');
  });

  it('detects a cycle', () => {
    const problems = planProblems(plan([node('a', ['b']), node('b', ['a'])]));
    expect(problems.some((p) => p.includes('cycle'))).toBe(true);
  });

  it('accepts a valid chain', () => {
    expect(planProblems(plan([node('a'), node('b', ['a'])]))).toEqual([]);
  });
});

describe('packProblems', () => {
  it('requires scope kinds when a pack requires a scope', () => {
    const p = parse({ safety: { requiresScope: true } });
    expect(packProblems(p).some((m) => m.includes('scopeKinds'))).toBe(true);
  });
});
