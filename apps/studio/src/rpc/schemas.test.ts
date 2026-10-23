import { describe, expect, it } from 'vitest';
import { ESTIMATE, GRAPH, PROVIDERS, SESSIONS } from '../test-helpers/fixtures';
import {
  GraphEstimateSchema,
  GraphEventSchema,
  PlanResultSchema,
  TaskGraphSchema,
  parseEstimate,
  parseModels,
  parseProviders,
  parseSessions,
  serverAllowsTest,
  visibleProviders,
} from './schemas';

describe('client schemas', () => {
  it('accepts kernel graphs and estimates, keeping extra fields', () => {
    expect(TaskGraphSchema.parse({ ...GRAPH, extra: 1 })).toMatchObject({ extra: 1 });
    expect(GraphEstimateSchema.parse(ESTIMATE).nodes[1]?.score).toBe(0.82);
    expect(PlanResultSchema.safeParse({ planId: 'p', graph: {}, estimate: ESTIMATE }).success).toBe(
      false,
    );
  });

  it('validates GraphEvents by type', () => {
    const ref = { provider: 'p', model: 'm' };
    expect(
      GraphEventSchema.safeParse({ type: 'text', nodeId: 'a', role: 'solo', ref, delta: 'x' })
        .success,
    ).toBe(true);
    expect(
      GraphEventSchema.safeParse({ type: 'text', nodeId: 'a', role: 'boss', ref, delta: 'x' })
        .success,
    ).toBe(false);
    expect(GraphEventSchema.safeParse({ type: 'graph_done', costUsd: 1, ok: true }).success).toBe(
      true,
    );
    expect(GraphEventSchema.safeParse({ type: 'nope' }).success).toBe(false);
  });

  it('parses sessions from an array or an object, dropping bad rows', () => {
    expect(parseSessions(SESSIONS).map((s) => s.id)).toEqual(['s1']);
    expect(parseSessions({ sessions: SESSIONS })).toHaveLength(1);
    expect(parseSessions(null)).toEqual([]);
    expect(parseSessions('x')).toEqual([]);
  });

  it('lists models of available providers', () => {
    expect(parseModels(PROVIDERS)).toEqual([
      { provider: 'anthropic', model: 'model-a' },
      { provider: 'anthropic', model: 'model-e' },
    ]);
    expect(parseModels({ providers: PROVIDERS })).toHaveLength(2);
    expect(parseModels([{ nope: 1 }])).toEqual([]);
    expect(parseModels(undefined)).toEqual([]);
  });

  it('reads provider kinds: local, cloud, test, or unknown when missing (S8 bug 4)', () => {
    const rows = parseProviders([
      { id: 'a', kind: 'local', models: [] },
      { id: 'b', kind: 'cloud', models: [] },
      { id: 'mock', name: 'Mock (offline)', kind: 'test', models: ['echo'] },
      { id: 'c', models: [] },
      { id: 'd', kind: 'quantum', models: [] },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['local', 'cloud', 'test', 'unknown', 'unknown']);
    expect(visibleProviders(rows, false).map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(visibleProviders(rows, true)).toHaveLength(5);
  });

  it('offers test models only when allowed, by the server or the run options', () => {
    const mock = { id: 'mock', kind: 'test', available: true, models: [{ id: 'echo' }] };
    const raw = { providers: [...PROVIDERS, mock] };
    expect(parseModels(raw)).toHaveLength(2);
    expect(parseModels(raw, true).at(-1)).toEqual({ provider: 'mock', model: 'echo' });
    expect(serverAllowsTest(raw)).toBe(false);
    expect(serverAllowsTest({ ...raw, testAllowed: true })).toBe(true);
    expect(serverAllowsTest([mock])).toBe(false);
    expect(serverAllowsTest(null)).toBe(false);
  });

  it('reads the D-021 likely cost and cap from the estimate or the result around it', () => {
    const old = { ...ESTIMATE, expectedUsd: undefined, capUsd: undefined };
    expect(parseEstimate(old)).not.toHaveProperty('capUsd');
    expect(parseEstimate(old, { expected: 0.3, cap: 0.6 })).toMatchObject({
      expectedUsd: 0.3,
      capUsd: 0.6,
    });
    expect(parseEstimate(ESTIMATE, { expectedUsd: 9, capUsd: 9 })).toMatchObject({
      expectedUsd: 0.4,
      capUsd: 0.5,
    });
    expect(parseEstimate({ ...old, capUsd: -1, expectedUsd: 'x' })).not.toHaveProperty('capUsd');
    expect(parseEstimate({ nodes: 'nope' })).toBeUndefined();
  });
});
