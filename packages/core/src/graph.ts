import type { ModelRef, TaskNode } from './routing.js';
import type { Deliverable } from './schemas.js';

/** Collaboration protocols of spec §3.1 (Relay and Swarm come later). */
export type ProtocolName = 'solo' | 'author_critic' | 'debate' | 'vote';

export interface GraphNode extends TaskNode {
  title: string;
  /** Ids of nodes whose outputs this node receives as context. */
  dependsOn: string[];
  protocol: ProtocolName;
  /** Tool names this node's models may call; none by default. */
  tools?: string[];
  /** What the node hands back (ADR-0022); default `patch` for code and tests, else `answer`. */
  deliverable?: Deliverable;
}

export interface TaskGraph {
  id: string;
  request: string;
  nodes: GraphNode[];
  /** How the plan was made, shown to the user. */
  createdBy: 'template' | 'model';
  reason: string;
}

export interface PlanContext {
  /** Workspace root, for planners that look at the repository. */
  root: string;
  signal?: AbortSignal;
}

export interface Planner {
  plan(request: string, ctx: PlanContext): Promise<TaskGraph>;
}

export type ContributionRole =
  'solo' | 'author' | 'critic' | 'revision' | 'debater' | 'judge' | 'voter';

/** Structured critique (author+critic protocol). */
export interface Verdict {
  approve: boolean;
  issues: Array<{ severity: 'major' | 'minor'; text: string }>;
  summary: string;
}

export interface Contribution {
  role: ContributionRole;
  ref: ModelRef;
  text: string;
  costUsd: number;
  verdict?: Verdict;
}

export interface ProtocolResult {
  nodeId: string;
  protocol: ProtocolName;
  output: string;
  contributions: Contribution[];
  costUsd: number;
  /** Author+critic: whether the critic approved the final version. */
  approved?: boolean;
  ok: boolean;
  error?: string;
}

export type NodeState =
  'pending' | 'running' | 'review' | 'done' | 'failed' | 'skipped' | 'cancelled';

/** Live events for the console's execution thread (spec §4.2). */
export type GraphEvent =
  | {
      type: 'node_state';
      nodeId: string;
      state: NodeState;
      ref?: ModelRef;
      role?: ContributionRole;
    }
  | { type: 'text'; nodeId: string; role: ContributionRole; ref: ModelRef; delta: string }
  | { type: 'contribution'; nodeId: string; contribution: Contribution }
  | { type: 'graph_done'; costUsd: number; ok: boolean };

export interface GraphResult {
  graphId: string;
  results: Record<string, ProtocolResult>;
  states: Record<string, NodeState>;
  costUsd: number;
  ok: boolean;
}
