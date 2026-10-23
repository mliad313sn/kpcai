import { randomUUID } from 'node:crypto';
import { ProviderError, isAbortError } from './errors.js';
import { estimateRequest, type CostEstimate } from './cost.js';
import {
  ChatRequestSchema,
  type ChatRequest,
  type ModelCard,
  type ProviderDescriptor,
  type StreamEvent,
} from './schemas.js';

export interface SendOptions {
  requestId?: string;
  signal?: AbortSignal;
}

export interface DetectResult {
  available: boolean;
  reason: string;
  /** Models found at runtime (local providers); merged into capabilities(). */
  models?: ModelCard[];
}

/**
 * The single contract every provider implements (spec §5.2).
 * Adding a provider = one YAML descriptor + one class implementing this.
 */
export interface ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  capabilities(): readonly ModelCard[];
  estimate(req: ChatRequest): CostEstimate;
  send(req: ChatRequest, options?: SendOptions): AsyncIterable<StreamEvent>;
  cancel(requestId: string): boolean;
  detect(): Promise<DetectResult>;
}

/**
 * Re-yields `source`, but rejects as soon as `signal` aborts, even while the source
 * is awaiting I/O that ignores the signal. Cancellation never depends on adapter care.
 */
async function* abortable<T>(source: AsyncIterable<T>, signal: AbortSignal): AsyncIterable<T> {
  const it = source[Symbol.asyncIterator]();
  let onAbort = (): void => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  try {
    for (;;) {
      const next = await Promise.race([it.next(), aborted]);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (signal.aborted) void it.return?.()?.catch(() => undefined);
  }
}

/**
 * Shared plumbing: input validation, cancellation registry, model lookup.
 * Subclasses only implement `stream()` and `detect()`.
 */
export abstract class BaseAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  protected discovered: ModelCard[] = [];
  private readonly inflight = new Map<string, AbortController>();

  constructor(descriptor: ProviderDescriptor) {
    this.descriptor = descriptor;
  }

  capabilities(): readonly ModelCard[] {
    const declared = new Set(this.descriptor.models.map((m) => m.id));
    return [...this.descriptor.models, ...this.discovered.filter((m) => !declared.has(m.id))];
  }

  card(modelId: string): ModelCard {
    const found = this.capabilities().find((m) => m.id === modelId);
    if (!found) {
      throw new ProviderError(
        'bad_request',
        this.descriptor.id,
        `Unknown model "${modelId}" for provider ${this.descriptor.id}`,
      );
    }
    return found;
  }

  estimate(req: ChatRequest): CostEstimate {
    return estimateRequest(req, this.card(req.model));
  }

  async *send(req: ChatRequest, options: SendOptions = {}): AsyncIterable<StreamEvent> {
    const parsed = ChatRequestSchema.parse(req);
    const requestId = options.requestId ?? randomUUID();
    const controller = new AbortController();
    const onOuterAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onOuterAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    this.inflight.set(requestId, controller);
    try {
      // Checked between events too, so an adapter that ignores the signal still stops.
      if (controller.signal.aborted) throw new Error('aborted before start');
      yield { type: 'start', requestId, model: parsed.model };
      yield* abortable(this.stream(parsed, controller.signal), controller.signal);
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) {
        throw new ProviderError('cancelled', this.descriptor.id, 'Request cancelled', {
          cause: err,
        });
      }
      throw err;
    } finally {
      this.inflight.delete(requestId);
      options.signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  cancel(requestId: string): boolean {
    const controller = this.inflight.get(requestId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  abstract detect(): Promise<DetectResult>;

  protected abstract stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
}
