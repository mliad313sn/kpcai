/**
 * R-502 and D-028 over the real protocol: `extensions.list`, `tickets.*` with results
 * validated, the plan's extensions summary, the structured facts on `confirm.request` and
 * the providers and source on `run.done`. Loopback WebSocket, mock providers, no network.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseResult, type MethodName } from '@kernelpai/kernel/protocol';
import { REQ, recordingHost } from '../../kernel/src/test-helpers/fixture.js';
import { startServer, type KernelServer } from './server.js';
import { connect, type TestClient } from './test-helpers/client.js';

const servers: KernelServer[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.close();
});

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

async function boot(env: Record<string, string> = { KPAI_CONFIRM_ABOVE_USD: '100' }) {
  const host = recordingHost(env);
  put(
    host.cwd,
    '.kpstudio/skills/tdd/SKILL.md',
    '---\nname: tdd\ndescription: tests first\n---\nBODY\n',
  );
  put(host.cwd, '.kpstudio/tickets/T-1.md', '---\ntitle: Fix it\nstatus: open\n---\nDo it.\n');
  const server = await startServer({
    kernel: { env: host.env, cwd: host.cwd },
    confirmTimeoutMs: 3000,
    serverFile: false,
  });
  servers.push(server);
  const c = await connect(`ws://127.0.0.1:${server.port}/rpc`, { token: server.token });
  clients.push(c);
  return { host, c };
}

async function ok<M extends MethodName>(c: TestClient, method: M, params?: unknown) {
  const r = await c.call(method, params);
  expect(r.error, `${method}: ${r.error?.message}`).toBeUndefined();
  expect(parseResult(method, r.result).ok, method).toBe(true);
  return r.result as Record<string, unknown>;
}

describe('extensions and tickets over the protocol', () => {
  it('lists extensions and tickets; shows a ticket’s run request; no body reaches a client', async () => {
    const { c } = await boot();
    const e = await ok(c, 'extensions.list');
    expect(e.skills).toEqual([expect.objectContaining({ name: 'tdd', trust: 'untrusted' })]);
    expect(JSON.stringify(e)).not.toContain('BODY');
    const l = await ok(c, 'tickets.list');
    expect(l.tickets).toEqual([expect.objectContaining({ id: 'T-1', status: 'open' })]);
    const s = await ok(c, 'tickets.show', { id: 'T-1' });
    expect(String(s.request)).toMatch(/UNTRUSTED text from \.kpstudio\/tickets\/T-1\.md/);
    expect((await c.call('tickets.show', { id: '../etc' })).error?.code).toBe(-32602);
    expect((await c.call('tickets.show', { id: 'nope' })).error?.code).toBe(-32004);
    const plan = await ok(c, 'plan', { request: REQ, options: { allowTest: true, skill: 'tdd' } });
    expect(plan.extensions).toMatchObject({ skills: [expect.objectContaining({ name: 'tdd' })] });
  });

  it('writes a ticket status only after confirm.request is answered yes', async () => {
    const { c, host } = await boot();
    c.onNote = (n) => {
      if (n.method !== 'confirm.request') return;
      expect(n.params).toMatchObject({ kind: 'artifact', inWorktree: false });
      void c.call('confirm.answer', { confirmId: n.params.confirmId, ok: true });
    };
    const r = await ok(c, 'tickets.setStatus', { id: 'T-1', status: 'done' });
    expect(r.written).toBe(true);
    expect(readFileSync(join(host.cwd, '.kpstudio/tickets/T-1.md'), 'utf8')).toMatch(
      /status: done/,
    );
  });

  it('sends amountUsd on a budget confirm.request and providers on run.done (D-028)', async () => {
    const { c } = await boot({ KPAI_CONFIRM_ABOVE_USD: '0' });
    const budgets: Array<Record<string, unknown>> = [];
    c.onNote = (n) => {
      if (n.method !== 'confirm.request') return;
      if (n.params.kind === 'budget') budgets.push(n.params);
      void c.call('confirm.answer', { confirmId: n.params.confirmId, ok: true });
    };
    const start = await ok(c, 'run.start', {
      request: REQ,
      options: { allowTest: true, isolated: false },
    });
    const done = await c.waitFor((n) => n.method === 'run.done' && n.params.runId === start.runId);
    expect(budgets[0]?.amountUsd).toEqual(expect.any(Number));
    expect(done.params).toMatchObject({ source: 'api', providers: expect.any(Array) });
    expect((done.params.providers as string[]).length).toBeGreaterThan(0);
  });
});
