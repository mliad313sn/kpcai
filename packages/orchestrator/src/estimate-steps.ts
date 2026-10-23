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
import {
  HEURISTIC_SPREAD,
  stepBand,
  type SpreadFn,
  type StepBand,
  type StepInput,
} from './band.js';
import { criticsOf } from './protocols/review.js';
import { routePinned, sameRef, servedCandidate } from './routing.js';
import type { PlannedNode } from './types.js';

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
  /** Size of one answer of this role, as the next step reads it. */
  output: TextSize;
}

/**
 * Size in tokens of a text another step produces (a dependency's result, the work a critic
 * reads): the expected size prices `expectedUsd`, low and high bound the band.
 */
export interface TextSize {
  expected: number;
  low: number;
  high: number;
  /** Sized from the producer's history; else around the dependency allowance. */
  calibrated: boolean;
}

/** A text of unknown size: the allowance, with the cold-start factors around it. */
export function heuristicText(allowance: number): TextSize {
  return {
    expected: allowance,
    low: allowance * HEURISTIC_SPREAD.low,
    high: allowance * HEURISTIC_SPREAD.high,
    calibrated: false,
  };
}

/** Low/high union of texts (one of several answers, e.g. two debaters'). */
export function unionText(texts: readonly TextSize[], allowance: number): TextSize {
  if (texts.length === 0) return heuristicText(allowance);
  return {
    expected: Math.max(...texts.map((t) => t.expected)),
    low: Math.min(...texts.map((t) => t.low)),
    high: Math.max(...texts.map((t) => t.high)),
    calibrated: texts.every((t) => t.calibrated),
  };
}

/** The dependencies' context as quoted placeholders, at each size. */
export interface ContextTexts {
  expected: string;
  low: string;
  high: string;
  calibrated: boolean;
}

/** Resolved estimate settings for one node. */
export interface StepContext {
  router: Router;
  candidates: readonly Candidate[];
  constraints: RoutingConstraints;
  allowSameProvider: boolean;
  maxRevisions: number;
  voters: number;
  /** Debate judges by default (a node's `judges` wins). */
  judges?: number | undefined;
  node: GraphNode;
  /** Quoted placeholders of the dependencies' outputs, at their expected, low, high size. */
  context: ContextTexts;
  /** Tokens assumed for a text whose producer has no history. */
  allowance: number;
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

/**
 * Quoted placeholders of a node's dependencies; `size` gives each one's tokens (the
 * dependency's output size, else the allowance).
 */
export function placeholderContext(
  node: GraphNode,
  allowanceTokens: number,
  size: (id: string) => TextSize = () => heuristicText(allowanceTokens),
): ContextTexts {
  const at = (pick: (t: TextSize) => number): string =>
    node.dependsOn.map((id) => quote(`${id} (${id})`, filler(pick(size(id))))).join('\n\n');
  return {
    expected: at((t) => t.expected),
    low: at((t) => t.low),
    high: at((t) => t.high),
    calibrated: node.dependsOn.every((id) => size(id).calibrated),
  };
}

/** One routed role, priced at the expected sizes, with its input range for the band. */
interface Priced {
  c: ScoredCandidate;
  waived: boolean;
  input: StepInput;
}

function step(
  x: StepContext,
  a: { role: ContributionRole; type: TaskType },
  p: Priced,
  calls: { min: number; max: number },
): StepEstimate {
  const { c } = p;
  const card = x.candidates.find((k) => sameRef(k.ref, c.ref))?.card;
  const spread = x.spread?.(c.ref, a.type, a.role);
  // With this role's history, the likely answer is its median (the router's calibration
  // pools every role of the model and task type).
  const median = spread && Math.min(spread.median, c.estimate.maxOutputTokens);
  const likely =
    card && median !== undefined
      ? costUsd(card.price, { inputTokens: c.estimate.inputTokens, outputTokens: median })
      : c.estimate.expectedCostUsd;
  // Invariant (D-021): low ≤ expected ≤ high, per call and so per step, node and graph.
  const band = stepBand(card, c.estimate, calls, spread, p.input, likely);
  const per = band.perCallUsd;
  const output: TextSize = spread
    ? {
        ...band.outputTokens,
        expected: Math.min(spread.median, band.outputTokens.high),
        calibrated: true,
      }
    : heuristicText(x.allowance);
  return {
    role: a.role,
    ref: c.ref,
    calls,
    perCallUsd: per,
    minUsd: r6(per * calls.min),
    expectedUsd: r6(per * calls.max),
    ...(p.waived ? { diversityWaived: true } : {}),
    band,
    output,
  };
}

class Diversity extends Error {}

/** A step prompt built from the dependencies' context and the work it reads. */
type Prompt = (context: string, work: string) => string;

/**
 * Adds the allowance (dependency context, work read) to a candidate's cost estimate, at
 * the expected sizes, and measures the first call's input at the low and high sizes for
 * the band. The allowance is a pricing assumption only (review N1): routing, and so the
 * context-window fit, uses the prompt without it, as the real outputs are unknown before
 * running; at run time the real prompt decides and fallback handles an overflow.
 */
function withAllowance(
  x: StepContext,
  r: { c: ScoredCandidate; waived: boolean },
  prompt: Prompt,
  work: TextSize,
): Priced {
  const { c } = r;
  const tools = (x.node.tools?.length ?? 0) > 0;
  const card = x.candidates.find((k) => sameRef(k.ref, c.ref))?.card;
  const calibrated = x.context.calibrated && work.calibrated;
  const flat = { low: c.estimate.inputTokens, high: c.estimate.inputTokens };
  if (!card) return { ...r, input: { tokens: flat, calibrated, tools } };
  const tokens = (context: string, w: string): number =>
    estimateRequest(
      { model: c.ref.model, messages: stepMessages(x.node, prompt(context, w)) },
      card,
    ).inputTokens;
  const bare = tokens('', '');
  const extra = Math.max(0, tokens(x.context.expected, filler(work.expected)) - bare);
  const add = costUsd(card.price, { inputTokens: extra, outputTokens: 0 });
  const e = c.estimate;
  const at = (ctx: string, w: number): number =>
    e.inputTokens + Math.max(0, tokens(ctx, filler(w)) - bare);
  return {
    c: {
      ...c,
      estimate: {
        ...e,
        inputTokens: e.inputTokens + extra,
        expectedCostUsd: r6(e.expectedCostUsd + add),
        maxCostUsd: r6(e.maxCostUsd + add),
      },
    },
    waived: r.waived,
    input: {
      tokens: { low: at(x.context.low, work.low), high: at(x.context.high, work.high) },
      calibrated,
      tools,
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
    /** The work this role reads (none: the dependency context only). */
    work?: TextSize;
  },
): Priced {
  return withAllowance(x, route(x, a), a.prompt, a.work ?? NO_TEXT);
}

const NO_TEXT: TextSize = { expected: 0, low: 0, high: 0, calibrated: true };

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
function on(x: StepContext, ref: ModelRef, type: TaskType, prompt: Prompt, work: TextSize): Priced {
  const node = { ...x.node, type, messages: stepMessages(x.node, prompt('', '')) };
  const c = servedCandidate(x.router.route(node, x.candidates, x.constraints), ref);
  return withAllowance(x, { c, waived: false }, prompt, work);
}

function solo(x: StepContext, steps: StepEstimate[]): void {
  const review = x.node.type === 'critique' && x.upstream.length > 0;
  const p = price(x, {
    role: 'solo',
    type: x.node.type,
    prompt: (ctx) => authorPrompt(x.node, ctx),
    ...(review ? { exclude: x.upstream } : {}),
  });
  steps.push(step(x, { role: 'solo', type: x.node.type }, p, { min: 1, max: 1 }));
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
  const author = step(x, { role: 'author', type: node.type }, a, { min: 1, max: 1 });
  steps.push(author);
  const c = price(x, {
    role: 'critic',
    type: 'critique',
    prompt: (ctx, work) => criticPrompt(node, ctx, work),
    exclude: [a.c.ref.provider],
    work: author.output,
  });
  const calls = { min: 1, max: x.maxRevisions + 2 };
  steps.push(step(x, { role: 'critic', type: 'critique' }, c, calls));
  const prompt: Prompt = (ctx, work) => criticPrompt(node, ctx, work);
  const more = { role: 'critic' as const, type: 'critique' as const, prompt, work: author.output };
  const wanted = criticsOf((node as PlannedNode).critics);
  extraReviewers(x, steps, { ...more, exclude: [a.c.ref.provider], wanted, calls }, c);
  const rev = on(
    x,
    a.c.ref,
    node.type,
    (ctx, work) => revisionPrompt(node, ctx, work, FAKE_VERDICT(work)),
    author.output,
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
  const s1 = step(x, { role: 'debater', type: node.type }, d1, { min: 1, max: 1 });
  const d2 = price(x, {
    role: 'debater',
    type: node.type,
    prompt: (ctx) => debaterPrompt(node, ctx, 2),
    exclude: [d1.c.ref.provider],
  });
  const s2 = step(x, { role: 'debater', type: node.type }, d2, { min: 1, max: 1 });
  steps.push(s1, s2);
  // Each rebuttal reads both openings; the judge reads both rebuttals.
  const openings = unionText([s1.output, s2.output], x.allowance);
  const rebuttals = [d1, d2].map((d) =>
    step(
      x,
      { role: 'debater', type: node.type },
      on(x, d.c.ref, node.type, (ctx, work) => rebuttalPrompt(node, ctx, work, work), openings),
      { min: 1, max: 1 },
    ),
  );
  steps.push(...rebuttals);
  const judge = {
    role: 'judge' as const,
    type: 'decision' as const,
    prompt: (ctx: string, work: string) => judgePrompt(node, ctx, work, work),
    exclude: [d1.c.ref.provider, d2.c.ref.provider],
    work: unionText(
      rebuttals.map((r) => r.output),
      x.allowance,
    ),
  };
  const j = price(x, judge);
  const calls = { min: 1, max: 2 };
  steps.push(step(x, judge, j, calls));
  const wanted = criticsOf((node as PlannedNode).judges ?? x.judges);
  extraReviewers(x, steps, { ...judge, wanted, calls }, j);
}

/**
 * Critics or judges beyond the first (R-404 policy): each from a provider not used yet
 * (strict, as the runner does); when none is left the node runs with fewer.
 */
function extraReviewers(
  x: StepContext,
  steps: StepEstimate[],
  a: {
    role: ContributionRole;
    type: TaskType;
    prompt: Prompt;
    work: TextSize;
    exclude: string[];
    wanted: number;
    calls: { min: number; max: number };
  },
  first: Priced,
): void {
  const used = [...a.exclude, first.c.ref.provider];
  for (let i = 1; i < a.wanted; i++) {
    try {
      const p = price(x, { ...a, exclude: [...used], strict: true });
      steps.push(step(x, { role: a.role, type: a.type }, p, a.calls));
      used.push(p.c.ref.provider);
    } catch (err) {
      if (!(err instanceof Diversity)) throw err;
      break;
    }
  }
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
      steps.push(step(x, { role: 'voter', type: x.node.type }, v, { min: 1, max: 2 }));
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

/** Roles whose answer becomes the node's output (what dependants read as context). */
const ANSWERS = new Set<ContributionRole>(['solo', 'author', 'revision', 'debater', 'voter']);

/** Size of a node's output from its planned steps (allowance when none could be planned). */
export function nodeOutput(steps: readonly StepEstimate[], allowance: number): TextSize {
  return unionText(
    steps.filter((s) => ANSWERS.has(s.role)).map((s) => s.output),
    allowance,
  );
}
