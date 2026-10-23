import type { RoutingProfile, RoutingWeights } from '@kernelpai/core';

/**
 * Weight presets for w1..w4 of spec §5.3. Competence terms are in [0,1] and
 * penalties are in [0,1], so the weights read directly as relative importance.
 * - economy favours cheap (often local) models, spec §3.4 « mode économe »;
 * - balanced is the default;
 * - performance buys competence and nearly ignores price.
 */
export const PROFILE_WEIGHTS: Readonly<Record<RoutingProfile, Readonly<RoutingWeights>>> = {
  economy: { competenceStatic: 0.3, competenceMeasured: 0.2, cost: 0.4, latency: 0.1 },
  balanced: { competenceStatic: 0.4, competenceMeasured: 0.25, cost: 0.2, latency: 0.15 },
  performance: { competenceStatic: 0.55, competenceMeasured: 0.35, cost: 0.05, latency: 0.05 },
};

export const DEFAULT_PROFILE: RoutingProfile = 'balanced';

/** Profile preset, optionally overridden weight by weight (e.g. by the benchmark). */
export function weightsFor(
  profile: RoutingProfile = DEFAULT_PROFILE,
  overrides: Partial<RoutingWeights> = {},
): RoutingWeights {
  const w = { ...PROFILE_WEIGHTS[profile], ...overrides };
  for (const [k, v] of Object.entries(w)) {
    if (!Number.isFinite(v) || v < 0) throw new RangeError(`Routing weight ${k} must be >= 0`);
  }
  return w;
}
