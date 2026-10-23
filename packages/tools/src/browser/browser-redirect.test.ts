/**
 * WP7-F1 (S7): Playwright routes never see the later hops of a redirect, so a loopback
 * page's 302 reached any origin without the allow-list or a confirmation. Every
 * non-loopback, non-listed host now goes to a proxy that refuses it.
 */
import { existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalToolBus } from '../bus.js';
import { call, makeCtx, tempDir } from '../test-helpers/ctx.js';
import { chromiumExecutable, proxyArgs } from './pool.js';
import { browserTools } from './tools.js';

const exe = chromiumExecutable(process.env) ?? chromium.executablePath();

it('sends every host but loopback and listed origins to the refusing proxy', () => {
  expect(proxyArgs('http://127.0.0.1:9', ['https://docs.example.com'])).toEqual([
    '--proxy-server=http://127.0.0.1:9',
    '--proxy-bypass-list=localhost;*.localhost;127.0.0.0/8;[::1];https://docs.example.com',
  ]);
});

describe.skipIf(!existsSync(exe))('browser redirects (WP7-F1)', () => {
  let server: http.Server;
  let port = 0;
  const hits: string[] = [];
  let root = '';
  let cleanup: () => Promise<void>;
  let bus: LocalToolBus;

  beforeAll(async () => {
    ({ dir: root, cleanup } = await tempDir('kpai-redirect-'));
    server = http.createServer((req, res) => {
      hits.push(`${req.headers.host}${req.url}`);
      const to = (p: string) => `http://remote.test:${port}${p}`;
      if (req.url === '/r') return res.writeHead(302, { location: to('/leak?d=1') }).end();
      if (req.url === '/r2') return res.writeHead(302, { location: to('/img?d=2') }).end();
      res.setHeader('content-type', 'text/html');
      if (req.url === '/sub') return res.end('<title>Sub</title><img src="/r2">');
      res.end('<title>Remote</title><p>REMOTE CONTENT</p>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
    bus = new LocalToolBus({
      // remote.test → loopback inside Chromium only: a reachable "remote" origin, no network.
      tools: browserTools({ launchArgs: ['--host-resolver-rules=MAP remote.test 127.0.0.1'] }),
    });
  }, 60_000);
  afterAll(async () => {
    await bus.close();
    await new Promise<void>((r) => server.close(() => r()));
    await cleanup();
  });

  it('a loopback redirect to an unlisted origin never reaches it', async () => {
    const ctx = makeCtx(root);
    const r = await bus.call(call('browser.open', { url: `http://127.0.0.1:${port}/r` }), ctx);
    expect(r).toMatchObject({ isError: true });
    expect(r.content).toMatch(/redirected to http:\/\/remote\.test:\d+\/leak/);
    expect(r.content).not.toMatch(/REMOTE CONTENT|Remote/);
    const sub = await bus.call(call('browser.open', { url: `http://127.0.0.1:${port}/sub` }), ctx);
    expect(sub.content).toMatch(/: Sub/);
    expect(sub.content).toMatch(/blocked requests[^\n]*remote\.test/);
    expect(hits.filter((h) => h.startsWith('remote.test'))).toEqual([]);
    expect(ctx.questions).toEqual([]);
  }, 60_000);
});
