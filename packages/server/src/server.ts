/**
 * The KernelPAI console server (ADR-0019): HTTP for the built KP Studio and a JSON-RPC 2.0
 * WebSocket at `/rpc`, bound to 127.0.0.1 on a random port, behind a bearer token, a
 * loopback Host check and an Origin allow-list. One kernel serves every connection; run
 * notifications and confirmations go to every authenticated client.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { Kernel, kpaiHome, type KernelHost, type RunHandle } from '@kernelpai/kernel';
import {
  CloseCodes,
  PROTOCOL_VERSION,
  SUBPROTOCOL,
  parseNotification,
  type NotificationName,
} from '@kernelpai/kernel/protocol';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  allowedOrigins,
  hasValidToken,
  isAllowedOrigin,
  isLoopbackHost,
  newToken,
} from './auth.js';
import { ConfirmBroker } from './confirm-broker.js';
import { handlers, type Handlers } from './handlers.js';
import { handleMessage } from './rpc.js';
import { removeServerFile, writeServerFile } from './server-file.js';
import { serveStatic } from './static.js';

export const DEFAULT_CONFIRM_TIMEOUT_MS = 120_000;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export interface ServerOptions {
  /** Environment, workspace root and journal of the kernel. */
  kernel: Pick<KernelHost, 'env' | 'cwd' | 'db'>;
  /** Built KP Studio (apps/studio/dist); without it a "not built" page is served. */
  staticDir?: string;
  /** 0 (default) picks a free port. The host is always 127.0.0.1. */
  port?: number;
  /** Extra allowed origins (a Vite dev server, the desktop shell). */
  origins?: readonly string[];
  confirmTimeoutMs?: number;
  /** Fixed token (tests); default a fresh random one per start. */
  token?: string;
  /** Write `$KPAI_HOME/server.json` (default true). */
  serverFile?: boolean;
}

export interface KernelServer {
  url: string;
  port: number;
  token: string;
  /** The URL to open: the UI, with the token in the fragment (never sent to a server). */
  studioUrl: string;
  close(): Promise<void>;
}

export async function startServer(o: ServerOptions): Promise<KernelServer> {
  const token = o.token ?? newToken();
  const clients = new Set<WebSocket>();
  const broadcast = broadcaster(clients);
  const broker = new ConfirmBroker(broadcast, o.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS);
  const kernel = new Kernel(kernelHost(o, broker, broadcast));
  const h = handlers({ kernel, broker, watch: (r) => watchRun(r, broadcast) });
  const http = createServer((req, res) => {
    if (!isLoopbackHost(req.headers.host, port())) {
      res.writeHead(421).end();
      return;
    }
    serveStatic(req, res, o.staticDir);
  });
  const port = (): number => (http.address() as AddressInfo | null)?.port ?? 0;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    handleProtocols: (set) => (set.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
  });
  http.on('upgrade', (req, socket, head) => {
    const origins = allowedOrigins(port(), o.origins);
    if (!upgradeAllowed(req, port(), origins)) return refuse(socket);
    wss.handleUpgrade(req, socket, head, (ws) => accept(ws, req, token, clients, h));
  });
  await listen(http, o.port ?? 0);
  const url = `http://127.0.0.1:${port()}`;
  const home = kpaiHome(o.kernel.env);
  if (o.serverFile !== false) {
    const info = { protocol: PROTOCOL_VERSION, url, port: port(), pid: process.pid, token };
    writeServerFile(home, { ...info, startedAt: new Date().toISOString() });
  }
  const close = async (): Promise<void> => {
    broker.declineAll();
    for (const ws of clients) ws.close(1001, 'server closing');
    wss.close();
    await stop(http);
    await kernel.close();
    if (o.serverFile !== false) removeServerFile(home, token);
  };
  return { url, port: port(), token, studioUrl: `${url}/#token=${token}`, close };
}

type Broadcast = (name: NotificationName, params: unknown) => number;

/** Validates a notification against the protocol, then sends it to every client. */
function broadcaster(clients: Set<WebSocket>): Broadcast {
  return (name, params) => {
    const checked = parseNotification(name, params);
    if (!checked.ok) return 0;
    const text = JSON.stringify({ jsonrpc: '2.0', method: name, params: checked.value });
    for (const ws of clients) ws.send(text);
    return clients.size;
  };
}

/** Loopback only: the kernel server is never reachable from another machine. */
function listen(http: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, '127.0.0.1', () => resolve());
  });
}

async function stop(http: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => http.close(() => resolve()));
  http.closeAllConnections();
  await closed;
}

function kernelHost(o: ServerOptions, broker: ConfirmBroker, broadcast: Broadcast): KernelHost {
  return {
    ...o.kernel,
    say: (text) => void broadcast('log', { level: 'info', message: text.trim().slice(0, 10_000) }),
    confirm: (req) => broker.ask(req),
    onEvent: (runId, event) => void broadcast('run.event', { runId, event }),
    onRunState: (runId, state) => void broadcast('run.state', { runId, state }),
    onControl: (runId, event) => void broadcast('run.control', { runId, event }),
    onRunPlanned: (runId, plan) =>
      void broadcast('run.planned', {
        runId,
        planId: plan.planId,
        graph: plan.graph,
        estimate: plan.estimate,
      }),
  };
}

/** Streams a run's end: `run.done` with the approved patches, or why it did not run. */
function watchRun(handle: RunHandle, broadcast: Broadcast): void {
  handle.done.then(
    (o) => {
      if (o.status === 'not_run') {
        broadcast('log', { level: 'warn', message: `not run — ${o.reason}`.slice(0, 10_000) });
        return;
      }
      broadcast('run.done', { runId: handle.runId, result: o.result, patches: o.patches });
    },
    (err: unknown) => {
      const message = `run ${handle.runId} failed: ${err instanceof Error ? err.message : String(err)}`;
      broadcast('log', { level: 'error', message: message.slice(0, 10_000) });
    },
  );
}

function upgradeAllowed(req: IncomingMessage, port: number, origins: Set<string>): boolean {
  const path = (req.url ?? '').split('?')[0];
  return (
    path === '/rpc' &&
    isLoopbackHost(req.headers.host, port) &&
    isAllowedOrigin(req.headers.origin, origins)
  );
}

function refuse(socket: Duplex): void {
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
}

function accept(
  ws: WebSocket,
  req: IncomingMessage,
  token: string,
  clients: Set<WebSocket>,
  h: Handlers,
): void {
  if (!hasValidToken(req, token)) {
    ws.close(CloseCodes.unauthorized, 'token refused');
    return;
  }
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('message', (data, isBinary) => {
    const text = isBinary ? '' : String(data);
    void handleMessage(text, h).then((reply) => {
      if (reply && ws.readyState === ws.OPEN) ws.send(JSON.stringify(reply));
    });
  });
}
