import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Journal, type JournalEventInput } from '@kernelpai/journal';
import { MockAdapter } from '@kernelpai/providers';
import { FallbackExecutor } from './executor.js';
import { metrics, percentile } from './metrics.js';
import { decision, mockDescriptor, node } from './test-helpers/fakes.js';

let journal: Journal;

beforeEach(() => {
  journal = Journal.open(':memory:');
});
afterEach(() => journal.close());

type Ev = Omit<JournalEventInput, 'sessionId'>;

function write(sessionId: string, events: Ev[]): void {
  for (const e of events) journal.append({ sessionId, ...e });
}

const routed = (elapsedMs: number): Ev => ({
  type: 'routing',
  nodeId: 'n1',
  payload: { elapsedMs },
});
const call = (est: number, nodeId = 'n1'): Ev => ({
  type: 'call',
  nodeId,
  payload: { estimatedInputTokens: est },
});
const response = (input: number, cost: number, extra: Record<string, unknown> = {}): Ev => ({
  type: 'response',
  nodeId: 'n1',
  costUsd: cost,
  payload: {
    inputTokens: input,
    outputTokens: 5,
    usageBasis: 'reported',
    stopReason: 'end',
    ...extra,
  },
});
const fallback: Ev = {
  type: 'routing',
  nodeId: 'n1',
  payload: { fallbackFrom: 'a/x', attempt: 1 },
};
const error: Ev = { type: 'error', nodeId: 'n1', payload: { kind: 'rate_limit' } };

describe('metrics', () => {
  it('is empty on an empty journal', () => {
    expect(metrics(journal)).toEqual({
      tasks: 0,
      calls: 0,
      fallbacks: 0,
      fallbackRate: null,
      fallbackSuccessRate: null,
      avgCostPerTaskUsd: null,
      estimateError: { samples: 0, meanAbsPct: null, meanSignedPct: null },
      routerLatencyMs: { samples: 0, p50: null, p95: null },
    });
  });

  it('computes rates, cost, estimate error and router latency', () => {
    const s1 = journal.startSession('one', '/');
    const s2 = journal.startSession('two', '/');
    const s3 = journal.startSession('three', '/');
    // s1: direct success, estimate 110 vs reported 100 (+10 %).
    write(s1, [routed(10), call(110), response(100, 0.02)]);
    // s2: fallback that succeeds, estimate 90 vs 100 (−10 %).
    write(s2, [routed(30), call(50), error, fallback, call(90), response(100, 0.04)]);
    // s3: fallback that ends cancelled, billed from estimates (not an estimate sample).
    write(s3, [
      routed(20),
      call(40),
      error,
      fallback,
      call(40),
      response(40, 0.03, { usageBasis: 'estimated', stopReason: 'cancelled' }),
    ]);
    const m = metrics(journal);
    expect(m.tasks).toBe(3);
    expect(m.calls).toBe(5);
    expect(m.fallbacks).toBe(2);
    expect(m.fallbackRate).toBe(0.6667);
    expect(m.fallbackSuccessRate).toBe(0.5);
    expect(m.avgCostPerTaskUsd).toBe(0.03);
    expect(m.estimateError).toEqual({ samples: 2, meanAbsPct: 10, meanSignedPct: 0 });
    expect(m.routerLatencyMs).toEqual({ samples: 3, p50: 20, p95: 30 });

    const only = metrics(journal, { sessionId: s2 });
    expect(only).toMatchObject({ tasks: 1, fallbackRate: 1, fallbackSuccessRate: 1 });
    expect(only.estimateError.meanSignedPct).toBe(-10);
  });

  it('counts each node of a session as its own task', () => {
    const s = journal.startSession('multi', '/');
    write(s, [call(10, 'n1'), call(10, 'n2')]);
    expect(metrics(journal, { sessionId: s }).tasks).toBe(2);
  });

  it('reads what FallbackExecutor writes', async () => {
    const s = journal.startSession('live', '/');
    const a = new MockAdapter(mockDescriptor('a'));
    a.behaviour.failWith = 'unavailable';
    const b = new MockAdapter(mockDescriptor('b'));
    const adapters = new Map([
      ['a', a],
      ['b', b],
    ]);
    const ex = new FallbackExecutor((ref) => adapters.get(ref.provider) as MockAdapter, journal);
    const r = await ex.execute(node(), decision('a/echo', 'b/echo'), { sessionId: s });
    const m = metrics(journal, { sessionId: s });
    expect(m).toMatchObject({ tasks: 1, calls: 2, fallbacks: 1, fallbackSuccessRate: 1 });
    expect(m.avgCostPerTaskUsd).toBe(r.costUsd);
    expect(m.estimateError.samples).toBe(1);
  });
});

describe('percentile', () => {
  it('uses nearest rank', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(95);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
    expect(percentile([1, 2], 0)).toBe(1);
  });
});
