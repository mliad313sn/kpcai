import type {
  Candidate,
  ContributionRole,
  GraphNode,
  ModelRef,
  Router,
  RoutingConstraints,
  ScoredCandidate,
  TaskType,
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
import { servedCandidate } from './routing.js';

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
  role: ContributionRole,
  c: ScoredCandidate,
  min: number,
  max: number,
  waived = false,
): StepEstimate {
  const per = c.estimate.expectedCostUsd;
  return {
    role,
    ref: c.ref,
    calls: { min, max },
    perCallUsd: per,
    minUsd: r6(per * min),
    expectedUsd: r6(per * max),
    ...(waived ? { diversityWaived: true } : {}),
  };
}

class Diversity extends Error {}

/** Routes one role as the runner would (same prompt, type and exclusions). */
function price(
  x: StepContext,
  a: {
    role: ContributionRole;
    type: TaskType;
    prompt: string;
    exclude?: string[];
    strict?: boolean;
  },
): { c: ScoredCandidate; waived: boolean } {
  const node = { ...x.node, type: a.type, messages: stepMessages(x.node, a.prompt) };
  const excluded = [...new Set(a.exclude ?? [])];
  const merged = {
    ...x.constraints,
    excludeProviders: [...(x.constraints.excludeProviders ?? []), ...excluded],
  };
  try {
    return { c: x.router.route(node, x.candidates, merged).chosen, waived: false };
  } catch (err) {
    if (excluded.length === 0) throw err;
    if (a.strict || !x.allowSameProvider) {
      throw new Diversity(
        `${a.role}: no provider other than ${excluded.join(', ')} (principle 2${a.strict ? '' : '; allowSameProvider waives it'})`,
      );
    }
    return { c: x.router.route(node, x.candidates, x.constraints).chosen, waived: true };
  }
}

/** Prices a prompt on a given model (revisions and rebuttals stay with their author). */
function on(x: StepContext, ref: ModelRef, type: TaskType, prompt: string): ScoredCandidate {
  const node = { ...x.node, type, messages: stepMessages(x.node, prompt) };
  return servedCandidate(x.router.route(node, x.candidates, x.constraints), ref);
}

function solo(x: StepContext, steps: StepEstimate[]): void {
  const review = x.node.type === 'critique' && x.upstream.length > 0;
  const p = price(x, {
    role: 'solo',
    type: x.node.type,
    prompt: authorPrompt(x.node, x.context),
    ...(review ? { exclude: x.upstream } : {}),
  });
  steps.push(step('solo', p.c, 1, 1, p.waived));
}

const FAKE_VERDICT = (x: StepContext) => ({
  approve: false,
  issues: [{ severity: 'major' as const, text: x.work.slice(0, 1024) }],
  summary: '',
});

/** Author, critic (author excluded; up to maxRevisions + 1 reviews + 1 retry), revisions. */
function authorCritic(x: StepContext, steps: StepEstimate[]): void {
  const { node, context, work } = x;
  const a = price(x, { role: 'author', type: node.type, prompt: authorPrompt(node, context) });
  steps.push(step('author', a.c, 1, 1));
  const c = price(x, {
    role: 'critic',
    type: 'critique',
    prompt: criticPrompt(node, context, work),
    exclude: [a.c.ref.provider],
  });
  steps.push(step('critic', c.c, 1, x.maxRevisions + 2, c.waived));
  const rev = on(x, a.c.ref, node.type, revisionPrompt(node, context, work, FAKE_VERDICT(x)));
  steps.push(step('revision', rev, 0, x.maxRevisions));
}

/** Two debaters (distinct providers), one rebuttal each, a judge (debaters excluded, +1 retry). */
function debate(x: StepContext, steps: StepEstimate[]): void {
  const { node, context, work } = x;
  const d1 = price(x, {
    role: 'debater',
    type: node.type,
    prompt: debaterPrompt(node, context, 1),
  });
  steps.push(step('debater', d1.c, 1, 1));
  const d2 = price(x, {
    role: 'debater',
    type: node.type,
    prompt: debaterPrompt(node, context, 2),
    exclude: [d1.c.ref.provider],
  });
  steps.push(step('debater', d2.c, 1, 1, d2.waived));
  for (const d of [d1, d2]) {
    steps.push(
      step('debater', on(x, d.c.ref, node.type, rebuttalPrompt(node, context, work, work)), 1, 1),
    );
  }
  const j = price(x, {
    role: 'judge',
    type: 'decision',
    prompt: judgePrompt(node, context, work, work),
    exclude: [d1.c.ref.provider, d2.c.ref.provider],
  });
  steps.push(step('judge', j.c, 1, 2, j.waived));
}

/** Voters from distinct providers (never waived), +1 retry each; fewer than two is incomplete. */
function vote(x: StepContext, steps: StepEstimate[]): void {
  const used: string[] = [];
  const prompt = voterPrompt(x.node, x.context);
  for (let i = 0; i < x.voters; i++) {
    try {
      const v = price(x, {
        role: 'voter',
        type: x.node.type,
        prompt,
        exclude: [...used],
        strict: true,
      });
      steps.push(step('voter', v.c, 1, 2));
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
