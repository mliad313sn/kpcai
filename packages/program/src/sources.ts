/**
 * Model sources and their policies (D-026 sources, ADR-0031 §8). Policies only narrow
 * from portfolio to program to department to seat, so "security is local-only" cannot be
 * undone by a seat, and a local-only seat never falls back to the cloud.
 */
import type {
  Charter,
  ProgramState,
  RunRecord,
  SourceKind,
  SourcePolicy,
  SubscriptionQuota,
} from './schemas.js';

export interface EffectivePolicy {
  /** Allowed sources; all three when no level restricts them. */
  sources: SourceKind[];
  /** Allowed providers; undefined means any provider not denied. */
  providers?: string[];
  deny: string[];
}

const ALL: SourceKind[] = ['local', 'api', 'subscription'];

/** Intersection of every level's allow-lists, union of their deny-lists. */
export function effectivePolicy(levels: Array<SourcePolicy | undefined>): EffectivePolicy {
  let sources = ALL;
  let providers: string[] | undefined;
  const deny = new Set<string>();
  for (const l of levels) {
    if (!l) continue;
    if (l.sources) sources = sources.filter((s) => l.sources!.includes(s));
    if (l.providers) providers = (providers ?? l.providers).filter((p) => l.providers!.includes(p));
    for (const d of l.denyProviders) deny.add(d);
  }
  return providers ? { sources, providers, deny: [...deny] } : { sources, deny: [...deny] };
}

/** True when a run on this source and provider is inside the policy. */
export function permits(p: EffectivePolicy, source: SourceKind, provider: string): boolean {
  if (!p.sources.includes(source)) return false;
  if (p.deny.includes(provider)) return false;
  return !p.providers || p.providers.includes(provider);
}

/**
 * The policy a work package's runs follow: program, then the lead seat's department, then
 * the seat. A review run (keyed by the phase id) follows the review department's.
 */
export function policyFor(
  charter: Charter,
  wpId: string,
  portfolio?: SourcePolicy,
): EffectivePolicy {
  const wp = charter.phases.flatMap((p) => p.workPackages).find((w) => w.id === wpId);
  const seat = wp
    ? charter.seats.find((s) => s.id === wp.lead)
    : charter.seats.find((s) => s.kind === 'reviewer');
  const dept = charter.departments.find((d) => d.id === seat?.department);
  return effectivePolicy([portfolio, charter.sources, dept?.sources, seat?.sources]);
}

/** Runs and hours a subscription has used in this program (live runs count as one run). */
export function subscriptionUse(
  runs: RunRecord[],
  provider: string,
): { runs: number; hours: number } {
  const mine = runs.filter((r) => r.source === 'subscription' && r.providers.includes(provider));
  const counted = mine.filter((r) => r.status !== 'not_run');
  return { runs: counted.length, hours: counted.reduce((a, r) => a + r.hours, 0) };
}

/** Why one more run on this subscription does not fit its quota, or undefined. */
export function quotaBlocker(
  state: Pick<ProgramState, 'runs'>,
  q: SubscriptionQuota | undefined,
): string | undefined {
  if (!q) return 'subscription not listed in the envelope';
  const used = subscriptionUse(state.runs, q.provider);
  if (q.runs !== undefined && used.runs + 1 > q.runs) return `${q.agent} run quota used up`;
  if (q.hours !== undefined && used.hours >= q.hours) return `${q.agent} hour quota used up`;
  return undefined;
}

export interface SourceSpend {
  apiUsd: number;
  localHours: number;
  subscriptions: Array<{ provider: string; agent: string; runs: number; hours: number }>;
}

/** Spend by source for reports: dollars, local compute time, subscription runs and hours. */
export function spendBySource(state: Pick<ProgramState, 'charter' | 'runs'>): SourceSpend {
  const of = (s: SourceKind): RunRecord[] => state.runs.filter((r) => r.source === s);
  return {
    apiUsd: of('api').reduce((a, r) => a + r.costUsd, 0),
    localHours: of('local').reduce((a, r) => a + r.hours, 0),
    subscriptions: state.charter.envelope.subscriptions.map((q) => ({
      provider: q.provider,
      agent: q.agent,
      ...subscriptionUse(state.runs, q.provider),
    })),
  };
}
