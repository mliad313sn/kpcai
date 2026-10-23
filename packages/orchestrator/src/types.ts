import type {
  Candidate,
  Contribution,
  ContributionRole,
  GraphEvent,
  GraphNode,
  ModelRef,
  Router,
  RoutingConstraints,
  RoutingDecision,
  ScoredCandidate,
  ToolBus,
} from '@kernelpai/core';
import type { AdapterResolver, FallbackExecutorOptions } from '@kernelpai/executor';
import type { Journal } from '@kernelpai/journal';

/**
 * Spend gate called before every model step and every fallback (principle 6), with the
 * same semantics as the CLI's `BudgetGate.allow`: resolve false to block (the step does not
 * run), ask the human inside the hook for a confirmation verdict.
 */
export type BudgetHook = (candidate: ScoredCandidate, label: string) => boolean | Promise<boolean>;

/** Everything the orchestrator needs, injected (no CLI imports). */
export interface OrchestratorOptions {
  router: Router;
  /** Available models (e.g. from `candidates(registry)`). */
  candidates: readonly Candidate[];
  /** Base constraints for every step; diversity exclusions are added on top. */
  constraints?: RoutingConstraints;
  resolve: AdapterResolver;
  journal: Journal;
  sessionId: string;
  /** Default: allow everything. */
  budget?: BudgetHook;
  /** Tool bus for nodes that list tools; without one, nodes run without tools. */
  tools?: ToolBus;
  /** Human confirmation for tool permissions; default declines (non-interactive). */
  confirm?: (question: string) => Promise<boolean>;
  /** Workspace root handed to tools; default `process.cwd()`. */
  root?: string;
  /**
   * Principle 2 override: when no other provider can act as critic/debater, run with the
   * same provider anyway (journaled as an intervention). Default false: the node fails.
   */
  allowSameProvider?: boolean;
  /** Passed to the internal `FallbackExecutor`. */
  executor?: FallbackExecutorOptions;
  /**
   * Cumulative cap for one graph run (USD). When the next call would take the total above
   * it, the budget hook is asked once with a label starting `graph total`; no hook or a
   * refusal stops every further step. Default: no cap.
   */
  maxGraphUsd?: number;
  /** Ready nodes run in parallel up to this many. Default 3. */
  concurrency?: number;
  /** Max tool rounds per model step. Default 8. */
  maxToolRounds?: number;
  /** Author+critic: max revisions after the first draft. Default 2. */
  maxRevisions?: number;
  /** Vote: number of voters wanted. Default 3. */
  voters?: number;
  /** Live progress feed (node states, text deltas, contributions, graph done). */
  onEvent?: (event: GraphEvent) => void;
  /** Run control feed (pause, resume, cancel, redirect, instruction, refusal). */
  onControl?: (event: RunControlEvent) => void;
}

/**
 * A graph node as the user approved it (R-301, principle 4). `model` pins the node's
 * first step (solo answer, author, first debater, first voter) to that model; later steps
 * are routed as usual (critics away from the author's provider, revisions on the author).
 * A pinned step has no automatic fallback to another model: the user's choice is kept and
 * a failure is reported, so the user can redirect again.
 */
export interface PlannedNode extends GraphNode {
  model?: ModelRef;
}

/** Run-level control events (principle 4, R-304); node states still go through `onEvent`. */
export type RunControlEvent =
  | { type: 'run_paused'; inFlight: string[] }
  | { type: 'run_resumed' }
  | { type: 'run_cancelled' }
  | {
      type: 'node_redirected';
      nodeId: string;
      from: ModelRef | null;
      to: ModelRef;
      /** True when a running attempt was cancelled to rerun on `to`. */
      restarted: boolean;
      /** Later steps whose model changed because of the redirect (e.g. the critic). */
      reroutes: Reroute[];
    }
  | { type: 'instruction_added'; nodeId: string; text: string }
  | { type: 'control_refused'; action: ControlAction; nodeId?: string; reason: string };

export type ControlAction = 'pause' | 'resume' | 'cancel' | 'redirect' | 'instruction';

export interface Reroute {
  role: ContributionRole;
  from: ModelRef;
  to: ModelRef;
}

export const DEFAULT_CONCURRENCY = 3;
export const DEFAULT_MAX_TOOL_ROUNDS = 8;
export const DEFAULT_MAX_REVISIONS = 2;
export const DEFAULT_VOTERS = 3;

/** Mutable state of one node while its protocol runs. */
export interface NodeRun {
  node: GraphNode;
  /** Dependency outputs, already formatted as untrusted context. */
  context: string;
  signal?: AbortSignal | undefined;
  /** Providers that contributed to the dependencies (a review avoids them when it can). */
  upstream?: string[];
  contributions: Contribution[];
  costUsd: number;
  /** The user's model for the node's first step; taken (cleared) by that step. */
  pin?: ModelRef | undefined;
}

/** A finished model step. */
export interface StepOk {
  ok: true;
  ref: ModelRef;
  text: string;
  costUsd: number;
  /** The candidate that served (for competence weighting). */
  served: ScoredCandidate;
  /** The decision the step started from (before any tool-round reordering). */
  decision: RoutingDecision;
  contribution: Contribution;
}

export interface StepFailed {
  ok: false;
  error: string;
  cancelled: boolean;
  costUsd: number;
  /** True when principle 2 could not be met (no other provider). */
  diversity?: boolean;
}

export type StepOutcome = StepOk | StepFailed;

export interface StepSpec {
  role: ContributionRole;
  /** Full text of the final user message; must start with the `Role: <role>` line. */
  prompt: string;
  /** Task type to route on; default the node's. */
  type?: GraphNode['type'];
  /** Providers that must not serve this step (principle 2). */
  exclude?: string[];
  /**
   * `hard` (default): fail when exclusion leaves no candidate, unless `allowSameProvider`.
   * `strict`: like `hard` but never waived (a second vote from the same provider is useless).
   */
  diversity?: 'hard' | 'strict';
  /** Try this model first when it survives routing (author revising its own draft). */
  prefer?: ModelRef;
  /** Only this model, no routing (retry after invalid output). */
  only?: ModelRef;
  /** Offer the node's tools. Default true. */
  tools?: boolean;
}

/** Thrown when a step cannot even be routed; the protocol turns it into a node failure. */
export class OrchestrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrchestrationError';
  }
}
