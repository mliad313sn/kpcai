import { estimateTokens, type ChatMessage, type ModelRef, type TaskType } from '@kernelpai/core';
import type { Journal, JournalEvent } from '@kernelpai/journal';

/** Extra tool rounds per model step (0 = answered without tools), learned or heuristic. */
export interface ToolRounds {
  low: number;
  high: number;
  /** Tokens of the tool results fed back per round (high quantile). */
  resultTokens: number;
  /** Output tokens of a tool-call turn (high quantile); the last round is the answer. */
  callTokens: number;
  /** Steps with tools offered behind the figures (0 when heuristic). */
  samples: number;
}

/** Spread of a model's output length on a task type, learned from the journal (tokens). */
export interface OutputSpread {
  low: number;
  median: number;
  high: number;
  samples: number;
  /** Tool rounds of this model on this task type, when it was offered tools often enough. */
  toolRounds?: ToolRounds;
  /**
   * Reported ÷ estimated input tokens of this model (the estimator counts 4 characters a
   * token; real tokenizers differ), low and high quantiles.
   */
  inputRatio?: { low: number; high: number };
}

/**
 * Spread for a model and task type; with `role`, that role's own history first (a critic's
 * verdict and an author's answer on the same model and type differ), else the type's.
 */
export type SpreadFn = (
  ref: ModelRef,
  taskType: TaskType,
  role?: string,
) => OutputSpread | undefined;

export interface OutputSpreadOptions {
  /** Most recent successful responses kept per (provider, model, task type). Default 20. */
  window?: number;
  /** Fewer samples than this → no spread (heuristic band). Default 3. */
  minSamples?: number;
  /** Maximum journal events read (most recent). Default 100,000. */
  limit?: number;
  /**
   * Quantiles taken as the low and high ends. Default 0.05 and 0.95: a graph's cost moves
   * with its request size in every step at once, so the ends of a sum are about as rare
   * as one step's; 0.1/0.9 left one run in five outside the band on the bench.
   */
  lowQuantile?: number;
  highQuantile?: number;
}

/** Linear-interpolated quantile of a non-empty list. */
export function quantile(xs: readonly number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const pos = Math.min(1, Math.max(0, q)) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (s[lo] as number) + ((s[hi] as number) - (s[lo] as number)) * (pos - lo);
}

const NOT_ANSWERED = new Set(['cancelled', 'refusal']);
const key = (...parts: string[]): string => parts.join('\u0000');

interface CallInfo {
  type: string;
  role: string | undefined;
  /** Tool round of the call: assistant tool-call turns already in the conversation. */
  round: number;
  /** Tools were offered on this call. */
  tools: boolean;
  /** Tokens of the tool results this call feeds back (its trailing `tool` turns). */
  results: number;
  /** The executor's input estimate of the call. */
  estimatedInput: number | undefined;
}

interface Samples {
  outputs: Map<string, number[]>;
  /** Successful tool-offered calls per round index, per (provider, model, type). */
  rounds: Map<string, number[]>;
  results: Map<string, number[]>;
  /** Output tokens of tool-call turns. */
  calls: Map<string, number[]>;
  /** Reported ÷ estimated input tokens per (provider, model). */
  ratios: Map<string, number[]>;
}

/**
 * Output spread per model, task type and role from the journal (reported output tokens of
 * successful answers; tool-call turns are counted as tool rounds instead), plus the tool
 * rounds per step: of S steps offered tools, the number reaching round k is the count of
 * successful calls whose conversation already holds k assistant tool-call turns. The
 * journal is read once, now.
 */
export function outputSpread(journal: Journal, options: OutputSpreadOptions = {}): SpreadFn {
  const window = options.window ?? 20;
  const minSamples = Math.max(1, options.minSamples ?? 3);
  const qLow = options.lowQuantile ?? 0.05;
  const qHigh = options.highQuantile ?? 0.95;
  const s = collect(journal.events({ limit: options.limit ?? 100_000 }));
  const rounds = new Map<string, ToolRounds>();
  for (const [k, counts] of s.rounds) {
    const r = toolRounds(counts, s.results.get(k) ?? [], s.calls.get(k) ?? [], qHigh, qLow);
    if (r.samples >= minSamples) rounds.set(k, r);
  }
  const ratio = (k: string): OutputSpread['inputRatio'] => {
    const xs = s.ratios.get(k.split('\u0000').slice(0, 2).join('\u0000'))?.slice(-window);
    return xs && xs.length >= minSamples
      ? { low: quantile(xs, qLow), high: quantile(xs, qHigh) }
      : undefined;
  };
  const spreads = new Map<string, OutputSpread>();
  for (const [k, xs] of s.outputs) {
    const recent = xs.slice(-window);
    if (recent.length < minSamples) continue;
    const tr = rounds.get(k.split('\u0000').slice(0, 3).join('\u0000'));
    const ir = ratio(k);
    spreads.set(k, {
      low: quantile(recent, qLow),
      median: quantile(recent, 0.5),
      high: quantile(recent, qHigh),
      samples: recent.length,
      ...(tr ? { toolRounds: tr } : {}),
      ...(ir ? { inputRatio: ir } : {}),
    });
  }
  return (ref, taskType, role) =>
    (role !== undefined ? spreads.get(key(ref.provider, ref.model, taskType, role)) : undefined) ??
    spreads.get(key(ref.provider, ref.model, taskType));
}

/** Rounds per step from per-round call counts: P(rounds ≥ k) = counts[k] / counts[0]. */
function toolRounds(
  counts: number[],
  results: number[],
  calls: number[],
  qHigh: number,
  qLow: number,
): ToolRounds {
  const steps = counts[0] ?? 0;
  const at = (q: number): number => {
    let k = 0;
    while (steps > 0 && (counts[k + 1] ?? 0) / steps > 1 - q) k++;
    return k;
  };
  return {
    low: at(qLow),
    high: at(qHigh),
    resultTokens: results.length ? Math.ceil(quantile(results, qHigh)) : 0,
    callTokens: calls.length ? Math.ceil(quantile(calls, qHigh)) : 0,
    samples: steps,
  };
}

function callInfo(payload: Record<string, unknown>): CallInfo | undefined {
  if (typeof payload.taskType !== 'string') return undefined;
  const req = payload.request as { messages?: ChatMessage[]; tools?: unknown[] } | undefined;
  const messages = Array.isArray(req?.messages) ? req.messages : [];
  let results = 0;
  for (let i = messages.length - 1; i >= 0 && messages[i]?.role === 'tool'; i--) {
    results += estimateTokens(String(messages[i]?.content ?? ''));
  }
  return {
    type: payload.taskType,
    role: typeof payload.role === 'string' ? payload.role : undefined,
    round: messages.filter((m) => m?.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0).length,
    tools: Array.isArray(req?.tools) && req.tools.length > 0,
    results,
    estimatedInput:
      typeof payload.estimatedInputTokens === 'number' ? payload.estimatedInputTokens : undefined,
  };
}

function push<T>(m: Map<string, T[]>, k: string, x: T): void {
  const xs = m.get(k);
  if (xs) xs.push(x);
  else m.set(k, [x]);
}

function collect(events: readonly JournalEvent[]): Samples {
  const calls = new Map<string, CallInfo>();
  const s: Samples = {
    outputs: new Map(),
    rounds: new Map(),
    results: new Map(),
    calls: new Map(),
    ratios: new Map(),
  };
  for (const e of events) {
    const requestId = e.payload.requestId;
    if (typeof requestId !== 'string') continue;
    if (e.type === 'call') {
      const info = callInfo(e.payload);
      if (info) calls.set(requestId, info);
      continue;
    }
    const c = calls.get(requestId);
    if (e.type !== 'response' || !e.provider || !e.model || !c) continue;
    const out = e.payload.outputTokens;
    const stop = e.payload.stopReason;
    if (e.payload.usageBasis !== 'reported') continue;
    if (typeof stop === 'string' && NOT_ANSWERED.has(stop)) continue;
    const typeKey = key(e.provider, e.model, c.type);
    const input = e.payload.inputTokens;
    if (typeof input === 'number' && input > 0 && c.estimatedInput && c.estimatedInput > 0) {
      push(s.ratios, key(e.provider, e.model), input / c.estimatedInput);
    }
    if (c.tools) {
      const counts = s.rounds.get(typeKey) ?? [];
      counts[c.round] = (counts[c.round] ?? 0) + 1;
      s.rounds.set(typeKey, counts);
      if (c.round > 0) push(s.results, typeKey, c.results);
    }
    if (typeof out !== 'number' || !(out > 0)) continue;
    if (stop === 'tool_use') {
      push(s.calls, typeKey, out);
      continue;
    }
    push(s.outputs, typeKey, out);
    if (c.role !== undefined) push(s.outputs, key(e.provider, e.model, c.type, c.role), out);
  }
  return s;
}
