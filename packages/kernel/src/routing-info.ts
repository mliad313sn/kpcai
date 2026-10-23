/**
 * Routing reason, score and token counts for the console (R-303, spec §4.4), gathered at
 * the kernel boundary without changing the router, executor or orchestrator: the router
 * and the journal handed to the GraphRunner are wrapped, and what they saw is attached to
 * the plan estimate and to the live events as optional extra fields.
 */
import {
  refToString,
  type GraphEvent,
  type ModelRef,
  type Router,
  type RoutingDecision,
  type ScoreParts,
  type ScoredCandidate,
} from '@kernelpai/core';
import type { Journal, JournalEventInput } from '@kernelpai/journal';
import type { GraphEstimate, NodeEstimate, StepEstimate } from '@kernelpai/orchestrator';

export interface RoutingExplained {
  /** The router's one-line justification (principle 1). */
  reason?: string;
  score?: number;
  parts?: ScoreParts;
  runnerUp?: { ref: ModelRef; score: number };
}

/**
 * A plan estimate as the kernel presents it: each node and each planned step may carry its
 * routing explanation (R-303), and the two cost figures of D-021 (ADR-0026).
 */
export type ExplainedEstimate = Omit<GraphEstimate, 'nodes'> & {
  nodes: Array<Omit<NodeEstimate, 'steps'> & RoutingExplained & { steps: ExplainedStep[] }>;
  /** The likely cost: the sum of the nodes' expected costs (`totalUsd`). */
  expectedUsd: number;
  /**
   * The most the run may spend without asking again: the top of the band (D-021). It is
   * what the user approves, what the graph budget check uses and the run's `maxGraphUsd`.
   */
  capUsd: number;
};

export type ExplainedStep = StepEstimate & RoutingExplained;

/** A live event, possibly with routing data (node_state) or token counts (contribution). */
export type KernelEvent = GraphEvent & {
  reason?: string;
  score?: number;
  usage?: { inputTokens: number; outputTokens: number };
};

/** Reason shown for a node whose first step runs on the model the user chose. */
export const USER_CHOICE = 'model chosen by the user (no automatic fallback)';

const same = (a: ModelRef, b: ModelRef): boolean =>
  a.provider === b.provider && a.model === b.model;

/** The decision's candidates, best first. */
const ranked = (d: RoutingDecision): ScoredCandidate[] => [d.chosen, ...d.fallbacks];

/**
 * Explains `ref` from a decision that offered it. The chosen model gets the router's reason;
 * a lower-ranked one (a revision or rebuttal kept on its author's model) says so.
 */
function explainRef(d: RoutingDecision, ref: ModelRef): RoutingExplained {
  const all = ranked(d);
  const i = all.findIndex((c) => same(c.ref, ref));
  const own = all[i] as ScoredCandidate;
  const other = all.find((c) => !same(c.ref, ref));
  return {
    reason:
      i === 0
        ? d.reason
        : `kept on the author's model ${refToString(ref)} (ranked #${i + 1}); ${d.reason}`,
    score: own.score,
    parts: own.parts,
    ...(other ? { runnerUp: { ref: other.ref, score: other.score } } : {}),
  };
}

/**
 * A router that records every decision it returns, per node and in order. The estimator is
 * given one, so a plan is explained with exactly the decisions it was priced on: the same
 * prompts, task types and per-step constraints (critic, judge and voter exclusions, a
 * review away from upstream providers, pinned models, pack rules in front of each node).
 */
export class DecisionLog implements Router {
  private readonly byNode = new Map<string, RoutingDecision[]>();

  constructor(private readonly inner: Router) {}

  route(...args: Parameters<Router['route']>): RoutingDecision {
    const d = this.inner.route(...args);
    const list = this.byNode.get(d.nodeId) ?? [];
    list.push(d);
    this.byNode.set(d.nodeId, list);
    return d;
  }

  of(nodeId: string): readonly RoutingDecision[] {
    return this.byNode.get(nodeId) ?? [];
  }
}

/**
 * The estimator routes each step once, in step order, and only successful routes are
 * recorded; each step is matched to the next recorded decision that offered its model.
 */
function explainSteps(
  steps: readonly StepEstimate[],
  decisions: readonly RoutingDecision[],
  pinned: ModelRef | undefined,
): ExplainedStep[] {
  let at = 0;
  return steps.map((s, i) => {
    const k = decisions.findIndex((d, j) => j >= at && ranked(d).some((c) => same(c.ref, s.ref)));
    if (k < 0) return s;
    at = k + 1;
    const e = explainRef(decisions[k] as RoutingDecision, s.ref);
    // The pinned first step was routed among the user's model only (principle 4).
    return i === 0 && pinned && same(pinned, s.ref)
      ? { ...s, ...e, reason: USER_CHOICE }
      : { ...s, ...e };
  });
}

/** The node's own explanation is its first step's. */
function nodeExplained(steps: readonly ExplainedStep[]): RoutingExplained {
  const f = steps[0];
  if (!f?.reason) return {};
  return {
    reason: f.reason,
    ...(f.score !== undefined ? { score: f.score } : {}),
    ...(f.parts ? { parts: f.parts } : {}),
    ...(f.runnerUp ? { runnerUp: f.runnerUp } : {}),
  };
}

/**
 * The estimate as the kernel presents it: every planned step with the routing decision it
 * was priced on (R-303), each node with its first step's, and the likely and cap figures
 * (D-021). `log` must be the router the estimator was given.
 */
export function explainEstimate(est: GraphEstimate, log: DecisionLog): ExplainedEstimate {
  const nodes = est.nodes.map((e) => {
    const steps = explainSteps(e.steps, log.of(e.nodeId), e.pinned);
    return { ...e, steps, ...nodeExplained(steps) };
  });
  return { ...est, nodes, ...costFigures(est) };
}

/** Likely and cap figures of an estimate (D-021, ADR-0026). */
export function costFigures(est: GraphEstimate): { expectedUsd: number; capUsd: number } {
  return { expectedUsd: est.totalUsd, capUsd: est.band.highUsd };
}

/** A router that remembers its recent decisions per node, to explain live events. */
export class RouterTap implements Router {
  private readonly decisions = new Map<string, RoutingDecision[]>();

  constructor(private readonly inner: Router) {}

  route(...args: Parameters<Router['route']>): RoutingDecision {
    const d = this.inner.route(...args);
    const list = this.decisions.get(d.nodeId) ?? [];
    list.push(d);
    this.decisions.set(d.nodeId, list.slice(-8));
    return d;
  }

  /** Reason and score of the latest decision about `nodeId` that offered `ref`. */
  lookup(nodeId: string, ref: ModelRef): { reason: string; score: number } | undefined {
    const list = this.decisions.get(nodeId) ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i] as RoutingDecision;
      if (same(d.chosen.ref, ref)) return { reason: d.reason, score: d.chosen.score };
      const k = d.fallbacks.findIndex((f) => same(f.ref, ref));
      if (k >= 0) {
        const f = d.fallbacks[k] as RoutingDecision['chosen'];
        return { reason: `ranked #${k + 2}: ${d.reason}`, score: f.score };
      }
    }
    return undefined;
  }
}

type Tokens = { inputTokens: number; outputTokens: number };

/** Token counts of `response` journal events, per node and model, until claimed. */
export class UsageTap {
  private readonly pending = new Map<string, Tokens>();

  /** A journal that behaves exactly like `journal` and reports each append to this tap. */
  wrap(journal: Journal): Journal {
    return new Proxy(journal, {
      get: (target, prop) => {
        if (prop === 'append') {
          return (input: JournalEventInput) => {
            const e = target.append(input);
            this.observe(input);
            return e;
          };
        }
        const v: unknown = Reflect.get(target, prop, target);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  }

  private observe(input: JournalEventInput): void {
    if (input.type !== 'response' || !input.nodeId || !input.provider || !input.model) return;
    const p = input.payload as Partial<Tokens>;
    const key = `${input.nodeId} ${refToString({ provider: input.provider, model: input.model })}`;
    const t = this.pending.get(key) ?? { inputTokens: 0, outputTokens: 0 };
    t.inputTokens += Number(p.inputTokens) || 0;
    t.outputTokens += Number(p.outputTokens) || 0;
    this.pending.set(key, t);
  }

  /** Tokens spent by `ref` on `nodeId` since the last claim. */
  claim(nodeId: string, ref: ModelRef): Tokens | undefined {
    const key = `${nodeId} ${refToString(ref)}`;
    const t = this.pending.get(key);
    this.pending.delete(key);
    return t;
  }
}

/** Attaches what the taps know to a live event. */
export function annotate(e: GraphEvent, router: RouterTap, usage: UsageTap): KernelEvent {
  if (e.type === 'node_state' && e.ref) {
    const r = router.lookup(e.nodeId, e.ref);
    return r ? { ...e, ...r } : e;
  }
  if (e.type === 'contribution') {
    const u = usage.claim(e.nodeId, e.contribution.ref);
    return u ? { ...e, usage: u } : e;
  }
  return e;
}
