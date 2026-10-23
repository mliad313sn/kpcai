import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { costUsd, type ProviderAdapter } from '@kernelpai/core';
import { Journal } from '@kernelpai/journal';
import { MockAdapter, ProviderRegistry } from '@kernelpai/providers';
import { FallbackExecutor } from './executor.js';
import { OK, ScriptedAdapter, decision, mockDescriptor, node } from './test-helpers/fakes.js';

const PRICE = { inputPerMTok: 1, outputPerMTok: 2 };

let journal: Journal;
let sessionId: string;

beforeEach(() => {
  journal = Journal.open(':memory:');
  sessionId = journal.startSession('test', '/tmp');
});
afterEach(() => journal.close());

function executorFor(...adapters: ProviderAdapter[]): FallbackExecutor {
  const byId = new Map(adapters.map((a) => [a.descriptor.id, a]));
  let t = 0;
  return new FallbackExecutor((ref) => byId.get(ref.provider) as ProviderAdapter, journal, {
    now: () => (t += 10),
  });
}

function mock(id: string, failWith?: MockAdapter['behaviour']['failWith']): MockAdapter {
  const m = new MockAdapter(mockDescriptor(id));
  if (failWith) m.behaviour.failWith = failWith;
  return m;
}

const events = (): Array<[string, string | null, string | null]> =>
  journal.events({ sessionId }).map((e) => [e.type, e.provider, e.model]);

describe('FallbackExecutor — happy path', () => {
  it('serves from the chosen model and journals call then response with cost', async () => {
    const ex = executorFor(mock('a'), mock('b'));
    const r = await ex.execute(node(), decision('a/echo', 'b/echo'), { sessionId });
    expect(r.servedBy).toEqual({ provider: 'a', model: 'echo' });
    expect(r.fellBack).toBe(false);
    expect(r.stopReason).toBe('end');
    expect(r.text).toBe('[mock/echo] You asked: Explain the fallback policy please');
    expect(r.costUsd).toBe(costUsd(PRICE, r.usage));
    expect(r.attempts).toEqual([{ ref: r.servedBy, ok: true, durationMs: 10 }]);
    expect(events()).toEqual([
      ['call', 'a', 'echo'],
      ['response', 'a', 'echo'],
    ]);
    const [call, response] = journal.events({ sessionId });
    expect(call?.nodeId).toBe('n1');
    expect(call?.payload).toMatchObject({ attempt: 0, estimatedInputTokens: expect.any(Number) });
    expect(response?.costUsd).toBe(r.costUsd);
    expect(response?.payload).toMatchObject({
      requestId: call?.payload.requestId,
      usageBasis: 'reported',
      stopReason: 'end',
      text: r.text,
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
    });
    expect(journal.verify().ok).toBe(true);
  });

  it('passes maxOutputTokens and calls the hooks', async () => {
    const a = new ScriptedAdapter('a', [OK]);
    const onText = vi.fn();
    const onAttemptStart = vi.fn();
    await executorFor(a).execute(node({ maxOutputTokens: 99 }), decision('a/echo'), {
      sessionId,
      hooks: { onText, onAttemptStart },
    });
    expect(a.requests[0]?.maxOutputTokens).toBe(99);
    expect(onAttemptStart).toHaveBeenCalledWith({ provider: 'a', model: 'echo' }, 0);
    expect(onText.mock.calls.map((c) => c[0])).toEqual(['hello ', 'world']);
  });

  it('keeps a max_tokens stop and bills from estimates when no usage is reported', async () => {
    const a = new ScriptedAdapter('a', [[{ text: 'abcdefgh' }, { end: 'max_tokens' }]]);
    const r = await executorFor(a).execute(node(), decision('a/echo'), { sessionId });
    expect(r.stopReason).toBe('max_tokens');
    expect(r.usage.outputTokens).toBe(2);
    expect(journal.events({ sessionId })[1]?.payload.usageBasis).toBe('estimated');
  });
});

describe('FallbackExecutor — fallback', () => {
  it('429 then success: error + routing, then the fallback serves', async () => {
    const ex = executorFor(mock('a', 'rate_limit'), mock('b'));
    const onAttemptFailed = vi.fn();
    const r = await ex.execute(node(), decision('a/echo', 'b/echo'), {
      sessionId,
      hooks: { onAttemptFailed },
    });
    expect(r.servedBy).toEqual({ provider: 'b', model: 'echo' });
    expect(r.fellBack).toBe(true);
    expect(r.attempts.map((a) => [a.ok, a.errorKind])).toEqual([
      [false, 'rate_limit'],
      [true, undefined],
    ]);
    expect(onAttemptFailed).toHaveBeenCalledOnce();
    expect(events()).toEqual([
      ['call', 'a', 'echo'],
      ['error', 'a', 'echo'],
      ['routing', 'b', 'echo'],
      ['call', 'b', 'echo'],
      ['response', 'b', 'echo'],
    ]);
    const all = journal.events({ sessionId });
    expect(all.every((e) => e.nodeId === 'n1')).toBe(true);
    expect(all[1]?.payload).toMatchObject({ kind: 'rate_limit', partialText: '', attempt: 0 });
    expect(all[2]?.payload).toEqual({
      reason: 'fallback to b/echo after a/echo: rate_limit',
      fallbackFrom: 'a/echo',
      attempt: 1,
      kind: 'rate_limit',
    });
    expect(all[3]?.payload.attempt).toBe(1);
  });

  it('5xx twice then success on the third model', async () => {
    const a = new ScriptedAdapter('a', [[{ fail: 'unavailable', status: 503 }]]);
    const b = new ScriptedAdapter('b', [[{ fail: 'unavailable', status: 502 }]]);
    const c = new ScriptedAdapter('c', [OK]);
    const r = await executorFor(a, b, c).execute(node(), decision('a/echo', 'b/echo', 'c/echo'), {
      sessionId,
    });
    expect(r.servedBy?.provider).toBe('c');
    expect(r.text).toBe('hello world');
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
    expect(r.attempts).toHaveLength(3);
    const errs = journal.events({ sessionId }).filter((e) => e.type === 'error');
    expect(errs.map((e) => e.payload.status)).toEqual([503, 502]);
    const reasons = journal
      .events({ sessionId })
      .filter((e) => e.type === 'routing')
      .map((e) => e.payload.reason);
    expect(reasons).toEqual([
      'fallback to b/echo after a/echo: unavailable',
      'fallback to c/echo after b/echo: unavailable',
    ]);
  });

  it('auth stops immediately: no fallback is tried', async () => {
    const b = new ScriptedAdapter('b', [OK]);
    const r = await executorFor(mock('a', 'auth'), b).execute(
      node(),
      decision('a/echo', 'b/echo'),
      { sessionId },
    );
    expect(r.servedBy).toBeNull();
    expect(r.stopReason).toBe('other');
    expect(r.attempts).toEqual([
      expect.objectContaining({ ok: false, errorKind: 'auth', message: 'Simulated auth' }),
    ]);
    expect(b.calls).toBe(0);
    expect(events().map((e) => e[0])).toEqual(['call', 'error']);
  });

  it('all fail: returns no answer after trying every model', async () => {
    const ex = executorFor(mock('a', 'rate_limit'), mock('b', 'unavailable'));
    const r = await ex.execute(node(), decision('a/echo', 'b/echo'), { sessionId });
    expect(r).toMatchObject({ servedBy: null, text: '', costUsd: 0, fellBack: false });
    expect(r.attempts.map((a) => a.errorKind)).toEqual(['rate_limit', 'unavailable']);
    expect(events().map((e) => e[0])).toEqual(['call', 'error', 'routing', 'call', 'error']);
  });

  it('malformed (stream without end event) falls back', async () => {
    const a = new ScriptedAdapter('a', [[{ text: 'half' }]]);
    const r = await executorFor(a, mock('b')).execute(node(), decision('a/echo', 'b/echo'), {
      sessionId,
    });
    expect(r.servedBy?.provider).toBe('b');
    expect(r.attempts[0]?.errorKind).toBe('malformed');
    expect(r.attempts[0]?.message).toBe('Stream ended without an end event');
  });

  it('refusal (thrown or as stop reason) falls back; all refusing yields refusal', async () => {
    const a = new ScriptedAdapter('a', [[{ text: 'I cannot' }, { end: 'refusal' }]]);
    const r = await executorFor(a, mock('b', 'refusal')).execute(
      node(),
      decision('a/echo', 'b/echo'),
      { sessionId },
    );
    expect(r.servedBy).toBeNull();
    expect(r.stopReason).toBe('refusal');
    expect(r.attempts.map((x) => x.errorKind)).toEqual(['refusal', 'refusal']);
    expect(journal.events({ sessionId })[1]?.payload.partialText).toBe('I cannot');
  });

  it('failure after partial text: text discarded for the next attempt, kept in the journal', async () => {
    const a = new ScriptedAdapter('a', [[{ text: 'partial ' }, { fail: 'unavailable' }]]);
    const b = new ScriptedAdapter('b', [OK]);
    const onText = vi.fn();
    const r = await executorFor(a, b).execute(node(), decision('a/echo', 'b/echo'), {
      sessionId,
      hooks: { onText },
    });
    expect(r.text).toBe('hello world');
    expect(onText).toHaveBeenCalledWith('partial ', { provider: 'a', model: 'echo' });
    const err = journal.events({ sessionId }).find((e) => e.type === 'error');
    expect(err?.payload).toMatchObject({ partialText: 'partial ', kind: 'unavailable' });
    expect(b.requests[0]?.messages).toEqual(node().messages);
  });

  it('works with ProviderRegistry.get; an unknown provider stops as bad_request', async () => {
    const registry = new ProviderRegistry([mockDescriptor('a')], {});
    const ex = new FallbackExecutor((ref) => registry.get(ref.provider), journal);
    const r = await ex.execute(node(), decision('zz/echo', 'a/echo'), { sessionId });
    expect(r.servedBy).toBeNull();
    expect(r.attempts[0]?.errorKind).toBe('bad_request');
    expect(events()).toEqual([['error', 'zz', 'echo']]);
    const ok = await ex.execute(node(), decision('a/echo'), { sessionId });
    expect(ok.servedBy?.provider).toBe('a');
  });

  it('journals and rethrows non-provider errors', async () => {
    const a = new ScriptedAdapter('a', [[{ throwPlain: 'boom' }]]);
    await expect(
      executorFor(a, mock('b')).execute(node(), decision('a/echo', 'b/echo'), { sessionId }),
    ).rejects.toThrow('boom');
    expect(journal.events({ sessionId })[1]?.payload).toMatchObject({
      kind: 'internal',
      message: 'boom',
    });
  });
});

describe('FallbackExecutor — cancellation', () => {
  it('cancel mid-stream stops everything and keeps the partial text, billed from estimates', async () => {
    const a = new ScriptedAdapter('a', [[{ text: 'abcd' }, { hang: true }]]);
    const b = new ScriptedAdapter('b', [OK]);
    const ac = new AbortController();
    const r = await executorFor(a, b).execute(node(), decision('a/echo', 'b/echo'), {
      sessionId,
      signal: ac.signal,
      hooks: { onText: () => ac.abort() },
    });
    expect(r).toMatchObject({ text: 'abcd', stopReason: 'cancelled', fellBack: false });
    expect(r.servedBy).toEqual({ provider: 'a', model: 'echo' });
    expect(r.attempts[0]).toMatchObject({ ok: false, errorKind: 'cancelled' });
    expect(b.calls).toBe(0);
    const response = journal.events({ sessionId })[1];
    expect(response?.type).toBe('response');
    expect(response?.payload).toMatchObject({
      usageBasis: 'estimated',
      stopReason: 'cancelled',
      outputTokens: 1,
    });
    expect(response?.costUsd).toBeGreaterThan(0);
    expect(r.costUsd).toBe(response?.costUsd);
  });

  it('cancel mid-stream on a slow MockAdapter', async () => {
    const a = mock('a');
    a.behaviour.delayMs = 20;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const r = await executorFor(a, mock('b')).execute(node(), decision('a/echo', 'b/echo'), {
      sessionId,
      signal: ac.signal,
    });
    expect(r.stopReason).toBe('cancelled');
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.text.length).toBeLessThan(50);
    expect(events().map((e) => e[0])).toEqual(['call', 'response']);
  });

  it('keeps reported usage when the provider sent it before the cancel', async () => {
    const usage = { inputTokens: 7, outputTokens: 1 };
    const a = new ScriptedAdapter('a', [[{ text: 'x' }, { usage }, { hang: true }]]);
    const ac = new AbortController();
    const r = await executorFor(a).execute(node(), decision('a/echo'), {
      sessionId,
      signal: ac.signal,
      hooks: { onText: () => setTimeout(() => ac.abort(), 5) },
    });
    expect(r.usage).toEqual(usage);
    expect(journal.events({ sessionId })[1]?.payload.usageBasis).toBe('reported');
  });

  it('treats an adapter-reported cancelled stop as a cancellation', async () => {
    const a = new ScriptedAdapter('a', [[{ text: 'x' }, { end: 'cancelled' }]]);
    const b = new ScriptedAdapter('b', [OK]);
    const r = await executorFor(a, b).execute(node(), decision('a/echo', 'b/echo'), {
      sessionId,
    });
    expect(r.stopReason).toBe('cancelled');
    expect(b.calls).toBe(0);
  });

  it('a signal aborted before start sends nothing and journals nothing', async () => {
    const a = new ScriptedAdapter('a', [OK]);
    const ac = new AbortController();
    ac.abort();
    const r = await executorFor(a).execute(node(), decision('a/echo'), {
      sessionId,
      signal: ac.signal,
    });
    expect(r).toMatchObject({ servedBy: null, stopReason: 'cancelled', attempts: [] });
    expect(a.calls).toBe(0);
    expect(events()).toEqual([]);
  });

  it('a cancel between attempts stops before the fallback', async () => {
    const ac = new AbortController();
    const b = new ScriptedAdapter('b', [OK]);
    const r = await executorFor(mock('a', 'rate_limit'), b).execute(
      node(),
      decision('a/echo', 'b/echo'),
      { sessionId, signal: ac.signal, hooks: { onAttemptFailed: () => ac.abort() } },
    );
    expect(r.stopReason).toBe('cancelled');
    expect(b.calls).toBe(0);
  });
});
