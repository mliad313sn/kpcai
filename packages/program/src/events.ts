/**
 * Events that move a program (ADR-0031 §2). The host stamps the actor from who really
 * acted (a Sponsor click, the PO assistant, a kernel fact); the actor is never read from
 * model output. Events are parsed strictly: the PO assistant's events are model output.
 */
import { z } from 'zod';
import {
  DecisionSchema,
  EscalationSchema,
  EvidenceSchema,
  GateRecordSchema,
  IdSchema,
  RunRecordSchema,
  UsdSchema,
} from './schemas.js';

/** `kernel`: facts the kernel journaled (a run started, a run settled, its cost). */
export const MachineActorSchema = z.enum(['sponsor', 'po', 'kernel']);
export type MachineActor = z.infer<typeof MachineActorSchema>;

export const ProgramEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('propose'), charter: z.unknown() }),
  z.strictObject({ type: z.literal('approve'), charterHash: z.string().min(1) }),
  z.strictObject({ type: z.literal('reject'), reason: z.string().max(2_000) }),
  z.strictObject({ type: z.literal('start') }),
  z.strictObject({ type: z.literal('run.started'), run: RunRecordSchema }),
  z.strictObject({
    type: z.literal('run.settled'),
    runId: IdSchema,
    status: z.enum(['finished', 'failed', 'cancelled', 'not_run']),
    costUsd: UsdSchema,
    testsPassed: z.boolean().optional(),
    /** Local compute time or subscription hours used. */
    hours: z.number().nonnegative().optional(),
    evidence: EvidenceSchema,
  }),
  z.strictObject({ type: z.literal('gate.open') }),
  z.strictObject({ type: z.literal('gate.close'), record: GateRecordSchema }),
  z.strictObject({ type: z.literal('pause') }),
  z.strictObject({ type: z.literal('resume') }),
  z.strictObject({ type: z.literal('stop'), reason: z.string().max(2_000) }),
  z.strictObject({ type: z.literal('amend'), charter: z.unknown() }),
  z.strictObject({ type: z.literal('amend.approve'), charterHash: z.string().min(1) }),
  z.strictObject({ type: z.literal('amend.reject') }),
  z.strictObject({ type: z.literal('decide'), decision: DecisionSchema }),
  z.strictObject({ type: z.literal('escalate'), escalation: EscalationSchema }),
  z.strictObject({
    type: z.literal('answer'),
    id: IdSchema,
    answer: z.enum(['yes', 'no']),
  }),
  z.strictObject({ type: z.literal('reported') }),
]);
export type ProgramEvent = z.infer<typeof ProgramEventSchema>;

/** Who may send each event. Anything else is refused. */
export const EVENT_ACTORS: Record<ProgramEvent['type'], readonly MachineActor[]> = {
  propose: ['po'],
  approve: ['sponsor'],
  reject: ['sponsor'],
  start: ['sponsor', 'po'],
  'run.started': ['kernel'],
  'run.settled': ['kernel'],
  'gate.open': ['po'],
  'gate.close': ['po'],
  pause: ['sponsor', 'po'],
  resume: ['sponsor', 'po'],
  stop: ['sponsor', 'po'],
  amend: ['po', 'sponsor'],
  'amend.approve': ['sponsor'],
  'amend.reject': ['sponsor'],
  decide: ['po', 'sponsor'],
  escalate: ['po'],
  answer: ['sponsor'],
  reported: ['po'],
};
