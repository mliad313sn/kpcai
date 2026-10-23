/** Phase 3 review regressions through the console protocol (P3-F1, P3-F2, P3-F6). */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseParams } from '@kernelpai/kernel/protocol';
import { REQ, recordingHost } from '../../kernel/src/test-helpers/fixture.js';
import { TWO_PATCHES } from '../../kernel/src/test-helpers/hold.js';
import { startServer, type KernelServer } from './server.js';
import { connect, type Note, type TestClient } from './test-helpers/client.js';

const servers: KernelServer[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.close();
});

const IN_PLACE = { allowTest: true, isolated: false };

async function boot(env: Record<string, string>) {
  const host = recordingHost(env);
  const server = await startServer({
    kernel: { env: host.env, cwd: host.cwd },
    confirmTimeoutMs: 10_000,
    serverFile: false,
  });
  servers.push(server);
  const c = await connect(`ws://127.0.0.1:${server.port}/rpc`, { token: server.token });
  clients.push(c);
  return { host, c };
}

const isRun = (method: string, runId: string) => (n: Note) =>
  n.method === method && n.params.runId === runId;

describe('patches.apply (review P3-F1)', () => {
  it('asks once per patch of one node, each confirm.request with its own diff', async () => {
    const { host, c } = await boot({ KPAI_CONFIRM_ABOVE_USD: '100' });
    const patches: Note[] = [];
    c.onNote = (n) => {
      if (n.method !== 'confirm.request') return;
      patches.push(n);
      // Yes to the first diff, no to the second.
      void c.call('confirm.answer', { confirmId: n.params.confirmId, ok: patches.length === 1 });
    };
    const start = await c.call('run.start', { request: TWO_PATCHES, options: IN_PLACE });
    const { runId } = start.result as { runId: string };
    await c.waitFor(isRun('run.done', runId));
    const res = await c.call('patches.apply', { runId, nodeIds: ['implementation'] });
    const results = (res.result as { results: Array<{ ok: boolean }> }).results;
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(patches.map((n) => n.params.kind)).toEqual(['patch', 'patch']);
    expect(patches[0]?.params.patch).toMatch(/\+\+\+ b\/a\.txt/);
    expect(patches[1]?.params.patch).toMatch(/\+\+\+ b\/b\.txt/);
    expect(existsSync(join(host.cwd, 'a.txt'))).toBe(true);
    expect(existsSync(join(host.cwd, 'b.txt'))).toBe(false);
  });
});

describe('run.cancel voids the run’s confirmations (review P3-F2)', () => {
  it('closes the open dialog, refuses a late yes and never sends the queued question', async () => {
    const { c } = await boot({ KPAI_CONFIRM_ABOVE_USD: '0' });
    let steps = 0;
    let held: Note | undefined;
    c.onNote = (n) => {
      if (n.method !== 'confirm.request') return;
      const graph = /graph estimate/.test(String(n.params.question));
      // Hold the debate's second round (both debaters ask at once); yes to the rest.
      if (!graph && !held && ++steps === 3) held = n;
      else if (!held) void c.call('confirm.answer', { confirmId: n.params.confirmId, ok: true });
    };
    const start = await c.call('run.start', { request: REQ, options: IN_PLACE });
    const { runId } = start.result as { runId: string };
    await c.waitFor(() => held !== undefined);
    await new Promise((r) => setTimeout(r, 100));
    const asked = c.notes.filter((n) => n.method === 'confirm.request').length;
    expect((await c.call('run.cancel', { runId })).result).toEqual({ cancelled: true });
    const closed = await c.waitFor((n) => n.method === 'confirm.closed');
    expect(closed.params).toEqual({
      confirmId: held?.params.confirmId,
      runId,
      reason: 'cancelled',
    });
    const late = await c.call('confirm.answer', { confirmId: held?.params.confirmId, ok: true });
    expect(late.result).toEqual({ accepted: false });
    await c.waitFor((n) => isRun('run.state', runId)(n) && n.params.state === 'cancelled');
    expect(c.notes.filter((n) => n.method === 'confirm.request').length).toBe(asked);
  });
});

describe('run options (review P3-F6)', () => {
  it('the console protocol carries no overBudget', () => {
    const p = parseParams('run.start', { request: 'r', options: { overBudget: true } });
    expect(p.ok && p.value.options).toEqual({});
  });
});
