import type { MethodResult, RunOptions } from '@kernelpai/kernel/protocol';

export type RunSummary = MethodResult<'runs.list'>['runs'][number];
export type Checkpoint = MethodResult<'run.checkpoints'>['checkpoints'][number];
export type Rules = NonNullable<MethodResult<'plan'>['rules']>;
export type PlanPacks = NonNullable<MethodResult<'plan'>['packs']>;
export type ScopeStatus = NonNullable<MethodResult<'plan'>['scope']>;
import type { LocalePref } from '../i18n/core';
import type {
  Contribution,
  ControlEvent,
  GraphEstimate,
  NodeState,
  ProviderView,
  Ref,
  Role,
  Session,
  TaskGraph,
} from '../rpc/schemas';
import type { ConnState } from '../rpc/client';

export type Profile = NonNullable<RunOptions['profile']>;

export type RunState =
  'starting' | 'running' | 'paused' | 'cancelling' | 'done' | 'failed' | 'cancelled';

export interface NodeRun {
  state: NodeState;
  ref?: Ref;
  role?: Role;
  /** First time the node started working (its duration). */
  startedAt?: number;
  /** When the current step (model + role) started (agents board elapsed). */
  stepStartedAt?: number;
  endedAt?: number;
  costUsd: number;
  /** Streaming text per `role provider/model`, until its contribution arrives. */
  streams: Record<string, string>;
  contributions: Contribution[];
  /** Final output from `run.done`. */
  output?: string;
  error?: string;
  approved?: boolean;
  reason?: string;
  score?: number;
  /** Tokens reported on `contribution` events (spec §4.4). */
  tokens?: { input: number; output: number };
}

/**
 * A non-code deliverable of a run (WI-S6-01): report, document, config, notebook, data,
 * model, map… Its text is model output: shown as text, never interpreted.
 */
export interface Artifact {
  nodeId?: string;
  path: string;
  kind: string;
  text: string;
  /** Who made it and from what, one `label: value` line each. */
  provenance: string[];
  /** False when no critic reviewed it (D-020): saving it is then its own decision. */
  reviewed?: boolean;
}

/** Glossary and tips of a selected domain pack (the subset of `@kernelpai/packs` `Pack`). */
export interface PackHelp {
  id: string;
  name: string;
  glossary: Array<{ term: string; meaning: string }>;
  tips: string[];
}

/** A steering event of the run (R-304), as shown in the thread. */
export interface ControlEntry {
  event: ControlEvent;
  at: number;
}

export interface Patch {
  nodeId: string;
  patch: string;
  files: string[];
}

export interface RunView {
  runId: string;
  request: string;
  state: RunState;
  graph?: TaskGraph;
  estimate?: GraphEstimate;
  nodes: Record<string, NodeRun>;
  costUsd: number;
  ok?: boolean;
  patches: Patch[];
  /** Node ids whose patches were applied. */
  applied: string[];
  startedAt: number;
  /** Pause, resume, redirect, instruction, refusal: newest last. */
  controls: ControlEntry[];
  /** Non-code deliverables from `run.done` (when the kernel sends them). */
  artifacts: Artifact[];
  /** The run's git worktree when it ran isolated (R-307). */
  worktree?: string;
}

/** Result of `plan.validate` for the plan as edited (R-301). */
export interface PlanCheckView {
  ok: boolean;
  problems: string[];
  warnings: string[];
  changes: string[];
}

export interface PlanView {
  planId: string;
  request: string;
  /** The plan as the user edited it; this is what runs. */
  graph: TaskGraph;
  /** The plan as proposed by the kernel (to reset edits and detect changes). */
  original: TaskGraph;
  /** Estimate of `graph`: the proposal's, then each `plan.validate` re-estimate. */
  estimate: GraphEstimate;
  /** Last validation of the edits; undefined while the plan is unedited. */
  check?: PlanCheckView;
  /** A `plan.validate` is in flight for the latest edit. */
  checking: boolean;
  /** Repository rule files every node gets as untrusted context (R-306). */
  rules?: Rules;
  /** Domain packs selected for the workspace and their zones (D-020). */
  packs?: PlanPacks;
  /** Authorised scope status; the kernel refuses the run while it has problems. */
  scope?: ScopeStatus;
}

export interface ConfirmView {
  confirmId: string;
  runId?: string;
  kind: 'budget' | 'tool' | 'patch' | 'restore' | 'artifact' | 'memory' | 'dispute';
  question: string;
  risk?: 'read' | 'write' | 'destructive';
  /** For a patch confirmation: the exact diff, shown apart from the question. */
  patch?: string;
  /** For an artifact confirmation: the exact text that would be written, and what it is. */
  content?: string;
  artifact?: {
    path: string;
    kind: string;
    mime: string;
    bytes: number;
    nodeId: string;
    reviewed?: boolean;
  };
  /** For a memory confirmation (ADR-0027): the proposed fact and its provenance. */
  memory?: {
    id: string;
    layer: 'user' | 'project' | 'session';
    text: string;
    source: string;
    evidence: string[];
    localOnly: boolean;
  };
  /**
   * For a dispute (R-405): options to pick from, untrusted model text shown quoted. Answer
   * with `confirm.answer {ok: true, choice}`; a plain yes without `choice` rejects.
   */
  dispute?: {
    nodeId: string;
    kind: string;
    reason: string;
    options: Array<{ id: string; label: string; text: string; backers: string[] }>;
    positions: Array<{ ref: string; role: string; says: string; option?: string }>;
  };
  timeoutMs: number;
  receivedAt: number;
}

export interface LogLine {
  level: 'info' | 'warn' | 'error';
  message: string;
  at: number;
}

export type Zone = 'explorer' | 'agents' | 'thread';
export type Tab = 'conversation' | 'diff' | 'artifacts' | 'runs' | 'terminal' | 'files';

export interface Prefs {
  theme: 'system' | 'dark' | 'light';
  density: 'comfortable' | 'compact';
  collapsed: Record<Zone, boolean>;
  /** Explorer and agents widths, thread height, in px. */
  sizes: Record<Zone, number>;
  /** Routing profile and the $0 path chosen at onboarding (R-308). */
  profile: Profile;
  localOnly: boolean;
  /** The first-run screen was completed or skipped. */
  onboarded: boolean;
  /** Display language; `system` follows the browser or OS (WI-S6-02). */
  locale: LocalePref;
}

export interface StudioState {
  conn: ConnState;
  connDetail?: string;
  plan?: PlanView;
  planning: boolean;
  runs: Record<string, RunView>;
  activeRunId?: string;
  sessions: Session[];
  /** Every provider the kernel lists, `test` ones included (filter with `testAllowed`). */
  providers: ProviderView[];
  /** Test providers may be shown and picked: the server allows them or `runOptions` does. */
  testAllowed: boolean;
  /** Models offered in the pickers (plan editor, redirect): test ones only when allowed. */
  models: Ref[];
  /** Options sent with `plan` and `run.start` (profile and $0 path come from prefs). */
  runOptions: RunOptions;
  onboardingOpen: boolean;
  /** Glossary and tips of the packs selected for this workspace (when the kernel says). */
  packs: PackHelp[];
  /** Runs manager rows from `runs.list` (R-307) and checkpoints per run (R-305). */
  serverRuns: RunSummary[];
  checkpoints: Record<string, Checkpoint[]>;
  /** Artifact paths written to the workspace in this window. */
  savedArtifacts: string[];
  confirms: ConfirmView[];
  logs: LogLine[];
  /** Polite live-region text; `seq` changes so a repeated message is re-announced. */
  announcement: { text: string; seq: number };
  tab: Tab;
  selectedNodeId?: string;
  paletteOpen: boolean;
  /** Output of the last `/` command (stats, tools, help), shown as plain text. */
  notice?: { title: string; body: string };
  prefs: Prefs;
  /** Which client renders this store: wording that names a key or a tab differs. */
  surface: 'web' | 'tui';
}
