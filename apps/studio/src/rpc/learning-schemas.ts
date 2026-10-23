/**
 * Client-side readings of the phase 4 shapes the protocol leaves open (ADR-0028, ADR-0029):
 * the run's verification ROI (`run.done.verification`), the dispute records of a run
 * result, and the replay attempts with their verdicts. Lenient like `schemas.ts`: extra
 * fields pass, anything that does not parse is dropped and never rendered.
 */
import { z } from 'zod';
import { RefSchema } from './schemas';

/**
 * The headline is `revisedVerdicts` (P4-F12): rejecting verdicts answered by a revision the
 * reviewers then approved, one each, and the review cost per such verdict. Raw issues come
 * second. An older kernel without them shows the raw issues only.
 */
export const VerificationSchema = z.looseObject({
  reviewUsd: z.number(),
  totalUsd: z.number(),
  share: z.number(),
  issuesRaised: z.number(),
  revisedVerdicts: z.number().optional().catch(undefined),
  usdPerRevisedVerdict: z.number().nullable().catch(null),
});
export type Verification = z.infer<typeof VerificationSchema>;

/** `run.done.verification` (R-404), or undefined when absent or malformed. */
export function parseVerification(raw: unknown): Verification | undefined {
  const p = VerificationSchema.safeParse(raw);
  return p.success ? p.data : undefined;
}

const DisputeRecordSchema = z.looseObject({
  kind: z.string(),
  reason: z.string(),
  options: z.array(z.looseObject({ id: z.string(), label: z.string() })).catch([]),
  choice: z.string().nullable(),
  by: z.string(),
  unresolved: z.string().optional().catch(undefined),
});
export type DisputeRecord = z.infer<typeof DisputeRecordSchema>;

/** `result.disputes` of `run.done` by node id; rows that do not parse are dropped. */
export function parseDisputeRecords(result: unknown): Record<string, DisputeRecord> {
  const raw = (result as { disputes?: unknown } | null)?.disputes;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, DisputeRecord> = {};
  for (const [id, r] of Object.entries(raw as Record<string, unknown>)) {
    const p = DisputeRecordSchema.safeParse(r);
    if (p.success) out[id] = p.data;
  }
  return out;
}

/** `result.reused` of a fork's `run.done`: node ids taken from the parent run. */
export function parseReused(result: unknown): string[] {
  const raw = (result as { reused?: unknown } | null)?.reused;
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

const VerdictRowSchema = z.looseObject({
  ref: RefSchema,
  approve: z.boolean(),
  issues: z.number(),
  summary: z.string(),
});

const AttemptSchema = z.looseObject({
  protocol: z.string(),
  ok: z.boolean(),
  output: z.string(),
  error: z.string().optional(),
  costUsd: z.number(),
  durationMs: z.number(),
  models: z.array(RefSchema),
  verdicts: z.array(VerdictRowSchema).catch([]),
  approved: z.boolean().optional().catch(undefined),
});
export type Attempt = z.infer<typeof AttemptSchema>;

export const ReplayViewSchema = z.looseObject({
  replayId: z.string(),
  runId: z.string(),
  nodeId: z.string(),
  original: AttemptSchema,
  replay: AttemptSchema,
  comparison: z.looseObject({
    sameOutput: z.boolean(),
    costDeltaUsd: z.number(),
    durationDeltaMs: z.number(),
  }),
});
export type ReplayView = z.infer<typeof ReplayViewSchema>;

const Ratio = z.number().nullable().catch(null);

/** R-406 `stats.productivity` (S8), read leniently: the fields the view shows. */
export const ProductivityViewSchema = z.looseObject({
  runs: z.number(),
  spentUsd: z.number(),
  runTimeMs: z.number(),
  changes: z.looseObject({
    accepted: z.number(),
    declined: z.number(),
    failed: z.number(),
    pending: z.number(),
    discarded: z.number(),
  }),
  runsWithAcceptedChange: z.number().catch(0),
  costPerAcceptedChangeUsd: Ratio,
  timePerAcceptedChangeMs: Ratio,
  rollbackRate: Ratio,
  reworkRate: Ratio,
  reworkWindowMs: z.number().catch(0),
  review: z
    .looseObject({
      reviewUsd: z.number(),
      issuesRaised: z.number().optional().catch(undefined),
      revisedVerdicts: z.number().optional().catch(undefined),
      usdPerRevisedVerdict: Ratio,
    })
    .optional()
    .catch(undefined),
  band: z
    .looseObject({ runs: z.number(), inBand: z.number(), rate: Ratio })
    .optional()
    .catch(undefined),
});
export type ProductivityView = z.infer<typeof ProductivityViewSchema>;
