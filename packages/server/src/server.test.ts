import { mkdirSync, mkdtempSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { recordingHost } from '../../kernel/src/test-helpers/fixture.js';
import { readServerFile, serverFilePath } from './server-file.js';
import { startServer, type KernelServer } from './server.js';
import { connect, type TestClient } from './test-helpers/client.js';

const servers: KernelServer[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.close();
});

async function boot(env: Record<string, string> = {}, confirmTimeoutMs = 2000) {
  const host = recordingHost(env);
  const dist = mkdtempSync(join(tmpdir(), 'kpai-dist-'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>KP Studio</title>');
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
  const server = await startServer({
    kernel: { env: host.env, cwd: host.cwd },
    staticDir: dist,
    confirmTimeoutMs,
  });
  servers.push(server);
  const wsUrl = `ws://127.0.0.1:${server.port}/rpc`;
  const open = async (o = {}): Promise<TestClient> => {
    const c = await connect(wsUrl, { token: server.token, ...o });
    clients.push(c);
    return c;
  };
  return { host, server, wsUrl, open };
}

/** How the handshake ends: `open`, `close <code>` (with `untilClose`) or `http <status>`. */
function closeCode(
  url: string,
  protocols: string[],
  origin?: string,
  untilClose = false,
): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, protocols, origin ? { origin } : {});
    ws.on('close', (code) => resolve(`close ${code}`));
    ws.on('unexpected-response', (_q, res) => resolve(`http ${res.statusCode}`));
    ws.on('error', () => undefined);
    ws.on('open', () => {
      if (untilClose) return;
      resolve('open');
      ws.close();
    });
  });
}

function get(port: number, path: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>(
    (resolve) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        let body = '';
        res.on('data', (d) => (body += String(d)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      });
      req.end();
    },
  );
}

describe('kernel server: connection security', () => {
  it('writes server.json readable by the owner only, removed on close', async () => {
    const { host, server } = await boot();
    const info = readServerFile(host.home);
    expect(info).toMatchObject({ token: server.token, port: server.port, protocol: 1 });
    if (process.platform !== 'win32')
      expect(statSync(serverFilePath(host.home)).mode & 0o777).toBe(0o600);
    expect(server.studioUrl).toBe(`http://127.0.0.1:${server.port}/#token=${server.token}`);
    await server.close();
    servers.length = 0;
    expect(existsSync(serverFilePath(host.home))).toBe(false);
  });

  it('echoes the protocol and refuses a wrong or missing token with 4401', async () => {
    const { wsUrl, open } = await boot();
    const c = await open();
    expect(c.ws.protocol).toBe('kernelpai.v1');
    expect((await c.call('kernel.hello', { client: 't', protocol: 1 })).result).toEqual({
      protocol: 1,
      server: 'kernelpai',
    });
    expect(
      await closeCode(wsUrl, ['kernelpai.v1', 'kernelpai.bearer.wrong-token-xyz'], undefined, true),
    ).toBe('close 4401');
    expect(await closeCode(wsUrl, ['kernelpai.v1'], undefined, true)).toBe('close 4401');
  });

  it('refuses foreign origins, foreign hosts and other paths before upgrading', async () => {
    const { server, wsUrl, open } = await boot();
    const t = ['kernelpai.v1', `kernelpai.bearer.${server.token}`];
    expect(await closeCode(wsUrl, t, 'https://evil.example')).toBe('http 403');
    expect(await closeCode(wsUrl, t, 'null')).toBe('http 403');
    expect(await closeCode(wsUrl.replace('/rpc', '/other'), t)).toBe('http 403');
    expect(await closeCode(wsUrl.replace('127.0.0.1', 'localhost'), t)).toBe('open');
    const ok = await open({ origin: `http://127.0.0.1:${server.port}` });
    expect(ok.ws.readyState).toBe(WebSocket.OPEN);
    const rebound = await get(server.port, '/', { Host: `evil.example:${server.port}` });
    expect(rebound.status).toBe(421);
  });

  it('serves the built UI with strict headers and never outside its folder', async () => {
    const { server } = await boot();
    const index = await get(server.port, '/');
    expect(index.status).toBe(200);
    expect(index.body).toContain('KP Studio');
    expect(String(index.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    expect(index.headers['x-content-type-options']).toBe('nosniff');
    expect((await get(server.port, '/assets/app.js')).headers['content-type']).toMatch(
      /javascript/,
    );
    expect((await get(server.port, '/runs/123')).body).toContain('KP Studio');
    expect((await get(server.port, '/missing.js')).status).toBe(404);
    // Dot segments are resolved inside the UI folder: the SPA page, never /etc/passwd.
    expect((await get(server.port, '/%2e%2e/%2e%2e/etc/passwd')).body).toContain('KP Studio');
    expect((await get(server.port, '/%E0%A4%A')).status).toBe(400);
    expect((await get(server.port, '/', {}, 'POST')).status).toBe(405);
    expect((await get(server.port, '/', {}, 'HEAD')).status).toBe(200);
  });
});

describe('kernel server: JSON-RPC', () => {
  it('rejects malformed messages, unknown methods and invalid params', async () => {
    const { open } = await boot();
    const c = await open();
    expect(await c.send('{not json')).toMatchObject({ id: null, error: { code: -32700 } });
    expect(await c.send('[]')).toMatchObject({ error: { code: -32600 } });
    expect(await c.send('{"jsonrpc":"1.0","id":null}')).toMatchObject({ error: { code: -32600 } });
    expect(await c.call('shell.exec', {})).toMatchObject({ error: { code: -32601 } });
    expect(await c.call('plan', { request: '' })).toMatchObject({
      error: { code: -32602, data: expect.stringMatching(/request/) },
    });
    expect(await c.call('kernel.hello', { client: 't', protocol: 99 })).toMatchObject({
      error: { code: -32600 },
    });
    expect(await c.call('run.cancel', { runId: 'nope' })).toMatchObject({
      error: { code: -32004 },
    });
    expect(await c.call('run.pause', { runId: 'nope' })).toMatchObject({ error: { code: -32004 } });
    expect(await c.call('confirm.answer', { confirmId: 'x', ok: true })).toMatchObject({
      result: { accepted: false },
    });
    // A client notification gets no reply; the next request is answered normally.
    c.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'plan', params: {} }));
    expect((await c.call('journal.verify')).result).toMatchObject({ ok: true });
  });

  it('answers the read-only methods with schema-checked results', async () => {
    const { open } = await boot();
    const c = await open();
    const providers = (await c.call('providers.list', {})).result as {
      providers: Array<{ id: string; available: boolean }>;
    };
    expect(providers.providers.find((p) => p.id === 'mock-beta')?.available).toBe(true);
    const tools = (await c.call('tools.list')).result as { tools: Array<{ name: string }> };
    expect(tools.tools.map((t) => t.name)).toContain('git.apply');
    expect((await c.call('sessions.list', {})).result).toEqual({ sessions: [] });
    expect((await c.call('stats')).result).toBeTypeOf('object');
    expect(await c.call('sessions.events', { sessionId: 'zz' })).toMatchObject({
      error: { code: -32004 },
    });
  });
});
