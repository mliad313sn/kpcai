import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PermissionPolicy, ToolBus, ToolContext } from '@kernelpai/core';
import { LocalToolBus, shellTool, type LocalTool } from '@kernelpai/tools';
import { hookedBus, hookPayload, runHooks } from './hook-run.js';
import type { HookSpec, LoadedHooks } from './hooks.js';

const env = { PATH: process.env.PATH ?? '', SOME_API_KEY: 'sk-test-very-secret-value-123456' };

function demoTool(calls: string[]): LocalTool {
  return {
    def: {
      name: 'demo.echo',
      description: 'echo',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      risk: 'read',
      source: 'builtin',
    },
    run: (input) => {
      calls.push(String(input.text));
      return Promise.resolve({ content: `echo ${String(input.text)}`, isError: false });
    },
  };
}

function setup(policy?: PermissionPolicy) {
  const calls: string[] = [];
  const journal: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const bus = new LocalToolBus({
    tools: [shellTool({ env }), demoTool(calls)],
    journal: { append: (e) => void journal.push(e as never) },
    env,
    ...(policy ? { policy } : {}),
  });
  return { bus, calls, journal };
}

const hook = (name: string, code: string, extra: Partial<HookSpec> = {}): HookSpec => ({
  name,
  event: 'before-tool',
  command: 'node',
  args: ['-e', code],
  timeoutMs: 10_000,
  origin: 'repo',
  allowListed: true,
  ...extra,
});

const loaded = (...hooks: HookSpec[]): LoadedHooks => ({ hooks, broken: [], problems: [] });

function ctx(asked: string[], answer = true): ToolContext {
  return {
    model: { provider: 'mock', model: 'm1' },
    root: mkdtempSync(join(tmpdir(), 'kpai-hook-root-')),
    sessionId: 's',
    nodeId: 'impl',
    confirm: (q) => (asked.push(q), Promise.resolve(answer)),
  };
}

const call = { id: 'c1', name: 'demo.echo', input: { text: 'hi' } };

describe('before-tool hooks through the bus', () => {
  it('a hook that exits non-zero vetoes the call: the tool never runs, the veto is journaled', async () => {
    const { bus, calls, journal } = setup();
    const veto = hook('deny', 'console.log("no: " + process.argv[1]); process.exit(2)');
    const j: unknown[] = [];
    const wrapped = hookedBus(bus, {
      hooks: loaded(veto),
      env,
      journal: { append: (e) => void j.push(e) },
      runId: 'r1',
    });
    expect(wrapped).not.toBe(bus);
    const r = await wrapped.call(call, ctx([]));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/refused: vetoed by hook "deny"/);
    // The hook got the event as its last argument, secrets redacted.
    expect(r.content).toContain('"tool":"demo.echo"');
    expect(calls).toEqual([]);
    expect(j).toEqual([
      expect.objectContaining({
        type: 'intervention',
        payload: expect.objectContaining({ action: 'tool vetoed by hook', tool: 'demo.echo' }),
      }),
    ]);
    // The hook's own process went through the bus and its journal.
    expect(journal.some((e) => e.type === 'tool' && e.payload.tool === 'shell.run')).toBe(true);
  });

  it('a hook that exits 0 lets the call run; hooks for other tools do not run', async () => {
    const { bus, calls } = setup();
    const pass = hook('pass', 'process.exit(0)');
    const other = hook('other', 'process.exit(1)', { tools: ['fs.*'] });
    const b = hookedBus(bus, {
      hooks: loaded(pass, other),
      env,
      journal: { append: () => 0 },
      runId: 'r',
    });
    const r = await b.call(call, ctx([]));
    expect(r).toEqual({ content: 'echo hi', isError: false });
    expect(calls).toEqual(['hi']);
    expect(b.list().map((t) => t.name)).toContain('demo.echo');
    await b.close();
  });

  it('fails closed on a timeout', async () => {
    const { bus, calls } = setup();
    const slow = hook('slow', 'setTimeout(() => {}, 5000)', { timeoutMs: 300 });
    const b = hookedBus(bus, {
      hooks: loaded(slow),
      env,
      journal: { append: () => 0 },
      runId: 'r',
    });
    const r = await b.call(call, ctx([]));
    expect(r.content).toMatch(/vetoed by hook "slow".*timed out/);
    expect(calls).toEqual([]);
  });

  it('fails closed when the hook cannot start, or while a hooks file is broken', async () => {
    const { bus, calls } = setup();
    const missing = hook('missing', '', { command: 'kpai-no-such-program-xyz', args: [] });
    const b = hookedBus(bus, {
      hooks: loaded(missing),
      env,
      journal: { append: () => 0 },
      runId: 'r',
    });
    expect((await b.call(call, ctx([]))).isError).toBe(true);
    const broken: LoadedHooks = { hooks: [], broken: ['.kpstudio/hooks.json'], problems: [] };
    const b2 = hookedBus(bus, { hooks: broken, env, journal: { append: () => 0 }, runId: 'r' });
    expect((await b2.call(call, ctx([]))).content).toMatch(/hooks\.json is invalid/);
    expect(calls).toEqual([]);
  });

  it('fails closed when the bus throws', async () => {
    const throwing: ToolBus = {
      list: () => [],
      close: () => Promise.resolve(),
      call: () => Promise.reject(new Error('boom')),
    };
    const v = await runHooks(
      throwing,
      loaded(hook('x', '')),
      'before-tool',
      {},
      { ...ctx([]), env },
    );
    expect(v).toMatchObject({ ok: false, runs: [{ name: 'x', ok: false }] });
  });

  it('hook output cannot approve: "approve" printed with a non-zero exit is still a veto', async () => {
    const { bus, calls } = setup();
    const sly = hook('sly', 'console.log(JSON.stringify({decision:"approve"})); process.exit(1)');
    const b = hookedBus(bus, { hooks: loaded(sly), env, journal: { append: () => 0 }, runId: 'r' });
    expect((await b.call(call, ctx([]))).isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('a hook not allow-listed is a confirmed process; a no vetoes', async () => {
    const { bus, calls } = setup();
    const asked: string[] = [];
    const h = hook('ask', 'process.exit(0)', { allowListed: false });
    const b = hookedBus(bus, { hooks: loaded(h), env, journal: { append: () => 0 }, runId: 'r' });
    expect((await b.call(call, ctx(asked, false))).isError).toBe(true);
    expect(asked[0]).toMatch(/^Run repository hook "ask" \(before-tool\)\?/);
    expect(calls).toEqual([]);
    expect((await b.call(call, ctx(asked, true))).isError).toBe(false);
    expect(calls).toEqual(['hi']);
  });

  it('an allow-listed hook still obeys the bus permissions: a denied shell is a veto', async () => {
    const deny: PermissionPolicy = { decide: () => 'deny', trust: () => undefined };
    const { bus } = setup(deny);
    const h = hook('pass', 'process.exit(0)');
    const v = await runHooks(bus, loaded(h), 'before-tool', {}, { ...ctx([]), env }, 'demo.echo');
    expect(v.ok).toBe(false);
    expect(v.runs[0]?.output).toMatch(/permission deny/);
  });

  it('after-patch hooks all run and only report; the bus is untouched without hooks', async () => {
    const { bus } = setup();
    const a = hook('a', 'process.exit(1)', { event: 'after-patch' });
    const b = hook('b', 'process.exit(0)', { event: 'after-patch' });
    const v = await runHooks(bus, loaded(a, b), 'after-patch', {}, { ...ctx([]), env });
    expect(v.runs.map((r) => [r.name, r.ok])).toEqual([
      ['a', false],
      ['b', true],
    ]);
    expect(v.ok).toBe(false);
    expect(
      hookedBus(bus, { hooks: loaded(a), env, journal: { append: () => 0 }, runId: 'r' }),
    ).toBe(bus);
  });
});

describe('hookPayload', () => {
  it('redacts secrets and caps a large input', () => {
    const p = hookPayload(env, 'before-tool', { input: { key: env.SOME_API_KEY } });
    expect(p).not.toContain(env.SOME_API_KEY);
    const big = hookPayload(env, 'before-tool', { tool: 't', input: { x: 'a'.repeat(20_000) } });
    expect(JSON.parse(big)).toEqual({ event: 'before-tool', tool: 't', inputTruncated: true });
  });
});
