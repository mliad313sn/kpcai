import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { main } from './main.js';
import { fakeIo } from './test-helpers/fake-io.js';

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
});
