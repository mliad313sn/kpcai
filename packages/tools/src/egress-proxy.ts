/**
 * Per-server egress allow-list (R-501, ADR-0032): a loopback HTTP proxy that lets an MCP
 * server reach only the hosts listed for it. The server is started with HTTP(S)_PROXY
 * pointing here and NO_PROXY cleared. Without an OS sandbox a server that ignores the
 * proxy variables is not contained: the proxy is an allow-list for well-behaved clients
 * and a record of what was refused, not a jail (see ADR-0032).
 */
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

export interface EgressDenial {
  host: string;
  port: number;
}

export interface EgressProxy {
  /** `http://127.0.0.1:<port>` */
  readonly url: string;
  /** Environment that routes the server's HTTP(S) traffic through the proxy. */
  env(): Record<string, string>;
  close(): Promise<void>;
}

/** `host`, `host:port` or `*.domain` (any sub-domain, not the domain itself). Case-insensitive. */
export function egressAllowed(allow: readonly string[], host: string, port: number): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return allow.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (entry === '') return false;
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry);
    if (!m) return false;
    const want = (m[1] as string).replace(/^\[|\]$/g, '');
    if (m[2] !== undefined && Number(m[2]) !== port) return false;
    if (want.startsWith('*.')) return h.endsWith(want.slice(1)) && h.length > want.length - 1;
    return h === want;
  });
}

function splitHostPort(target: string, fallback: number): { host: string; port: number } {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(target);
  if (!m) return { host: target, port: fallback };
  return { host: m[1] as string, port: m[2] === undefined ? fallback : Number(m[2]) };
}

const refusal = (server: string, host: string, port: number): string =>
  `egress to ${host}:${port} is not on the allow-list of MCP server "${server}"`;

function onRequest(
  server: string,
  allow: readonly string[],
  deny: (d: EgressDenial) => void,
): http.RequestListener {
  return (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('absolute URL required');
      return;
    }
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (url.protocol !== 'http:' || !egressAllowed(allow, url.hostname, port)) {
      deny({ host: url.hostname, port });
      res.writeHead(403, { 'content-type': 'text/plain' }).end(refusal(server, url.hostname, port));
      return;
    }
    const upstream = http.request(
      { host: url.hostname, port, path: `${url.pathname}${url.search}`, method: req.method },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined && !/^proxy-/i.test(k)) upstream.setHeader(k, v);
    }
    upstream.on('error', () => res.writeHead(502).end('upstream unreachable'));
    req.pipe(upstream);
  };
}

function onConnect(
  server: string,
  allow: readonly string[],
  deny: (d: EgressDenial) => void,
): (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => void {
  return (req, socket, head) => {
    const { host, port } = splitHostPort(req.url ?? '', 443);
    socket.on('error', () => socket.destroy());
    if (!egressAllowed(allow, host, port)) {
      deny({ host, port });
      const body = refusal(server, host, port);
      socket.end(
        `HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
      return;
    }
    const upstream = net.connect(port, host.replace(/^\[|\]$/g, ''), () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
  };
}

/** Starts the proxy for one server on 127.0.0.1 (random port). */
export async function startEgressProxy(
  server: string,
  allow: readonly string[],
  onDeny: (d: EgressDenial) => void = () => undefined,
): Promise<EgressProxy> {
  const deny = (d: EgressDenial): void => {
    try {
      onDeny(d);
    } catch {
      // A broken listener never opens the proxy.
    }
  };
  const srv = http.createServer(onRequest(server, allow, deny));
  srv.on('connect', onConnect(server, allow, deny));
  const sockets = new Set<net.Socket>();
  srv.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve());
  });
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return {
    url,
    env: () => ({
      HTTP_PROXY: url,
      HTTPS_PROXY: url,
      ALL_PROXY: url,
      http_proxy: url,
      https_proxy: url,
      all_proxy: url,
      NO_PROXY: '',
      no_proxy: '',
    }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        srv.close(() => resolve());
      }),
  };
}
