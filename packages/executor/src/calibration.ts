import type { ModelRef, TaskType } from '@kernelpai/core';
import type { Journal, JournalEvent } from '@kernelpai/journal';

export interface OutputCalibrationOptions {
  /** Most recent successful responses kept per (provider, model, task type). Default 20. */
  window?: number;
  /** Fewer samples than this → undefined (heuristic). Default 3. */
  minSamples?: number;
  /** Maximum journal events read (most recent). Default 100,000. */
  limit?: number;
}

/** Stop reasons that do not count as a typical answer. */
const NOT_ANSWERED = new Set(['cancelled', 'refusal']);

const key = (provider: string, model: string, taskType: string): string =>
  `${provider}\u0000${model}\u0000${taskType}`;

export function median(xs: readonly number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] as number;
  return sorted.length % 2 ? hi : ((sorted[mid - 1] as number) + hi) / 2;
}

/**
 * Typical output per model and task type, learned from the journal, for
 * `FallbackExecutorOptions.expectedOutput`: the median reported `outputTokens` of the
 * last `window` successful responses of that provider/model/taskType. The task type
 * comes from the `call` event with the same `requestId`. Responses billed from
 * estimates, cancelled or refused are ignored. The journal is read once, now.
 */
export function outputCalibration(
  journal: Journal,
  options: OutputCalibrationOptions = {},
): (ref: ModelRef, taskType: TaskType) => number | undefined {
  const window = options.window ?? 20;
  const minSamples = options.minSamples ?? 3;
  const samples = collect(journal.events({ limit: options.limit ?? 100_000 }));
  const medians = new Map<string, number>();
  for (const [k, xs] of samples) {
    const recent = xs.slice(-window);
    const m = median(recent);
    if (recent.length >= minSamples && m !== undefined) medians.set(k, m);
  }
  return (ref, taskType) => medians.get(key(ref.provider, ref.model, taskType));
}

function collect(events: readonly JournalEvent[]): Map<string, number[]> {
  const taskTypeOf = new Map<string, string>();
  const samples = new Map<string, number[]>();
  for (const e of events) {
    const requestId = e.payload.requestId;
    if (typeof requestId !== 'string') continue;
    if (e.type === 'call' && typeof e.payload.taskType === 'string') {
      taskTypeOf.set(requestId, e.payload.taskType);
    } else if (e.type === 'response') {
      const taskType = taskTypeOf.get(requestId);
      const out = e.payload.outputTokens;
      const stop = e.payload.stopReason;
      if (taskType === undefined || !e.provider || !e.model) continue;
      if (e.payload.usageBasis !== 'reported' || typeof out !== 'number' || !(out > 0)) continue;
      if (typeof stop === 'string' && NOT_ANSWERED.has(stop)) continue;
      const k = key(e.provider, e.model, taskType);
      samples.set(k, [...(samples.get(k) ?? []), out]);
    }
  }
  return samples;
}
