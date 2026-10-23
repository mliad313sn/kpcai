import {
  ProviderError,
  type Candidate,
  type Planner,
  type RoutingConstraints,
} from '@kernelpai/core';
import { outputCalibration } from '@kernelpai/executor';
import type { Journal } from '@kernelpai/journal';
import {
  ModelPlanner,
  TemplatePlanner,
  type BudgetHook,
  type RecordedRun,
  type ReviewPolicy,
} from '@kernelpai/orchestrator';
import { candidates as scanCandidates, type ProviderRegistry } from '@kernelpai/providers';
import { CompetenceStore } from '@kernelpai/learning';
import { CompetenceRouter } from '@kernelpai/router';
import { buildRegistry, routingProfile, type Env } from './env.js';
import { KernelError } from './errors.js';
import { reviewPolicyOf } from './review-config.js';
import { rulesResolver } from './rules.js';
import type { Pack } from '@kernelpai/packs';

/** Planning and routing choices of one request (the protocol's `RunOptions`, plus `yes`). */
export interface GraphOptions {
  planner?: 'template' | 'model';
  profile?: string;
  localOnly?: boolean;
  exclude?: string[];
  allowTest?: boolean;
  allowSameProvider?: boolean;
  /** Accept cost confirmations without asking; never approves writes (review P2-F15). */
  yes?: boolean;
  overBudget?: boolean;
  /** Report unavailable providers while planning. */
  verbose?: boolean;
  /**
   * One git worktree per run (R-307, ADR-0021). `auto` isolates when the workspace is a
   * git working tree and runs in place otherwise; `true` requires git. Default false.
   */
  isolated?: boolean | 'auto';
  /** Authorised scope for packs that require one (WI-S1-03); validated by the kernel. */
  scope?: unknown;
  /** A skill every node of the plan uses (R-502); it can only narrow the nodes' tools. */
  skill?: string;
  /** A named agent every node of the plan is assigned (R-502); narrowing only. */
  agent?: string;
  /**
   * Nobody watches this run (the Enterprise daemon, ADR-0035): subscription agents are
   * refused (D-029 R1), journaled with the run. Narrowing only; not a protocol option.
   */
  unattended?: boolean;
  /** Why the run exists (S10 R6 J1): journaled as `run intent` with its run id. */
  intent?: { id: string; origin: string };
}

/** The routing constraints journaled with a run (P4-F2). */
export type RunRouting = NonNullable<RecordedRun['routing']>;

/** What a run's options say about routing, as journaled with it (the profile resolved). */
export function routingRecord(env: Env, o: GraphOptions): RunRouting {
  let profile: string | undefined;
  try {
    profile = routingProfile(env, o.profile);
  } catch {
    profile = undefined;
  }
  return {
    ...(o.localOnly ? { localOnly: true } : {}),
    ...(o.exclude?.length ? { exclude: [...o.exclude] } : {}),
    ...(profile ? { profile } : {}),
    allowTest: o.allowTest === true,
    ...(o.allowSameProvider === true ? { allowSameProvider: true } : {}),
  };
}

/**
 * A replay's or a fork's options held to the original run's routing as a floor (P4-F2):
 * local-only stays on, excluded providers stay excluded, test providers stay refused when
 * the run refused them; the run's profile applies unless one is given. Stricter options
 * are kept. A run journaled before P4-F2 has no record: the options are used as given.
 * `allowSameProvider` is refused unless the run had it (P4-R3; an unrecorded run did not).
 */
export function routingFloor(o: GraphOptions, r: RunRouting | undefined): GraphOptions {
  // Provider diversity (principle 2) is waived only if the run waived it (P4-R3).
  if (o.allowSameProvider === true && r?.allowSameProvider !== true)
    throw new KernelError(
      'refused',
      'allowSameProvider is refused: the original run kept provider diversity (principle 2)',
    );
  if (!r) return o;
  const out: GraphOptions = { ...o };
  if (r.localOnly) out.localOnly = true;
  const exclude = [...new Set([...(r.exclude ?? []), ...(o.exclude ?? [])])];
  if (exclude.length > 0) out.exclude = exclude;
  if (r.allowTest !== true) delete out.allowTest;
  if (o.profile === undefined && r.profile !== undefined) out.profile = r.profile;
  return out;
}

export interface GraphSetup {
  registry: ProviderRegistry;
  candidates: Candidate[];
  constraints: RoutingConstraints;
  router: CompetenceRouter;
  /** R-404 from `KPAI_REVIEW_POLICY` (ADR-0030): applied to the estimate and to the run. */
  reviewPolicy?: ReviewPolicy;
}

export async function graphSetup(
  env: Env,
  say: (text: string) => void,
  o: GraphOptions,
  journal: Journal,
  /** The workspace whose measured competence routing blends in (ADR-0028). */
  project?: string,
): Promise<GraphSetup> {
  // Read first: a bad setting fails before any provider is scanned.
  const reviewPolicy = reviewPolicyOf(env);
  const registry = buildRegistry(env, say);
  const scan = await scanCandidates(registry);
  if (o.verbose) for (const u of scan.unavailable) say(`  – ${u.provider}: ${u.reason}\n`);
  if (scan.candidates.length === 0) {
    throw new ProviderError(
      'unavailable',
      'kernel',
      'No provider is available; see `kpai providers`.',
    );
  }
  const constraints: RoutingConstraints = {
    ...(o.localOnly ? { localOnly: true } : {}),
    ...(o.exclude?.length ? { deniedProviders: o.exclude } : {}),
    ...(o.allowTest ? { excludeKinds: [] } : {}),
  };
  const router = new CompetenceRouter({
    profile: routingProfile(env, o.profile),
    expectedOutput: outputCalibration(journal),
    // Grades of this repository, read once per plan from the journal (ADR-0028).
    ...(project !== undefined
      ? { measured: CompetenceStore.fromJournal(journal, { project }) }
      : {}),
  });
  return {
    registry,
    candidates: scan.candidates,
    constraints,
    router,
    ...(reviewPolicy ? { reviewPolicy } : {}),
  };
}

/** Template by default (free, instant, deterministic); `planner: 'model'` asks a routed model. */
export function plannerFor(
  o: GraphOptions,
  s: GraphSetup,
  journal: Journal,
  sessionId: string,
  budget: BudgetHook,
  extra: { rulesText?: string; packs?: readonly Pack[] } = {},
): Planner {
  // Domain packs shape the plan (WI-S4-01); their text stays untrusted data there.
  const packs = extra.packs?.length ? { packs: extra.packs } : {};
  if (o.planner !== 'model') return new TemplatePlanner(packs);
  // A model plan is a paid call: it goes through the budget gate like any step (P2-F8).
  return new ModelPlanner({
    budget,
    router: s.router,
    candidates: s.candidates,
    constraints: s.constraints,
    // The planner sees the repository rules too, as untrusted context (R-306).
    resolve: rulesResolver((ref) => s.registry.get(ref.provider), extra.rulesText ?? ''),
    executor: { expectedOutput: outputCalibration(journal) },
    ...packs,
    journal,
    sessionId,
  });
}
