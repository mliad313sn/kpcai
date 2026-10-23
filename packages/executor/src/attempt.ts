import { randomUUID } from 'node:crypto';
import {
  ProviderError,
  costUsd,
  estimateRequest,
  estimateTokens,
  isAbortError,
  type ChatRequest,
  type CostEstimate,
  type ExecutionHooks,
  type ModelCard,
  type ModelRef,
  type ProviderAdapter,
  type StopReason,
  type TaskType,
  type Usage,
} from '@kernelpai/core';
import type { Journal } from '@kernelpai/journal';
import { Watchdog, type StallTimeouts } from './watchdog.js';

/** Everything one attempt (one model, one request) needs. */
export interface AttemptContext {
  journal: Journal;
  sessionId: string;
  nodeId: string;
  /** node.type, journaled on `call` so output can be calibrated per task type. */
  taskType: TaskType;
  ref: ModelRef;
  /** 0 = decision.chosen, n = decision.fallbacks[n - 1]. */
  index: number;
  resolve: () => ProviderAdapter;
  req: ChatRequest;
  signal: AbortSignal | undefined;
  hooks: ExecutionHooks | undefined;
  now: () => number;
  /** Calibrated typical output (tokens) for this model and task type, if known. */
  expectedOutputTokens?: number | undefined;
  /** Stall timeouts; omitted = none (the executor always passes its defaults). */
  timeouts?: StallTimeouts;
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
  | {
      status: 'failed';
      error: ProviderError;
      partialText: string;
      /** Billed cost of the failed attempt (0 when nothing was used). */
      costUsd: number;
      durationMs: number;
    };

interface StreamState {
  adapter?: ProviderAdapter;
  card?: ModelCard | undefined;
  estimate?: CostEstimate;
  requestId: string;
  started: number;
  text: string;
  usage: Usage | null;
  stopReason: StopReason | null;
}

const NO_TIMEOUTS: StallTimeouts = { firstChunkMs: 0, idleMs: 0 };

function who(ctx: AttemptContext): { provider: string; model: string; nodeId: string } {
  return { provider: ctx.ref.provider, model: ctx.ref.model, nodeId: ctx.nodeId };
}

/**
 * Typical output tokens behind `estimate.expectedCostUsd`: mirrors `estimateRequest`
 * (calibrated value clipped to the cap, else a quarter of the cap, at least 256).
 */
export function expectedOutputOf(estimate: CostEstimate, calibrated?: number): number {
  const cap = estimate.maxOutputTokens;
  return calibrated !== undefined && Number.isFinite(calibrated) && calibrated > 0
    ? Math.min(cap, Math.ceil(calibrated))
    : Math.min(cap, Math.max(256, Math.ceil(cap / 4)));
}

/**
 * Runs one streamed call and journals it: `call` first (with cost estimates), then
 * exactly one of `response` (success or cancellation) or `error` (with partial text).
 * Whichever closes the attempt carries its cost, so spend is never double counted.
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
    s.card = s.adapter.capabilities().find((m) => m.id === ctx.req.model);
    s.estimate = s.card
      ? estimateRequest(ctx.req, s.card, withExpected(ctx.expectedOutputTokens))
      : s.adapter.estimate(ctx.req);
    journalCall(ctx, s, s.estimate);
  } catch (err) {
    return failed(ctx, s, err);
  }
  return stream(ctx, s);
}

function withExpected(n: number | undefined): { expectedOutputTokens?: number } {
  return n === undefined ? {} : { expectedOutputTokens: n };
}

function journalCall(ctx: AttemptContext, s: StreamState, estimate: CostEstimate): void {
  ctx.journal.append({
    ...who(ctx),
    sessionId: ctx.sessionId,
    type: 'call',
    payload: {
      requestId: s.requestId,
      attempt: ctx.index,
      taskType: ctx.taskType,
      estimatedInputTokens: estimate.inputTokens,
      estimatedOutputTokens: expectedOutputOf(estimate, ctx.expectedOutputTokens),
      estimatedCostUsd: estimate.expectedCostUsd,
      estimatedMaxCostUsd: estimate.maxCostUsd,
      estimateBasis: estimate.basis,
      request: ctx.req,
    },
  });
}

async function stream(ctx: AttemptContext, s: StreamState): Promise<AttemptOutcome> {
  const dog = new Watchdog(ctx.timeouts ?? NO_TIMEOUTS, ctx.signal);
  try {
    await consume(ctx, s, dog);
  } catch (err) {
    if (dog.stalled) {
      const id = s.adapter?.descriptor.id ?? ctx.ref.provider;
      const msg = `no output for ${String(dog.stalledAfterMs)}ms`;
      return failed(ctx, s, new ProviderError('unavailable', id, msg, { cause: err }));
    }
    if (isCancellation(err, ctx.signal)) return finish(ctx, s, 'cancelled');
    return failed(ctx, s, err);
  } finally {
    dog.dispose();
  }
  return finish(ctx, s, 'ok');
}

async function consume(ctx: AttemptContext, s: StreamState, dog: Watchdog): Promise<void> {
  const adapter = s.adapter as ProviderAdapter;
  const options = { requestId: s.requestId, signal: dog.signal };
  for await (const ev of adapter.send(ctx.req, options)) {
    if (ev.type !== 'start') dog.activity();
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

function priced(s: StreamState, usage: Usage): number {
  return s.card ? costUsd(s.card.price, usage) : 0;
}

/** Journals the `response` event; a call without reported usage is billed from estimates. */
function finish(ctx: AttemptContext, s: StreamState, status: 'ok' | 'cancelled'): AttemptOutcome {
  const reported = s.usage !== null && (status === 'ok' || s.usage.inputTokens > 0);
  const usage: Usage = reported
    ? (s.usage as Usage)
    : { inputTokens: s.estimate?.inputTokens ?? 0, outputTokens: estimateTokens(s.text) };
  const usageBasis: UsageBasis = reported ? 'reported' : 'estimated';
  const stopReason: StopReason = status === 'cancelled' ? 'cancelled' : (s.stopReason ?? 'other');
  const cost = priced(s, usage);
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

/**
 * What a failed attempt is billed: the provider's reported usage if any, else estimated
 * usage when text was streamed (the provider generated it), else nothing.
 */
function failedUsage(s: StreamState): { usage: Usage; usageBasis: UsageBasis } | null {
  if (s.usage !== null) return { usage: s.usage, usageBasis: 'reported' };
  if (s.text === '') return null;
  const usage = { inputTokens: s.estimate?.inputTokens ?? 0, outputTokens: estimateTokens(s.text) };
  return { usage, usageBasis: 'estimated' };
}

/** Journals the `error` event, keeping any text streamed before the failure, and its cost. */
function failed(ctx: AttemptContext, s: StreamState, err: unknown): AttemptOutcome {
  const durationMs = ctx.now() - s.started;
  const kind = err instanceof ProviderError ? err.kind : 'internal';
  const message = err instanceof Error ? err.message : String(err);
  const billed = failedUsage(s);
  const cost = billed ? priced(s, billed.usage) : 0;
  ctx.journal.append({
    ...who(ctx),
    sessionId: ctx.sessionId,
    type: 'error',
    ...(billed ? { costUsd: cost } : {}),
    payload: {
      requestId: s.requestId,
      attempt: ctx.index,
      kind,
      message,
      ...(err instanceof ProviderError && err.status !== undefined ? { status: err.status } : {}),
      partialText: s.text,
      ...(billed ? { ...billed.usage, usageBasis: billed.usageBasis } : {}),
      durationMs,
    },
  });
  if (!(err instanceof ProviderError)) throw err;
  return { status: 'failed', error: err, partialText: s.text, costUsd: cost, durationMs };
}
