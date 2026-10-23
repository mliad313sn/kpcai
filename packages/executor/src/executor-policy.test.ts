import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { costUsd, type ProviderAdapter } from '@kernelpai/core';
import { Journal } from '@kernelpai/journal';
import { FallbackExecutor, type FallbackExecutorOptions } from './executor.js';
import { OK, ScriptedAdapter, decision, node } from './test-helpers/fakes.js';

const PRICE = { inputPerMTok: 1, outputPerMTok: 2 };
const A = { provider: 'a', model: 'echo' };
const B = { provider: 'b', model: 'echo' };

let journal: Journal;
let sessionId: string;

beforeEach(() => {
  journal = Journal.open(':memory:');
  sessionId = journal.startSession('test', '/tmp');
});
afterEach(() => journal.close());

function executorFor(
  adapters: ProviderAdapter[],
  options: FallbackExecutorOptions = {},
): FallbackExecutor {
  const byId = new Map(adapters.map((a) => [a.descriptor.id, a]));
  return new FallbackExecutor((ref) => byId.get(ref.provider) as ProviderAdapter, journal, options);
}

const types = (): string[] => journal.events({ sessionId }).map((e) => e.type);
const ofType = (t: string) => journal.events({ sessionId }).filter((e) => e.type === t);

describe('FallbackExecutor — beforeFallback policy (F1)', () => {
  const failing = (): ScriptedAdapter => new ScriptedAdapter('a', [[{ fail: 'rate_limit' }]]);

  it('is called with the next candidate and the failed attempt; true continues', async () => {
    const b = new ScriptedAdapter('b', [OK]);
    const beforeFallback = vi.fn(() => Promise.resolve(true));
    const d = decision('a/echo', 'b/echo');
    const r = await executorFor([failing(), b]).execute(node(), d, {
      sessionId,
      hooks: { beforeFallback },
    });
    expect(beforeFallback).toHaveBeenCalledOnce();
    expect(beforeFallback).toHaveBeenCalledWith(
      d.fallbacks[0],
      expect.objectContaining({ ref: A, ok: false, errorKind: 'rate_limit' }),
    );
    expect(r.servedBy).toEqual(B);
    expect(types()).toEqual(['call', 'error', 'routing', 'call', 'response']);
  });

  it('false on the only fallback journals an intervention and returns no answer', async () => {
    const b = new ScriptedAdapter('b', [OK]);
    const r = await executorFor([failing(), b]).execute(node(), decision('a/echo', 'b/echo'), {
      sessionId,
      hooks: { beforeFallback: () => false },
    });
    expect(b.calls).toBe(0);
    expect(r).toMatchObject({ servedBy: null, stopReason: 'other', text: '', fellBack: false });
    expect(r.attempts).toHaveLength(1);
    expect(types()).toEqual(['call', 'error', 'intervention']);
    const [iv] = ofType('intervention');
    expect(iv).toMatchObject({ nodeId: 'n1', provider: 'b', model: 'echo' });
    expect(iv?.payload).toEqual({
      action: 'fallback skipped by policy',
      next: 'b/echo',
      after: 'a/echo',
    });
  });

  it('skips a refused fallback and tries the next affordable one (review N1)', async () => {
    const b = new ScriptedAdapter('b', [OK]);
    const c = new ScriptedAdapter('c', [OK]);
    const asked: string[] = [];
    const r = await executorFor([failing(), b, c]).execute(
      node(),
      decision('a/echo', 'b/echo', 'c/echo'),
      {
        sessionId,
        hooks: {
          beforeFallback: (next) => {
            asked.push(next.ref.provider);
            return next.ref.provider !== 'b';
          },
        },
      },
    );
    expect(asked).toEqual(['b', 'c']);
    expect(b.calls).toBe(0);
    expect(r).toMatchObject({ servedBy: { provider: 'c', model: 'echo' }, fellBack: true });
    expect(types()).toEqual(['call', 'error', 'intervention', 'routing', 'call', 'response']);
    expect(ofType('routing')[0]?.payload).toMatchObject({ fallbackFrom: 'a/echo' });
  });

  it('a stop after a refusal still reports other, not refusal', async () => {
    const a = new ScriptedAdapter('a', [[{ fail: 'refusal' }]]);
    const r = await executorFor([a, new ScriptedAdapter('b', [OK])]).execute(
      node(),
      decision('a/echo', 'b/echo'),
      { sessionId, hooks: { beforeFallback: () => false } },
    );
    expect(r.stopReason).toBe('other');
  });

  it('a throwing hook counts as false and journals the message', async () => {
    const b = new ScriptedAdapter('b', [OK]);
    const r = await executorFor([failing(), b]).execute(node(), decision('a/echo', 'b/echo'), {
      sessionId,
      hooks: {
        beforeFallback: () => {
          throw new Error('budget says no');
        },
      },
    });
    expect(r.servedBy).toBeNull();
    expect(b.calls).toBe(0);
    expect(ofType('intervention')[0]?.payload).toMatchObject({ error: 'budget says no' });
  });

  it('a rejected promise is journaled too', async () => {
    const r = await executorFor([failing(), new ScriptedAdapter('b', [OK])]).execute(
      node(),
      decision('a/echo', 'b/echo'),
      { sessionId, hooks: { beforeFallback: () => Promise.reject('nope') } },
    );
    expect(r.servedBy).toBeNull();
    expect(ofType('intervention')[0]?.payload.error).toBe('nope');
  });

  it('is not called for the first attempt, on success, or without a fallback', async () => {
    const beforeFallback = vi.fn(() => true);
    const hooks = { beforeFallback };
    await executorFor([new ScriptedAdapter('a', [OK])]).execute(
      node(),
      decision('a/echo', 'b/echo'),
      { sessionId, hooks },
    );
    await executorFor([failing()]).execute(node(), decision('a/echo'), { sessionId, hooks });
    const auth = new ScriptedAdapter('a', [[{ fail: 'auth' }]]);
    await executorFor([auth]).execute(node(), decision('a/echo', 'b/echo'), { sessionId, hooks });
    expect(beforeFallback).not.toHaveBeenCalled();
  });
});

describe('FallbackExecutor — failed attempts are billed (F3)', () => {
  it('bills reported usage on the error event and totals cost over attempts', async () => {
    const usage = { inputTokens: 100, outputTokens: 50 };
    const a = new ScriptedAdapter('a', [[{ text: 'part' }, { usage }, { fail: 'unavailable' }]]);
    const r = await executorFor([a, new ScriptedAdapter('b', [OK])]).execute(
      node(),
      decision('a/echo', 'b/echo'),
      { sessionId },
    );
    const [err] = ofType('error');
    expect(err?.costUsd).toBe(costUsd(PRICE, usage));
    expect(err?.payload).toMatchObject({ ...usage, usageBasis: 'reported' });
    const resp = ofType('response')[0];
    expect(r.costUsd).toBe(0.000218);
    expect(r.costUsd).toBeCloseTo((err?.costUsd ?? 0) + (resp?.costUsd ?? 0), 9);
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it('bills estimated usage when text streamed without usage', async () => {
    const a = new ScriptedAdapter('a', [[{ text: 'abcdefgh' }, { fail: 'unavailable' }]]);
    const r = await executorFor([a]).execute(node(), decision('a/echo'), { sessionId });
    const [call] = ofType('call');
    const [err] = ofType('error');
    const input = call?.payload.estimatedInputTokens as number;
    expect(err?.payload).toMatchObject({
      inputTokens: input,
      outputTokens: 2,
      usageBasis: 'estimated',
    });
    expect(err?.costUsd).toBe(costUsd(PRICE, { inputTokens: input, outputTokens: 2 }));
    expect(r).toMatchObject({ servedBy: null, costUsd: err?.costUsd });
  });

  it('bills nothing when nothing was streamed', async () => {
    const a = new ScriptedAdapter('a', [[{ fail: 'unavailable' }]]);
    const r = await executorFor([a]).execute(node(), decision('a/echo'), { sessionId });
    const [err] = ofType('error');
    expect(err?.costUsd).toBeNull();
    expect(err?.payload).not.toHaveProperty('usageBasis');
    expect(r.costUsd).toBe(0);
  });
});

describe('FallbackExecutor — stall timeouts (F4)', () => {
  const fast = { firstChunkTimeoutMs: 50, idleTimeoutMs: 50 };

  it('no first chunk: the attempt fails as unavailable and the next model answers', async () => {
    const a = new ScriptedAdapter('a', [[{ hang: true }]]);
    const r = await executorFor([a, new ScriptedAdapter('b', [OK])], fast).execute(
      node(),
      decision('a/echo', 'b/echo'),
      { sessionId },
    );
    expect(r.servedBy).toEqual(B);
    expect(r.attempts[0]).toMatchObject({
      errorKind: 'unavailable',
      message: 'no output for 50ms',
    });
    expect(ofType('error')[0]?.payload).toMatchObject({ kind: 'unavailable' });
    expect(ofType('routing')[0]?.payload.reason).toBe(
      'fallback to b/echo after a/echo: unavailable',
    );
  });

  it('idle mid-stream: falls back and bills the partial text', async () => {
    const a = new ScriptedAdapter('a', [[{ text: 'abcd' }, { hang: true }]]);
    const r = await executorFor([a, new ScriptedAdapter('b', [OK])], {
      firstChunkTimeoutMs: 0,
      idleTimeoutMs: 40,
    }).execute(node(), decision('a/echo', 'b/echo'), { sessionId });
    expect(r.text).toBe('hello world');
    const [err] = ofType('error');
    expect(err?.payload).toMatchObject({
      kind: 'unavailable',
      message: 'no output for 40ms',
      partialText: 'abcd',
      usageBasis: 'estimated',
    });
  });

  it('a user cancel during a stream is still a cancel, not a timeout', async () => {
    const a = new ScriptedAdapter('a', [[{ text: 'x' }, { hang: true }]]);
    const b = new ScriptedAdapter('b', [OK]);
    const ac = new AbortController();
    const r = await executorFor([a, b], { firstChunkTimeoutMs: 1000, idleTimeoutMs: 1000 }).execute(
      node(),
      decision('a/echo', 'b/echo'),
      { sessionId, signal: ac.signal, hooks: { onText: () => setTimeout(() => ac.abort(), 5) } },
    );
    expect(r.stopReason).toBe('cancelled');
    expect(b.calls).toBe(0);
    expect(types()).toEqual(['call', 'response']);
  });
});

describe('FallbackExecutor — call estimates (F7a)', () => {
  it('journals expected and max cost, expected output and task type (heuristic)', async () => {
    await executorFor([new ScriptedAdapter('a', [OK])]).execute(node(), decision('a/echo'), {
      sessionId,
    });
    const p = ofType('call')[0]?.payload ?? {};
    const input = p.estimatedInputTokens as number;
    expect(p).toMatchObject({
      taskType: 'analysis',
      estimatedOutputTokens: 1024,
      estimateBasis: 'heuristic',
      estimatedCostUsd: costUsd(PRICE, { inputTokens: input, outputTokens: 1024 }),
      estimatedMaxCostUsd: costUsd(PRICE, { inputTokens: input, outputTokens: 4096 }),
    });
  });

  it('uses expectedOutput for the expected cost', async () => {
    const expectedOutput = vi.fn(() => 100.4);
    await executorFor([new ScriptedAdapter('a', [OK])], { expectedOutput }).execute(
      node({ type: 'code' }),
      decision('a/echo'),
      { sessionId },
    );
    expect(expectedOutput).toHaveBeenCalledWith(A, 'code');
    const p = ofType('call')[0]?.payload ?? {};
    expect(p).toMatchObject({
      taskType: 'code',
      estimatedOutputTokens: 101,
      estimateBasis: 'calibrated',
      estimatedCostUsd: costUsd(PRICE, {
        inputTokens: p.estimatedInputTokens as number,
        outputTokens: 101,
      }),
    });
  });
});
