/**
 * A minimal JSON-RPC client on Node's built-in WebSocket, for assertions on the kernel side
 * of an e2e test (the journal, the runs manager). Same token transport as the browser: the
 * bearer token rides as the second subprotocol (ADR-0019). Loopback only.
 */
export interface Rpc {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  close(): void;
}

export function rpc(port: number, token: string): Promise<Rpc> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, [
    'kernelpai.v1',
    `kernelpai.bearer.${token}`,
  ]);
  const waiting = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>();
  let next = 1;
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data)) as { id?: number; result?: unknown };
    if (typeof m.id === 'number') waiting.get(m.id)?.(m);
  });
  const client: Rpc = {
    call: (method, params) =>
      new Promise((resolve, reject) => {
        const id = next++;
        waiting.set(id, (m) => {
          waiting.delete(id);
          if (m.error) reject(new Error(`${method}: ${m.error.message}`));
          else resolve(m.result as never);
        });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }));
      }),
    close: () => ws.close(),
  };
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(client), { once: true });
    ws.addEventListener('close', (e) => reject(new Error(`close ${e.code}`)), { once: true });
  });
}

export interface JournalEvent {
  type: string;
  nodeId?: string | null;
  provider?: string | null;
  model?: string | null;
  costUsd?: number | null;
  payload: Record<string, unknown>;
}

/** Every journal event of the session that ran `runId` (through `runs.list`). */
export async function runEvents(r: Rpc, runId: string): Promise<JournalEvent[]> {
  const { runs } = await r.call<{ runs: Array<{ runId: string; sessionId: string }> }>('runs.list');
  const sessionId = runs.find((x) => x.runId === runId)?.sessionId;
  if (!sessionId) throw new Error(`run ${runId} not listed`);
  const { events } = await r.call<{ events: JournalEvent[] }>('sessions.events', { sessionId });
  return events;
}
