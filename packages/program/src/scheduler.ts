/**
 * Portfolio scheduling (D-026 §2, ADR-0031 §7): which queued jobs start now. Pure: the
 * daemon persists the queue (durable across restarts) and asks `schedule` on every tick
 * and every settled run. Rules, in order: kill switch, portfolio cap (band tops reserved,
 * D-021), the program's own envelope, concurrency (total, per program, per provider),
 * rate-limited providers skipped for the job's next fallback. Priority with aging, so a
 * low-priority job is never starved.
 */
import { z } from 'zod';
import type { Verdict } from './actions.js';
import { IdSchema, SourceKindSchema, SourcePolicySchema, UsdSchema } from './schemas.js';
import { effectivePolicy, permits } from './sources.js';

export const PrioritySchema = z.enum(['urgent', 'high', 'normal', 'low']);
const RANK = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
const Provider = z.string().min(1).max(64);

export const JobSchema = z.strictObject({
  id: IdSchema,
  programId: IdSchema,
  wpId: IdSchema,
  priority: PrioritySchema,
  /**
   * Primary candidate first, then fallbacks, across sources (a subscription agent, then the
   * same provider's API, then a local model…). One entry when the model is pinned (ADR-0020).
   */
  candidates: z
    .array(z.strictObject({ provider: Provider, source: SourceKindSchema }))
    .min(1)
    .max(8),
  /** The work package's effective source policy (program, department, seat). */
  policy: SourcePolicySchema.optional(),
  /** The run's band top (D-021). */
  capUsd: UsdSchema,
  enqueuedAt: z.iso.datetime(),
  attempts: z.number().int().nonnegative().default(0),
});
export type Job = z.infer<typeof JobSchema>;

export const PortfolioSchema = z.strictObject({
  id: IdSchema,
  capUsd: UsdSchema,
  /** Global kill switch: nothing starts; the daemon cancels what runs. */
  killSwitch: z.boolean().default(false),
  limits: z.strictObject({
    total: z.number().int().min(1).max(256),
    perProgram: z.number().int().min(1).max(64),
    perProvider: z.record(Provider, z.number().int().min(0).max(256)).default({}),
    defaultPerProvider: z.number().int().min(1).max(256),
  }),
  /** Portfolio-wide source policy: the outermost level, narrowed by each job's own. */
  sources: SourcePolicySchema.optional(),
  /** Minutes of waiting that promote a job one priority level. */
  agingMinutes: z.number().int().min(1).max(10_080).default(30),
});
export type Portfolio = z.infer<typeof PortfolioSchema>;

export const QueueSchema = z.strictObject({
  pending: z.array(JobSchema).default([]),
  running: z
    .array(
      z.strictObject({
        job: JobSchema,
        provider: Provider,
        source: SourceKindSchema,
        startedAt: z.iso.datetime(),
      }),
    )
    .default([]),
  /** Settled spend of the portfolio, USD. */
  spentUsd: UsdSchema.default(0),
  /**
   * `source:provider` → instant it can be used again: an API's 429 Retry-After, or a
   * subscription's exhausted quota. Keyed by source, so a rate-limited API does not block
   * the same provider's subscription agent, and the reverse.
   */
  rateLimitedUntil: z.record(Provider, z.iso.datetime()).default({}),
});
export type Queue = z.infer<typeof QueueSchema>;

export interface Pick {
  job: Job;
  provider: string;
  source: z.infer<typeof SourceKindSchema>;
}
export interface ScheduleResult {
  start: Pick[];
  held: Array<{ jobId: string; reason: string }>;
}

/** The program's envelope verdict for a job (from `checkAction`); default allows. */
export type ProgramCheck = (job: Job) => Verdict;

const EPS = 1e-9;

export function schedule(p: Portfolio, q: Queue, now: Date, check?: ProgramCheck): ScheduleResult {
  if (p.killSwitch) return { start: [], held: q.pending.map(held('kill switch')) };
  const start: Pick[] = [];
  const out: ScheduleResult['held'] = [];
  const live: Pick[] = q.running.map((r) => ({
    job: r.job,
    provider: r.provider,
    source: r.source,
  }));
  let committed = q.spentUsd + sum(q.running.map((r) => r.job.capUsd));
  for (const job of order(q.pending, now, p.agingMinutes)) {
    const reason = blocker(p, live, job, committed, check);
    if (reason) {
      out.push({ jobId: job.id, reason });
      continue;
    }
    const c = pickCandidate(p, q, live, job, now);
    if (!c) {
      out.push({ jobId: job.id, reason: 'no candidate free, within limits and policy' });
      continue;
    }
    const pick = { job, ...c };
    start.push(pick);
    live.push(pick);
    committed += job.capUsd;
  }
  return { start, held: out };
}

function blocker(
  p: Portfolio,
  live: Pick[],
  job: Job,
  committed: number,
  check: ProgramCheck | undefined,
): string | undefined {
  if (live.length >= p.limits.total) return 'total concurrency limit';
  if (live.filter((l) => l.job.programId === job.programId).length >= p.limits.perProgram)
    return 'program concurrency limit';
  if (committed + job.capUsd > p.capUsd + EPS) return 'portfolio cap';
  const v = check?.(job);
  if (v && v.verdict !== 'allow') return `program envelope: ${v.verdict} (${v.rule})`;
  return undefined;
}

/**
 * The first candidate inside the policy, not rate-limited or out of quota, and under its
 * provider's concurrency limit. A local-only job has no cloud candidate to fall back to.
 */
function pickCandidate(
  p: Portfolio,
  q: Queue,
  live: Pick[],
  job: Job,
  now: Date,
): Job['candidates'][number] | undefined {
  const policy = effectivePolicy([p.sources, job.policy]);
  return job.candidates.find((c) => {
    if (!permits(policy, c.source, c.provider)) return false;
    const until = q.rateLimitedUntil[sourceKey(c)];
    if (until && Date.parse(until) > now.getTime()) return false;
    const limit = p.limits.perProvider[c.provider] ?? p.limits.defaultPerProvider;
    return live.filter((l) => l.provider === c.provider).length < limit;
  });
}

/** The key rate limits and quotas are tracked under. */
export function sourceKey(c: { source: string; provider: string }): string {
  return `${c.source}:${c.provider}`;
}

/** Priority, promoted one level per `aging` minutes waited; then oldest first; then id. */
export function order(jobs: Job[], now: Date, agingMinutes: number): Job[] {
  const rank = (j: Job): number => {
    const waited = Math.max(0, now.getTime() - Date.parse(j.enqueuedAt)) / 60_000;
    return RANK[j.priority] - Math.floor(waited / agingMinutes);
  };
  return [...jobs].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      Date.parse(a.enqueuedAt) - Date.parse(b.enqueuedAt) ||
      (a.id < b.id ? -1 : 1),
  );
}

/** Moves the picked jobs from pending to running. */
export function started(q: Queue, picks: Pick[], now: Date): Queue {
  const ids = new Set(picks.map((x) => x.job.id));
  const at = now.toISOString();
  return {
    ...q,
    pending: q.pending.filter((j) => !ids.has(j.id)),
    running: [...q.running, ...picks.map((x) => ({ ...x, startedAt: at }))],
  };
}

/** A run settled: its real cost replaces its reservation. */
export function settled(q: Queue, jobId: string, costUsd: number): Queue {
  if (!q.running.some((r) => r.job.id === jobId)) return q;
  return {
    ...q,
    running: q.running.filter((r) => r.job.id !== jobId),
    spentUsd: q.spentUsd + costUsd,
  };
}

/**
 * An API answered 429, or a subscription's quota ran out: that source and provider are
 * skipped until `retryAfterMs` passes, and the job goes back to the queue, where its next
 * candidate within policy is tried. Its partial cost is billed.
 */
export function rateLimited(
  q: Queue,
  jobId: string,
  retryAfterMs: number,
  costUsd: number,
  now: Date,
): Queue {
  const run = q.running.find((r) => r.job.id === jobId);
  const until = new Date(now.getTime() + Math.max(1_000, retryAfterMs)).toISOString();
  if (!run) return q;
  const rateLimitedUntil = { ...q.rateLimitedUntil, [sourceKey(run)]: until };
  const job = { ...run.job, attempts: run.job.attempts + 1 };
  return {
    pending: [...q.pending, job],
    running: q.running.filter((r) => r.job.id !== jobId),
    spentUsd: q.spentUsd + costUsd,
    rateLimitedUntil,
  };
}

/** Kill switch: what the daemon must cancel now. Pending jobs stay queued, held. */
export function killList(q: Queue): string[] {
  return q.running.map((r) => r.job.id);
}

function held(reason: string) {
  return (j: Job) => ({ jobId: j.id, reason });
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
