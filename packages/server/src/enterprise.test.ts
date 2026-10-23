/**
 * Enterprise mode over the real protocol (design §14, ADR-0035): `program.*` and
 * `enterprise.*` with results validated, the `enterprise.*` stream, the daemon running a
 * program headless, the loopback heartbeat endpoint, and the switch-off.
 */
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { parseResult, type MethodName } from '@kernelpai/kernel/protocol';
import { recordingHost } from '../../kernel/src/test-helpers/fixture.js';
import { startServer, type KernelServer, type ServerOptions } from './server.js';
import { connect, type TestClient } from './test-helpers/client.js';

const servers: KernelServer[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.close();
});

async function boot(extra: Partial<ServerOptions> = {}) {
  const host = recordingHost({ KPAI_CONFIRM_ABOVE_USD: '100' });
  const server = await startServer({
    kernel: { env: host.env, cwd: host.cwd },
    serverFile: false,
    defaults: { allowTest: true },
    ...extra,
  });
  servers.push(server);
  const c = await connect(`ws://127.0.0.1:${server.port}/rpc`, { token: server.token });
  clients.push(c);
  return { host, c, server };
}

async function ok<M extends MethodName>(c: TestClient, method: M, params?: unknown) {
  const r = await c.call(method, params);
  expect(r.error, `${method}: ${r.error?.message}`).toBeUndefined();
  const checked = parseResult(method, r.result);
  expect(checked.ok, `${method}: ${checked.ok ? '' : checked.error}`).toBe(true);
  return r.result as Record<string, unknown>;
}

function get(port: number, path: string, host = `127.0.0.1:${port}`) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += String(d)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const GOAL =
  'Two parts:\n- add an OAuth state validator with tests [[diff:src/a.ts]]\n- add a token parser with tests [[diff:src/b.ts]]';

describe('program.* and enterprise.* over the protocol', () => {
  it('a goal runs headless: charter, approval, two work packages, stream and snapshot', async () => {
    const { c, server } = await boot({ enterprise: { daemon: true }, headless: true });
    const created = await ok(c, 'program.create', { goal: GOAL, budgetUsd: 20, critic: false });
    const id = String(created['programId']);
    expect(created['baseline']).toMatchObject({ capUsd: expect.any(Number) });
    const bad = await c.call('program.approve', { programId: id, charterHash: 'x' });
    expect(bad.error?.message).toMatch(/another charter/);
    await ok(c, 'program.approve', { programId: id, charterHash: created['charterHash'] });
    await c.waitFor((n) => n.method === 'enterprise.wp' && n.params['state'] === 'done', 30_000);
    const snap = await ok(c, 'enterprise.snapshot', {});
    expect((snap['programs'] as unknown[]).length).toBe(1);
    expect(snap['heartbeat']).toMatchObject({ status: expect.stringMatching(/ok|alert/) });
    const got = await ok(c, 'program.get', { programId: id });
    expect(got['status']).toMatch(/running|gate/);
    expect((await ok(c, 'program.list'))['programs']).toHaveLength(1);
    const act = await ok(c, 'enterprise.activity', { since: 0 });
    expect((act['items'] as unknown[]).length).toBeGreaterThan(2);
    expect(c.notes.some((n) => n.method === 'enterprise.activity')).toBe(true);
    // Headless: no UI; the dead-man endpoint answers on loopback only.
    expect((await get(server.port, '/')).status).toBe(404);
    const hb = await get(server.port, '/enterprise/heartbeat');
    expect(hb.status).toBe(200);
    expect(JSON.parse(hb.body)).toMatchObject({ status: expect.any(String) });
    expect((await get(server.port, '/enterprise/heartbeat', 'evil.example')).status).toBe(421);
    await ok(c, 'program.pause', { programId: id });
    await ok(c, 'program.resume', { programId: id });
    expect((await ok(c, 'enterprise.kill'))['cancelled']).toEqual(expect.any(Array));
    await ok(c, 'enterprise.unkill');
    await ok(c, 'program.stop', { programId: id });
    expect((await ok(c, 'program.reports', { programId: id }))['reports']).toEqual(
      expect.any(Array),
    );
    await ok(c, 'enterprise.heartbeat');
  });

  it('answers, batches and views are the Sponsor’s; unknown ids are errors', async () => {
    const { c } = await boot();
    const created = await ok(c, 'program.create', {
      goal: 'one thing',
      budgetUsd: 5,
      critic: false,
    });
    const id = String(created['programId']);
    const miss = await c.call('program.answer', {
      programId: id,
      escalationId: 'esc-x',
      answer: 'yes',
    });
    expect(miss.error?.message).toMatch(/no open question/);
    const batch = await ok(c, 'program.answerBatch', {
      programId: id,
      escalationIds: ['esc-x'],
      answer: 'no',
    });
    expect(batch['refused']).toHaveLength(1);
    const view = await c.call('program.viewed', { programId: id, ref: { kind: 'run', id: 'r' } });
    expect(view.error?.message).toMatch(/no run/);
    await ok(c, 'program.reject', { programId: id, reason: 'not now' });
    expect((await c.call('program.get', { programId: 'prog-none' })).error?.message).toMatch(
      /no program/,
    );
  });

  it('without Enterprise mode every method is unsupported', async () => {
    const { c, server } = await boot({ enterprise: false });
    const r = await c.call('enterprise.snapshot', {});
    expect(r.error?.code).toBe(-32005);
    expect((await get(server.port, '/enterprise/heartbeat')).body).not.toMatch(/staleAfterSec/);
  });
});
