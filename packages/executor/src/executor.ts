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
  type ScoredCandidate,
  type TaskNode,
  type TaskType,
} from '@kernelpai/core';
import type { Journal } from '@kernelpai/journal';
import { runAttempt, type AttemptOutcome } from './attempt.js';
import type { StallTimeouts } from './watchdog.js';

/** Maps a routed model to the adapter serving it, e.g. `(ref) => registry.get(ref.provider)`. */
export type AdapterResolver = (ref: ModelRef) => ProviderAdapter;

export interface FallbackExecutorOptions {
  /** Clock in ms, injectable for tests. */
  now?: () => number;
  /**
   * Max wait (ms) for the first stream event of an attempt. On expiry the attempt is
   * aborted and fails as `unavailable` (fallback-eligible). Default 30,000; 0 disables.
   */
  firstChunkTimeoutMs?: number;
  /** Max gap (ms) between stream events once output began; same handling. Default 60,000. */
  idleTimeoutMs?: number;
  /**
   * Typical output tokens for a model and task type (e.g. `outputCalibration(journal)`),
   * used for the `call` event's expected cost. Undefined = heuristic (a quarter of the cap).
   */
  expectedOutput?: (ref: ModelRef, taskType: TaskType) => number | undefined;
}

export const DEFAULT_FIRST_CHUNK_TIMEOUT_MS = 30_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

interface ExecuteOptions {
  sessionId: string;
  signal?: AbortSignal;
  hooks?: ExecutionHooks;
}

const NO_USAGE = { inputTokens: 0, outputTokens: 0 };

/** Why the chain ended without an answer. */
type EndCause = 'exhausted' | 'policy';

/**
 * Executes a routed node: `decision.chosen` first, then `decision.fallbacks` in order.
 *
 * - A `ProviderError` whose `fallbackEligible` is true (rate_limit, unavailable, refusal,
 *   malformed) journals `error` then `routing` ("fallback to X after Y: kind") and moves on.
 * - Any other error (auth, bad_request, budget) stops: no further model is tried.
 * - Cancellation through `signal` stops everything; the partial text is kept and billed
 *   (from estimates when the provider reported no usage).
 * - Text streamed by a failed attempt is discarded for the next attempt but journaled
 *   as `partialText` on its `error` event, billed (reported usage, else estimated).
 * - A stalled stream (no event within `firstChunkTimeoutMs` / `idleTimeoutMs`) fails that
 *   attempt as `unavailable` and falls back; only the caller's `signal` cancels everything.
 * - Before each fallback, `hooks.beforeFallback(next, failed)` is awaited; false (or a
 *   throw) stops the chain, journals an `intervention`, and returns no answer ('other').
 *
 * `ExecutionResult.costUsd` is the total billed over all attempts (failed ones included);
 * `usage` and `text` are those of the serving attempt.
 */
export class FallbackExecutor implements Executor {
  private readonly resolve: AdapterResolver;
  private readonly journal: Journal;
  private readonly now: () => number;
  private readonly timeouts: StallTimeouts;
  private readonly expectedOutput: FallbackExecutorOptions['expectedOutput'];

  constructor(resolve: AdapterResolver, journal: Journal, options: FallbackExecutorOptions = {}) {
    this.resolve = resolve;
    this.journal = journal;
    this.now = options.now ?? (() => Date.now());
    this.timeouts = {
      firstChunkMs: options.firstChunkTimeoutMs ?? DEFAULT_FIRST_CHUNK_TIMEOUT_MS,
      idleMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    };
    this.expectedOutput = options.expectedOutput;
  }

  async execute(
    node: TaskNode,
    decision: RoutingDecision,
    options: ExecuteOptions,
  ): Promise<ExecutionResult> {
    const candidates = [decision.chosen, ...decision.fallbacks];
    const attempts: Attempt[] = [];
    let cost = 0;
    let lastError: ProviderError | undefined;
    let cause: EndCause = 'exhausted';
    for (const [index, { ref }] of candidates.entries()) {
      if (options.signal?.aborted) break;
      options.hooks?.onAttemptStart?.(ref, index);
      const outcome = await this.attempt(node, ref, index, options);
      const attempt = toAttempt(ref, outcome);
      attempts.push(attempt);
      cost += outcome.costUsd;
      if (outcome.status !== 'failed') {
        return succeeded(node, { ref, index, outcome, attempts, costUsd: total(cost) });
      }
      options.hooks?.onAttemptFailed?.(attempt);
      lastError = outcome.error;
      const next = candidates[index + 1];
      if (!outcome.error.fallbackEligible || !next) break;
      if (!(await this.mayFallBack(node, options, next, attempt))) {
        cause = 'policy';
        break;
      }
      const step = { from: ref, to: next.ref, index: index + 1 };
      this.journalFallback(node, options.sessionId, step, lastError);
    }
    const aborted = options.signal?.aborted === true;
    return failedResult(node, attempts, { lastError, aborted, cause, costUsd: total(cost) });
  }

  /** Awaits `hooks.beforeFallback`; a refusal or a throw stops the chain and is journaled. */
  private async mayFallBack(
    node: TaskNode,
    options: ExecuteOptions,
    next: ScoredCandidate,
    failed: Attempt,
  ): Promise<boolean> {
    const hook = options.hooks?.beforeFallback;
    if (!hook) return true;
    let error: string | undefined;
    try {
      if ((await hook(next, failed)) !== false) return true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    this.journal.append({
      sessionId: options.sessionId,
      type: 'intervention',
      nodeId: node.id,
      provider: next.ref.provider,
      model: next.ref.model,
      payload: {
        action: 'fallback stopped by policy',
        next: refToString(next.ref),
        after: refToString(failed.ref),
        ...(error !== undefined ? { error } : {}),
      },
    });
    return false;
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
      taskType: node.type,
      ref,
      index,
      expectedOutputTokens: this.expectedOutput?.(ref, node.type),
      timeouts: this.timeouts,
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

const total = (n: number): number => Math.round(n * 1e6) / 1e6;

function succeeded(
  node: TaskNode,
  r: {
    ref: ModelRef;
    index: number;
    outcome: Exclude<AttemptOutcome, { status: 'failed' }>;
    attempts: Attempt[];
    costUsd: number;
  },
): ExecutionResult {
  return {
    nodeId: node.id,
    servedBy: r.ref,
    text: r.outcome.text,
    usage: r.outcome.usage,
    costUsd: r.costUsd,
    stopReason: r.outcome.stopReason,
    attempts: r.attempts,
    fellBack: r.index > 0,
  };
}

/**
 * No model answered: every attempt failed, a non-eligible error or the fallback policy
 * stopped us, or a cancel came before the start. Failed attempts may still have cost.
 */
function failedResult(
  node: TaskNode,
  attempts: Attempt[],
  end: { lastError: ProviderError | undefined; aborted: boolean; cause: EndCause; costUsd: number },
): ExecutionResult {
  const refused = end.cause === 'exhausted' && end.lastError?.kind === 'refusal';
  return {
    nodeId: node.id,
    servedBy: null,
    text: '',
    usage: NO_USAGE,
    costUsd: end.costUsd,
    stopReason: end.aborted ? 'cancelled' : refused ? 'refusal' : 'other',
    attempts,
    fellBack: false,
  };
}
