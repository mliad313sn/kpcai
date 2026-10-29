/**
 * Actions the PO assistant proposes, checked by the envelope before anything happens. The
 * assistant is a model: its proposals are parsed with these strict schemas, like any
 * untrusted input, and an action that does not parse is refused.
 */
import { z } from 'zod';
import { EnvelopeSchema, IdSchema, SourceKindSchema, UsdSchema } from './schemas.js';

/**
 * Decisions only the Sponsor takes (charter §5, D-019, D-025). The envelope has no field
 * that can name one of these, so it can never answer them in the Sponsor's place.
 */
export const RESERVED_ITEMS = [
  'spend-beyond-envelope',
  'publish',
  'licence',
  'credentials',
  'external-account',
  'third-party-terms',
  'merge-default-branch',
  'destructive',
  'physical-device',
  'human-only-check',
  'widen-envelope',
] as const;
export const ReservedItemSchema = z.enum(RESERVED_ITEMS);
export type ReservedItem = z.infer<typeof ReservedItemSchema>;

/** The kernel's confirmation kinds (packages/kernel/src/confirm.ts). */
export const ConfirmKindSchema = z.enum([
  'budget',
  'tool',
  'patch',
  'restore',
  'artifact',
  'memory',
  'dispute',
]);

export const ProposedActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('run.start'),
    wpId: IdSchema,
    /** The plan's band top (`capUsd`, D-021), never its expected cost. */
    capUsd: UsdSchema,
    isolated: z.boolean(),
    /** `review`: the gate's independent review run; its `wpId` is the phase id. */
    purpose: z.enum(['work', 'review']).default('work'),
    /** Where the run's authors run; a subscription agent counts as its provider. */
    source: SourceKindSchema.default('api'),
    providers: z.array(z.string().min(1).max(64)).max(20).default([]),
  }),
  z.strictObject({
    kind: z.literal('confirm'),
    confirm: ConfirmKindSchema,
    risk: z.enum(['read', 'write', 'destructive']).optional(),
    /** For `budget`: the extra amount asked, in USD. Without it the Sponsor is asked. */
    amountUsd: UsdSchema.optional(),
    /** The write lands in the run's own worktree (R-307), not the user's tree. */
    inWorktree: z.boolean(),
    /** The step actuates a physical device (D-019). */
    physical: z.boolean().default(false),
    /** The write touches a control file (`.kpstudio/`, `.claude/`, package.json…, D-035). */
    control: z.boolean().default(false),
    /** Relaxes a D-020 protection: a pack zone relaxation, a workspace opt-in (P5-R3). */
    zoneRelaxation: z.boolean().default(false),
    /** For `budget`: spend past a cap already accepted (D-035); like a missing amount. */
    overCap: z.boolean().default(false),
  }),
  z.strictObject({
    kind: z.literal('merge'),
    runId: IdSchema,
    testsPassed: z.boolean(),
    criticApproved: z.boolean(),
    zonesTouched: z.boolean(),
    files: z.number().int().nonnegative(),
    lines: z.number().int().nonnegative(),
    /** CI is green for the exact commit being merged (not an earlier one). */
    ciGreenForCommit: z.boolean(),
    targetIsDefaultBranch: z.boolean(),
  }),
  z.strictObject({ kind: z.literal('reserved'), item: ReservedItemSchema }),
  z.strictObject({ kind: z.literal('envelope.change'), proposed: EnvelopeSchema }),
]);
export type ProposedAction = z.infer<typeof ProposedActionSchema>;
export type ProposedActionInput = z.input<typeof ProposedActionSchema>;

export type VerdictKind = 'allow' | 'escalate' | 'refuse';

export interface Verdict {
  verdict: VerdictKind;
  /** Stable rule id, journaled with the verdict and shown in the decision log. */
  rule: string;
  reason: string;
  /** Set when the verdict is an escalation for a Sponsor-reserved item. */
  reserved?: ReservedItem;
}
