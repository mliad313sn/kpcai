/**
 * A fake KernelPAI kernel for tests: a real WebSocket server on 127.0.0.1 (random port)
 * speaking the JSON-RPC protocol, with scriptable method handlers and notifications.
 * Never touches the network beyond loopback.
 */
import { WebSocketServer, type WebSocket } from 'ws';

export const TOKEN = 'test-token-0123456789';

export type Handler = (params: unknown) => unknown | Promise<unknown>;

export interface Received {
  method: string;
  params: unknown;
  id: unknown;
}

export class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export class FakeKernel {
  readonly received: Received[] = [];
  readonly replies: unknown[] = [];
  readonly handlers = new Map<string, Handler>();
  readonly sockets = new Set<WebSocket>();
  protocols: string[] = [];
  private server!: WebSocketServer;
  url = '';

  constructor(handlers: Record<string, Handler> = {}) {
    this.handlers.set('kernel.hello', () => ({ protocol: 1, server: 'fake' }));
    for (const [k, v] of Object.entries(handlers)) this.handlers.set(k, v);
  }

  async start(port = 0): Promise<this> {
    this.server = new WebSocketServer({
      host: '127.0.0.1',
      port,
      handleProtocols: (set) => (set.has('kernelpai.v1') ? 'kernelpai.v1' : false),
    });
    await new Promise<void>((r) => this.server.once('listening', () => r()));
    const addr = this.server.address();
    this.url = `ws://127.0.0.1:${addr && typeof addr === 'object' ? addr.port : 0}/rpc`;
    this.server.on('connection', (ws, req) =>
      this.accept(ws, req.headers['sec-websocket-protocol']),
    );
    return this;
  }

  private accept(ws: WebSocket, header: string | undefined): void {
    this.protocols = (header ?? '').split(',').map((s) => s.trim());
    if (!this.protocols.includes(`kernelpai.bearer.${TOKEN}`)) {
      ws.close(4401, 'bad token');
      return;
    }
    this.sockets.add(ws);
    ws.on('close', () => this.sockets.delete(ws));
    ws.on('message', (data) => void this.onMessage(ws, String(data)));
  }

  private async onMessage(ws: WebSocket, text: string): Promise<void> {
    const msg = JSON.parse(text) as { id?: unknown; method?: string; params?: unknown };
    if (!msg.method) {
      this.replies.push(msg);
      return;
    }
    this.received.push({ method: msg.method, params: msg.params, id: msg.id });
    const h = this.handlers.get(msg.method);
    let reply: Record<string, unknown>;
    try {
      if (!h) throw new RpcFailure(-32601, `unknown method ${msg.method}`);
      reply = { result: (await h(msg.params)) ?? null };
    } catch (e) {
      const code = e instanceof RpcFailure ? e.code : -32603;
      reply = { error: { code, message: e instanceof Error ? e.message : String(e) } };
    }
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...reply }));
  }

  notify(method: string, params: unknown): void {
    this.sendRaw(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  sendRaw(text: string): void {
    for (const ws of this.sockets) ws.send(text);
  }

  /** Requests for one method, in arrival order. */
  calls(method: string): unknown[] {
    return this.received.filter((r) => r.method === method).map((r) => r.params);
  }

  dropClients(code = 1011): void {
    for (const ws of this.sockets) ws.close(code, 'dropped');
  }

  async stop(): Promise<void> {
    for (const ws of this.sockets) ws.terminate();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

/** A handler that never answers (for timeout tests). */
export const NEVER: Handler = () => new Promise(() => undefined);

/** Polls until `check` passes (or throws its last error after `ms`). */
export async function until(check: () => unknown, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if ((await check()) !== false) return;
    } catch (e) {
      if (Date.now() > end) throw e;
    }
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}
