/**
 * Rate limits and quota exhaustion per `source:provider` (R-5E3, ADR-0034): an API's 429 or
 * an agent's exhausted plan marks that source and provider until a cooldown passes; later
 * steps of the run take the next candidate within policy. Keyed by source, so a rate-limited
 * API does not block the same provider's subscription agent, and the reverse. The policy
 * (local-only, denied providers) still applies to every fallback: a local-only node has no
 * cloud candidate to fall back to.
 */
import type { Candidate, RoutingConstraints } from '@kernelpai/core';

export type SourceKind = 'local' | 'api' | 'subscription';

/** Default cooldown after an API's 429 (no Retry-After reaches the orchestrator). */
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;

/** A routed model's source: `local` for local providers, else `api` (BYOK keys). */
export function sourceOf(c: Pick<Candidate, 'providerKind'>): SourceKind {
  return c.providerKind === 'local' ? 'local' : 'api';
}

/** The key limits are tracked under (same form as the program scheduler's). */
export function sourceKey(source: SourceKind, provider: string): string {
  return `${source}:${provider}`;
}

export class SourceLimits {
  private readonly until = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Marks `key` limited for `ms`; returns the instant it may be used again. */
  mark(key: string, ms: number): number {
    const at = this.now() + Math.max(1_000, ms);
    this.until.set(key, Math.max(at, this.until.get(key) ?? 0));
    return at;
  }

  limited(key: string): boolean {
    const at = this.until.get(key);
    if (at === undefined) return false;
    if (at > this.now()) return true;
    this.until.delete(key);
    return false;
  }

  /** Routed providers currently limited on their own source. */
  limitedProviders(candidates: readonly Candidate[]): string[] {
    const out = candidates
      .filter((c) => this.limited(sourceKey(sourceOf(c), c.ref.provider)))
      .map((c) => c.ref.provider);
    return [...new Set(out)];
  }
}

/** Constraints with limited providers denied on top (lists kept, never loosened). */
export function avoiding(
  base: RoutingConstraints | undefined,
  avoid: string[],
): RoutingConstraints {
  const b = base ?? {};
  if (avoid.length === 0) return b;
  return { ...b, deniedProviders: [...(b.deniedProviders ?? []), ...avoid] };
}
