import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REQ, recordingHost } from '../../kernel/src/test-helpers/fixture.js';
import { startServer, type KernelServer } from './server.js';
import { connect, type Note, type TestClient } from './test-helpers/client.js';

const servers: KernelServer[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.close();
});

const OPTIONS = { allowTest: true };

async function boot(
  env: Record<string, string>,
  confirmTimeoutMs = 3000,
  defaults?: { allowTest?: boolean },
) {
  const host = recordingHost(env);
  const server = await startServer({
    kernel: { env: host.env, cwd: host.cwd },
    confirmTimeoutMs,
    serverFile: false,
    ...(defaults ? { defaults } : {}),
  });
  servers.push(server);
  const c = await connect(`ws://127.0.0.1:${server.port}/rpc`, { token: server.token });
  clients.push(c);
  return { host, server, c };
}

const isRun = (method: string, runId: string) => (n: Note) =>
  n.method === method && n.params.runId === runId;

describe('kernel server: runs', () => {
  it('plan → run.start → events → run.done, with reasons, tokens and the patches', async () => {
    const { c } = await boot({ KPAI_CONFIRM_ABOVE_USD: '100' });
    const plan = (await c.call('plan', { request: REQ, options: OPTIONS })).result as {
      planId: string;
      estimate: { band: { lowUsd: number }; nodes: Array<{ reason?: string }> };
    };
    expect(plan.estimate.band.lowUsd).toBeGreaterThanOrEqual(0);
    expect(plan.estimate.nodes.some((n) => n.reason)).toBe(true);
    const start = await c.call('run.start', { request: REQ, planId: plan.planId });
    const { runId } = start.result as { runId: string };
    const done = await c.waitFor(isRun('run.done', runId));
    expect((done.params.patches as unknown[]).length).toBe(2);
    const order = c.notes.filter((n) => n.params.runId === runId).map((n) => n.method);
    expect(order[0]).toBe('run.planned');
    expect(order).toContain('run.event');
    const events = c.notes
      .filter(isRun('run.event', runId))
      .map((n) => n.params.event as Record<string, unknown>);
    expect(events.some((e) => e.type === 'node_state' && typeof e.reason === 'string')).toBe(true);
    expect(events.some((e) => e.type === 'contribution' && e.usage)).toBe(true);
    await c.waitFor((n) => n.method === 'run.state' && n.params.state === 'done');
    expect(await c.call('run.pause', { runId })).toMatchObject({ error: { code: -32003 } });
  });

  it('confirms through confirm.request / confirm.answer, patches with their diff', async () => {
    const { host, c } = await boot({ KPAI_CONFIRM_ABOVE_USD: '0' });
    const seen: Note[] = [];
    c.onNote = (n) => {
      if (n.method !== 'confirm.request') return;
      seen.push(n);
      void c.call('confirm.answer', { confirmId: n.params.confirmId, ok: true });
    };
    const options = { ...OPTIONS, isolated: false };
    const { runId } = (await c.call('run.start', { request: REQ, options })).result as {
      runId: string;
    };
    await c.waitFor(isRun('run.done', runId));
    expect(seen[0]?.params).toMatchObject({ kind: 'budget', runId, timeoutMs: 3000 });
    const applied = await c.call('patches.apply', { runId, nodeIds: ['implementation'] });
    expect(applied.result).toEqual({
      results: [expect.objectContaining({ nodeId: 'implementation', ok: true })],
    });
    const patch = seen.find((n) => n.params.kind === 'patch');
    expect(patch?.params).toMatchObject({
      risk: 'write',
      patch: expect.stringMatching(/^diff --git/),
    });
    expect(patch?.params.question).toMatch(/git\.apply/);
    expect(existsSync(join(host.cwd, 'src/s.ts'))).toBe(true);
  });

  it('treats no answer before the timeout as "no": the run does not start', async () => {
    const { c } = await boot({ KPAI_CONFIRM_ABOVE_USD: '0' }, 150);
    const { runId } = (await c.call('run.start', { request: REQ, options: OPTIONS })).result as {
      runId: string;
    };
    const ask = await c.waitFor((n) => n.method === 'confirm.request');
    await c.waitFor((n) => n.method === 'run.state' && n.params.state === 'cancelled');
    const log = await c.waitFor(
      (n) => n.method === 'log' && /not run/.test(String(n.params.message)),
    );
    expect(log.params.level).toBe('warn');
    expect(
      await c.call('confirm.answer', { confirmId: ask.params.confirmId, ok: true }),
    ).toMatchObject({
      result: { accepted: false },
    });
    expect(await c.call('patches.apply', { runId })).toMatchObject({ error: { code: -32003 } });
  });

  it('validates edited plans and refuses runs outside a project', async () => {
    const { host, c } = await boot({ KPAI_CONFIRM_ABOVE_USD: '100' });
    const plan = (await c.call('plan', { request: REQ, options: OPTIONS })).result as {
      planId: string;
      graph: { nodes: Array<Record<string, unknown>> };
    };
    const nodes = plan.graph.nodes.map((n) =>
      n.id === 'tests' ? { ...n, model: { provider: 'mock-alpha', model: 'm1' } } : n,
    );
    const check = await c.call('plan.validate', { planId: plan.planId, graph: { nodes } });
    expect(check.result).toMatchObject({
      ok: true,
      changes: ['tests: model routed → mock-alpha/m1'],
    });
    const bad = await c.call('run.start', {
      request: REQ,
      planId: plan.planId,
      graph: { nodes: [{ id: 'x' }] },
    });
    expect(bad).toMatchObject({
      error: { code: -32602, message: expect.stringMatching(/cannot run/) },
    });
    host.cwd = '/';
    const noProject = await boot({}).then(async (b) => {
      servers.push(await startServer({ kernel: { env: b.host.env, cwd: '/' }, serverFile: false }));
      const s = servers.at(-1) as KernelServer;
      const cc = await connect(`ws://127.0.0.1:${s.port}/rpc`, { token: s.token });
      clients.push(cc);
      return cc.call('run.start', { request: REQ, options: OPTIONS });
    });
    expect(noProject).toMatchObject({ error: { code: -32006 } });
  });

  it('steers a live run: pause, instruct, resume; refusals come back as errors', async () => {
    const { c } = await boot({ KPAI_CONFIRM_ABOVE_USD: '0' });
    let held: Note | undefined;
    c.onNote = (n) => {
      if (n.method !== 'confirm.request') return;
      // Hold the first step's confirmation so the run stays live; accept everything else.
      if (!held && !/graph estimate/.test(String(n.params.question))) held = n;
      else void c.call('confirm.answer', { confirmId: n.params.confirmId, ok: true });
    };
    const { runId } = (await c.call('run.start', { request: REQ, options: OPTIONS })).result as {
      runId: string;
    };
    await c.waitFor(() => held !== undefined);
    expect(await c.call('run.pause', { runId })).toEqual(
      expect.objectContaining({ result: { ok: true } }),
    );
    await c.waitFor((n) => n.method === 'run.state' && n.params.state === 'paused');
    expect(await c.call('run.pause', { runId })).toMatchObject({ error: { code: -32003 } });
    await c.call('confirm.answer', { confirmId: held?.params.confirmId, ok: true });
    expect(
      (await c.call('run.instruct', { runId, nodeId: 'review', text: 'mind the length' })).result,
    ).toEqual({ ok: true });
    await c.waitFor(
      (n) =>
        n.method === 'run.control' &&
        (n.params.event as { type: string }).type === 'instruction_added',
    );
    expect((await c.call('run.resume', { runId })).result).toEqual({ ok: true });
    await c.waitFor(isRun('run.done', runId));
  });

  it('--allow-test sets the default: test providers by kind, plans, a request can opt out', async () => {
    const { c } = await boot({ KPAI_CONFIRM_ABOVE_USD: '100' }, 3000, { allowTest: true });
    const list = (await c.call('providers.list')).result as {
      providers: Array<{ id: string; kind: string }>;
      testAllowed: boolean;
    };
    expect(list.testAllowed).toBe(true);
    expect(list.providers.find((p) => p.id === 'mock-beta')?.kind).toBe('test');
    type Est = { capUsd: number; band: { highUsd: number }; nodes: Array<{ reason?: string }> };
    const plan = (await c.call('plan', { request: REQ })).result as { estimate: Est };
    expect(plan.estimate.nodes.every((n) => n.reason)).toBe(true);
    expect(plan.estimate.capUsd).toBe(plan.estimate.band.highUsd);
    const opted = (await c.call('plan', { request: REQ, options: { allowTest: false } }))
      .result as { estimate: { complete: boolean } };
    expect(opted.estimate.complete).toBe(false);
  });

  it('plan.validate keeps refusing test providers when they are not allowed', async () => {
    const { c } = await boot({ KPAI_CONFIRM_ABOVE_USD: '100' });
    const list = (await c.call('providers.list')).result as { testAllowed: boolean };
    expect(list.testAllowed).toBe(false);
    const plan = (await c.call('plan', { request: REQ })).result as {
      planId: string;
      graph: { nodes: Array<Record<string, unknown>> };
      estimate: { complete: boolean };
    };
    expect(plan.estimate.complete).toBe(false);
    const model = { provider: 'mock-alpha', model: 'm1' };
    const nodes = plan.graph.nodes.map((n) => ({ ...n, model }));
    const check = await c.call('plan.validate', { planId: plan.planId, graph: { nodes } });
    const r = check.result as { ok: boolean; problems: string[] };
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/kind "test" excluded/);
    const run = await c.call('run.start', { request: REQ, planId: plan.planId, graph: { nodes } });
    expect(run).toMatchObject({ error: { code: -32602 } });
  });
});
