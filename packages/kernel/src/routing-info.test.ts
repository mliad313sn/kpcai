import { describe, expect, it } from 'vitest';
import type { Router, RoutingDecision, ScoredCandidate } from '@kernelpai/core';
import { Journal } from '@kernelpai/journal';
import {
  DecisionLog,
  RouterTap,
  USER_CHOICE,
  UsageTap,
  annotate,
  explainEstimate,
} from './routing-info.js';

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

  it('explains every step with the decision the estimator priced it on', () => {
    // Recorded as the estimator routes: author, critic (author excluded), revision.
    const answers = [
      decision('n', cand('a', 0.9), cand('b', 0.7)),
      decision('n', cand('b', 0.8), cand('c', 0.6)),
      decision('n', cand('b', 0.85), cand('a', 0.9)),
      decision('p', cand('z', 0.5)),
    ];
    const log = new DecisionLog({ route: () => answers.shift() as RoutingDecision });
    for (let i = 0; i < 4; i++) log.route({ id: 'x' } as never, []);
    const step = (role: string, provider: string) => ({ role, ref: { provider, model: 'm' } });
    const est = {
      totalUsd: 0.4,
      band: { lowUsd: 0.1, highUsd: 0.9, basis: 'heuristic' },
      nodes: [
        {
          nodeId: 'n',
          ref: { provider: 'a', model: 'm' },
          steps: [step('author', 'a'), step('critic', 'b'), step('revision', 'a')],
        },
        {
          nodeId: 'p',
          ref: { provider: 'z', model: 'm' },
          pinned: { provider: 'z', model: 'm' },
          steps: [step('solo', 'z'), step('critic', 'nobody')],
        },
        { nodeId: 'gone', ref: null, steps: [] },
      ],
    };
    const out = explainEstimate(est as never, log);
    const [n, p, gone] = out.nodes;
    expect(n?.steps.map((x) => [x.reason, x.score, x.runnerUp?.ref.provider])).toEqual([
      ['a wins', 0.9, 'b'],
      ['b wins', 0.8, 'c'],
      ["kept on the author's model a/m (ranked #2); b wins", 0.9, 'b'],
    ]);
    expect(n).toMatchObject({ reason: 'a wins', score: 0.9, runnerUp: { score: 0.7 } });
    expect(p?.reason).toBe(USER_CHOICE);
    expect(p?.steps[0]).not.toHaveProperty('runnerUp');
    expect(p?.steps[1]).not.toHaveProperty('reason');
    expect(gone).not.toHaveProperty('reason');
    expect(out).toMatchObject({ expectedUsd: 0.4, capUsd: 0.9 });
  });
});
