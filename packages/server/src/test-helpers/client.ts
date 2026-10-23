/** A real WebSocket JSON-RPC client for integration tests (loopback only). */
import WebSocket from 'ws';

export interface Note {
  method: string;
  params: Record<string, unknown>;
}

export interface TestClient {
  ws: WebSocket;
  notes: Note[];
  call(
    method: string,
    params?: unknown,
  ): Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }>;
  send(raw: string): Promise<unknown>;
  waitFor(pred: (n: Note) => boolean, timeoutMs?: number): Promise<Note>;
  onNote?: (n: Note) => void;
  close(): void;
}

export interface ConnectOptions {
  token?: string;
  origin?: string;
  protocols?: string[];
  headers?: Record<string, string>;
}

/** Resolves with the open client, or rejects with `close <code>` / `http <status>`. */
export function connect(wsUrl: string, o: ConnectOptions = {}): Promise<TestClient> {
  const protocols = o.protocols ?? [
    'kernelpai.v1',
    ...(o.token ? [`kernelpai.bearer.${o.token}`] : []),
  ];
  const ws = new WebSocket(wsUrl, protocols, {
    ...(o.origin ? { origin: o.origin } : {}),
    ...(o.headers ? { headers: o.headers } : {}),
  });
  const notes: Note[] = [];
  const waiting = new Map<number | null, (m: never) => void>();
  const watchers: Array<() => void> = [];
  let nextId = 1;
  const client: TestClient = {
    ws,
    notes,
    call: (method, params) => {
      const id = nextId++;
      return new Promise((resolve) => {
        waiting.set(id, resolve as never);
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            method,
            ...(params !== undefined ? { params } : {}),
          }),
        );
      });
    },
    send: (raw) =>
      new Promise((resolve) => {
        waiting.set(null, resolve as never);
        ws.send(raw);
      }),
    // Generous: it resolves as soon as the notification arrives; Windows CI runners are slow.
    waitFor: (pred, timeoutMs = 30_000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no matching notification')), timeoutMs);
        const check = (): void => {
          const hit = notes.find(pred);
          if (hit) {
            clearTimeout(timer);
            resolve(hit);
          } else watchers.push(check);
        };
        check();
      }),
    close: () => ws.close(),
  };
  ws.on('message', (data) => {
    const m = JSON.parse(String(data)) as {
      id?: number | null;
      method?: string;
      params?: Record<string, unknown>;
    };
    if (m.method) {
      const n = { method: m.method, params: m.params ?? {} };
      notes.push(n);
      client.onNote?.(n);
      for (const w of watchers.splice(0)) w();
      return;
    }
    const key = m.id ?? null;
    const resolve = waiting.get(key);
    waiting.delete(key);
    resolve?.(m as never);
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(client));
    ws.once('close', (code) => reject(new Error(`close ${code}`)));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`http ${res.statusCode}`)));
    ws.once('error', () => undefined);
  });
}
