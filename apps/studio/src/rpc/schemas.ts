/**
 * Client-side schemas for the kernel objects that `@kernelpai/kernel/protocol` carries as
 * `unknown` (graph, estimate, GraphEvent, method results). They mirror `packages/core`
 * (graph.ts, routing.ts) and `packages/orchestrator` (estimate.ts) but are lenient: unknown
 * extra fields pass through, so a newer kernel does not break an older console. Anything
 * that does not match is dropped, never rendered.
 */
import { z } from 'zod';

export const RefSchema = z.object({ provider: z.string(), model: z.string() });
export type Ref = z.infer<typeof RefSchema>;

export const RoleSchema = z.enum([
  'solo',
  'author',
  'critic',
  'revision',
  'debater',
  'judge',
  'voter',
]);
export type Role = z.infer<typeof RoleSchema>;

export const NodeStateSchema = z.enum([
  'pending',
  'running',
  'review',
  'done',
  'failed',
  'skipped',
  'cancelled',
]);
export type NodeState = z.infer<typeof NodeStateSchema>;

const MessageSchema = z.looseObject({ role: z.string(), content: z.string() });

export const GraphNodeSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  type: z.string(),
  protocol: z.string(),
  dependsOn: z.array(z.string()),
  criticality: z.string().optional(),
  messages: z.array(MessageSchema).optional(),
  tools: z.array(z.string()).optional(),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const TaskGraphSchema = z.looseObject({
  id: z.string(),
  request: z.string(),
  nodes: z.array(GraphNodeSchema),
  createdBy: z.string(),
  reason: z.string(),
});
export type TaskGraph = z.infer<typeof TaskGraphSchema>;

const StepSchema = z.looseObject({
  role: RoleSchema,
  ref: RefSchema,
  calls: z.object({ min: z.number(), max: z.number() }),
  minUsd: z.number(),
  expectedUsd: z.number(),
  diversityWaived: z.boolean().optional(),
});

export const NodeEstimateSchema = z.looseObject({
  nodeId: z.string(),
  protocol: z.string(),
  upgraded: z.string().optional(),
  ref: RefSchema.nullable(),
  minUsd: z.number(),
  expectedUsd: z.number(),
  steps: z.array(StepSchema).default([]),
  error: z.string().optional(),
  /** Not in the phase-3 contract; shown when a kernel provides them. */
  reason: z.string().optional(),
  score: z.number().optional(),
});
export type NodeEstimate = z.infer<typeof NodeEstimateSchema>;

export const GraphEstimateSchema = z.looseObject({
  nodes: z.array(NodeEstimateSchema),
  minUsd: z.number(),
  totalUsd: z.number(),
  complete: z.boolean(),
  problems: z.array(z.string()).default([]),
});
export type GraphEstimate = z.infer<typeof GraphEstimateSchema>;

const VerdictSchema = z.looseObject({
  approve: z.boolean(),
  issues: z.array(z.object({ severity: z.enum(['major', 'minor']), text: z.string() })),
  summary: z.string(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export const ContributionSchema = z.looseObject({
  role: RoleSchema,
  ref: RefSchema,
  text: z.string(),
  costUsd: z.number(),
  verdict: VerdictSchema.optional(),
});
export type Contribution = z.infer<typeof ContributionSchema>;

export const GraphEventSchema = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('node_state'),
    nodeId: z.string(),
    state: NodeStateSchema,
    ref: RefSchema.optional(),
    role: RoleSchema.optional(),
    /** Optional extensions (routing reason, router score), not in the phase-3 contract. */
    reason: z.string().optional(),
    score: z.number().optional(),
  }),
  z.looseObject({
    type: z.literal('text'),
    nodeId: z.string(),
    role: RoleSchema,
    ref: RefSchema,
    delta: z.string(),
  }),
  z.looseObject({
    type: z.literal('contribution'),
    nodeId: z.string(),
    contribution: ContributionSchema,
  }),
  z.looseObject({ type: z.literal('graph_done'), costUsd: z.number(), ok: z.boolean() }),
]);
export type GraphEvent = z.infer<typeof GraphEventSchema>;

/** Result of `plan`. The protocol leaves it untyped; this is the shape of `run.planned`. */
export const PlanResultSchema = z.looseObject({
  planId: z.string(),
  graph: TaskGraphSchema,
  estimate: GraphEstimateSchema,
});
export type PlanResult = z.infer<typeof PlanResultSchema>;

export const RunStartResultSchema = z.looseObject({ runId: z.string() });

export const SessionSchema = z.looseObject({
  id: z.string(),
  createdAt: z.string(),
  title: z.string(),
  eventCount: z.number().optional(),
  costUsd: z.number().optional(),
});
export type Session = z.infer<typeof SessionSchema>;

/** Accepts a bare array or `{ sessions: [...] }`; invalid rows are dropped. */
export function parseSessions(raw: unknown): Session[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { sessions?: unknown } | null)?.sessions)
      ? (raw as { sessions: unknown[] }).sessions
      : [];
  return list.flatMap((r) => {
    const p = SessionSchema.safeParse(r);
    return p.success ? [p.data] : [];
  });
}

const ProviderSchema = z.looseObject({
  id: z.string(),
  available: z.boolean().optional(),
  models: z.array(z.union([z.string(), z.looseObject({ id: z.string() })])).default([]),
});

/** Models offered by `providers.list` (array or `{ providers }`), as provider/model refs. */
export function parseModels(raw: unknown): Ref[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { providers?: unknown } | null)?.providers)
      ? (raw as { providers: unknown[] }).providers
      : [];
  return list.flatMap((r) => {
    const p = ProviderSchema.safeParse(r);
    if (!p.success || p.data.available === false) return [];
    return p.data.models.map((m) => ({
      provider: p.data.id,
      model: typeof m === 'string' ? m : m.id,
    }));
  });
}
