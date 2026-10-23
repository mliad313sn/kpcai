import type { CostEstimate } from './cost.js';
import type { ChatMessage, Modality, ModelCard, ProviderDescriptor, TaskType } from './schemas.js';

/** A model addressed as provider/model. */
export interface ModelRef {
  provider: string;
  model: string;
}

export function refToString(r: ModelRef): string {
  return `${r.provider}/${r.model}`;
}

export type Criticality = 'low' | 'normal' | 'critical';

/** One unit of work in the task graph (spec §5.2). Phase 1 plans a single node. */
export interface TaskNode {
  id: string;
  type: TaskType;
  messages: ChatMessage[];
  criticality: Criticality;
  /** Budget for this node in USD; the router penalises cost relative to it. */
  budgetUsd?: number;
  maxLatencyMs?: number;
  requiredModalities?: Modality[];
  maxOutputTokens?: number;
}

/** A model the router may choose, with what it needs to know about its provider. */
export interface Candidate {
  ref: ModelRef;
  providerKind: ProviderDescriptor['kind'];
  jurisdiction: string;
  card: ModelCard;
}

export interface RoutingConstraints {
  /** If set, only these jurisdictions (e.g. ["local", "EU"]). */
  allowedJurisdictions?: string[];
  deniedProviders?: string[];
  /** "provider/model" strings. */
  deniedModels?: string[];
  localOnly?: boolean;
  /** Diversity (principle 2): providers that must not be chosen, e.g. the author's. */
  excludeProviders?: string[];
  /** Provider kinds never routed to unless explicitly allowed (default: ["test"]). */
  excludeKinds?: ProviderDescriptor['kind'][];
}

/** w1..w4 of spec §5.3. */
export interface RoutingWeights {
  competenceStatic: number;
  competenceMeasured: number;
  cost: number;
  latency: number;
}

export type RoutingProfile = 'economy' | 'balanced' | 'performance';

export interface ScoreParts {
  staticCompetence: number;
  measuredCompetence: number | null;
  costPenalty: number;
  latencyPenalty: number;
}

export interface ScoredCandidate {
  ref: ModelRef;
  score: number;
  parts: ScoreParts;
  estimate: CostEstimate;
}

export interface Rejection {
  ref: ModelRef;
  reason: string;
}

export interface RoutingDecision {
  nodeId: string;
  chosen: ScoredCandidate;
  /** Ordered fallback list (principle: repli automatique). */
  fallbacks: ScoredCandidate[];
  rejected: Rejection[];
  /** One-line justification, journaled (principle 1). */
  reason: string;
  elapsedMs: number;
}

/** Competence learned on this project (phase 4 fills it; phase 1 may return undefined). */
export interface MeasuredCompetence {
  get(ref: ModelRef, type: TaskType): { score: number; samples: number } | undefined;
}

export interface Router {
  /** Throws ProviderError('bad_request') when no candidate survives the constraints. */
  route(
    node: TaskNode,
    candidates: readonly Candidate[],
    constraints?: RoutingConstraints,
  ): RoutingDecision;
}
