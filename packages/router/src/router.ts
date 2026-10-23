import {
  ProviderError,
  estimateRequest,
  refToString,
  type Candidate,
  type CostEstimate,
  type MeasuredCompetence,
  type ModelRef,
  type Rejection,
  type Router,
  type RoutingConstraints,
  type RoutingDecision,
  type RoutingProfile,
  type RoutingWeights,
  type ScoredCandidate,
  type TaskNode,
  type TaskType,
} from '@kernelpai/core';
import {
  capabilityRejection,
  policyRejection,
  prepareConstraints,
  type PreparedConstraints,
} from './filters.js';
import { SCORE_EPSILON, explain } from './reason.js';
import {
  contributions,
  measuredInForce,
  scoreParts,
  sumContributions,
  type Contributions,
  type MeasuredSample,
} from './score.js';
import { weightsFor } from './weights.js';

export interface CompetenceRouterOptions {
  profile?: RoutingProfile;
  /** Per-weight overrides on top of the profile preset. */
  weights?: Partial<RoutingWeights>;
  /** Competence learned on this project (phase 4); absent means static only. */
  measured?: MeasuredCompetence;
  /**
   * Absolute cost reference used when the node has no `budgetUsd`:
   * cost penalty = min(1, expected cost / reference). Default 0.10 USD.
   * Absolute (not the priciest survivor) so the order of two candidates never
   * depends on a third, unrelated one (independence of irrelevant alternatives).
   */
  costReferenceUsd?: number;
  /**
   * Absolute latency reference used when the node has no `maxLatencyMs`:
   * latency penalty = min(1, typical latency / reference). Default 20 000 ms.
   */
  latencyReferenceMs?: number;
  /**
   * Calibrated typical output tokens for a model on a task type (from history);
   * `undefined` falls back to the heuristic of `estimateRequest`.
   */
  expectedOutput?: (ref: ModelRef, type: TaskType) => number | undefined;
  /** Monotonic clock in ms, injectable for tests. */
  clock?: () => number;
}

/** Default `costReferenceUsd`: a 10-cent call gets the full cost penalty. */
export const DEFAULT_COST_REFERENCE_USD = 0.1;
/** Default `latencyReferenceMs`: a 20 s typical latency gets the full latency penalty. */
export const DEFAULT_LATENCY_REFERENCE_MS = 20_000;

function positive(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be > 0`);
  return value;
}

/** How many rejections the "nothing survives" error lists before summarising. */
export const MAX_LISTED_REJECTIONS = 10;

interface Survivor {
  cand: Candidate;
  estimate: CostEstimate;
}

interface Ranked {
  scored: ScoredCandidate;
  parts: Contributions;
  /** The measured evidence behind the score, when it is in force. */
  evidence?: string;
}

/** Spec §5.3 competence router: filter, score, rank, explain in one line. */
export class CompetenceRouter implements Router {
  readonly weights: Readonly<RoutingWeights>;
  readonly profile: RoutingProfile;
  readonly costReferenceUsd: number;
  readonly latencyReferenceMs: number;
  private readonly measured: MeasuredCompetence | undefined;
  private readonly expectedOutput: CompetenceRouterOptions['expectedOutput'];
  private readonly clock: () => number;

  constructor(options: CompetenceRouterOptions = {}) {
    this.profile = options.profile ?? 'balanced';
    this.weights = weightsFor(this.profile, options.weights);
    this.costReferenceUsd = positive(
      'costReferenceUsd',
      options.costReferenceUsd,
      DEFAULT_COST_REFERENCE_USD,
    );
    this.latencyReferenceMs = positive(
      'latencyReferenceMs',
      options.latencyReferenceMs,
      DEFAULT_LATENCY_REFERENCE_MS,
    );
    this.measured = options.measured;
    this.expectedOutput = options.expectedOutput;
    this.clock = options.clock ?? (() => performance.now());
  }

  route(
    node: TaskNode,
    candidates: readonly Candidate[],
    constraints?: RoutingConstraints,
  ): RoutingDecision {
    const t0 = this.clock();
    const { survivors, rejected } = this.filter(node, candidates, prepareConstraints(constraints));
    if (survivors.length === 0) throw noCandidateError(node, rejected);
    const ranked = this.rank(node, survivors);
    const [first, second] = ranked as [Ranked, Ranked | undefined];
    const reason = explain({
      type: node.type,
      chosen: first.scored,
      chosenParts: first.parts,
      runnerUp: second,
      rejected: rejected.length,
      evidence: first.evidence,
    });
    return {
      nodeId: node.id,
      chosen: first.scored,
      fallbacks: ranked.slice(1).map((r) => r.scored),
      rejected,
      reason,
      elapsedMs: this.clock() - t0,
    };
  }

  private filter(
    node: TaskNode,
    candidates: readonly Candidate[],
    c: PreparedConstraints,
  ): { survivors: Survivor[]; rejected: Rejection[] } {
    const survivors: Survivor[] = [];
    const rejected: Rejection[] = [];
    for (const cand of candidates) {
      const policy = policyRejection(cand, c);
      if (policy) {
        rejected.push({ ref: cand.ref, reason: policy });
        continue;
      }
      const estimate = estimateRequest(
        { model: cand.ref.model, messages: node.messages, maxOutputTokens: node.maxOutputTokens },
        cand.card,
        { expectedOutputTokens: this.expectedOutput?.(cand.ref, node.type) },
      );
      const capability = capabilityRejection(cand, node, estimate);
      if (capability) rejected.push({ ref: cand.ref, reason: capability });
      else survivors.push({ cand, estimate });
    }
    return { survivors, rejected };
  }

  private rank(node: TaskNode, survivors: readonly Survivor[]): Ranked[] {
    // Without a node budget / latency cap, normalise against absolute references,
    // never against other survivors, so each candidate's score is independent.
    const budgetUsd = node.budgetUsd ?? this.costReferenceUsd;
    const maxLatencyMs = node.maxLatencyMs ?? this.latencyReferenceMs;
    const ranked = survivors.map((s) => this.score(node, s, budgetUsd, maxLatencyMs));
    return ranked.sort(compareRanked);
  }

  private score(node: TaskNode, s: Survivor, budgetUsd: number, maxLatencyMs: number): Ranked {
    const { ref, card } = s.cand;
    const measured: MeasuredSample = this.measured?.get(ref, node.type);
    const parts = scoreParts({
      card,
      type: node.type,
      expectedCostUsd: s.estimate.expectedCostUsd,
      budgetUsd,
      maxLatencyMs,
      measured,
    });
    const contrib = contributions(parts, this.weights, measured);
    const score = sumContributions(contrib);
    const ranked: Ranked = { scored: { ref, score, parts, estimate: s.estimate }, parts: contrib };
    if (measuredInForce(measured) && measured.evidence) ranked.evidence = measured.evidence;
    return ranked;
  }
}

/** Score desc; ties broken by expected cost asc, then "provider/model" asc. */
function compareRanked(a: Ranked, b: Ranked): number {
  const d = b.scored.score - a.scored.score;
  if (Math.abs(d) > SCORE_EPSILON) return d;
  const c = a.scored.estimate.expectedCostUsd - b.scored.estimate.expectedCostUsd;
  if (c !== 0) return c;
  const x = refToString(a.scored.ref);
  const y = refToString(b.scored.ref);
  return x < y ? -1 : x > y ? 1 : 0;
}

function noCandidateError(node: TaskNode, rejected: readonly Rejection[]): ProviderError {
  if (rejected.length === 0) {
    return new ProviderError(
      'bad_request',
      'router',
      `No candidate for node ${node.id}: no models available`,
    );
  }
  const listed = rejected
    .slice(0, MAX_LISTED_REJECTIONS)
    .map((r) => `${refToString(r.ref)}: ${r.reason}`)
    .join('; ');
  const more =
    rejected.length > MAX_LISTED_REJECTIONS
      ? `; … and ${rejected.length - MAX_LISTED_REJECTIONS} more`
      : '';
  return new ProviderError(
    'bad_request',
    'router',
    `No candidate for node ${node.id}: all ${rejected.length} rejected — ${listed}${more}`,
  );
}
