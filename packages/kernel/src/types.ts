import type { GraphResult, TaskGraph } from '@kernelpai/core';
import type { ForkPlan, RunControlEvent } from '@kernelpai/orchestrator';
import type { Choose, Confirm } from './confirm.js';
import type { Env, Money } from './env.js';
import type { Artifact, RefusedArtifact } from './artifacts.js';
import type { Patch } from './patches.js';
import type { SelectedPacks } from './packs.js';
import type { LoadedMemory, TaintSeed } from './memory.js';
import type { LoadedRules } from './rules.js';
import type { ScopeCheck } from './scope.js';
import type { ExplainedEstimate, KernelEvent } from './routing-info.js';
import type { GraphOptions, GraphSetup } from './setup.js';

export type RunState = 'running' | 'paused' | 'cancelling' | 'done' | 'failed' | 'cancelled';

/** Everything the kernel needs from the program hosting it (CLI, console server, tests). */
export interface KernelHost {
  env: Env;
  /** Workspace root: plans, tools and patches act here and nowhere else. */
  cwd: string;
  /** Journal file; default `$KPAI_HOME/journal.db`. */
  db?: string;
  /** Diagnostics, newline-terminated (a terminal prints them as is). */
  say?(text: string): void;
  /** Asks the human. Calls are serialized by the kernel; no confirm means "no". */
  confirm?: Confirm;
  /**
   * Asks the human to pick one answer of a disputed node (R-405), on the same queue as
   * `confirm`. Without it every dispute is rejected and the node fails closed.
   */
  choose?: Choose;
  /** A run was accepted for this plan; called before any of its events or states. */
  onRunPlanned?(runId: string, plan: Plan): void;
  onEvent?(runId: string, event: KernelEvent): void;
  /** Steering of a run (pause, resume, cancel, redirect, instruction, refusal). */
  onControl?(runId: string, event: RunControlEvent): void;
  onRunState?(runId: string, state: RunState): void;
  /**
   * The run was cancelled: settle its confirmations still on screen as "no" and tell the
   * client to close them (review P3-F2). Questions still queued are declined by the kernel.
   */
  cancelConfirmations?(runId: string): void;
}

/** A plan the user can see before anything runs (spec §4.5 "zéro surprise"). */
export interface Plan {
  planId: string;
  sessionId: string;
  request: string;
  graph: TaskGraph;
  estimate: ExplainedEstimate;
  options: GraphOptions;
  /** The user's edits to the proposal (R-301), one line each; journaled when it runs. */
  edits?: string[];
  setup: GraphSetup;
  m: Money;
  /** Repository rule files given to every node as untrusted context (R-306). */
  rules: LoadedRules;
  /** Memory every node gets (ADR-0027); absent on plans made without it. */
  memory?: LoadedMemory;
  /**
   * A fork's or replay's recorded nodes whose output may quote local-only facts (P4-R1):
   * the nodes run after them are held on local providers.
   */
  taint?: TaintSeed;
  /** Domain packs for the workspace, why, and the zones in force with origin (D-020). */
  packs: SelectedPacks;
  /** The authorised scope selected packs require (WI-S1-03). */
  scope: ScopeCheck;
  /** A fork of a past run (R-403): its graph runs as recorded, reused nodes not re-run. */
  fork?: ForkPlan;
}

export type RunOutcome =
  /** Refused before anything ran: the whole-graph budget check said no. */
  | { status: 'not_run'; reason: string }
  | {
      status: 'finished';
      result: GraphResult;
      /** True when any node was cancelled: nothing may then be applied (review P2-F6). */
      cancelled: boolean;
      /** Critic-approved, hidden-byte-free patches. */
      patches: Patch[];
      /** Patches refused for hidden control characters (never applied). */
      refused: Patch[];
      /** Non-code outputs of approved nodes (D-019, ADR-0022). */
      artifacts: Artifact[];
      refusedArtifacts: RefusedArtifact[];
      /** The run's worktree when it ran isolated (R-307), to merge or discard. */
      worktree?: string;
      /** Memory proposals of the run, pending until a human confirms them (ADR-0027). */
      proposals?: string[];
    };

export interface RunHandle {
  runId: string;
  planId: string;
  sessionId: string;
  /** Settles when the run has finished or was refused before starting; rejects only on an
   * unexpected error (the run is then `failed`). */
  done: Promise<RunOutcome>;
}

export interface StartRunInput {
  request: string;
  /** The plan the user saw; without it the kernel plans again. */
  planId?: string;
  /** The plan's graph as the user edited it (R-301); needs `planId`. Validated again. */
  graph?: unknown;
  options?: GraphOptions;
}

export interface ApplyResult {
  nodeId: string;
  ok: boolean;
  /** What the tool reported (first 300 characters). */
  message: string;
}

export interface ArtifactApplyResult {
  path: string;
  nodeId: string;
  ok: boolean;
  message: string;
}

/** One line of the runs manager view (R-307). */
export interface RunSummary {
  runId: string;
  planId: string;
  sessionId: string;
  request: string;
  state: RunState | 'starting';
  startedAt: string;
  /** Spent so far (live) or in total (finished), USD. */
  costUsd: number;
  isolated: boolean;
  /** The run's worktree (isolated runs, until discarded). */
  worktree?: string;
  diff?: { files: number; additions: number; deletions: number };
  /** Critic verdicts so far: all approved, some changes requested, or none yet. */
  verdict?: 'approved' | 'changes_requested';
  patches: number;
  artifacts: number;
}
