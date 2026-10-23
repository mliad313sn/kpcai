/**
 * Protocol additions for Enterprise mode (design ENTERPRISE-MODE.md §14, ADR-0031,
 * ADR-0035; version 1, additive). Merged into `Methods` and `Notifications` by protocol.ts.
 *
 * Every object is lenient on extra fields (a newer daemon never breaks an older client).
 * Text a model wrote (goals the PO drafted, escalation questions, critiques) is untrusted:
 * clients render it as text, never as markup. Activity text is built by the daemon from
 * typed events, never copied from model output.
 */
import { z } from 'zod';

const Id = z.string().min(1).max(100);
const At = z.string().max(40);
const Ok = z.object({ ok: z.literal(true) });

export const SeatStateSchema = z.enum([
  'idle',
  'thinking',
  'writing',
  'reviewing',
  'waiting_for_you',
  'blocked',
]);
export const HealthSchema = z.enum(['on_track', 'at_risk', 'blocked']);
export const SourceKindSchema = z.enum(['local', 'api', 'subscription']);
/** S10 R5: V0 unchecked, V1 other-provider review, V2 plus tests/CI, V3 plus a human looked. */
export const AssuranceLabelSchema = z.enum(['V0', 'V1', 'V2', 'V3']);
export const RefSchema = z.looseObject({
  kind: z.enum(['run', 'node', 'event', 'diff', 'report', 'escalation']),
  id: z.string().min(1).max(200),
});

export const SeatViewSchema = z.looseObject({
  programId: Id,
  seatId: Id,
  department: Id,
  kind: z.string().max(40),
  title: z.string().max(200),
  model: z.looseObject({ provider: z.string(), model: z.string() }).optional(),
  source: SourceKindSchema.optional(),
  state: SeatStateSchema,
  wpId: Id.optional(),
  runId: Id.optional(),
});

export const GaugeSchema = z.looseObject({
  scope: z.enum(['portfolio', 'program', 'department', 'source']),
  id: z.string().max(100),
  usd: z.looseObject({ committed: z.number(), spent: z.number(), cap: z.number() }).optional(),
  quota: z
    .looseObject({
      runs: z.number(),
      runsCap: z.number().optional(),
      hours: z.number(),
      hoursCap: z.number().optional(),
    })
    .optional(),
  localHours: z.number().optional(),
  concurrency: z.looseObject({ inUse: z.number(), limit: z.number() }).optional(),
  /** Portfolio only (S10 R3): spend of the last hour against the $/hour cap. */
  rate: z.looseObject({ usdLastHour: z.number(), usdPerHour: z.number() }).optional(),
});

export const ProgramCardSchema = z.looseObject({
  programId: Id,
  /** The Sponsor's goal (their own text, shown as text). */
  goal: z.string().max(4_000),
  status: z.string().max(40),
  health: HealthSchema,
  phases: z.array(
    z.looseObject({
      id: Id,
      title: z.string().max(200),
      state: z.enum(['done', 'current', 'next']),
    }),
  ),
  gate: z.looseObject({ phaseId: Id, verdict: z.string().optional() }).optional(),
  nextDecision: z.looseObject({ escalationId: Id, question: z.string() }).optional(),
  /** When the delegation envelope expires (S10 R3: 14 days by default). */
  expires: At.optional(),
  /** Why the program is paused, when the daemon paused it (no progress, expiry…). */
  pausedReason: z.string().max(500).optional(),
});

/** One question waiting for the Sponsor. `question` may quote model text: show it as text. */
export const InboxItemSchema = z.looseObject({
  programId: Id,
  escalationId: Id,
  rule: z.string().max(64),
  question: z.string().max(2_000),
  evidence: z.array(RefSchema),
  /**
   * S10 R8: `trivial` items may be answered in one batch (`program.answerBatch`);
   * `consequential` ones only one by one, after their evidence was opened (`program.viewed`).
   */
  class: z.enum(['trivial', 'consequential']).optional(),
  askedAt: At.optional(),
  /** True once the Sponsor opened this item's evidence. */
  viewed: z.boolean().optional(),
  /** For a run over the envelope: the one run a yes covers. */
  subject: z.looseObject({ wpId: Id, capUsd: z.number() }).optional(),
});

export const QueueEntrySchema = z.looseObject({
  jobId: Id,
  programId: Id,
  wpId: Id,
  priority: z.enum(['urgent', 'high', 'normal', 'low']),
  state: z.enum(['pending', 'running']),
  enqueuedAt: At,
  /** Why a pending job does not start (limits, cap, rate limit, kill switch). */
  held: z.string().max(300).optional(),
  capUsd: z.number().optional(),
});

export const ReportEntrySchema = z.looseObject({
  programId: Id,
  reportId: Id,
  kind: z.string().max(20),
  title: z.string().max(300),
  at: At,
  channels: z.array(z.string().max(40)),
  /** False when a success claim lacks evidence ("Delivered. Not verified: …"). */
  verified: z.boolean().optional(),
});

/** S10 R5: the assurance label of one delivered run, and what earned it. */
export const ResultEntrySchema = z.looseObject({
  programId: Id,
  wpId: Id,
  runId: Id,
  status: z.string().max(20),
  assurance: AssuranceLabelSchema,
  /** "V1: critic mock-delta approved; no tests". */
  basis: z.string().max(300),
});

/** S10 R2: daemon liveness. `stale` is computed by a reader from `at` and `staleAfterSec`. */
export const HeartbeatSchema = z.looseObject({
  at: At,
  pid: z.number().int().optional(),
  intervalSec: z.number(),
  staleAfterSec: z.number(),
  status: z.enum(['ok', 'alert', 'stale']),
  alerts: z.array(
    z.looseObject({
      rule: z.string().max(64),
      text: z.string().max(500),
      programId: Id.optional(),
    }),
  ),
  programs: z.number().int().optional(),
  running: z.number().int().optional(),
});

export const EnterpriseSnapshotSchema = z.looseObject({
  version: z.literal(1),
  at: At,
  killSwitch: z.boolean(),
  programs: z.array(ProgramCardSchema),
  seats: z.array(SeatViewSchema),
  gauges: z.array(GaugeSchema),
  inbox: z.array(InboxItemSchema),
  /** Last activity sequence included; resume the stream with `enterprise.activity {since}`. */
  cursor: z.number().int(),
  queue: z.array(QueueEntrySchema).optional(),
  reports: z.array(ReportEntrySchema).optional(),
  results: z.array(ResultEntrySchema).optional(),
  heartbeat: HeartbeatSchema.optional(),
  /** S10 R8 metric G2: consequential approvals given unviewed or in under 3 s. */
  rubberStamp: z
    .looseObject({ rate: z.number().nullable(), consequential: z.number().int() })
    .optional(),
});
export type EnterpriseSnapshot = z.infer<typeof EnterpriseSnapshotSchema>;

export const ActivitySchema = z.looseObject({
  seq: z.number().int(),
  at: At,
  programId: Id.optional(),
  text: z.string().max(1_000),
  refs: z.array(RefSchema),
});

const Seq = { seq: z.number().int() };

/** Server → client notifications; each has a monotonic `seq` (resume with `since`). */
export const EnterpriseNotifications = {
  'enterprise.seat': SeatViewSchema.extend(Seq),
  'enterprise.wp': z.looseObject({
    ...Seq,
    programId: Id,
    wpId: Id,
    from: z.string().optional(),
    to: z.string(),
    state: z.enum(['queued', 'running', 'review', 'done', 'held']),
  }),
  'enterprise.program': ProgramCardSchema.extend(Seq),
  'enterprise.gauge': GaugeSchema.extend(Seq),
  'enterprise.activity': ActivitySchema,
  'enterprise.inbox': z.looseObject({
    ...Seq,
    programId: Id,
    escalationId: Id,
    state: z.enum(['open', 'answered', 'expired']),
  }),
  'enterprise.report': ReportEntrySchema.extend(Seq),
  'enterprise.heartbeat': HeartbeatSchema.extend(Seq),
} as const;

const Cadence = z.discriminatedUnion('every', [
  z.object({ every: z.literal('gate') }),
  z.object({ every: z.literal('hours'), hours: z.number().int().min(1).max(720) }),
]);
const ProgramRef = { programId: Id };
const Answer = z.enum(['yes', 'no']);

/** Request params and results (design §14.1). The Sponsor is the authenticated local user. */
export const EnterpriseMethods = {
  /**
   * The PO drafts a charter from the goal (one small team by default, S10 R7), a critic of
   * another provider reviews it, and the "one run" baseline is shown beside the envelope
   * (S10 R10). Nothing runs until the Sponsor approves the charter hash.
   */
  'program.create': {
    params: z.object({
      goal: z.string().min(1).max(4_000),
      locale: z.enum(['en', 'fr']).optional(),
      budgetUsd: z.number().positive().max(1_000_000).optional(),
      cadence: Cadence.optional(),
      /** Opt-in departments (S10 R7); default one team. */
      departments: z.boolean().optional(),
      /** Skip the charter critic (it is a paid run). */
      critic: z.boolean().optional(),
    }),
    result: z.looseObject({
      programId: Id,
      charter: z.looseObject({}),
      charterHash: z.string(),
      baseline: z
        .looseObject({ expectedUsd: z.number(), capUsd: z.number(), basis: z.string() })
        .optional(),
      critique: z
        .looseObject({
          status: z.enum(['done', 'skipped', 'failed']),
          providers: z.array(z.string()),
          text: z.string().max(4_000),
          runId: Id.optional(),
        })
        .optional(),
    }),
  },
  'program.list': {
    params: z.object({}).optional(),
    result: z.object({ programs: z.array(ProgramCardSchema) }),
  },
  /** The program state (`ProgramStateSchema`), plus `meta`: baseline, critique, runs. */
  'program.get': {
    params: z.object(ProgramRef),
    result: z.looseObject({ version: z.literal(1), status: z.string(), charter: z.unknown() }),
  },
  'program.approve': { params: z.object({ ...ProgramRef, charterHash: z.string() }), result: Ok },
  'program.reject': {
    params: z.object({ ...ProgramRef, reason: z.string().max(2_000) }),
    result: Ok,
  },
  'program.pause': { params: z.object(ProgramRef), result: Ok },
  'program.resume': { params: z.object(ProgramRef), result: Ok },
  'program.stop': {
    params: z.object({ ...ProgramRef, reason: z.string().max(2_000).optional() }),
    result: Ok,
  },
  /** A consequential item is refused until its evidence was opened (`program.viewed`). */
  'program.answer': {
    params: z.object({ ...ProgramRef, escalationId: Id, answer: Answer }),
    result: Ok,
  },
  /** Trivial items only (S10 R8); consequential ones are listed in `refused`. */
  'program.answerBatch': {
    params: z.object({ ...ProgramRef, escalationIds: z.array(Id).min(1).max(100), answer: Answer }),
    result: z.object({
      answered: z.array(Id),
      refused: z.array(z.object({ escalationId: Id, reason: z.string() })),
    }),
  },
  /** The Sponsor opened evidence (journaled `viewed`, S10 R6 J2, R8). */
  'program.viewed': {
    params: z.object({ ...ProgramRef, escalationId: Id.optional(), ref: RefSchema }),
    result: Ok,
  },
  'program.reports': {
    params: z.object({ ...ProgramRef, since: At.optional() }),
    result: z.object({
      reports: z.array(ReportEntrySchema.extend({ markdown: z.string().max(200_000) })),
    }),
  },
  'enterprise.snapshot': {
    params: z.object({}).optional(),
    result: EnterpriseSnapshotSchema,
  },
  'enterprise.activity': {
    params: z
      .object({
        since: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(1_000).optional(),
      })
      .optional(),
    result: z.object({ items: z.array(ActivitySchema), cursor: z.number().int() }),
  },
  'enterprise.heartbeat': { params: z.object({}).optional(), result: HeartbeatSchema },
  'enterprise.kill': {
    params: z.object({}).optional(),
    result: z.object({ cancelled: z.array(z.string()) }),
  },
  'enterprise.unkill': {
    params: z.object({}).optional(),
    result: z.object({ cancelled: z.array(z.string()) }),
  },
} as const;
