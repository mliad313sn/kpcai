import type { ProviderErrorKind } from './errors.js';
import type { ModelRef, RoutingDecision, TaskNode } from './routing.js';
import type { StopReason, Usage } from './schemas.js';

export interface Attempt {
  ref: ModelRef;
  ok: boolean;
  errorKind?: ProviderErrorKind;
  message?: string;
  durationMs: number;
}

export interface ExecutionResult {
  nodeId: string;
  /** The model that produced the final answer, if any succeeded. */
  servedBy: ModelRef | null;
  text: string;
  usage: Usage;
  costUsd: number;
  stopReason: StopReason;
  attempts: Attempt[];
  /** True when the answer came from a fallback rather than the first choice. */
  fellBack: boolean;
}

export interface ExecutionHooks {
  onText?(delta: string, ref: ModelRef): void;
  onAttemptStart?(ref: ModelRef, index: number): void;
  onAttemptFailed?(attempt: Attempt): void;
}

export interface Executor {
  execute(
    node: TaskNode,
    decision: RoutingDecision,
    options: { sessionId: string; signal?: AbortSignal; hooks?: ExecutionHooks },
  ): Promise<ExecutionResult>;
}

/** Task-type classification of a request (phase 1: heuristic; ADR to come). */
export interface Classification {
  type: TaskNode['type'];
  confidence: number;
  reason: string;
}
