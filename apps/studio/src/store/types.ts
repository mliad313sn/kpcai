import type {
  Contribution,
  GraphEstimate,
  NodeState,
  Ref,
  Role,
  Session,
  TaskGraph,
} from '../rpc/schemas';
import type { ConnState } from '../rpc/client';

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
}

export interface PlanView {
  planId: string;
  request: string;
  graph: TaskGraph;
  estimate: GraphEstimate;
}

export interface ConfirmView {
  confirmId: string;
  runId?: string;
  kind: 'budget' | 'tool' | 'patch';
  question: string;
  risk?: 'read' | 'write' | 'destructive';
  timeoutMs: number;
  receivedAt: number;
}

export interface LogLine {
  level: 'info' | 'warn' | 'error';
  message: string;
  at: number;
}

export type Zone = 'explorer' | 'agents' | 'thread';
export type Tab = 'conversation' | 'diff' | 'terminal' | 'files';

export interface Prefs {
  theme: 'system' | 'dark' | 'light';
  density: 'comfortable' | 'compact';
  collapsed: Record<Zone, boolean>;
  /** Explorer and agents widths, thread height, in px. */
  sizes: Record<Zone, number>;
}

export interface StudioState {
  conn: ConnState;
  connDetail?: string;
  plan?: PlanView;
  planning: boolean;
  runs: Record<string, RunView>;
  activeRunId?: string;
  sessions: Session[];
  models: Ref[];
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
}
