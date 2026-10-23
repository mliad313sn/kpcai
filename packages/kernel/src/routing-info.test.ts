import { describe, expect, it } from 'vitest';
import type { Router, RoutingDecision, ScoredCandidate } from '@kernelpai/core';
import { Journal } from '@kernelpai/journal';
import { RouterTap, UsageTap, annotate, explainEstimate } from './routing-info.js';
import type { GraphSetup } from './setup.js';

const cand = (provider: string, score: number): ScoredCandidate =>
  ({ ref: { provider, model: 'm' }, score, parts: {}, estimate: {} }) as ScoredCandidate;

const decision = (nodeId: string, ...c: ScoredCandidate[]): RoutingDecision => ({
  nodeId,
  chosen: c[0] as ScoredCandidate,
  fallbacks: c.slice(1),
  rejected: [],
  reason: `${c[0]?.ref.provider} wins`,
  elapsedMs: 0,
});

describe('routing info', () => {
  it('remembers decisions per node and explains a chosen or fallback model', () => {
    const inner: Router = { route: (n) => decision(n.id, cand('a', 0.9), cand('b', 0.7)) };
    const tap = new RouterTap(inner);
    tap.route({ id: 'n1' } as never, []);
    expect(tap.lookup('n1', { provider: 'a', model: 'm' })).toEqual({
      reason: 'a wins',
      score: 0.9,
    });
    expect(tap.lookup('n1', { provider: 'b', model: 'm' })).toEqual({
      reason: 'ranked #2: a wins',
      score: 0.7,
    });
    expect(tap.lookup('n1', { provider: 'c', model: 'm' })).toBeUndefined();
    expect(tap.lookup('n2', { provider: 'a', model: 'm' })).toBeUndefined();
  });

  it('counts tokens of response events per node and model through a transparent journal', () => {
    const usage = new UsageTap();
    const raw = Journal.open(':memory:');
    const j = usage.wrap(raw);
    const sessionId = j.startSession('t', '/w');
    const response = {
      sessionId,
      type: 'response' as const,
      nodeId: 'n',
      provider: 'a',
      model: 'm',
    };
    j.append({ ...response, payload: { inputTokens: 10, outputTokens: 5 } });
    j.append({ ...response, payload: { inputTokens: 1, outputTokens: 2 } });
    j.append({ sessionId, type: 'intervention', payload: {} });
    expect(j.events()).toHaveLength(3);
    const router = new RouterTap({ route: () => decision('x', cand('a', 1)) });
    const e = annotate(
      {
        type: 'contribution',
        nodeId: 'n',
        contribution: { role: 'solo', ref: { provider: 'a', model: 'm' }, text: '', costUsd: 0 },
      },
      router,
      usage,
    );
    expect(e.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(usage.claim('n', { provider: 'a', model: 'm' })).toBeUndefined();
    expect(annotate({ type: 'graph_done', costUsd: 0, ok: true }, router, usage)).toEqual({
      type: 'graph_done',
      costUsd: 0,
      ok: true,
    });
    raw.close();
  });

  it('claims no reason when the router would pick another model or throws', () => {
    const graph = { nodes: [{ id: 'n' }, { id: 'p', model: { provider: 'z', model: 'm' } }] };
    const est = {
      nodes: [
        { nodeId: 'n', ref: { provider: 'b', model: 'm' } },
        { nodeId: 'p', ref: { provider: 'z', model: 'm' } },
        { nodeId: 'gone', ref: null },
      ],
    };
    const setup = (route: Router['route']): GraphSetup =>
      ({ router: { route }, candidates: [], constraints: {} }) as unknown as GraphSetup;
    const other = explainEstimate(
      graph as never,
      est as never,
      setup((n) => decision(n.id, cand('a', 1))),
    );
    expect(other.nodes[0]).not.toHaveProperty('reason');
    expect(other.nodes[1]?.reason).toMatch(/chosen by the user/);
    const boom = explainEstimate(
      graph as never,
      est as never,
      setup(() => {
        throw new Error('x');
      }),
    );
    expect(boom.nodes[0]).not.toHaveProperty('reason');
  });
});
