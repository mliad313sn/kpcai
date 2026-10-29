/**
 * `RunStarter` over the kernel (ADR-0031 §5, ADR-0035): a work package becomes one planned
 * graph run in its own worktree, unattended (D-029 R1: no subscription agent), with its
 * intent journaled (S10 R6 J1) and its own journal session (its cost is read back after a
 * crash). Calls run inside the program's async context so the kernel's questions for this
 * run reach the envelope, not a human dialog.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  plannedSources,
  sourceOf,
  type GraphOptions,
  type Kernel,
  type Plan,
  type RunHandle,
} from '@kernelpai/kernel';
import {
  permits,
  type EffectivePolicy,
  type PlannedRun,
  type RunStarter,
} from '@kernelpai/program';
import { soloGraph } from './solo.js';

export interface ProgramContext {
  programId: string;
  wpId: string;
}

/** Set around every kernel call made for a program: confirmations read it. */
export const programContext = new AsyncLocalStorage<ProgramContext>();

interface Planned {
  plan: PlannedRun;
  /** The source policy it was planned within (a new policy plans again). */
  policyKey: string;
  /** A review run's one-node read-only graph (passed as the plan's edit). */
  graph?: unknown;
  request: string;
  sessionId: string;
  options: GraphOptions;
  ctx: ProgramContext;
  intent: { id: string; origin: string };
}

export interface StartedHandle {
  handle: RunHandle;
  sessionId: string;
  planId: string;
  ctx: ProgramContext;
}

export interface StarterOptions {
  kernel: Kernel;
  /** Defaults of every program run (`allowTest` for offline demos). */
  options?: GraphOptions;
  /** Providers a review run must not use (every builder of the phase). */
  reviewExclude?: (programId: string) => string[];
  /** The charter hash a run's intent names (`charter-wp:<hash>`). */
  charterHash?: (programId: string) => string;
  onStarted?: (s: StartedHandle) => void;
}

function sourceOfPlan(p: Plan): PlannedRun['source'] {
  const s = plannedSources(p.estimate, (provider) => kindOf(p, provider));
  const kinds = new Set(s.sources.map((x) => x.source));
  // A mixed plan counts as its most restricted source: subscription, then API.
  if (kinds.has('subscription')) return 'subscription';
  if (kinds.has('api') || kinds.size === 0) return 'api';
  return 'local';
}

function kindOf(p: Plan, provider: string): string | undefined {
  try {
    return p.setup.registry.get(provider).descriptor.kind;
  } catch {
    return undefined;
  }
}

type PlanInput = Parameters<RunStarter['plan']>[0];

/**
 * A work package's source policy as routing options (P5-F3): local-only when only local
 * sources are allowed, and every known provider outside the policy excluded, so the run's
 * in-run fallback (rate limit, error) stays within it. `known` maps provider id → kind.
 */
export function policyOptions(
  policy: EffectivePolicy | undefined,
  known: ReadonlyMap<string, string | undefined>,
): Pick<GraphOptions, 'localOnly' | 'exclude'> {
  if (!policy) return {};
  const outside = [...known].filter(([id, kind]) => !permits(policy, sourceOf(kind), id));
  const exclude = [...new Set([...policy.deny, ...outside.map(([id]) => id)])].sort();
  return {
    ...(policy.sources.every((x) => x === 'local') ? { localOnly: true } : {}),
    ...(exclude.length ? { exclude } : {}),
  };
}

function merged(
  base: GraphOptions,
  extra: string[],
  over: Pick<GraphOptions, 'localOnly' | 'exclude'>,
): GraphOptions {
  const exclude = [...new Set([...extra, ...(over.exclude ?? [])])];
  const out: GraphOptions = { ...base, ...(over.localOnly ? { localOnly: true } : {}) };
  if (exclude.length) out.exclude = exclude;
  else delete out.exclude;
  return out;
}

/** The gate review as one read-only critique node, re-estimated (its cap is what is checked). */
function reviewPlan(k: Kernel, p: Plan, request: string) {
  const graph = soloGraph(p, 'Independent gate review', request);
  const check = k.validatePlan(p.planId, graph);
  if (!check.ok || !check.estimate)
    throw new Error(`review cannot run: ${check.problems.join('; ')}`);
  return { graph, estimate: check.estimate };
}

export class KernelRunStarter implements RunStarter {
  private readonly planned = new Map<string, Planned>();
  private readonly byWp = new Map<string, string>();
  /** Providers the kernel's registry holds, id → kind, learnt from plans (P5-F3). */
  private readonly known = new Map<string, string | undefined>();

  constructor(private readonly o: StarterOptions) {}

  async plan(input: PlanInput): Promise<PlannedRun> {
    const key = `${input.programId}/${input.wpId}/${input.purpose}`;
    const policyKey = JSON.stringify(input.policy ?? null);
    const cached = this.planned.get(this.byWp.get(key) ?? '');
    if (cached && cached.request === input.request && cached.policyKey === policyKey)
      return cached.plan;
    const ctx = { programId: input.programId, wpId: input.wpId };
    const k = this.o.kernel;
    const sessionId = k.openSession(`program ${input.programId} ${input.wpId}`, false);
    const { p, options } = await this.planWithin(input, ctx, sessionId);
    const review = input.purpose === 'review' ? reviewPlan(k, p, input.request) : undefined;
    const est = review?.estimate ?? p.estimate;
    const sources = plannedSources(est, (provider) => kindOf(p, provider));
    const plan: PlannedRun = {
      planId: p.planId,
      capUsd: est.capUsd,
      expectedUsd: est.expectedUsd,
      providers: sources.providers,
      source: sourceOfPlan({ ...p, estimate: est }),
    };
    const hash = this.o.charterHash?.(input.programId) ?? 'unknown';
    const intent = {
      id: `${input.programId}/${input.wpId}`,
      origin: `charter-wp:${hash.slice(0, 16)}`,
    };
    const graph = review ? { graph: review.graph } : {};
    this.planned.set(p.planId, {
      plan,
      policyKey,
      request: input.request,
      sessionId,
      options,
      ctx,
      intent,
      ...graph,
    });
    this.byWp.set(key, p.planId);
    return plan;
  }

  /**
   * Plans within the work package's source policy (P5-F3). Providers the kernel knows are
   * learnt from each plan's registry; when one turns out to be outside the policy and was
   * not yet excluded, the request is planned again with it excluded (once per provider).
   */
  private async planWithin(input: PlanInput, ctx: ProgramContext, sessionId: string) {
    const review =
      input.purpose === 'review' ? (this.o.reviewExclude?.(input.programId) ?? []) : [];
    const extra = [...(this.o.options?.exclude ?? []), ...review];
    const base: GraphOptions = { ...this.o.options, isolated: true, unattended: true };
    const k = this.o.kernel;
    const run = (o: GraphOptions) =>
      programContext.run(ctx, () => k.plan(input.request, o, sessionId));
    let options = merged(base, extra, policyOptions(input.policy, this.known));
    let p = await run(options);
    if (!input.policy) return { p, options };
    for (const a of p.setup.registry.list?.() ?? [])
      this.known.set(a.descriptor.id, a.descriptor.kind);
    const again = merged(base, extra, policyOptions(input.policy, this.known));
    if ((again.exclude ?? []).some((x) => !(options.exclude ?? []).includes(x))) {
      options = again;
      p = await run(options);
    }
    return { p, options };
  }

  /** Starts a plan this starter made; the envelope has allowed it (the driver's contract). */
  async start(planId: string, _o: { isolated: true }): Promise<{ runId: string }> {
    const p = this.planned.get(planId);
    if (!p) throw new Error(`no program plan ${planId}`);
    // WP7-L13: a daemon's run is unattended, whatever the defaults said (D-029 R1).
    if (p.options.unattended !== true) throw new Error('a program run must be unattended');
    this.forget(planId);
    const k = this.o.kernel;
    const handle = await programContext.run(p.ctx, () =>
      k.startRun({
        request: p.request,
        planId,
        ...(p.graph ? { graph: p.graph } : {}),
        options: { ...p.options, intent: p.intent },
      }),
    );
    this.o.onStarted?.({ handle, sessionId: p.sessionId, planId, ctx: p.ctx });
    return { runId: handle.runId };
  }

  /** The session a plan journals in (known until the plan is started or dropped). */
  sessionOf(planId: string): string | undefined {
    return this.planned.get(planId)?.sessionId;
  }

  /** Drops a cached plan (an escalation or a refusal: the next attempt plans again). */
  forget(planId: string): void {
    const p = this.planned.get(planId);
    if (!p) return;
    this.planned.delete(planId);
    for (const [k, v] of this.byWp) if (v === planId) this.byWp.delete(k);
  }

  /** Drops every cached plan of a work package. */
  forgetWp(programId: string, wpId: string): void {
    for (const purpose of ['work', 'review']) {
      const id = this.byWp.get(`${programId}/${wpId}/${purpose}`);
      if (id) this.forget(id);
    }
  }
}
