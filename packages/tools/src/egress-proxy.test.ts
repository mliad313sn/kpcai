import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { egressAllowed, startEgressProxy, type EgressDenial } from './egress-proxy.js';

describe('egress allow-list patterns', () => {
  it('matches host, host:port and *.domain only', () => {
    const allow = ['api.example.com', 'local:8080', '*.corp.test', '[::1]', ' '];
    expect(egressAllowed(allow, 'API.example.com', 443)).toBe(true);
    expect(egressAllowed(allow, 'example.com', 443)).toBe(false);
    expect(egressAllowed(allow, 'evil-api.example.com', 443)).toBe(false);
    expect(egressAllowed(allow, 'local', 8080)).toBe(true);
    expect(egressAllowed(allow, 'local', 80)).toBe(false);
    expect(egressAllowed(allow, 'a.corp.test', 1)).toBe(true);
    expect(egressAllowed(allow, 'corp.test', 1)).toBe(false);
    expect(egressAllowed(allow, 'xcorp.test', 1)).toBe(false);
    expect(egressAllowed(allow, '[::1]', 1)).toBe(true);
    expect(egressAllowed([], 'localhost', 80)).toBe(false);
  });
});

/** Sends a raw CONNECT through the proxy; resolves with the first response bytes. */
function connectThrough(proxy: string, target: string, then?: string): Promise<string> {
  const u = new URL(proxy);
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(u.port), u.hostname, () => {
      s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let buf = '';
    s.on('data', (c) => {
      buf += c.toString();
      if (then && buf.includes('200 Connection Established') && !buf.includes('HTTP/1.1 200 OK')) {
        if (!buf.includes('GET-SENT')) {
          buf += 'GET-SENT';
          s.write(then);
        }
        return;
      }
      if (!then || buf.includes('hello')) {
        s.destroy();
        resolve(buf.replace('GET-SENT', ''));
      }
    });
    s.on('error', reject);
    s.on('end', () => resolve(buf));
  });
}

describe('egress proxy', () => {
  let target: http.Server;
  let port: number;
  beforeAll(async () => {
    target = http.createServer((_q, s) => s.end('hello'));
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
    port = (target.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => target.close(() => r())));

  it('tunnels CONNECT to an allowed host and refuses the others', async () => {
    const denied: EgressDenial[] = [];
    const proxy = await startEgressProxy('srv', [`127.0.0.1:${port}`], (d) => {
      denied.push(d);
      throw new Error('a broken listener changes nothing');
    });
    try {
      const get = `GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`;
      const ok = await connectThrough(proxy.url, `127.0.0.1:${port}`, get);
      expect(ok).toMatch(/200 Connection Established[\s\S]*hello/);
      const no = await connectThrough(proxy.url, 'example.invalid:443');
      expect(no).toMatch(
        /403 Forbidden[\s\S]*egress to example\.invalid:443 is not on the allow-list of MCP server "srv"/,
      );
      expect(denied).toEqual([{ host: 'example.invalid', port: 443 }]);
      expect(proxy.env()).toMatchObject({ HTTPS_PROXY: proxy.url, NO_PROXY: '' });
    } finally {
      await proxy.close();
    }
  });

  it('forwards plain HTTP to an allowed host; refuses https:// and relative URLs', async () => {
    const proxy = await startEgressProxy('srv', [`127.0.0.1:${port}`]);
    const u = new URL(proxy.url);
    const ask = (path: string): Promise<string> =>
      new Promise((resolve) => {
        const req = http.request({ host: u.hostname, port: u.port, path }, (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve(`${res.statusCode} ${b}`));
        });
        req.end();
      });
    try {
      expect(await ask(`http://127.0.0.1:${port}/x`)).toBe('200 hello');
      expect(await ask(`http://127.0.0.2:${port}/x`)).toMatch(/^403 egress to 127\.0\.0\.2/);
      expect(await ask(`https://127.0.0.1:${port}/x`)).toMatch(/^403/);
      expect(await ask('/relative')).toBe('400 absolute URL required');
      const closed = await startEgressProxy('srv', ['127.0.0.1:1']);
      const c = new URL(closed.url);
      const unreachable = await new Promise<string>((resolve) => {
        http
          .request({ host: c.hostname, port: c.port, path: 'http://127.0.0.1:1/' }, (res) =>
            resolve(String(res.statusCode)),
          )
          .end();
      });
      await closed.close();
      expect(unreachable).toBe('502');
    } finally {
      await proxy.close();
    }
  });
});
