/**
 * Client-side refinements of the protocol's schemas. Every result is first checked by
 * `@kernelpai/kernel/protocol` (in `RpcClient.call`); these schemas then read the fields
 * the protocol leaves open (node type and protocol, estimate steps, GraphEvent variants).
 * They mirror `packages/core` and `packages/orchestrator` but stay lenient: unknown extra
 * fields pass through, so a newer kernel does not break an older console. Anything that
 * does not match is dropped, never rendered.
 */
import { BandSchema, ControlEventSchema } from '@kernelpai/kernel/protocol';
import { z } from 'zod';

export type Band = z.infer<typeof BandSchema>;
export type ControlEvent = z.infer<typeof ControlEventSchema>;

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
  /** Pinned model of the node's first step (R-301, ADR-0020). */
  model: RefSchema.optional(),
  budgetUsd: z.number().optional(),
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
  band: BandSchema.optional(),
  /** Routing explanation (R-303), present when the router agrees with the estimate. */
  reason: z.string().optional(),
  score: z.number().optional(),
  parts: z.record(z.string(), z.number().nullable()).optional(),
  runnerUp: z.object({ ref: RefSchema, score: z.number() }).optional(),
});
export type NodeEstimate = z.infer<typeof NodeEstimateSchema>;

export const GraphEstimateSchema = z.looseObject({
  nodes: z.array(NodeEstimateSchema),
  minUsd: z.number(),
  totalUsd: z.number(),
  complete: z.boolean(),
  problems: z.array(z.string()).default([]),
  band: BandSchema.optional(),
  /** D-021: the likely cost and the hard cap (the band's top), when the kernel sends them. */
  expectedUsd: z.number().optional().catch(undefined),
  capUsd: z.number().optional().catch(undefined),
});
export type GraphEstimate = z.infer<typeof GraphEstimateSchema>;

const COST_KEYS = { expectedUsd: ['expectedUsd', 'expected'], capUsd: ['capUsd', 'cap'] } as const;

function costNumber(o: unknown, keys: readonly string[]): number | undefined {
  if (!o || typeof o !== 'object') return undefined;
  for (const k of keys) {
    const v = (o as Record<string, unknown>)[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  }
  return undefined;
}

/**
 * An estimate with its D-021 figures read leniently: `expectedUsd`/`expected` and
 * `capUsd`/`cap`, on the estimate or on the result that carries it (plan, run.planned,
 * plan.validate). The estimate's own fields win. Undefined when the estimate is invalid.
 */
export function parseEstimate(raw: unknown, container?: unknown): GraphEstimate | undefined {
  const parsed = GraphEstimateSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const est = { ...parsed.data };
  for (const [field, keys] of Object.entries(COST_KEYS) as Array<
    [keyof typeof COST_KEYS, readonly string[]]
  >) {
    const v = costNumber(raw, keys) ?? costNumber(container, keys);
    if (v === undefined) delete est[field];
    else est[field] = v;
  }
  return est;
}

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
    /** Kernel extras (R-303): the router's reason and score for this model. */
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
    usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
  }),
  z.looseObject({ type: z.literal('graph_done'), costUsd: z.number(), ok: z.boolean() }),
]);
export type GraphEvent = z.infer<typeof GraphEventSchema>;

/** Result of `plan`, also the shape of `run.planned`, with the client's refinements. */
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
  name: z.string().optional(),
  kind: z.string().optional(),
  available: z.boolean().optional(),
  reason: z.string().optional(),
  models: z.array(z.union([z.string(), z.looseObject({ id: z.string() })])).default([]),
});

/** Descriptor kind; `unknown` when a kernel does not say (shown as "cloud?"). */
export type ProviderKind = 'local' | 'cloud' | 'test' | 'unknown';

const KINDS = new Set<string>(['local', 'cloud', 'test']);

export interface ProviderView {
  id: string;
  name: string;
  /** `local` costs nothing; `test` providers are offline fakes, hidden unless allowed. */
  kind: ProviderKind;
  available: boolean;
  reason: string;
  models: string[];
}

/** `providers.list` (array or `{ providers }`) as display rows; invalid rows are dropped. */
export function parseProviders(raw: unknown): ProviderView[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { providers?: unknown } | null)?.providers)
      ? (raw as { providers: unknown[] }).providers
      : [];
  return list.flatMap((r) => {
    const p = ProviderSchema.safeParse(r);
    if (!p.success) return [];
    const d = p.data;
    const models = d.models.map((m) => (typeof m === 'string' ? m : m.id));
    return [
      {
        id: d.id,
        name: d.name ?? d.id,
        kind: d.kind && KINDS.has(d.kind) ? (d.kind as ProviderKind) : 'unknown',
        available: d.available !== false,
        reason: d.reason ?? '',
        models,
      },
    ];
  });
}

/**
 * True when the server says test providers may be used (`kpai studio --allow-test`): a
 * top-level `testAllowed: true` on the `providers.list` result.
 */
export function serverAllowsTest(raw: unknown): boolean {
  return (
    !!raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    (raw as { testAllowed?: unknown }).testAllowed === true
  );
}

/** Rows to show: `test` providers only when they are allowed (S8 bug 4). */
export function visibleProviders(rows: ProviderView[], allowTest: boolean): ProviderView[] {
  return allowTest ? rows : rows.filter((p) => p.kind !== 'test');
}

/** Models of the available, visible providers, as provider/model refs (model pickers). */
export function parseModels(raw: unknown, allowTest = false): Ref[] {
  return visibleProviders(parseProviders(raw), allowTest).flatMap((p) =>
    p.available ? p.models.map((model) => ({ provider: p.id, model })) : [],
  );
}

const ArtifactSchema = z.looseObject({
  path: z.string().min(1).max(1000),
  kind: z.string().min(1).max(50),
  nodeId: z.string().optional(),
  content: z.string().optional(),
  text: z.string().optional(),
  provenance: z.unknown().optional(),
  reviewed: z.boolean().optional(),
});

function provenanceLines(p: unknown): string[] {
  if (typeof p === 'string') return [p];
  if (!p || typeof p !== 'object') return [];
  return Object.entries(p as Record<string, unknown>).map(([k, v]) => {
    const r = v as Partial<Ref> | null;
    const value =
      r && typeof r === 'object' && typeof r.provider === 'string' && typeof r.model === 'string'
        ? `${r.provider}/${r.model}`
        : typeof v === 'object'
          ? JSON.stringify(v)
          : String(v);
    return `${k}: ${value}`;
  });
}

/** `run.done` artifacts (WI-S6-01), leniently: rows that do not parse are dropped. */
export function parseArtifacts(raw: unknown): Array<{
  nodeId?: string;
  path: string;
  kind: string;
  text: string;
  provenance: string[];
  reviewed?: boolean;
}> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    const a = ArtifactSchema.safeParse(r);
    if (!a.success) return [];
    const d = a.data;
    return [
      {
        ...(d.nodeId ? { nodeId: d.nodeId } : {}),
        path: d.path,
        kind: d.kind,
        text: d.content ?? d.text ?? '',
        provenance: provenanceLines(d.provenance),
        ...(d.reviewed !== undefined ? { reviewed: d.reviewed } : {}),
      },
    ];
  });
}
