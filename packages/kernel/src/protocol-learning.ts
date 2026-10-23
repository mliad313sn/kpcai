/**
 * Protocol additions for grades, measured competence and estimate accuracy (ADR-0028),
 * replay and fork (R-403) and disputes (R-405); version 1, additive. Merged into
 * `Methods` by protocol.ts.
 */
import { z } from 'zod';

const Id = z.string().min(1).max(100);
const Ref = z.object({ provider: z.string().max(100), model: z.string().max(200) });
const Protocol = z.enum(['solo', 'author_critic', 'debate', 'vote']);

const AccuracyRow = z.looseObject({
  label: z.string(),
  samples: z.number().int(),
  meanEstimateUsd: z.number(),
  meanActualUsd: z.number(),
  meanAbsErrorPct: z.number().nullable(),
  meanSignedErrorPct: z.number().nullable(),
  inBand: z.number().int(),
  below: z.number().int(),
  above: z.number().int(),
  inBandRate: z.number().nullable(),
});

export const AccuracySchema = z.looseObject({
  runs: AccuracyRow,
  byTaskType: z.array(AccuracyRow),
  byBasis: z.array(AccuracyRow),
  excluded: z.looseObject({
    cancelled: z.number().int(),
    notFinished: z.number().int(),
    noPlan: z.number().int(),
  }),
});

const Ratio = z.number().nullable();
const Count = z.number().int().min(0);

/** One change counted by `stats.productivity` (journal sequences, for audit). */
const ChangeSchema = z.looseObject({
  runKey: z.string(),
  nodeId: z.string(),
  kind: z.enum(['patch', 'artifact', 'merge']),
  files: z.array(z.string()),
  seq: z.number().int(),
  status: z.enum(['accepted', 'declined', 'failed', 'pending', 'discarded']),
  landed: z.looseObject({ seq: z.number().int(), ts: z.string() }).optional(),
  rolledBackSeq: z.number().int().optional(),
  reworkedSeq: z.number().int().optional(),
});

/** R-406: productivity from the journal only (docs/metrics/PRODUCTIVITY.md). */
export const ProductivitySchema = z.looseObject({
  project: z.string(),
  since: z.string().nullable(),
  runs: Count,
  spentUsd: z.number(),
  runTimeMs: z.number(),
  changes: z.looseObject({
    accepted: Count,
    declined: Count,
    failed: Count,
    pending: Count,
    discarded: Count,
  }),
  runsWithAcceptedChange: Count,
  rolledBack: Count,
  reworked: Count,
  unattributedRestores: Count,
  costPerAcceptedChangeUsd: Ratio,
  timePerAcceptedChangeMs: Ratio,
  rollbackRate: Ratio,
  reworkRate: Ratio,
  reworkWindowMs: z.number(),
  review: z.looseObject({
    nodes: Count,
    reviewUsd: z.number(),
    issuesRaised: Count,
    acceptedFindings: Count,
    acceptedRevisions: Count,
    usdPerAcceptedFinding: Ratio,
  }),
  band: z.looseObject({ runs: Count, inBand: Count, rate: Ratio }),
  list: z.array(ChangeSchema).max(1_000).optional(),
});

export const CompetenceEntrySchema = z.looseObject({
  ref: Ref,
  taskType: z.string(),
  project: z.string(),
  samples: z.number().int(),
  score: z.number(),
  approved: z.number().int(),
  evidence: z.string(),
});

const Attempt = z.looseObject({
  protocol: z.string(),
  ok: z.boolean(),
  output: z.string(),
  error: z.string().optional(),
  costUsd: z.number(),
  durationMs: z.number(),
  models: z.array(Ref),
});

export const ReplayResultSchema = z.looseObject({
  replayId: Id,
  runId: Id,
  nodeId: Id,
  original: Attempt,
  replay: Attempt,
  comparison: z.looseObject({
    sameOutput: z.boolean(),
    costDeltaUsd: z.number(),
    durationDeltaMs: z.number(),
  }),
});

/** A disputed node as `confirm.request` (kind `dispute`) shows it; all text is model output. */
export const DisputeSchema = z.object({
  nodeId: Id,
  kind: z.string().max(20),
  reason: z.string().max(2_000),
  options: z
    .array(
      z.object({
        id: Id,
        label: z.string().max(200),
        text: z.string().max(20_000),
        backers: z.array(z.string().max(300)).max(20),
      }),
    )
    .max(20),
  positions: z
    .array(
      z.object({
        ref: z.string().max(300),
        role: z.string().max(20),
        says: z.string().max(2_000),
        option: z.string().max(100).optional(),
      }),
    )
    .max(20),
});

export const NodeEdit = {
  model: Ref.optional(),
  protocol: Protocol.optional(),
};

export const LearningMethods = {
  /** A human's grade of one node of a run (ADR-0028); the author defaults to the local user. */
  grade: {
    params: z.object({
      runId: Id,
      nodeId: Id,
      grade: z.enum(['good', 'bad']),
      note: z.string().max(500).optional(),
      author: z.string().min(1).max(100).optional(),
    }),
    result: z.object({
      runId: z.string(),
      nodeId: z.string(),
      graded: z.string(),
      taskType: z.string().optional(),
    }),
  },
  /** Estimates against billed costs in this workspace (R-402). */
  'stats.accuracy': { params: z.object({}).optional(), result: AccuracySchema },
  /** Productivity here (R-406): cost and time per accepted change, rollback, rework, review. */
  'stats.productivity': {
    params: z
      .object({
        since: z.iso.datetime({ offset: true }).optional(),
        reworkDays: z.number().int().min(1).max(365).optional(),
        detail: z.boolean().optional(),
      })
      .optional(),
    result: ProductivitySchema,
  },
  /** Measured competence here, with the evidence the router cites. */
  competence: {
    params: z.object({}).optional(),
    result: z.object({ entries: z.array(CompetenceEntrySchema) }),
  },
  /** Reruns one finished node with another model or protocol, beside the original. */
  'run.replay': {
    params: z.object({ runId: Id, nodeId: Id, ...NodeEdit }),
    result: ReplayResultSchema,
  },
  /** Starts a planned fork; its band top is checked like any plan's (D-021). */
  'run.fork': { params: z.object({ planId: Id }), result: z.object({ runId: Id }) },
} as const;
