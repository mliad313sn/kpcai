/**
 * ADR-0027 over the real protocol: `memory.*` round trip, results validated, the plan's
 * memory summary, and a model proposal confirmed only through `confirm.request` of kind
 * `memory`. A WebSocket client on loopback, mock providers, no network.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parseResult, type MethodName } from '@kernelpai/kernel/protocol';
import { recordingHost } from '../../kernel/src/test-helpers/fixture.js';
import { startServer, type KernelServer } from './server.js';
import { connect, type TestClient } from './test-helpers/client.js';

const servers: KernelServer[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.close();
});

async function boot(confirmTimeoutMs = 3000) {
  const host = recordingHost({ KPAI_CONFIRM_ABOVE_USD: '100' });
  const server = await startServer({
    kernel: { env: host.env, cwd: host.cwd },
    confirmTimeoutMs,
    serverFile: false,
  });
  servers.push(server);
  const c = await connect(`ws://127.0.0.1:${server.port}/rpc`, { token: server.token });
  clients.push(c);
  return { host, c };
}

/** Calls a method and checks its result against the protocol schema. */
async function ok<M extends MethodName>(c: TestClient, method: M, params?: unknown) {
  const r = await c.call(method, params);
  expect(r.error, `${method}: ${r.error?.message}`).toBeUndefined();
  const checked = parseResult(method, r.result);
  expect(checked.ok, method).toBe(true);
  return r.result as Record<string, unknown>;
}

type FactOut = { id: string; text: string; provenance: { source: string; localOnly: boolean } };

describe('memory.* over the protocol', () => {
  it('adds, lists, edits, removes, with provenance', async () => {
    const { c } = await boot();
    const added = (await ok(c, 'memory.add', { layer: 'project', text: 'Use pnpm' })) as {
      fact: FactOut;
    };
    expect(added.fact.provenance.source).toBe('human');
    await ok(c, 'memory.add', { layer: 'user', text: 'Prefers tabs', localOnly: true });
    const list = (await ok(c, 'memory.list', { layer: 'project' })) as { facts: FactOut[] };
    expect(list.facts.map((f) => f.text)).toEqual(['Use pnpm']);
    const edited = (await ok(c, 'memory.edit', {
      layer: 'project',
      id: added.fact.id,
      text: 'Use pnpm 10',
      localOnly: true,
    })) as { fact: FactOut };
    expect(edited.fact).toMatchObject({ text: 'Use pnpm 10', provenance: { localOnly: true } });
    await ok(c, 'memory.edit', { layer: 'project', id: added.fact.id });
    await ok(c, 'memory.remove', { layer: 'project', id: added.fact.id });
    expect(((await ok(c, 'memory.list', { layer: 'project' })) as { facts: [] }).facts).toEqual([]);
    const session = await ok(c, 'memory.list', { layer: 'session', sessionId: 's1' });
    expect(session).toMatchObject({ layer: 'session', exists: false, facts: [] });
  });

  it('refuses forbidden zones and bad params with JSON-RPC errors', async () => {
    const { c } = await boot();
    const zone = await c.call('memory.add', { layer: 'user', text: 'creds in ~/.aws/config' });
    expect(zone.error?.code).toBe(-32003);
    const noSession = await c.call('memory.list', { layer: 'session' });
    expect(noSession.error?.code).toBe(-32602);
    const badLayer = await c.call('memory.list', { layer: 'team' });
    expect(badLayer.error?.code).toBe(-32602);
    const missing = await c.call('memory.confirm', { id: 'm-0000' });
    expect(missing.error?.code).toBe(-32004);
    const badId = await c.call('memory.reject', { id: '../x' });
    expect(badId.error?.code).toBe(-32602);
  });

  it('asks about a model proposal with confirm.request kind memory; pending until yes', async () => {
    const { c } = await boot();
    const request = [
      'summarize the architecture',
      '```memory',
      '- [project] Tests use vitest',
      '- [user, local-only] Works from Lyon',
      '```',
    ].join('\n');
    const answered: string[] = [];
    c.onNote = (n) => {
      if (n.method !== 'confirm.request' || n.params.kind !== 'memory') return;
      const m = n.params.memory as { text: string };
      answered.push(m.text);
      // Yes to the first; the second is left unanswered and times out: still pending.
      if (answered.length === 1)
        void c.call('confirm.answer', { confirmId: n.params.confirmId, ok: true });
    };
    const plan = await ok(c, 'plan', { request, options: { allowTest: true } });
    expect(plan.memory).toMatchObject({ truncated: false, pending: 0 });
    const start = await ok(c, 'run.start', {
      request,
      options: { allowTest: true, isolated: false },
    });
    await c.waitFor((n) => n.method === 'run.done' && n.params.runId === start.runId);
    await c.waitFor(
      (n) => n.method === 'log' && /proposal\(s\) pending/.test(String(n.params.message)),
    );
    expect(answered).toEqual(['Tests use vitest', 'Works from Lyon']);
    const kept = (await ok(c, 'memory.list', { layer: 'project' })) as { facts: FactOut[] };
    expect(kept.facts.map((f) => f.text)).toEqual(['Tests use vitest']);
    expect(kept.facts[0]!.provenance.source).not.toBe('human');
    const pending = (await ok(c, 'memory.pending')) as { pending: Array<{ id: string }> };
    expect(pending.pending).toHaveLength(1);
    const rejected = await ok(c, 'memory.reject', { id: pending.pending[0]!.id });
    expect(rejected.rejected).toMatchObject({ text: 'Works from Lyon' });
    expect(((await ok(c, 'memory.pending')) as { pending: [] }).pending).toEqual([]);
  });

  it('confirms a pending proposal from the memory view', async () => {
    const { host, c } = await boot();
    const { MemoryStore } = await import('@kernelpai/memory');
    const p = await new MemoryStore({ home: host.home }).propose(
      { scope: { layer: 'user' }, text: 'Prefers short answers' },
      { source: 'mock-alpha/m1' },
    );
    const r = (await ok(c, 'memory.confirm', { id: p.id })) as { fact: FactOut };
    expect(r.fact).toMatchObject({ id: p.id, provenance: { source: 'mock-alpha/m1' } });
  });
});
