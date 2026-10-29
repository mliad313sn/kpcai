/**
 * What the runtime keeps beside a program's state (ADR-0035): never a permission, only
 * bookkeeping. The state (`ProgramStateSchema`) is what the envelope and the machine read;
 * this file holds the draft's baseline and critique, the kernel session of each run (to
 * read its cost after a crash), the Sponsor's answers and views (S10 R6, R8), the progress
 * checkpoints the Sponsor let pass (R3), follow-ups done, and the report archive index.
 */
import { z } from 'zod';

const Iso = z.string().max(40);
const Id = z.string().min(1).max(100);

export const RefSchema = z.object({
  kind: z.enum(['run', 'node', 'event', 'diff', 'report', 'escalation']),
  id: z.string().min(1).max(200),
});
export type Ref = z.infer<typeof RefSchema>;

export const ProgramMetaSchema = z.object({
  createdAt: Iso,
  baseline: z
    .object({ expectedUsd: z.number(), capUsd: z.number(), basis: z.string().max(40) })
    .optional(),
  critique: z
    .object({
      status: z.enum(['done', 'skipped', 'failed']),
      providers: z.array(z.string().max(100)).max(20),
      /** Model output: shown quoted, never parsed. */
      text: z.string().max(4_000),
      runId: Id.optional(),
    })
    .optional(),
  runs: z
    .record(
      Id,
      z.object({
        sessionId: Id,
        planId: Id,
        wpId: Id,
        purpose: z.enum(['work', 'review']),
        jobId: Id.optional(),
        worktree: z.string().max(1_000).optional(),
        /** What earned the run's assurance label (S10 R5). */
        basis: z.string().max(300).optional(),
      }),
    )
    .default({}),
  progressAck: z.record(Id, z.number().int().min(0).max(4)).default({}),
  viewed: z
    .array(z.object({ ref: RefSchema, escalationId: Id.optional(), at: Iso }))
    .max(10_000)
    .default([]),
  answers: z
    .array(
      z.object({
        escalationId: Id,
        rule: z.string().max(64),
        answer: z.enum(['yes', 'no']),
        askedAt: Iso,
        answeredAt: Iso,
        viewed: z.boolean(),
        viewedAt: Iso.optional(),
        batch: z.boolean().optional(),
      }),
    )
    .max(10_000)
    .default([]),
  /** Escalations raised by the runtime: what a yes does, whether it expired. */
  escalations: z
    .record(
      Id,
      z.object({
        kind: z.enum(['run', 'confirm', 'gate', 'progress', 'expiry', 'policy']),
        runId: Id.optional(),
        evidence: z.array(RefSchema).max(20).default([]),
        expired: z.boolean().optional(),
        handled: z.boolean().optional(),
        /** Expiry renewal: the exact `expires` the yes approves. */
        renewTo: Iso.optional(),
        checkpoint: z.number().int().optional(),
      }),
    )
    .default({}),
  reports: z
    .array(
      z.object({
        reportId: Id,
        kind: z.string().max(20),
        title: z.string().max(300),
        at: Iso,
        verified: z.boolean(),
        channels: z.array(z.string().max(40)),
      }),
    )
    .max(10_000)
    .default([]),
  pausedReason: z.string().max(500).optional(),
  /** The last `events.jsonl` line a report or digest heartbeat covered (ADR-0036). */
  reportSeq: z.number().int().min(0).optional(),
});
export type ProgramMeta = z.infer<typeof ProgramMetaSchema>;

export function newMeta(now: Date): ProgramMeta {
  return ProgramMetaSchema.parse({ createdAt: now.toISOString() });
}
