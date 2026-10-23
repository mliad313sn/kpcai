import {
  refToString,
  type Attempt,
  type ChatRequest,
  type ExecutionHooks,
  type ExecutionResult,
  type Executor,
  type ModelRef,
  type ProviderAdapter,
  type ProviderError,
  type RoutingDecision,
  type TaskNode,
} from '@kernelpai/core';
import type { Journal } from '@kernelpai/journal';
import { runAttempt, type AttemptOutcome } from './attempt.js';

/** Maps a routed model to the adapter serving it, e.g. `(ref) => registry.get(ref.provider)`. */
export type AdapterResolver = (ref: ModelRef) => ProviderAdapter;

export interface FallbackExecutorOptions {
  /** Clock in ms, injectable for tests. */
  now?: () => number;
}

interface ExecuteOptions {
  sessionId: string;
  signal?: AbortSignal;
  hooks?: ExecutionHooks;
}

const NO_USAGE = { inputTokens: 0, outputTokens: 0 };

/**
 * Executes a routed node: `decision.chosen` first, then `decision.fallbacks` in order.
 *
 * - A `ProviderError` whose `fallbackEligible` is true (rate_limit, unavailable, refusal,
 *   malformed) journals `error` then `routing` ("fallback to X after Y: kind") and moves on.
 * - Any other error (auth, bad_request, budget) stops: no further model is tried.
 * - Cancellation through `signal` stops everything; the partial text is kept and billed
 *   (from estimates when the provider reported no usage).
 * - Text streamed by a failed attempt is discarded for the next attempt but journaled
 *   as `partialText` on its `error` event.
 */
export class FallbackExecutor implements Executor {
  private readonly resolve: AdapterResolver;
  private readonly journal: Journal;
  private readonly now: () => number;

  constructor(resolve: AdapterResolver, journal: Journal, options: FallbackExecutorOptions = {}) {
    this.resolve = resolve;
    this.journal = journal;
    this.now = options.now ?? (() => Date.now());
  }

  async execute(
    node: TaskNode,
    decision: RoutingDecision,
    options: ExecuteOptions,
  ): Promise<ExecutionResult> {
    const refs = [decision.chosen, ...decision.fallbacks].map((c) => c.ref);
    const attempts: Attempt[] = [];
    let lastError: ProviderError | undefined;
    for (const [index, ref] of refs.entries()) {
      if (options.signal?.aborted) break;
      options.hooks?.onAttemptStart?.(ref, index);
      const outcome = await this.attempt(node, ref, index, options);
      const attempt = toAttempt(ref, outcome);
      attempts.push(attempt);
      if (outcome.status !== 'failed') return succeeded(node, ref, index, outcome, attempts);
      options.hooks?.onAttemptFailed?.(attempt);
      lastError = outcome.error;
      const next = refs[index + 1];
      if (!outcome.error.fallbackEligible || !next) break;
      this.journalFallback(
        node,
        options.sessionId,
        { from: ref, to: next, index: index + 1 },
        lastError,
      );
    }
    return failedResult(node, attempts, lastError, options.signal?.aborted === true);
  }

  private attempt(
    node: TaskNode,
    ref: ModelRef,
    index: number,
    options: ExecuteOptions,
  ): Promise<AttemptOutcome> {
    const req: ChatRequest = {
      model: ref.model,
      messages: node.messages,
      ...(node.maxOutputTokens ? { maxOutputTokens: node.maxOutputTokens } : {}),
    };
    return runAttempt({
      journal: this.journal,
      sessionId: options.sessionId,
      nodeId: node.id,
      ref,
      index,
      resolve: () => this.resolve(ref),
      req,
      signal: options.signal,
      hooks: options.hooks,
      now: this.now,
    });
  }

  private journalFallback(
    node: TaskNode,
    sessionId: string,
    step: { from: ModelRef; to: ModelRef; index: number },
    err: ProviderError,
  ): void {
    const from = refToString(step.from);
    this.journal.append({
      sessionId,
      type: 'routing',
      nodeId: node.id,
      provider: step.to.provider,
      model: step.to.model,
      payload: {
        reason: `fallback to ${refToString(step.to)} after ${from}: ${err.kind}`,
        fallbackFrom: from,
        attempt: step.index,
        kind: err.kind,
      },
    });
  }
}

function toAttempt(ref: ModelRef, outcome: AttemptOutcome): Attempt {
  if (outcome.status !== 'failed') {
    return outcome.status === 'ok'
      ? { ref, ok: true, durationMs: outcome.durationMs }
      : { ref, ok: false, errorKind: 'cancelled', durationMs: outcome.durationMs };
  }
  return {
    ref,
    ok: false,
    errorKind: outcome.error.kind,
    message: outcome.error.message,
    durationMs: outcome.durationMs,
  };
}

function succeeded(
  node: TaskNode,
  ref: ModelRef,
  index: number,
  outcome: Exclude<AttemptOutcome, { status: 'failed' }>,
  attempts: Attempt[],
): ExecutionResult {
  return {
    nodeId: node.id,
    servedBy: ref,
    text: outcome.text,
    usage: outcome.usage,
    costUsd: outcome.costUsd,
    stopReason: outcome.stopReason,
    attempts,
    fellBack: index > 0,
  };
}

/** No model answered: every attempt failed, a non-eligible error stopped us, or cancel before start. */
function failedResult(
  node: TaskNode,
  attempts: Attempt[],
  lastError: ProviderError | undefined,
  aborted: boolean,
): ExecutionResult {
  return {
    nodeId: node.id,
    servedBy: null,
    text: '',
    usage: NO_USAGE,
    costUsd: 0,
    stopReason: aborted ? 'cancelled' : lastError?.kind === 'refusal' ? 'refusal' : 'other',
    attempts,
    fellBack: false,
  };
}
