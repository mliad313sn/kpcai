import {
  ProviderError,
  estimateRequest,
  refToString,
  type Candidate,
  type CostEstimate,
  type MeasuredCompetence,
  type Rejection,
  type Router,
  type RoutingConstraints,
  type RoutingDecision,
  type RoutingProfile,
  type RoutingWeights,
  type ScoredCandidate,
  type TaskNode,
} from '@kernelpai/core';
import {
  capabilityRejection,
  policyRejection,
  prepareConstraints,
  type PreparedConstraints,
} from './filters.js';
import { SCORE_EPSILON, explain } from './reason.js';
import { contributions, scoreParts, sumContributions, type Contributions } from './score.js';
import { weightsFor } from './weights.js';

export interface CompetenceRouterOptions {
  profile?: RoutingProfile;
  /** Per-weight overrides on top of the profile preset. */
  weights?: Partial<RoutingWeights>;
  /** Competence learned on this project (phase 4); absent means static only. */
  measured?: MeasuredCompetence;
  /** Monotonic clock in ms, injectable for tests. */
  clock?: () => number;
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
}

/** Spec §5.3 competence router: filter, score, rank, explain in one line. */
export class CompetenceRouter implements Router {
  readonly weights: Readonly<RoutingWeights>;
  readonly profile: RoutingProfile;
  private readonly measured: MeasuredCompetence | undefined;
  private readonly clock: () => number;

  constructor(options: CompetenceRouterOptions = {}) {
    this.profile = options.profile ?? 'balanced';
    this.weights = weightsFor(this.profile, options.weights);
    this.measured = options.measured;
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
      );
      const capability = capabilityRejection(cand, node, estimate);
      if (capability) rejected.push({ ref: cand.ref, reason: capability });
      else survivors.push({ cand, estimate });
    }
    return { survivors, rejected };
  }

  private rank(node: TaskNode, survivors: readonly Survivor[]): Ranked[] {
    // Without a node budget / latency cap, normalise against the worst surviving candidate.
    const budgetUsd = node.budgetUsd ?? maxOf(survivors, (s) => s.estimate.expectedCostUsd);
    const maxLatencyMs =
      node.maxLatencyMs ?? maxOf(survivors, (s) => s.cand.card.latencyMsTypical ?? 0);
    const ranked = survivors.map((s) => this.score(node, s, budgetUsd, maxLatencyMs));
    return ranked.sort(compareRanked);
  }

  private score(node: TaskNode, s: Survivor, budgetUsd: number, maxLatencyMs: number): Ranked {
    const { ref, card } = s.cand;
    const measured = this.measured?.get(ref, node.type);
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
    return { scored: { ref, score, parts, estimate: s.estimate }, parts: contrib };
  }
}

function maxOf<T>(xs: readonly T[], f: (x: T) => number): number {
  let m = 0;
  for (const x of xs) m = Math.max(m, f(x));
  return m;
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
