import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { main } from './main.js';
import { fakeIo } from './test-helpers/fake-io.js';
import { writeMockProviders } from './test-helpers/mock-providers.js';

describe('kpai studio', () => {
  it('starts the kernel server, prints the URL with its token, stops on Ctrl+C', async () => {
    const io = fakeIo({ KPAI_STUDIO_DIST: '/nowhere' });
    const exit = main(['studio', '--port', '0'], io);
    while (!/#token=/.test(io.stdout)) await new Promise((r) => setTimeout(r, 10));
    const m = /http:\/\/127\.0\.0\.1:(\d+)\/#token=([\w-]+)/.exec(io.stdout);
    expect(m).not.toBeNull();
    expect(io.stderr).toMatch(/runs will be refused here/);
    expect(existsSync(join(io.home, 'server.json'))).toBe(true);
    const ws = new WebSocket(`ws://127.0.0.1:${m?.[1]}/rpc`, [
      'kernelpai.v1',
      `kernelpai.bearer.${m?.[2]}`,
    ]);
    const reply = await new Promise<string>((resolve) => {
      ws.on('open', () =>
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'kernel.hello',
            params: { client: 't', protocol: 1 },
          }),
        ),
      );
      ws.on('message', (d) => resolve(String(d)));
    });
    expect(JSON.parse(reply)).toMatchObject({ result: { server: 'kernelpai' } });
    ws.close();
    io.interrupt();
    expect(await exit).toBe(0);
    expect(existsSync(join(io.home, 'server.json'))).toBe(false);
    expect(await main(['studio', '--port', '70000'], fakeIo())).toBe(2);
  });

  it('--allow-test makes offline mock providers the server default; origins and --db apply', async () => {
    const io = fakeIo({
      KPAI_STUDIO_DIST: '/nowhere',
      KPAI_STUDIO_ORIGINS: 'http://localhost:5173, ,',
    });
    writeMockProviders(io.home, [{ id: 'mock-alpha', price: [1, 2], code: 0.9, writing: 0.6 }]);
    const db = join(io.home, 'other.db');
    const exit = main(['studio', '--allow-test', '--db', db], io);
    while (!/#token=/.test(io.stdout)) await new Promise((r) => setTimeout(r, 10));
    expect(io.stderr).toMatch(/test providers allowed \(--allow-test\)/);
    const [, port, token] = /:(\d+)\/#token=([\w-]+)/.exec(io.stdout) ?? [];
    // An extra allowed origin (a Vite dev server) may connect.
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/rpc`,
      ['kernelpai.v1', `kernelpai.bearer.${token}`],
      {
        origin: 'http://localhost:5173',
      },
    );
    const replies = new Map<number, unknown>();
    await new Promise<void>((resolve, reject) => {
      ws.on('error', reject);
      ws.on('open', () => {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'providers.list' }));
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'sessions.list', params: {} }));
      });
      // Notifications (logs) may come in between: keep the replies by request id.
      ws.on('message', (d) => {
        const msg = JSON.parse(String(d)) as { id?: number };
        if (msg.id !== undefined) replies.set(msg.id, msg);
        if (replies.size === 2) resolve();
      });
    });
    expect(replies.get(1)).toMatchObject({
      result: {
        testAllowed: true,
        providers: expect.arrayContaining([
          expect.objectContaining({ id: 'mock-alpha', kind: 'test' }),
        ]),
      },
    });
    ws.close();
    io.interrupt();
    expect(await exit).toBe(0);
    expect(existsSync(db)).toBe(true);
  });
});
