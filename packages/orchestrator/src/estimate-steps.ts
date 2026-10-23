import {
  costUsd,
  estimateRequest,
  type Candidate,
  type ContributionRole,
  type GraphNode,
  type ModelRef,
  type Router,
  type RoutingConstraints,
  type ScoredCandidate,
  type TaskType,
} from '@kernelpai/core';
import {
  authorPrompt,
  criticPrompt,
  debaterPrompt,
  judgePrompt,
  quote,
  rebuttalPrompt,
  revisionPrompt,
  stepMessages,
  voterPrompt,
} from './prompts.js';
import { stepBand, type SpreadFn, type StepBand } from './band.js';
import { routePinned, sameRef, servedCandidate } from './routing.js';

export interface StepEstimate {
  role: ContributionRole;
  ref: ModelRef;
  /** Calls of this role: fewest (everything approved first time) and most. */
  calls: { min: number; max: number };
  /** Expected cost of one call of this role on `ref`, prompt overhead and context included. */
  perCallUsd: number;
  minUsd: number;
  expectedUsd: number;
  /** Principle 2 could only be met with `allowSameProvider`. */
  diversityWaived?: boolean;
  /** Low–high cost of this role from the calibration spread (R-302). */
  band: StepBand;
}

/** Resolved estimate settings for one node. */
export interface StepContext {
  router: Router;
  candidates: readonly Candidate[];
  constraints: RoutingConstraints;
  allowSameProvider: boolean;
  maxRevisions: number;
  voters: number;
  node: GraphNode;
  /** Quoted placeholder of the dependencies' outputs (allowance per dependency). */
  context: string;
  /** Placeholder of one step's output (the work a critic, rebuttal or judge reads). */
  work: string;
  /** Providers behind the dependencies (a review is routed away from them). */
  upstream: string[];
  /** The user's model for the first step (principle 4); taken by the first routed role. */
  pin?: ModelRef | undefined;
  /** Output spread from history, for the cost band. */
  spread?: SpreadFn | undefined;
}

export type Planned =
  { ok: true; steps: StepEstimate[] } | { ok: false; steps: StepEstimate[]; error: string };

const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Placeholder text of about `tokens` tokens (the core estimator counts 4 chars a token). */
export function filler(tokens: number): string {
  return 'x'.repeat(Math.max(0, Math.ceil(tokens)) * 4);
}

export function placeholderContext(node: GraphNode, allowanceTokens: number): string {
  return node.dependsOn.map((id) => quote(`${id} (${id})`, filler(allowanceTokens))).join('\n\n');
}

function step(
  x: StepContext,
  a: { role: ContributionRole; type: TaskType },
  c: ScoredCandidate,
  calls: { min: number; max: number },
  waived = false,
): StepEstimate {
  const per = c.estimate.expectedCostUsd;
  const card = x.candidates.find((k) => sameRef(k.ref, c.ref))?.card;
  return {
    role: a.role,
    ref: c.ref,
    calls,
    perCallUsd: per,
    minUsd: r6(per * calls.min),
    expectedUsd: r6(per * calls.max),
    ...(waived ? { diversityWaived: true } : {}),
    band: stepBand(card, c.estimate, calls, x.spread?.(c.ref, a.type)),
  };
}

class Diversity extends Error {}

/** A step prompt built from the dependencies' context and the work it reads. */
type Prompt = (context: string, work: string) => string;

/**
 * Adds the allowance (dependency context, work read) to a candidate's cost estimate. The
 * allowance is a pricing assumption only (review N1): routing, and so the context-window
 * fit, uses the prompt without it, as the real outputs are unknown before running; at run
 * time the real prompt decides and fallback handles an overflow.
 */
function withAllowance(x: StepContext, c: ScoredCandidate, prompt: Prompt): ScoredCandidate {
  const card = x.candidates.find((k) => sameRef(k.ref, c.ref))?.card;
  if (!card) return c;
  const tokens = (context: string, work: string): number =>
    estimateRequest(
      { model: c.ref.model, messages: stepMessages(x.node, prompt(context, work)) },
      card,
    ).inputTokens;
  const extra = Math.max(0, tokens(x.context, x.work) - tokens('', ''));
  const add = costUsd(card.price, { inputTokens: extra, outputTokens: 0 });
  const e = c.estimate;
  return {
    ...c,
    estimate: {
      ...e,
      inputTokens: e.inputTokens + extra,
      expectedCostUsd: r6(e.expectedCostUsd + add),
      maxCostUsd: r6(e.maxCostUsd + add),
    },
  };
}

/** Routes one role as the runner would (same prompt, type and exclusions), then prices it. */
function price(
  x: StepContext,
  a: {
    role: ContributionRole;
    type: TaskType;
    prompt: Prompt;
    exclude?: string[];
    strict?: boolean;
  },
): { c: ScoredCandidate; waived: boolean } {
  const r = route(x, a);
  return { c: withAllowance(x, r.c, a.prompt), waived: r.waived };
}

function route(
  x: StepContext,
  a: {
    role: ContributionRole;
    type: TaskType;
    prompt: Prompt;
    exclude?: string[];
    strict?: boolean;
  },
): { c: ScoredCandidate; waived: boolean } {
  const node = { ...x.node, type: a.type, messages: stepMessages(x.node, a.prompt('', '')) };
  const excluded = [...new Set(a.exclude ?? [])];
  const merged = {
    ...x.constraints,
    excludeProviders: [...(x.constraints.excludeProviders ?? []), ...excluded],
  };
  const pin = x.pin;
  x.pin = undefined;
  const decide = (c: RoutingConstraints): ScoredCandidate =>
    (pin
      ? routePinned(x.router, node, x.candidates, c, pin)
      : x.router.route(node, x.candidates, c)
    ).chosen;
  try {
    return { c: decide(merged), waived: false };
  } catch (err) {
    if (excluded.length === 0) throw err;
    if (a.strict || !x.allowSameProvider) {
      throw new Diversity(
        `${a.role}: no provider other than ${excluded.join(', ')} (principle 2${a.strict ? '' : '; allowSameProvider waives it'})`,
      );
    }
    return { c: decide(x.constraints), waived: true };
  }
}

/** Prices a prompt on a given model (revisions and rebuttals stay with their author). */
function on(x: StepContext, ref: ModelRef, type: TaskType, prompt: Prompt): ScoredCandidate {
  const node = { ...x.node, type, messages: stepMessages(x.node, prompt('', '')) };
  const c = servedCandidate(x.router.route(node, x.candidates, x.constraints), ref);
  return withAllowance(x, c, prompt);
}

function solo(x: StepContext, steps: StepEstimate[]): void {
  const review = x.node.type === 'critique' && x.upstream.length > 0;
  const p = price(x, {
    role: 'solo',
    type: x.node.type,
    prompt: (ctx) => authorPrompt(x.node, ctx),
    ...(review ? { exclude: x.upstream } : {}),
  });
  steps.push(step(x, { role: 'solo', type: x.node.type }, p.c, { min: 1, max: 1 }, p.waived));
}

const FAKE_VERDICT = (work: string) => ({
  approve: false,
  issues: [{ severity: 'major' as const, text: work.slice(0, 1024) || 'issue' }],
  summary: '',
});

/** Author, critic (author excluded; up to maxRevisions + 1 reviews + 1 retry), revisions. */
function authorCritic(x: StepContext, steps: StepEstimate[]): void {
  const { node } = x;
  const a = price(x, { role: 'author', type: node.type, prompt: (ctx) => authorPrompt(node, ctx) });
  steps.push(step(x, { role: 'author', type: node.type }, a.c, { min: 1, max: 1 }));
  const c = price(x, {
    role: 'critic',
    type: 'critique',
    prompt: (ctx, work) => criticPrompt(node, ctx, work),
    exclude: [a.c.ref.provider],
  });
  steps.push(
    step(
      x,
      { role: 'critic', type: 'critique' },
      c.c,
      { min: 1, max: x.maxRevisions + 2 },
      c.waived,
    ),
  );
  const rev = on(x, a.c.ref, node.type, (ctx, work) =>
    revisionPrompt(node, ctx, work, FAKE_VERDICT(work)),
  );
  steps.push(step(x, { role: 'revision', type: node.type }, rev, { min: 0, max: x.maxRevisions }));
}

/** Two debaters (distinct providers), one rebuttal each, a judge (debaters excluded, +1 retry). */
function debate(x: StepContext, steps: StepEstimate[]): void {
  const { node } = x;
  const d1 = price(x, {
    role: 'debater',
    type: node.type,
    prompt: (ctx) => debaterPrompt(node, ctx, 1),
  });
  steps.push(step(x, { role: 'debater', type: node.type }, d1.c, { min: 1, max: 1 }));
  const d2 = price(x, {
    role: 'debater',
    type: node.type,
    prompt: (ctx) => debaterPrompt(node, ctx, 2),
    exclude: [d1.c.ref.provider],
  });
  steps.push(step(x, { role: 'debater', type: node.type }, d2.c, { min: 1, max: 1 }, d2.waived));
  for (const d of [d1, d2]) {
    steps.push(
      step(
        x,
        { role: 'debater', type: node.type },
        on(x, d.c.ref, node.type, (ctx, work) => rebuttalPrompt(node, ctx, work, work)),
        { min: 1, max: 1 },
      ),
    );
  }
  const j = price(x, {
    role: 'judge',
    type: 'decision',
    prompt: (ctx, work) => judgePrompt(node, ctx, work, work),
    exclude: [d1.c.ref.provider, d2.c.ref.provider],
  });
  steps.push(step(x, { role: 'judge', type: 'decision' }, j.c, { min: 1, max: 2 }, j.waived));
}

/** Voters from distinct providers (never waived), +1 retry each; fewer than two is incomplete. */
function vote(x: StepContext, steps: StepEstimate[]): void {
  const used: string[] = [];
  const prompt: Prompt = (ctx) => voterPrompt(x.node, ctx);
  for (let i = 0; i < x.voters; i++) {
    try {
      const v = price(x, {
        role: 'voter',
        type: x.node.type,
        prompt,
        exclude: [...used],
        strict: true,
      });
      steps.push(step(x, { role: 'voter', type: x.node.type }, v.c, { min: 1, max: 2 }));
      used.push(v.c.ref.provider);
    } catch (err) {
      if (!(err instanceof Diversity)) throw err;
      if (i < 2) throw new Diversity(`vote: only ${i} distinct provider(s), at least 2 needed`);
      break;
    }
  }
}

const PLANS = { solo, author_critic: authorCritic, debate, vote };

/** The steps a node's protocol will run, each priced on the model it would be routed to. */
export function planSteps(x: StepContext, protocol: keyof typeof PLANS): Planned {
  const steps: StepEstimate[] = [];
  try {
    PLANS[protocol](x, steps);
    return { ok: true, steps };
  } catch (err) {
    return { ok: false, steps, error: err instanceof Error ? err.message : String(err) };
  }
}
