/**
 * `stats.northStar` (S10) over the real protocol: the result passes its schema with and
 * without detail, the run journals its intent, and bad params are refused. Loopback only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parseResult } from '@kernelpai/kernel/protocol';
import { REQ, recordingHost } from '../../kernel/src/test-helpers/fixture.js';
import { startServer, type KernelServer } from './server.js';
import { connect, type TestClient } from './test-helpers/client.js';

const servers: KernelServer[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.close();
});

describe('stats.northStar', () => {
  it('returns DVO and guardrails that pass the protocol schema', async () => {
    const host = recordingHost({ KPAI_CONFIRM_ABOVE_USD: '100' });
    const server = await startServer({
      kernel: { env: host.env, cwd: host.cwd },
      confirmTimeoutMs: 3000,
      serverFile: false,
      defaults: { allowTest: true },
    });
    servers.push(server);
    const c = await connect(`ws://127.0.0.1:${server.port}/rpc`, { token: server.token });
    clients.push(c);
    const started = await c.call('run.start', { request: REQ, options: { isolated: false } });
    const { runId } = started.result as { runId: string };
    await c.waitFor((n) => n.method === 'run.done' && n.params.runId === runId);
    const r = await c.call('stats.northStar');
    expect(r.error).toBeUndefined();
    expect(parseResult('stats.northStar', r.result).ok).toBe(true);
    const n = r.result as {
      intents: number;
      dvo: number;
      guardrails: { g5Safety: { ok: boolean } };
    };
    // One run, one human intent; nothing was applied, so no outcome yet.
    expect(n).toMatchObject({ intents: 1, dvo: 0, dvoDoc: 0 });
    expect(n).not.toHaveProperty('deliverables');
    expect(n.guardrails.g5Safety.ok).toBe(true);
    const d = await c.call('stats.northStar', { since: '2000-01-01T00:00:00Z', detail: true });
    expect(d.result).toMatchObject({
      since: '2000-01-01T00:00:00.000Z',
      deliverables: [],
      list: [],
    });
    expect((await c.call('stats.northStar', { since: 'soon' })).error?.code).toBe(-32602);
  });
});
