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
  type TaskGraph,
} from '@kernelpai/core';
import type { Journal, JournalEventInput } from '@kernelpai/journal';
import type { GraphEstimate, NodeEstimate, PlannedNode } from '@kernelpai/orchestrator';
import type { GraphSetup } from './setup.js';

export interface RoutingExplained {
  /** The router's one-line justification (principle 1). */
  reason?: string;
  score?: number;
  parts?: ScoreParts;
  runnerUp?: { ref: ModelRef; score: number };
}

/** A plan estimate whose nodes may carry their routing explanation. */
export type ExplainedEstimate = Omit<GraphEstimate, 'nodes'> & {
  nodes: Array<NodeEstimate & RoutingExplained>;
};

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

function explain(d: RoutingDecision): RoutingExplained {
  const second = d.fallbacks[0];
  return {
    reason: d.reason,
    score: d.chosen.score,
    parts: d.chosen.parts,
    ...(second ? { runnerUp: { ref: second.ref, score: second.score } } : {}),
  };
}

/**
 * Adds each node's routing reason to the estimate when the router, asked about the node
 * as planned, picks the same first model as the estimate (otherwise nothing is claimed).
 */
export function explainEstimate(
  graph: TaskGraph,
  est: GraphEstimate,
  s: GraphSetup,
): ExplainedEstimate {
  const nodes = est.nodes.map((e) => {
    const node = graph.nodes.find((n) => n.id === e.nodeId);
    if (!node || !e.ref) return e;
    const pinned = (node as PlannedNode).model;
    if (pinned && same(pinned, e.ref)) return { ...e, reason: USER_CHOICE };
    try {
      const d = s.router.route(node, s.candidates, s.constraints);
      return same(d.chosen.ref, e.ref) ? { ...e, ...explain(d) } : e;
    } catch {
      return e;
    }
  });
  return { ...est, nodes };
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
