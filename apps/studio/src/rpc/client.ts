/**
 * JSON-RPC 2.0 client over the kernel's local WebSocket (ADR-0019). Outgoing params are
 * validated with the protocol's zod schemas before sending; incoming notifications are
 * validated before they reach the UI (anything malformed is dropped and reported).
 */
import {
  ErrorCodes,
  Methods,
  Notifications,
  PROTOCOL_VERSION,
  parseParams,
  parseResult,
  type MethodName,
  type MethodResult,
  type NotificationName,
} from '@kernelpai/kernel/protocol';
import type { z } from 'zod';
import { authProtocols } from './token';

export type { MethodName, MethodResult, NotificationName };

export type ConnState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'unauthorized';

export type Params<M extends MethodName> = z.input<(typeof Methods)[M]['params']>;
export type NotificationParams<N extends NotificationName> = z.infer<(typeof Notifications)[N]>;
export type NotificationHandler = <N extends NotificationName>(
  name: N,
  params: NotificationParams<N>,
) => void;

export class RpcError extends Error {
  constructor(
    readonly code: number | 'timeout' | 'disconnected' | 'invalid_params' | 'invalid_result',
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export interface RpcClientOptions {
  url: string;
  token: string;
  onNotification: NotificationHandler;
  onState?: (state: ConnState, detail?: string) => void;
  /** A message from the server that failed validation (dropped). */
  onInvalid?: (reason: string) => void;
  /**
   * A `confirm.*` notice this client does not know, carrying a `confirmId` (a newer kernel
   * withdrawing a confirmation, P3-F2): passed on instead of being reported as invalid.
   */
  onConfirmNotice?: (method: string, params: unknown) => void;
  WebSocketImpl?: typeof WebSocket;
  requestTimeoutMs?: number;
  backoff?: { initialMs: number; maxMs: number };
  clientName?: string;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function isConfirmNotice(method: string, params: unknown): boolean {
  const id = (params as { confirmId?: unknown } | null)?.confirmId;
  return method.startsWith('confirm.') && typeof id === 'string' && id.length <= 200;
}

/** Close codes the server uses for a bad token (4401) or a policy violation (1008). */
const AUTH_CLOSE_CODES = new Set([4401, 1008]);

export class RpcClient {
  private ws: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  state: ConnState = 'idle';

  constructor(private readonly opts: RpcClientOptions) {}

  connect(): void {
    this.stopped = false;
    this.open();
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      ws.close(1000, 'client closed');
    }
    this.failAll('connection closed');
    this.setState('closed');
  }

  /**
   * Sends a request; rejects on invalid params, error reply, timeout or disconnect. The
   * result is checked against the protocol's result schema before it reaches the caller.
   */
  async call<M extends MethodName>(
    method: M,
    params: Params<M>,
    timeoutMs = this.opts.requestTimeoutMs ?? 30_000,
  ): Promise<MethodResult<M>> {
    const raw = await this.send(method, params, timeoutMs);
    const checked = parseResult(method, raw);
    if (!checked.ok) throw new RpcError('invalid_result', `${method}: ${checked.error}`);
    return checked.value;
  }

  private send<M extends MethodName>(
    method: M,
    params: Params<M>,
    timeoutMs: number,
  ): Promise<unknown> {
    const checked = parseParams(method, params);
    if (!checked.ok) return Promise.reject(new RpcError('invalid_params', checked.error));
    const ws = this.ws;
    if (!ws || ws.readyState !== 1)
      return Promise.reject(new RpcError('disconnected', 'not connected to the kernel'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError('timeout', `${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: checked.value }));
    });
  }

  private open(): void {
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    let ws: WebSocket;
    try {
      ws = new Impl(this.opts.url, authProtocols(this.opts.token));
    } catch (e) {
      this.setState('closed', e instanceof Error ? e.message : String(e));
      return;
    }
    this.ws = ws;
    ws.onopen = () => void this.hello();
    ws.onmessage = (ev: MessageEvent) => this.receive(ev.data);
    ws.onclose = (ev: CloseEvent) => this.onClose(ws, ev.code, ev.reason);
    // Errors are always followed by a close event, which is where they are handled.
    ws.onerror = () => undefined;
  }

  private async hello(): Promise<void> {
    try {
      await this.call('kernel.hello', {
        client: this.opts.clientName ?? 'kp-studio',
        protocol: PROTOCOL_VERSION,
      });
      this.attempt = 0;
      this.setState('open');
    } catch (e) {
      if (e instanceof RpcError && e.code === ErrorCodes.unauthorized) {
        this.stopped = true;
        this.setState('unauthorized', e.message);
        this.ws?.close(1000, 'unauthorized');
      } else if (!(e instanceof RpcError && e.code === 'disconnected')) {
        // An older kernel without `kernel.hello` (or a slow one) is still usable.
        this.attempt = 0;
        this.setState('open', e instanceof Error ? e.message : undefined);
      }
    }
  }

  private onClose(ws: WebSocket, code: number, reason: string): void {
    if (this.ws !== ws) return;
    this.ws = undefined;
    this.failAll('connection lost');
    if (AUTH_CLOSE_CODES.has(code)) {
      this.stopped = true;
      this.setState('unauthorized', reason || 'the kernel refused the token');
      return;
    }
    if (this.stopped) return;
    const { initialMs, maxMs } = this.opts.backoff ?? { initialMs: 250, maxMs: 10_000 };
    const delay = Math.min(maxMs, initialMs * 2 ** this.attempt);
    this.attempt++;
    this.setState('reconnecting', `retrying in ${Math.round(delay / 100) / 10} s`);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private receive(data: unknown): void {
    let msg: unknown;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      this.opts.onInvalid?.('unparseable message');
      return;
    }
    if (!msg || typeof msg !== 'object') return this.opts.onInvalid?.('not an object');
    const m = msg as Record<string, unknown>;
    if (m.jsonrpc !== '2.0') return this.opts.onInvalid?.('not JSON-RPC 2.0');
    if (typeof m.method === 'string') return this.inbound(m.method, m.params, m.id);
    if (typeof m.id === 'number') return this.settle(m.id, m);
    this.opts.onInvalid?.('unexpected message');
  }

  private settle(id: number, m: Record<string, unknown>): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    const err = m.error as { code?: unknown; message?: unknown; data?: unknown } | undefined;
    if (err && typeof err === 'object') {
      const code = typeof err.code === 'number' ? err.code : ErrorCodes.internal;
      p.reject(new RpcError(code, String(err.message ?? 'error'), err.data));
    } else p.resolve(m.result);
  }

  /** Server → client message: a notification, or a request expecting an acknowledgement. */
  private inbound(method: string, params: unknown, id: unknown): void {
    const known = Object.hasOwn(Notifications, method);
    const parsed = known ? Notifications[method as NotificationName].safeParse(params) : undefined;
    if (id !== undefined && (typeof id === 'string' || typeof id === 'number')) {
      const reply = parsed?.success
        ? { jsonrpc: '2.0', id, result: null }
        : {
            jsonrpc: '2.0',
            id,
            error: known
              ? { code: ErrorCodes.invalidParams, message: 'invalid params' }
              : { code: ErrorCodes.methodNotFound, message: `unknown method ${method}` },
          };
      this.ws?.send(JSON.stringify(reply));
    }
    if (!parsed && this.opts.onConfirmNotice && isConfirmNotice(method, params))
      return this.opts.onConfirmNotice(method, params);
    if (!parsed) return this.opts.onInvalid?.(`unknown notification ${method.slice(0, 100)}`);
    if (!parsed.success) return this.opts.onInvalid?.(`invalid ${method}`);
    this.opts.onNotification(method as NotificationName, parsed.data as never);
  }

  private failAll(reason: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new RpcError('disconnected', reason));
    }
    this.pending.clear();
  }

  private setState(state: ConnState, detail?: string): void {
    this.state = state;
    this.opts.onState?.(state, detail);
  }
}
