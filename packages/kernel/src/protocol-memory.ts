/**
 * Protocol additions for unified memory (ADR-0027; version 1, additive). Merged into
 * `Methods` by protocol.ts. Facts are listed with their provenance; models never call these.
 */
import { z } from 'zod';

const Id = z.string().min(1).max(100);
const FactId = z.string().regex(/^m-[A-Za-z0-9]{4,32}$/);
const LayerSchema = z.enum(['user', 'project', 'session']);
const Origin = z.enum(['user', 'project', 'session', 'repository']);

export const ProvenanceSchema = z.looseObject({
  /** `human`, or the proposing model as `provider/model`. */
  source: z.string(),
  date: z.string(),
  evidence: z.array(z.string()),
  localOnly: z.boolean(),
  confirmed: z.string().optional(),
  edited: z.string().optional(),
});

export const FactSchema = z.looseObject({
  id: z.string(),
  layer: LayerSchema,
  text: z.string(),
  provenance: ProvenanceSchema,
});

export const PendingFactSchema = z.looseObject({
  id: z.string(),
  scope: z.looseObject({ layer: LayerSchema }),
  text: z.string(),
  provenance: ProvenanceSchema,
  proposedAt: z.string(),
});

/** What every node of a plan gets from memory: counts, ids and sources (never the text). */
export const MemorySummarySchema = z.looseObject({
  layers: z.array(
    z.looseObject({
      origin: Origin,
      facts: z.number().int(),
      included: z.number().int(),
      untrusted: z.number().int(),
      localOnly: z.number().int(),
      omitted: z.number().int().optional(),
    }),
  ),
  included: z.array(
    z.looseObject({
      id: z.string(),
      origin: Origin,
      source: z.string(),
      trust: z.enum(['user', 'untrusted']),
      localOnly: z.boolean(),
    }),
  ),
  budgetTokens: z.number().int(),
  usedTokens: z.number().int(),
  omitted: z.number().int(),
  truncated: z.boolean(),
  localOnly: z.number().int(),
  distrusted: z.boolean(),
  pending: z.number().int(),
  problems: z.array(z.string()),
});

/** The fact a `confirm.request` of kind `memory` asks about. */
export const MemoryConfirmSchema = z.object({
  id: FactId,
  layer: LayerSchema,
  text: z.string().max(2_000),
  source: z.string().max(300),
  evidence: z.array(z.string().max(300)).max(10),
  localOnly: z.boolean(),
});

/** A layer; `session` needs its session id. */
const LayerRef = { layer: LayerSchema, sessionId: Id.optional() };
const Text = z.string().min(1).max(1_000);
const FactResult = z.object({ fact: FactSchema });

export const MemoryMethods = {
  /** One layer's facts with provenance, and what looked odd in its file (nothing dropped). */
  'memory.list': {
    params: z.object(LayerRef),
    result: z.object({
      layer: LayerSchema,
      file: z.string(),
      exists: z.boolean(),
      facts: z.array(FactSchema),
      problems: z.array(z.object({ line: z.number().int(), message: z.string() })),
    }),
  },
  /** A fact the human writes: redacted, refused when it names a forbidden zone. */
  'memory.add': {
    params: z.object({ ...LayerRef, text: Text, localOnly: z.boolean().optional() }),
    result: FactResult,
  },
  'memory.edit': {
    params: z.object({
      ...LayerRef,
      id: FactId,
      text: Text.optional(),
      localOnly: z.boolean().optional(),
    }),
    result: FactResult,
  },
  'memory.remove': { params: z.object({ ...LayerRef, id: FactId }), result: FactResult },
  /** Model proposals waiting for a human. */
  'memory.pending': {
    params: z.object({}).optional(),
    result: z.object({ pending: z.array(PendingFactSchema) }),
  },
  /** A human keeps a proposal: it becomes a fact, its model source kept. */
  'memory.confirm': { params: z.object({ id: FactId }), result: FactResult },
  /** A human drops a proposal. */
  'memory.reject': {
    params: z.object({ id: FactId }),
    result: z.object({ rejected: PendingFactSchema }),
  },
} as const;
