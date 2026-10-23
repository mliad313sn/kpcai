/**
 * Program mode data (D-025, ADR-0031): the charter the Sponsor approves, the delegation
 * envelope inside it, and the program state the host persists. Every object is strict: an
 * unknown key is an error, so nothing can smuggle an extra permission into a charter.
 */
import { z } from 'zod';

/** Stored in USD like every KernelPAI amount (ADR-0005); shown in the display currency. */
export const UsdSchema = z.number().finite().nonnegative();
export const IdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Text = (max: number) => z.string().min(1).max(max);
const Lines = z.array(Text(500)).max(50);
export const LocaleSchema = z.enum(['en', 'fr']);
export type Locale = z.infer<typeof LocaleSchema>;

/**
 * What a seat is for. The title is free ("CAD engineer", "GIS analyst"): seats are
 * domain-neutral lenses; only `reviewer` carries a rule (independence, charter §4).
 */
export const SeatKindSchema = z.enum([
  'architect',
  'builder',
  'specialist',
  'security',
  'qa',
  'reviewer',
]);

/**
 * Where a model runs (D-026 sources): `local` (Ollama, llama.cpp: $0, offline possible),
 * `api` (BYOK keys, billed per token in USD), `subscription` (the user's own agent CLI or
 * hosted plan, R-503: quota-based, counted in runs and hours; KP never holds its credentials).
 */
export const SourceKindSchema = z.enum(['local', 'api', 'subscription']);
export type SourceKind = z.infer<typeof SourceKindSchema>;

/**
 * A source policy at one level (portfolio, program, department, seat). Levels only narrow:
 * the effective policy is the intersection of the allowed sources and provider lists, and
 * the union of the denied providers.
 */
export const SourcePolicySchema = z.strictObject({
  sources: z.array(SourceKindSchema).min(1).max(3).optional(),
  providers: z.array(Text(64)).max(30).optional(),
  denyProviders: z.array(Text(64)).max(30).default([]),
});
export type SourcePolicy = z.infer<typeof SourcePolicySchema>;

/** The budget unit of one subscription: runs and hours, not dollars. */
export const SubscriptionQuotaSchema = z.strictObject({
  /** The provider the subscription belongs to (`anthropic` for Claude Code…): diversity key. */
  provider: Text(64),
  /** The agent or plan (`claude-code`, `codex`, `gemini-cli`…), for reports. */
  agent: Text(64),
  runs: z.number().int().nonnegative().optional(),
  hours: z.number().nonnegative().optional(),
});
export type SubscriptionQuota = z.infer<typeof SubscriptionQuotaSchema>;

/**
 * Departments of the virtual enterprise (D-026). `domain` departments come from packs
 * (CAD shop, GIS lab…). `review` is the independent review function: it holds only
 * reviewer seats and builds nothing.
 */
export const DepartmentKindSchema = z.enum([
  'product',
  'design',
  'engineering',
  'data',
  'security',
  'qa',
  'documentation',
  'operations',
  'review',
  'domain',
]);

export const DepartmentSchema = z.strictObject({
  id: IdSchema,
  kind: DepartmentKindSchema,
  title: Text(120),
  /** Department cap on committed spend (D-021 band tops), inside the total cap. */
  capUsd: UsdSchema.optional(),
  /** Escalation line: the department it escalates to, or the Sponsor. */
  escalatesTo: z.union([z.literal('sponsor'), IdSchema]).default('sponsor'),
  sources: SourcePolicySchema.optional(),
});
export type Department = z.infer<typeof DepartmentSchema>;

export const SeatSchema = z.strictObject({
  id: IdSchema,
  kind: SeatKindSchema,
  department: IdSchema,
  title: Text(120),
  mandate: Text(2_000),
  /** Domain packs the seat's runs use (D-019); ids only, resolved by the kernel. */
  packs: z.array(IdSchema).max(20).default([]),
  sources: SourcePolicySchema.optional(),
});
export type Seat = z.infer<typeof SeatSchema>;

export const WorkPackageSchema = z.strictObject({
  id: IdSchema,
  title: Text(200),
  /** The seat that leads it; never a reviewer seat (a reviewer builds nothing). */
  lead: IdSchema,
  /** The request handed to the kernel planner. Written by the PO assistant: model output,
   * planned, estimated and gated by the kernel like any user request. */
  request: Text(4_000),
  deliverables: Lines,
  acceptance: z.array(Text(500)).min(1).max(50),
});
export type WorkPackage = z.infer<typeof WorkPackageSchema>;

export const PhaseSchema = z.strictObject({
  id: IdSchema,
  title: Text(200),
  goal: Text(2_000),
  /** Per-phase cap (D-021: compared with run band tops, never with expected costs). */
  capUsd: UsdSchema,
  workPackages: z.array(WorkPackageSchema).min(1).max(30),
  exit: z.array(Text(500)).min(1).max(30),
});
export type Phase = z.infer<typeof PhaseSchema>;

/**
 * Confirmations the envelope may answer in the Sponsor's place. Closed list: there is no
 * value for a Sponsor-reserved item, a destructive action, a dispute or a memory fact.
 */
export const PreAnswerSchema = z.enum(['budget-within-envelope', 'write-in-worktree']);
export type PreAnswer = z.infer<typeof PreAnswerSchema>;

export const AutoMergeSchema = z.strictObject({
  maxFiles: z.number().int().min(1).max(200),
  maxLines: z.number().int().min(1).max(20_000),
});

export const WritePolicySchema = z.discriminatedUnion('mode', [
  /** Default: runs write only in their own worktree; merging is a one-click Sponsor approval. */
  z.strictObject({ mode: z.literal('isolated-only') }),
  /** Opt-in: merge without asking when tests pass, the critic approves and no zone is touched. */
  z.strictObject({ mode: z.literal('auto-merge'), limits: AutoMergeSchema }),
]);
export type WritePolicy = z.infer<typeof WritePolicySchema>;

/** The delegation envelope: what the PO assistant may do without asking. */
export const EnvelopeSchema = z.strictObject({
  totalCapUsd: UsdSchema,
  /** Optional cap on a single run's band top. */
  runCapUsd: UsdSchema.optional(),
  write: WritePolicySchema.default({ mode: 'isolated-only' }),
  preAnswer: z.array(PreAnswerSchema).max(2).default([]),
  /** Subscriptions the program may use, each with its quota. Unlisted: not usable. */
  subscriptions: z.array(SubscriptionQuotaSchema).max(20).default([]),
  /** After this instant every action escalates. */
  expires: z.iso.datetime().optional(),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

export const CadenceSchema = z.discriminatedUnion('every', [
  z.strictObject({ every: z.literal('gate') }),
  z.strictObject({
    every: z.literal('hours'),
    hours: z
      .number()
      .int()
      .min(1)
      .max(24 * 30),
  }),
]);
export type Cadence = z.infer<typeof CadenceSchema>;

const CharterObject = z.strictObject({
  version: z.literal(1),
  programId: IdSchema,
  goal: Text(4_000),
  locale: LocaleSchema,
  /** Domain packs of the whole program (any domain, D-019). */
  packs: z.array(IdSchema).max(20).default([]),
  /** Program-level source policy (narrowed further by departments and seats). */
  sources: SourcePolicySchema.optional(),
  outOfScope: Lines.default([]),
  departments: z.array(DepartmentSchema).min(1).max(30),
  seats: z.array(SeatSchema).min(2).max(20),
  phases: z.array(PhaseSchema).min(1).max(20),
  envelope: EnvelopeSchema,
  reports: z.strictObject({ cadence: CadenceSchema, locale: LocaleSchema.optional() }),
});

/** A charter is coherent or it is not a charter: these checks run on every parse. */
export const CharterSchema = CharterObject.superRefine((c, ctx) => {
  const issue = (message: string): void => ctx.addIssue({ code: 'custom', message });
  checkOrg(c, issue);
  const seats = new Map(c.seats.map((s) => [s.id, s]));
  const phaseSum = c.phases.reduce((sum, p) => sum + p.capUsd, 0);
  if (phaseSum > c.envelope.totalCapUsd + 1e-9) issue('phase caps exceed the total cap');
  const ids = new Set<string>();
  for (const p of c.phases) {
    if (ids.has(p.id)) issue(`duplicate id ${p.id}`);
    ids.add(p.id);
    for (const wp of p.workPackages) {
      if (ids.has(wp.id)) issue(`duplicate id ${wp.id}`);
      ids.add(wp.id);
      const lead = seats.get(wp.lead);
      if (!lead) issue(`work package ${wp.id}: unknown lead ${wp.lead}`);
      else if (lead.kind === 'reviewer') issue(`work package ${wp.id}: a reviewer cannot lead`);
    }
  }
});
export type Charter = z.infer<typeof CharterSchema>;

/** Org chart rules: known departments, an independent review function, sane escalation. */
function checkOrg(c: z.infer<typeof CharterObject>, issue: (m: string) => void): void {
  const depts = new Map(c.departments.map((d) => [d.id, d]));
  if (depts.size !== c.departments.length) issue('department ids must be unique');
  if (new Set(c.seats.map((s) => s.id)).size !== c.seats.length) issue('seat ids must be unique');
  if (!c.seats.some((s) => s.kind === 'reviewer')) issue('a charter needs a reviewer seat');
  for (const d of c.departments) {
    if (d.capUsd !== undefined && d.capUsd > c.envelope.totalCapUsd + 1e-9)
      issue(`department ${d.id}: cap above the total cap`);
    if (d.escalatesTo !== 'sponsor' && !depts.has(d.escalatesTo))
      issue(`department ${d.id}: unknown escalation line ${d.escalatesTo}`);
  }
  for (const s of c.seats) {
    const d = depts.get(s.department);
    if (!d) issue(`seat ${s.id}: unknown department ${s.department}`);
    else if ((d.kind === 'review') !== (s.kind === 'reviewer'))
      issue(`seat ${s.id}: reviewers sit in the review department, and only they do`);
  }
  if (escalationLoops(c.departments)) issue('escalation lines must end at the Sponsor');
}

function escalationLoops(depts: Department[]): boolean {
  const next = new Map(depts.map((d) => [d.id, d.escalatesTo]));
  for (const d of depts) {
    const seen = new Set<string>();
    let at: string | undefined = d.id;
    while (at && at !== 'sponsor') {
      if (seen.has(at)) return true;
      seen.add(at);
      at = next.get(at);
    }
  }
  return false;
}

export const ProgramStatusSchema = z.enum([
  'draft',
  'proposed',
  'approved',
  'running',
  'gate',
  'paused',
  'stopped',
  'delivered',
]);
export type ProgramStatus = z.infer<typeof ProgramStatusSchema>;

export const ActorSchema = z.enum(['sponsor', 'po']);
export type Actor = z.infer<typeof ActorSchema>;

/** Journal references: `event:<id>`, `run:<id>`, `ci:<commit>:<status>`, `test:<id>`… */
export const EvidenceSchema = z.array(z.string().min(1).max(200)).max(100);

/**
 * S10 R5 assurance of a run's result: V0 unchecked; V1 approved by a critic of another
 * provider; V2 plus objective evidence (tests that ran, CI on the exact commit); V3 plus a
 * human opened the evidence. Only the kernel reports V0–V2; V3 is derived from `viewed`.
 */
export const AssuranceSchema = z.enum(['V0', 'V1', 'V2', 'V3']);
export type Assurance = z.infer<typeof AssuranceSchema>;

export const RunRecordSchema = z.strictObject({
  runId: IdSchema,
  wpId: IdSchema,
  phaseId: IdSchema,
  /** The band top approved for the run (D-021): reserved against the envelope while live. */
  capUsd: UsdSchema,
  costUsd: UsdSchema.default(0),
  status: z.enum(['running', 'finished', 'failed', 'cancelled', 'not_run']),
  purpose: z.enum(['work', 'review']).default('work'),
  source: SourceKindSchema.default('api'),
  /** Wall time: local compute time, or subscription hours. */
  hours: z.number().nonnegative().default(0),
  /** `provider` of the run's authors, as the kernel journaled it (cross-provider gate check). */
  providers: z.array(Text(64)).max(20).default([]),
  /** True only when the kernel reports tests run and passed for this run. */
  testsPassed: z.boolean().optional(),
  evidence: EvidenceSchema.default([]),
  startedAt: z.iso.datetime(),
  /** When the kernel settled it (spend-rate window, S10 R3). */
  settledAt: z.iso.datetime().optional(),
  /** S10 R5, from kernel facts only (`run.settled`). */
  assurance: AssuranceSchema.optional(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export const GateRecordSchema = z.strictObject({
  phaseId: IdSchema,
  verdict: z.enum(['pass', 'pass-with-notes', 'hold']),
  reviewer: IdSchema,
  /** The provider the review ran on: must differ from every builder's (cross-provider). */
  reviewerProvider: Text(64),
  openCriticalOrHigh: z.number().int().nonnegative(),
  evidence: EvidenceSchema,
  at: z.iso.datetime(),
});
export type GateRecord = z.infer<typeof GateRecordSchema>;

export const DecisionSchema = z.strictObject({
  id: IdSchema,
  at: z.iso.datetime(),
  actor: ActorSchema,
  /** What was decided. PO text is model output: shown quoted, never executed. */
  text: Text(2_000),
  rejected: z.string().max(1_000).optional(),
  evidence: EvidenceSchema.default([]),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const EscalationSchema = z.strictObject({
  id: IdSchema,
  at: z.iso.datetime(),
  /** The envelope rule that sent it to the Sponsor. */
  rule: Text(64),
  question: Text(2_000),
  /** For a run over the envelope: the one run a yes covers (work package and band top). */
  subject: z.strictObject({ wpId: IdSchema, capUsd: UsdSchema }).optional(),
  answer: z.enum(['yes', 'no']).optional(),
  answeredAt: z.iso.datetime().optional(),
  /** A yes covers one action: set when that action used it. */
  consumed: z.boolean().optional(),
});
export type Escalation = z.infer<typeof EscalationSchema>;

export const ProgramStateSchema = z.strictObject({
  version: z.literal(1),
  status: ProgramStatusSchema,
  charter: CharterSchema,
  /** Sponsor approval, bound to the exact charter text by hash. */
  approval: z.strictObject({ charterHash: z.string(), at: z.iso.datetime() }).optional(),
  /** A charter change waiting for the Sponsor; the approved charter stays in force. */
  amendment: CharterSchema.optional(),
  phaseIndex: z.number().int().nonnegative().default(0),
  pausedFrom: ProgramStatusSchema.optional(),
  pausedBy: ActorSchema.optional(),
  runs: z.array(RunRecordSchema).default([]),
  gates: z.array(GateRecordSchema).default([]),
  decisions: z.array(DecisionSchema).default([]),
  escalations: z.array(EscalationSchema).default([]),
  lastReportAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime(),
});
export type ProgramState = z.infer<typeof ProgramStateSchema>;
