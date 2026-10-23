import { randomUUID } from 'node:crypto';
import {
  ProviderError,
  costUsd,
  estimateTokens,
  isAbortError,
  type ChatRequest,
  type CostEstimate,
  type ExecutionHooks,
  type ModelRef,
  type ProviderAdapter,
  type StopReason,
  type Usage,
} from '@kernelpai/core';
import type { Journal } from '@kernelpai/journal';

/** Everything one attempt (one model, one request) needs. */
export interface AttemptContext {
  journal: Journal;
  sessionId: string;
  nodeId: string;
  ref: ModelRef;
  /** 0 = decision.chosen, n = decision.fallbacks[n - 1]. */
  index: number;
  resolve: () => ProviderAdapter;
  req: ChatRequest;
  signal: AbortSignal | undefined;
  hooks: ExecutionHooks | undefined;
  now: () => number;
}

export type UsageBasis = 'reported' | 'estimated';

export type AttemptOutcome =
  | {
      status: 'ok' | 'cancelled';
      text: string;
      usage: Usage;
      usageBasis: UsageBasis;
      stopReason: StopReason;
      costUsd: number;
      durationMs: number;
    }
  | { status: 'failed'; error: ProviderError; partialText: string; durationMs: number };

interface StreamState {
  adapter?: ProviderAdapter;
  estimate?: CostEstimate;
  requestId: string;
  started: number;
  text: string;
  usage: Usage | null;
  stopReason: StopReason | null;
}

function who(ctx: AttemptContext): { provider: string; model: string; nodeId: string } {
  return { provider: ctx.ref.provider, model: ctx.ref.model, nodeId: ctx.nodeId };
}

/**
 * Runs one streamed call and journals it: `call` first, then exactly one of
 * `response` (success or cancellation, with cost) or `error` (with partial text).
 * Non-ProviderError exceptions are journaled as kind `internal` and rethrown.
 */
export async function runAttempt(ctx: AttemptContext): Promise<AttemptOutcome> {
  const s: StreamState = {
    requestId: randomUUID(),
    started: ctx.now(),
    text: '',
    usage: null,
    stopReason: null,
  };
  try {
    s.adapter = ctx.resolve();
    s.estimate = s.adapter.estimate(ctx.req);
    ctx.journal.append({
      ...who(ctx),
      sessionId: ctx.sessionId,
      type: 'call',
      payload: {
        requestId: s.requestId,
        attempt: ctx.index,
        estimatedInputTokens: s.estimate.inputTokens,
        request: ctx.req,
      },
    });
    await consume(ctx, s);
  } catch (err) {
    if (isCancellation(err, ctx.signal)) return finish(ctx, s, 'cancelled');
    return failed(ctx, s, err);
  }
  return finish(ctx, s, 'ok');
}

async function consume(ctx: AttemptContext, s: StreamState): Promise<void> {
  const adapter = s.adapter as ProviderAdapter;
  const options = { requestId: s.requestId, ...(ctx.signal ? { signal: ctx.signal } : {}) };
  for await (const ev of adapter.send(ctx.req, options)) {
    if (ev.type === 'text') {
      s.text += ev.delta;
      ctx.hooks?.onText?.(ev.delta, ctx.ref);
    } else if (ev.type === 'usage') s.usage = ev.usage;
    else if (ev.type === 'end') s.stopReason = ev.stopReason;
  }
  const id = adapter.descriptor.id;
  // Adapters may report a refusal as a stop reason rather than throwing: same treatment.
  if (s.stopReason === 'refusal') throw new ProviderError('refusal', id, 'Model refused');
  if (s.stopReason === 'cancelled') throw new ProviderError('cancelled', id, 'Request cancelled');
  if (s.stopReason === null) {
    throw new ProviderError('malformed', id, 'Stream ended without an end event');
  }
}

function isCancellation(err: unknown, signal: AbortSignal | undefined): boolean {
  if (err instanceof ProviderError) return err.kind === 'cancelled';
  return isAbortError(err) || signal?.aborted === true;
}

/** Journals the `response` event; a call without reported usage is billed from estimates. */
function finish(ctx: AttemptContext, s: StreamState, status: 'ok' | 'cancelled'): AttemptOutcome {
  const reported = s.usage !== null && (status === 'ok' || s.usage.inputTokens > 0);
  const usage: Usage = reported
    ? (s.usage as Usage)
    : { inputTokens: s.estimate?.inputTokens ?? 0, outputTokens: estimateTokens(s.text) };
  const usageBasis: UsageBasis = reported ? 'reported' : 'estimated';
  const stopReason: StopReason = status === 'cancelled' ? 'cancelled' : (s.stopReason ?? 'other');
  const card = s.adapter?.capabilities().find((m) => m.id === ctx.req.model);
  const cost = card ? costUsd(card.price, usage) : 0;
  const durationMs = ctx.now() - s.started;
  ctx.journal.append({
    ...who(ctx),
    sessionId: ctx.sessionId,
    type: 'response',
    costUsd: cost,
    payload: {
      requestId: s.requestId,
      attempt: ctx.index,
      text: s.text,
      ...usage,
      usageBasis,
      stopReason,
      durationMs,
    },
  });
  return { status, text: s.text, usage, usageBasis, stopReason, costUsd: cost, durationMs };
}

/** Journals the `error` event, keeping any text streamed before the failure. */
function failed(ctx: AttemptContext, s: StreamState, err: unknown): AttemptOutcome {
  const durationMs = ctx.now() - s.started;
  const kind = err instanceof ProviderError ? err.kind : 'internal';
  const message = err instanceof Error ? err.message : String(err);
  ctx.journal.append({
    ...who(ctx),
    sessionId: ctx.sessionId,
    type: 'error',
    payload: {
      requestId: s.requestId,
      attempt: ctx.index,
      kind,
      message,
      ...(err instanceof ProviderError && err.status !== undefined ? { status: err.status } : {}),
      partialText: s.text,
      durationMs,
    },
  });
  if (!(err instanceof ProviderError)) throw err;
  return { status: 'failed', error: err, partialText: s.text, durationMs };
}
