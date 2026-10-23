import type { MethodResult, RunOptions } from '@kernelpai/kernel/protocol';
import type {
  DisputeRecord,
  ProductivityView,
  ReplayView,
  Verification,
} from '../rpc/learning-schemas';

export type RunSummary = MethodResult<'runs.list'>['runs'][number];
export type Checkpoint = MethodResult<'run.checkpoints'>['checkpoints'][number];
export type Rules = NonNullable<MethodResult<'plan'>['rules']>;
export type PlanPacks = NonNullable<MethodResult<'plan'>['packs']>;
export type ScopeStatus = NonNullable<MethodResult<'plan'>['scope']>;
/** Unified memory (ADR-0027): facts with provenance, proposals, what a plan sends. */
export type Fact = MethodResult<'memory.list'>['facts'][number];
export type PendingFact = MethodResult<'memory.pending'>['pending'][number];
export type MemoryLayer = Fact['layer'];
export type MemorySummary = NonNullable<MethodResult<'plan'>['memory']>;
/** Grades, measured competence and estimate accuracy (ADR-0028). */
export type Accuracy = MethodResult<'stats.accuracy'>;
export type AccuracyRow = Accuracy['runs'];
export type CompetenceEntry = MethodResult<'competence'>['entries'][number];
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
  /** Review spend against accepted findings (R-404), from `run.done`. */
  verification?: Verification;
  /** Disputed nodes (R-405): open while the human is asked, then how it was settled. */
  disputes?: Record<string, DisputeView>;
  /** A fork: the run and node it started from, and the nodes reused from it (R-403). */
  forkOf?: { runId: string; nodeId: string };
  reused?: string[];
}

/** A disputed node: `open` while it waits for the human; `chosen` or `rejected` after. */
export interface DisputeView {
  status: 'open' | 'chosen' | 'rejected';
  reason?: string;
  /** Option ids and labels named by `node_disputed`. */
  options?: Array<{ id: string; label: string }>;
  /** Label of the chosen option (model text, shown as text). */
  choice?: string;
  record?: DisputeRecord;
}

/** One layer's file as `memory.list` returned it. */
export interface LayerView {
  file: string;
  exists: boolean;
  facts: Fact[];
  problems: Array<{ line: number; message: string }>;
}

export interface MemoryView {
  layers: Partial<Record<MemoryLayer, LayerView>>;
  pending: PendingFact[];
  /** The session whose session layer is shown. */
  sessionId?: string;
  loading: boolean;
}

export interface EvidenceView {
  accuracy?: Accuracy;
  /** R-406 productivity from the journal, when the kernel offers `stats.productivity`. */
  productivity?: ProductivityView;
  competence?: CompetenceEntry[];
  loading: boolean;
}

/**
 * A replay of one node (R-403): in flight (cancellable by its plan id, P4-F5), or its
 * side-by-side result.
 */
export type ReplayEntry =
  { pending: true; planId?: string; cancelling?: boolean } | { pending: false; result: ReplayView };

export interface GradeView {
  grade: 'good' | 'bad';
  /** The model the grade went to (`provider/model`), as the kernel says. */
  graded: string;
  note?: string;
}

/** A fork plan (R-403): what reruns, what is reused from the parent run, the edits. */
export interface ForkPlanView {
  parent: { runId: string; nodeId: string };
  rerun: string[];
  reused: string[];
  edits: string[];
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
  /** Memory every node gets: counts, sources, truncation, distrust (ADR-0027). */
  memory?: MemorySummary;
  /** Set when this plan is a fork of a past run: it starts with `run.fork`. */
  fork?: ForkPlanView;
  /** Options this plan was made with when they differ from the defaults (a ticket's skill). */
  options?: RunOptions;
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
    /** `truncated`: the kernel cut the text; such an option cannot be chosen (P4-F11). */
    options: Array<{
      id: string;
      label: string;
      text: string;
      backers: string[];
      truncated?: boolean;
    }>;
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
export type Tab =
  | 'conversation'
  | 'diff'
  | 'artifacts'
  | 'runs'
  | 'memory'
  | 'evidence'
  | 'tools'
  | 'terminal'
  | 'files';

/** The run console, or the Enterprise view of programs and seats (R-5E10). */
export type View = 'workspace' | 'enterprise';

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
  view: View;
  selectedNodeId?: string;
  paletteOpen: boolean;
  /** Output of the last `/` command (stats, tools, help), shown as plain text. */
  notice?: { title: string; body: string };
  prefs: Prefs;
  /** Which client renders this store: wording that names a key or a tab differs. */
  surface: 'web' | 'tui';
  /** Memory editor: facts per layer and model proposals waiting for a human. */
  memory: MemoryView;
  /** Accuracy & competence view (R-402, ADR-0028). */
  evidence: EvidenceView;
  /** Replays by `runId:nodeId`, newest kept. */
  replays: Record<string, ReplayEntry>;
  /** Manual grades given in this window, by `runId:nodeId`. */
  grades: Record<string, GradeView>;
}
