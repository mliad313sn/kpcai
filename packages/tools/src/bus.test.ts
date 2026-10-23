import type { PermissionPolicy } from '@kernelpai/core';
import { Journal } from '@kernelpai/journal';
import { describe, expect, it, vi } from 'vitest';
import { LocalToolBus } from './bus.js';
import { JailError } from './paths.js';
import { call, makeCtx, RecordingJournal } from './test-helpers/ctx.js';
import { fail, ok, ToolError, type LocalTool } from './types.js';

const SECRET = 'very-secret-value-123456';

function tool(over: Partial<LocalTool> & { name?: string } = {}): LocalTool {
  return {
    def: {
      name: over.name ?? 'demo.echo',
      description: 'echo',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      risk: 'read',
      source: 'builtin',
    },
    run: async (input) => ok(String(input.text), { length: String(input.text).length }),
    ...over,
  };
}

function bus(
  tools: LocalTool[],
  extra: { policy?: PermissionPolicy; maxResultBytes?: number } = {},
) {
  const journal = new RecordingJournal();
  const b = new LocalToolBus({ tools, journal, env: { DEMO_API_KEY: SECRET }, ...extra });
  return { b, journal };
}

describe('LocalToolBus', () => {
  it('lists tools and runs a valid call', async () => {
    const { b, journal } = bus([tool()]);
    expect(b.list().map((d) => d.name)).toEqual(['demo.echo']);
    const res = await b.call(call('demo.echo', { text: 'hi' }), makeCtx('/ws'));
    expect(res).toEqual({ content: 'hi', isError: false });
    const e = journal.last();
    expect(e).toMatchObject({
      type: 'tool',
      sessionId: 's1',
      nodeId: 'n1',
      provider: 'mock',
      model: 'm1',
    });
    expect(e.payload).toMatchObject({
      tool: 'demo.echo',
      source: 'builtin',
      risk: 'read',
      decision: 'allow',
      isError: false,
      truncated: false,
      meta: { length: 2 },
      input: { text: 'hi' },
      result: { preview: 'hi', chars: 2 },
    });
    expect(typeof e.payload.durationMs).toBe('number');
  });

  it('returns validation errors as isError results, never throws', async () => {
    const run = vi.fn();
    const { b, journal } = bus([tool({ run })]);
    for (const input of [{ text: 1 }, {}, 'text', null, { text: 'a', extra: 1 }]) {
      const res = await b.call(call('demo.echo', input), makeCtx('/ws'));
      expect(res.isError).toBe(true);
      expect(res.content).toMatch(/^invalid input for demo\.echo/);
    }
    expect(run).not.toHaveBeenCalled();
    expect(journal.last().payload.decision).toBe('invalid');
  });

  it('reports unknown tools and cancelled calls', async () => {
    const { b, journal } = bus([tool()]);
    expect(await b.call(call('nope.tool', {}), makeCtx('/ws'))).toEqual({
      content: 'unknown tool: nope.tool',
      isError: true,
    });
    expect(journal.last().payload).toMatchObject({ decision: 'unknown', risk: null });
    const ac = new AbortController();
    ac.abort();
    const res = await b.call(
      call('demo.echo', { text: 'x' }),
      makeCtx('/ws', { signal: ac.signal }),
    );
    expect(res.content).toMatch(/cancelled/);
  });

  it('refuses a call cancelled while its confirmation was pending (review P3-F2)', async () => {
    const run = vi.fn(async () => ok('written'));
    const { b, journal } = bus([tool({ run, def: { ...tool().def, risk: 'write' } })]);
    const ac = new AbortController();
    // The user cancels the run while the question is on screen, then clicks yes.
    const confirm = async (): Promise<boolean> => (ac.abort(), true);
    const res = await b.call(
      call('demo.echo', { text: 'x' }),
      makeCtx('/ws', { signal: ac.signal, confirm }),
    );
    expect(res).toMatchObject({ isError: true, content: expect.stringMatching(/cancelled/) });
    expect(run).not.toHaveBeenCalled();
    expect(journal.last().payload.decision).toBe('cancelled');
  });

  it('turns tool failures into isError results', async () => {
    const thrower = (err: unknown) => tool({ run: async () => Promise.reject(err) });
    for (const [err, re] of [
      [new JailError('path is outside the workspace: x'), /^path is outside/],
      [new ToolError('bad patch'), /^bad patch$/],
      [new Error('kaboom \x1b[2J'), /^tool failed: kaboom $/],
      ['plain string', /^tool failed: plain string$/],
    ] as const) {
      const { b } = bus([thrower(err)]);
      const res = await b.call(call('demo.echo', { text: 'x' }), makeCtx('/ws'));
      expect(res.isError).toBe(true);
      expect(res.content).toMatch(re);
    }
    const { b } = bus([tool({ run: async () => fail('nope', { code: 2 }) })]);
    expect(await b.call(call('demo.echo', { text: 'x' }), makeCtx('/ws'))).toEqual({
      content: 'nope',
      isError: true,
    });
  });

  it('truncates results and journals only a preview', async () => {
    const big = 'y'.repeat(5000);
    const { b, journal } = bus([tool({ run: async () => ok(big) })], { maxResultBytes: 1000 });
    const res = await b.call(call('demo.echo', { text: big }), makeCtx('/ws'));
    expect(Buffer.byteLength(res.content)).toBeLessThan(1100);
    expect(res.content).toMatch(/\[truncated: 4000 more bytes\]$/);
    const payload = JSON.stringify(journal.last().payload);
    expect(payload).not.toContain(big);
    expect(journal.last().payload.truncated).toBe(true);
    expect(journal.last().payload.input).toMatchObject({ text: { chars: 5000 } });
  });

  it('redacts secrets from results, journal and confirmation questions', async () => {
    const leak = tool({
      def: { ...tool().def, risk: 'destructive' },
      run: async () => ok(`token=${SECRET} key=sk-${'z'.repeat(30)}`),
    });
    const { b, journal } = bus([leak]);
    const ctx = makeCtx('/ws', { answers: [true] });
    const res = await b.call(call('demo.echo', { text: `use ${SECRET}` }), ctx);
    expect(res.content).toBe('token=[redacted] key=[redacted]');
    expect(JSON.stringify(journal.events)).not.toContain(SECRET);
    expect(ctx.questions[0]).toContain('[redacted]');
    expect(ctx.questions[0]).not.toContain(SECRET);
  });

  it('uses per-call risk and forced confirmation', async () => {
    const run = vi.fn(async () => ok('ran'));
    const t = tool({ riskFor: () => 'write', alwaysConfirm: () => true, run });
    const { b, journal } = bus([t]);
    const ctx = makeCtx('/ws', { answers: [true, false] });
    expect((await b.call(call('demo.echo', { text: 'a' }), ctx)).isError).toBe(false);
    expect(journal.last().payload.risk).toBe('write');
    // A forced confirmation still asks after the policy has allowed the batch.
    expect((await b.call(call('demo.echo', { text: 'a' }), ctx)).isError).toBe(true);
    expect(ctx.questions).toHaveLength(2);
    expect(ctx.questions[0]).toMatch(/^Allow demo\.echo \(write\) for mock\/m1 on node n1\?/);
  });

  it('survives a throwing policy and a throwing journal', async () => {
    const policy: PermissionPolicy = {
      decide: () => {
        throw new Error('policy bug');
      },
      trust: () => undefined,
    };
    const b = new LocalToolBus({
      tools: [tool()],
      policy,
      journal: {
        append: () => {
          throw new Error('disk full');
        },
      },
    });
    const res = await b.call(call('demo.echo', { text: 'a' }), makeCtx('/ws'));
    expect(res).toEqual({ content: 'permission deny: demo.echo is not permitted', isError: true });
  });

  it('refuses duplicate names and closes MCP connections', async () => {
    const close = vi.fn(async () => undefined);
    const b = new LocalToolBus({
      tools: [tool()],
      mcp: [{ server: 's', tools: [tool({ name: 'mcp.s.x' })], skipped: [], close }],
    });
    expect(() => b.register(tool())).toThrow(/already registered/);
    expect(b.list()).toHaveLength(2);
    await b.close();
    await b.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('shows what prepare() describes, sanitised, redacted and capped at 20 lines', async () => {
    const t = tool({
      def: { ...tool().def, risk: 'destructive' },
      prepare: async () => ({
        summary: `write x.txt \x1b[2J(${SECRET})`,
        preview: Array.from({ length: 30 }, (_, i) => `line ${i}\x07`).join('\n'),
      }),
    });
    const { b } = bus([t]);
    const ctx = makeCtx('/ws', { answers: [true] });
    await b.call(call('demo.echo', { text: 'a' }), ctx);
    const q = ctx.questions[0] as string;
    expect(q).toMatch(
      /^Allow demo\.echo \(destructive\) for mock\/m1 on node n1\?\nwrite x\.txt \(\[redacted\]\)\nline 0\n/,
    );
    expect(q).toContain('line 19\n… (10 more lines)');
    expect(q).not.toContain('line 20');
    // eslint-disable-next-line no-control-regex
    expect(q).not.toMatch(/[\x07\x1b]/);
  });

  it('refuses without asking when prepare() fails', async () => {
    const run = vi.fn();
    for (const [err, re] of [
      [new ToolError('bad patch'), /^bad patch$/],
      [new Error('crash'), /^tool failed: crash$/],
    ] as const) {
      const t = tool({
        def: { ...tool().def, risk: 'write' },
        prepare: () => Promise.reject(err),
        run,
      });
      const { b, journal } = bus([t]);
      const ctx = makeCtx('/ws', { answers: [true] });
      const res = await b.call(call('demo.echo', { text: 'a' }), ctx);
      expect(res).toEqual({ content: expect.stringMatching(re), isError: true });
      expect(ctx.questions).toHaveLength(0);
      expect(journal.last().payload.decision).toBe('refused');
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('writes hash-chained tool events into the real journal', async () => {
    const journal = Journal.open(':memory:');
    const sessionId = journal.startSession('tools', '/ws');
    const b = new LocalToolBus({ tools: [tool()], journal });
    await b.call(call('demo.echo', { text: 'hi' }), makeCtx('/ws', { sessionId }));
    const events = journal.events({ sessionId });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('tool');
    expect(events[0]?.payload.decision).toBe('allow');
    expect(journal.verify().ok).toBe(true);
  });
});
