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
import type { TestEvidence } from '@kernelpai/tools';
import type { AgentDescriptor, AgentRunner, Env } from '@kernelpai/providers';
import type { AgentBudgetLimits } from './agent-budget.js';
import type { SourceLimits } from './source-limits.js';
import type { Deliverable } from './deliverable.js';
import type { DisputeHook, DisputeKind } from './dispute.js';
import type { ReviewPolicy } from './review-policy.js';

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
  /** Run control feed (pause, resume, cancel, redirect, instruction, refusal, disputes). */
  onControl?: (event: RunControlEvent) => void;
  /**
   * Review depth by criticality (R-404). When set, nodes planned as solo or author+critic
   * get the protocol (and critic count) the policy names; code and tests never go below
   * author+critic (principle 2). Default: the plan's protocols as they are.
   */
  reviewPolicy?: ReviewPolicy;
  /**
   * The human's choice for a disputed node (R-405): returns an option id, or null to
   * reject. Absent, a disputed node stays disputed and fails closed (no output, no patch).
   */
  dispute?: DisputeHook;
  /** Debate: judges wanted (each from a new provider). Default 1. */
  judges?: number;
  /**
   * Extra routing constraints for every later step of one node, asked before each step
   * (e.g. local providers only once the node, or a node it depends on, has seen local-only
   * memory: ADR-0027 §6). Routed steps are routed under them; a fixed step (a retry, the
   * author's revision) runs only on a model that meets them. When none does, the step
   * fails with `reason` (fail closed). Default: none.
   */
  nodeConstraints?: (nodeId: string) => NodeConstraint | undefined;
  /**
   * External agent CLIs as node authors (R-503, ADR-0034). Absent: a node naming an agent
   * is refused (or falls back, per its `agent.fallback`).
   */
  agents?: AgentOptions;
  /** How long `api:<provider>` is skipped after a 429 (R-5E3). Default 60 s. */
  rateLimitCooldownMs?: number;
  /**
   * Rate limits per `source:provider` (R-5E3), shared by every runner given the same object
   * (one per kernel). Default: one per runner, kept across its runs.
   */
  sourceLimits?: SourceLimits;
}

/** Agent CLIs the run may use as authors, and their budget (R-503, R-5E7). */
export interface AgentOptions {
  descriptors: readonly AgentDescriptor[];
  /** Per graph run, in runs and minutes (a subscription has no dollar price). */
  budget: AgentBudgetLimits;
  /** The parent environment handed (scrubbed) to the agent; default `process.env`. */
  env?: Env;
  /** KernelPAI's API key variable names (provider descriptors' `auth.env`): never passed on. */
  scrub: readonly string[];
  /** Runs one agent; default `runAgent` of `@kernelpai/providers` (tests inject fakes). */
  run?: AgentRunner;
}

/**
 * The node's author is an agent CLI (R-503). `fallback: 'route'` lets the author step be
 * routed to a model as usual when the agent may not run (unattended run, rate limit or
 * quota, local-only node, budget): the routed step keeps every policy and budget gate.
 * Default `none`: the node fails with the reason (the user's choice is kept, like a pin).
 */
export interface AgentChoice {
  id: string;
  fallback?: 'route' | 'none';
}

/** Constraints one node's steps must meet, and why (shown when nothing meets them). */
export interface NodeConstraint {
  constraints: RoutingConstraints;
  reason: string;
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
  /**
   * What the node hands back (orchestrator-local until core has it, WI-S1-02). Absent:
   * `patch` for code and tests, else `answer` (`deliverableOf`). A non-patch node is asked
   * for that artifact, and the run result carries what was extracted (`NodeDeliverable`).
   */
  deliverable?: Deliverable;
  /** Id of the domain pack whose plan hint produced the node. */
  pack?: string;
  /**
   * The pack's instruction for this node. Pack files may come from users or the community:
   * it is untrusted data, capped and quoted in prompts, and never changes protocol rules.
   */
  guidance?: string;
  /** Pack review criteria added to the critic prompt (quoted, capped, can only add checks). */
  reviewCriteria?: string[];
  /** The pack's name for the node's kind of work, mapped onto `type` (`mapsTo`). */
  proposedType?: string;
  /**
   * The authorised boundary shown in every prompt. Set only by the runner from a scope it
   * validated (WI-S4-02); any value given in the graph is discarded.
   */
  authorisedScope?: string;
  /** Author+critic: independent critics per review round (1 to 3; default 1, R-404 policy). */
  critics?: number;
  /** Debate: judges (1 to 3; default `OrchestratorOptions.judges`, else 1). */
  judges?: number;
  /** An agent CLI writes the node's work in its own worktree (R-503); always reviewed. */
  agent?: AgentChoice;
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
  | { type: 'control_refused'; action: ControlAction; nodeId?: string; reason: string }
  | {
      /** R-405: critics, judges or voters disagree; the human is asked to choose. */
      type: 'node_disputed';
      nodeId: string;
      kind: DisputeKind;
      reason: string;
      options: Array<{ id: string; label: string }>;
    }
  | {
      type: 'dispute_resolved';
      nodeId: string;
      /** The option chosen, or null when rejected or nobody answered (fails closed). */
      choice: string | null;
      by: 'human' | 'none';
    };

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
  /** Spend of this attempt so far (each model call adds to it as it returns). */
  costUsd: number;
  /**
   * Spend of the node's earlier attempts (cancelled by a redirect): counted against the
   * node's `budgetUsd`, reported in the result through the run's carried cost.
   */
  priorUsd?: number;
  /** The user's model for the node's first step; taken (cleared) by that step. */
  pin?: ModelRef | undefined;
  /** Extra journal tags for every call of this node (e.g. a replay id). */
  tags?: Record<string, unknown>;
  /**
   * The last `test.run` result of this attempt (R-505), read from the tool's own header;
   * replaced only by a newer run. Feeds the critic and gates its approval.
   */
  tests?: TestEvidence;
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
