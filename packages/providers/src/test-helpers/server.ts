import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeServer {
  url: string;
  requests: Array<{ path: string; body: unknown; headers: IncomingMessage['headers'] }>;
  close(): Promise<void>;
}

type Handler = (req: IncomingMessage, res: ServerResponse, body: unknown) => void;

/** Local HTTP server standing in for a provider API; records every request. */
export async function fakeServer(handler: Handler): Promise<FakeServer> {
  const requests: FakeServer['requests'] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body: unknown = raw ? JSON.parse(raw) : undefined;
      requests.push({ path: req.url ?? '', body, headers: req.headers });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function sse(
  res: ServerResponse,
  events: ReadonlyArray<Record<string, unknown>>,
  hold = false,
): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(`event: ${String(e['type'])}\ndata: ${JSON.stringify(e)}\n\n`);
  if (!hold) res.end();
}

/** Returns a URL on which nothing listens. */
export async function deadUrl(): Promise<string> {
  const s = await fakeServer(() => undefined);
  await s.close();
  return s.url;
}
