import type { Candidate, Planner, RoutingConstraints } from '@kernelpai/core';
import { outputCalibration } from '@kernelpai/executor';
import type { Journal } from '@kernelpai/journal';
import { ModelPlanner, TemplatePlanner } from '@kernelpai/orchestrator';
import { candidates as scanCandidates, type ProviderRegistry } from '@kernelpai/providers';
import { CompetenceRouter } from '@kernelpai/router';
import { ProviderError } from '@kernelpai/core';
import { routingProfile } from '../config.js';
import { buildRegistry } from '../context.js';
import type { Io } from '../io.js';

export interface GraphOptions {
  request: string;
  planner?: 'template' | 'model';
  profile?: string;
  localOnly?: boolean;
  exclude?: string[];
  allowTest?: boolean;
  allowSameProvider?: boolean;
  apply?: boolean;
  /** Approve the git.apply write without asking (separate from --yes, review P2-F15). */
  yesApply?: boolean;
  yes?: boolean;
  overBudget?: boolean;
  newSession?: boolean;
  verbose?: boolean;
  db?: string;
}

export interface GraphSetup {
  registry: ProviderRegistry;
  candidates: Candidate[];
  constraints: RoutingConstraints;
  router: CompetenceRouter;
}

export async function graphSetup(io: Io, o: GraphOptions, journal: Journal): Promise<GraphSetup> {
  const registry = buildRegistry(io.env, io.err);
  const scan = await scanCandidates(registry);
  if (o.verbose) for (const u of scan.unavailable) io.err(`  – ${u.provider}: ${u.reason}\n`);
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
    profile: routingProfile(io.env, o.profile),
    expectedOutput: outputCalibration(journal),
  });
  return { registry, candidates: scan.candidates, constraints, router };
}

/** Template by default (free, instant, deterministic); `--planner model` asks a routed model. */
export function plannerFor(
  o: GraphOptions,
  s: GraphSetup,
  journal: Journal,
  sessionId: string,
): Planner {
  if (o.planner !== 'model') return new TemplatePlanner();
  return new ModelPlanner({
    router: s.router,
    candidates: s.candidates,
    constraints: s.constraints,
    resolve: (ref) => s.registry.get(ref.provider),
    journal,
    sessionId,
  });
}
