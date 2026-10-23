import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Journal } from '@kernelpai/journal';
import { FallbackExecutor } from './executor.js';
import { OK, ScriptedAdapter, decision, node } from './test-helpers/fakes.js';

let journal: Journal;
let sessionId: string;
beforeEach(() => {
  journal = Journal.open(':memory:');
  sessionId = journal.startSession('t', '/tmp');
});
afterEach(() => journal.close());

const TOOLS = [{ name: 'fs.read', description: 'read', inputSchema: { type: 'object' } }];
const CALL = { id: 'c1', name: 'fs.read', input: { path: 'a' } };

describe('tools and tags (phase 2)', () => {
  it('sends tools, returns tool calls and journals them with the tags', async () => {
    const a = new ScriptedAdapter('a', [
      [
        { text: 'looking' },
        { toolCall: CALL },
        { usage: { inputTokens: 1, outputTokens: 1 } },
        { end: 'tool_use' },
      ],
    ]);
    const ex = new FallbackExecutor(() => a, journal);
    const r = await ex.execute(node(), decision('a/echo'), {
      sessionId,
      tools: TOOLS,
      tags: { role: 'author' },
    });
    expect(a.requests[0]?.tools).toEqual(TOOLS);
    expect(r.stopReason).toBe('tool_use');
    expect(r.toolCalls).toEqual([CALL]);
    const ev = journal.events({ sessionId });
    expect(ev.map((e) => [e.type, e.payload['role']])).toEqual([
      ['call', 'author'],
      ['response', 'author'],
    ]);
    expect(ev[1]?.payload['toolCalls']).toEqual([CALL]);
  });

  it('omits empty tools, tags fallbacks and failed attempts, and returns no calls on failure', async () => {
    const a = new ScriptedAdapter('a', [[{ fail: 'unavailable' }]]);
    const b = new ScriptedAdapter('b', [OK]);
    const ex = new FallbackExecutor((ref) => (ref.provider === 'a' ? a : b), journal);
    const r = await ex.execute(node(), decision('a/echo', 'b/echo'), {
      sessionId,
      tools: [],
      tags: { role: 'critic' },
    });
    expect(a.requests[0]?.tools).toBeUndefined();
    expect(r.toolCalls).toEqual([]);
    const ev = journal.events({ sessionId });
    expect(ev.every((e) => e.payload['role'] === 'critic')).toBe(true);
    expect(ev.map((e) => e.type)).toEqual(['call', 'error', 'routing', 'call', 'response']);
    const none = await new FallbackExecutor(() => a, journal).execute(node(), decision('a/echo'), {
      sessionId,
    });
    expect(none.toolCalls).toEqual([]);
    expect(journal.events({ sessionId }).at(-1)?.payload['role']).toBeUndefined();
  });

  it('tags the policy-skip intervention', async () => {
    const a = new ScriptedAdapter('a', [[{ fail: 'unavailable' }]]);
    const ex = new FallbackExecutor(() => a, journal);
    await ex.execute(node(), decision('a/echo', 'a/echo'), {
      sessionId,
      tags: { role: 'voter' },
      hooks: { beforeFallback: () => false },
    });
    const iv = journal.events({ sessionId }).find((e) => e.type === 'intervention');
    expect(iv?.payload['role']).toBe('voter');
  });
});
