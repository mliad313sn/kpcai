import {
  ProviderError,
  type Candidate,
  type Planner,
  type RoutingConstraints,
} from '@kernelpai/core';
import { outputCalibration } from '@kernelpai/executor';
import type { Journal } from '@kernelpai/journal';
import { ModelPlanner, TemplatePlanner, type BudgetHook } from '@kernelpai/orchestrator';
import { candidates as scanCandidates, type ProviderRegistry } from '@kernelpai/providers';
import { CompetenceRouter } from '@kernelpai/router';
import { buildRegistry, routingProfile, type Env } from './env.js';

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
}

export interface GraphSetup {
  registry: ProviderRegistry;
  candidates: Candidate[];
  constraints: RoutingConstraints;
  router: CompetenceRouter;
}

export async function graphSetup(
  env: Env,
  say: (text: string) => void,
  o: GraphOptions,
  journal: Journal,
): Promise<GraphSetup> {
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
  });
  return { registry, candidates: scan.candidates, constraints, router };
}

/** Template by default (free, instant, deterministic); `planner: 'model'` asks a routed model. */
export function plannerFor(
  o: GraphOptions,
  s: GraphSetup,
  journal: Journal,
  sessionId: string,
  budget: BudgetHook,
): Planner {
  if (o.planner !== 'model') return new TemplatePlanner();
  // A model plan is a paid call: it goes through the budget gate like any step (P2-F8).
  return new ModelPlanner({
    budget,
    router: s.router,
    candidates: s.candidates,
    constraints: s.constraints,
    resolve: (ref) => s.registry.get(ref.provider),
    journal,
    sessionId,
  });
}
