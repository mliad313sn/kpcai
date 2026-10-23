import type { Journal, JournalEvent } from '@kernelpai/journal';

export interface MetricsFilter {
  sessionId?: string;
  /** Maximum events read (most recent first when no session is given). Default 100,000. */
  limit?: number;
}

export interface EstimateError {
  samples: number;
  /** mean(|est − actual| ÷ actual) × 100. */
  meanAbsPct: number | null;
  /** mean((est − actual) ÷ actual) × 100; positive = we over-estimate. */
  meanSignedPct: number | null;
}

export interface ExecutorMetrics {
  /** Distinct (session, node) pairs with at least one `call` event. */
  tasks: number;
  calls: number;
  /** `routing` events carrying `payload.fallbackFrom`. */
  fallbacks: number;
  /** Tasks with ≥ 1 fallback ÷ tasks. Null when there are no tasks. */
  fallbackRate: number | null;
  /** Fell-back tasks that got an answer ÷ fell-back tasks. Null when nothing fell back. */
  fallbackSuccessRate: number | null;
  /**
   * Σ event cost_usd of the tasks ÷ tasks, failed attempts included (their `error`
   * events carry the billed cost). Null when there are no tasks.
   */
  avgCostPerTaskUsd: number | null;
  /** Input-token estimate vs reported input tokens (calls whose response reported > 0). */
  estimateError: EstimateError;
  /** `call` estimatedCostUsd (expected) vs the response's cost, reported usage and cost > 0. */
  costError: EstimateError;
  /** `call` estimatedOutputTokens (expected) vs reported output tokens > 0. */
  outputTokenError: EstimateError;
  /** Nearest-rank percentiles of `routing` events' `payload.elapsedMs`. */
  routerLatencyMs: { samples: number; p50: number | null; p95: number | null };
}

interface TaskState {
  cost: number;
  fellBack: boolean;
  answered: boolean;
  /** Estimates of the latest `call`, consumed by the next `response`. */
  pending: Pending | null;
}

interface Pending {
  input: number | null;
  output: number | null;
  cost: number | null;
}

/** Relative errors (est − actual) ÷ actual, one list per metric. */
interface Samples {
  input: number[];
  output: number[];
  cost: number[];
}

const NOT_ANSWERED = new Set(['cancelled', 'refusal']);

const taskKey = (e: JournalEvent): string => `${e.sessionId}\u0000${e.nodeId ?? ''}`;
// `|| 0` turns −0 (a tiny negative float error) into 0.
const round = (n: number, digits: number): number => Number(n.toFixed(digits)) || 0;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

/**
 * Executor and router health from the journal (WP3 item 4).
 * Tasks are keyed by (session, node). Each `response` is paired with the latest `call`
 * of the same task to measure the token estimate; responses billed from estimates are
 * skipped, since comparing an estimate with itself says nothing.
 */
export function metrics(journal: Journal, filter: MetricsFilter = {}): ExecutorMetrics {
  const events = journal.events({
    ...(filter.sessionId ? { sessionId: filter.sessionId } : {}),
    limit: filter.limit ?? 100_000,
  });
  const tasks = new Map<string, TaskState>();
  const errors: Samples = { input: [], output: [], cost: [] };
  const latencies: number[] = [];
  let calls = 0;
  let fallbacks = 0;
  for (const e of events) {
    const t = tasks.get(taskKey(e)) ?? {
      cost: 0,
      fellBack: false,
      answered: false,
      pending: null,
    };
    t.cost += e.costUsd ?? 0;
    if (e.type === 'call') {
      calls++;
      t.pending = {
        input: num(e.payload.estimatedInputTokens),
        output: num(e.payload.estimatedOutputTokens),
        cost: num(e.payload.estimatedCostUsd),
      };
      tasks.set(taskKey(e), t);
    } else if (e.type === 'response') {
      onResponse(e, t, errors);
    } else if (e.type === 'routing') {
      if (typeof e.payload.fallbackFrom === 'string') {
        fallbacks++;
        t.fellBack = true;
      }
      const ms = num(e.payload.elapsedMs);
      if (ms !== null) latencies.push(ms);
    }
  }
  return summarise({ tasks: [...tasks.values()], calls, fallbacks, errors, latencies });
}

function onResponse(e: JournalEvent, t: TaskState, errors: Samples): void {
  const stop = e.payload.stopReason;
  if (typeof stop !== 'string' || !NOT_ANSWERED.has(stop)) t.answered = true;
  const p = t.pending;
  t.pending = null;
  if (e.payload.usageBasis !== 'reported' || p === null) return;
  const sample = (list: number[], est: number | null, actual: number | null): void => {
    if (est !== null && actual) list.push((est - actual) / actual);
  };
  sample(errors.input, p.input, num(e.payload.inputTokens));
  sample(errors.output, p.output, num(e.payload.outputTokens));
  sample(errors.cost, p.cost, num(e.costUsd));
}

function summarise(d: {
  tasks: TaskState[];
  calls: number;
  fallbacks: number;
  errors: Samples;
  latencies: number[];
}): ExecutorMetrics {
  const n = d.tasks.length;
  const fell = d.tasks.filter((t) => t.fellBack);
  const sorted = [...d.latencies].sort((a, b) => a - b);
  return {
    tasks: n,
    calls: d.calls,
    fallbacks: d.fallbacks,
    fallbackRate: n ? round(fell.length / n, 4) : null,
    fallbackSuccessRate: fell.length
      ? round(fell.filter((t) => t.answered).length / fell.length, 4)
      : null,
    avgCostPerTaskUsd: n ? round(d.tasks.reduce((s, t) => s + t.cost, 0) / n, 6) : null,
    estimateError: estimateError(d.errors.input),
    costError: estimateError(d.errors.cost),
    outputTokenError: estimateError(d.errors.output),
    routerLatencyMs: {
      samples: sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
    },
  };
}

function estimateError(xs: number[]): EstimateError {
  const mean = (ys: number[]): number | null =>
    ys.length ? round((ys.reduce((a, b) => a + b, 0) / ys.length) * 100, 2) : null;
  return { samples: xs.length, meanAbsPct: mean(xs.map(Math.abs)), meanSignedPct: mean(xs) };
}
