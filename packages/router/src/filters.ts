import {
  refToString,
  type Candidate,
  type CostEstimate,
  type ProviderDescriptor,
  type RoutingConstraints,
  type TaskNode,
} from '@kernelpai/core';

export const DEFAULT_EXCLUDED_KINDS: readonly ProviderDescriptor['kind'][] = ['test'];

/** Constraints with defaults applied and lists turned into sets for O(1) checks. */
export interface PreparedConstraints {
  allowedJurisdictions: ReadonlySet<string> | undefined;
  deniedProviders: ReadonlySet<string>;
  deniedModels: ReadonlySet<string>;
  excludeProviders: ReadonlySet<string>;
  excludeKinds: ReadonlySet<string>;
  localOnly: boolean;
}

const lower = (xs: readonly string[] | undefined): Set<string> =>
  new Set((xs ?? []).map((x) => x.toLowerCase()));

export function prepareConstraints(c: RoutingConstraints = {}): PreparedConstraints {
  return {
    allowedJurisdictions: c.allowedJurisdictions ? lower(c.allowedJurisdictions) : undefined,
    deniedProviders: new Set(c.deniedProviders ?? []),
    deniedModels: new Set(c.deniedModels ?? []),
    excludeProviders: new Set(c.excludeProviders ?? []),
    excludeKinds: new Set(c.excludeKinds ?? DEFAULT_EXCLUDED_KINDS),
    localOnly: c.localOnly ?? false,
  };
}

/** Policy filters that need no cost estimate. Returns a rejection reason or undefined. */
export function policyRejection(cand: Candidate, c: PreparedConstraints): string | undefined {
  const { provider } = cand.ref;
  if (c.excludeKinds.has(cand.providerKind)) {
    return `provider kind "${cand.providerKind}" excluded`;
  }
  if (c.deniedProviders.has(provider)) return `provider ${provider} denied`;
  if (c.deniedModels.has(refToString(cand.ref))) return 'model denied';
  if (c.excludeProviders.has(provider)) return `provider ${provider} excluded for diversity`;
  if (c.localOnly && cand.providerKind !== 'local') return 'local only';
  if (c.allowedJurisdictions && !c.allowedJurisdictions.has(cand.jurisdiction.toLowerCase())) {
    return `jurisdiction ${cand.jurisdiction} not allowed`;
  }
  return undefined;
}

/** Capability filters: required modalities and context window. */
export function capabilityRejection(
  cand: Candidate,
  node: TaskNode,
  estimate: CostEstimate,
): string | undefined {
  const missing = (node.requiredModalities ?? []).filter((m) => !cand.card.modalities.includes(m));
  if (missing.length > 0) return `missing modality ${missing.join(', ')}`;
  const needed = estimate.inputTokens + estimate.maxOutputTokens;
  if (needed > cand.card.contextWindow) {
    return `context ${cand.card.contextWindow} < ${needed} tokens needed`;
  }
  return undefined;
}
