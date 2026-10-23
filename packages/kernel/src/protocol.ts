/**
 * KernelPAI console protocol (ADR-0019): JSON-RPC 2.0 over a local WebSocket between the
 * kernel server and its clients (web, desktop, TUI). Every message is validated with these
 * schemas on both sides; anything that does not parse is rejected.
 *
 * Client → server: requests (`Methods`), each with a params and a result schema.
 * Server → client: notifications (`Notifications`), including confirmation requests the
 * client answers with the `confirm.answer` method.
 *
 * Connection: the WebSocket subprotocols are `[SUBPROTOCOL, BEARER_PREFIX + token]`; the
 * server echoes `SUBPROTOCOL` only, and closes with `CloseCodes.unauthorized` (4401) when
 * the token is refused. Non-browser clients may send `Authorization: Bearer <token>`.
 */
import { z } from 'zod';
import {
  ArtifactSchema,
  AuthorisedScopeInputSchema,
  PacksSchema,
  RulesSchema,
  ScopeStatusSchema,
  WorkspaceMethods,
} from './protocol-workspace.js';
import { MemoryConfirmSchema, MemoryMethods, MemorySummarySchema } from './protocol-memory.js';
import { DisputeSchema, LearningMethods } from './protocol-learning.js';
import { replayMethods } from './protocol-replay.js';

export {
  AccuracySchema,
  CompetenceEntrySchema,
  DisputeSchema,
  ProductivitySchema,
  ReplayResultSchema,
} from './protocol-learning.js';
export {
  FactSchema,
  MemoryConfirmSchema,
  MemorySummarySchema,
  PendingFactSchema,
  ProvenanceSchema,
} from './protocol-memory.js';
export {
  ArtifactKindSchema,
  ArtifactSchema,
  AuthorisedScopeInputSchema,
  CheckpointSchema,
  PacksSchema,
  RulesSchema,
  ScopeStatusSchema,
} from './protocol-workspace.js';

export const PROTOCOL_VERSION = 1;
export const SUBPROTOCOL = 'kernelpai.v1';
export const BEARER_PREFIX = 'kernelpai.bearer.';
export const CloseCodes = { unauthorized: 4401, policy: 1008 } as const;

const Ref = z.object({ provider: z.string(), model: z.string() });
const Id = z.string().min(1).max(100);
const Usd = z.number();

export const RunOptionsSchema = z.object({
  planner: z.enum(['template', 'model']).optional(),
  profile: z.enum(['economy', 'balanced', 'performance']).optional(),
  localOnly: z.boolean().optional(),
  exclude: z.array(z.string()).max(50).optional(),
  allowTest: z.boolean().optional(),
  /** A waiver shown on the plan: on `run.start` with a `planId` the plan's own value is
   * used, never the start request's (review P3-F6). */
  allowSameProvider: z.boolean().optional(),
  // No `overBudget`: a console never skips budget questions (P3-F6, ADR-0019 addendum).
  // An unknown key is stripped, so an older client that sends it gets the questions.
  /** One git worktree per run (R-307, ADR-0021). Omitted over the protocol: isolated
   * when the workspace is a git working tree, in place otherwise. */
  isolated: z.boolean().optional(),
  /** Authorised scope for packs that require one (WI-S1-03). */
  scope: AuthorisedScopeInputSchema.optional(),
});
export type RunOptions = z.infer<typeof RunOptionsSchema>;

/** Why a node goes to its model (R-303): the router's one line, score and runner-up. */
const Routing = {
  reason: z.string().optional(),
  score: z.number().optional(),
  parts: z.record(z.string(), z.number().nullable()).optional(),
  runnerUp: z.object({ ref: Ref, score: z.number() }).optional(),
};

/** Kernel objects are lenient on extra fields: a newer kernel does not break a client. */
/** What a node hands back (core `Deliverable`, ADR-0022). */
const DeliverableSchema = z.enum([
  'answer',
  'report',
  'patch',
  'notebook',
  'design',
  'build',
  'checklist',
  'model3d',
  'map',
  'config',
  'asset',
]);

export const GraphSchema = z.looseObject({
  id: z.string(),
  request: z.string(),
  nodes: z.array(
    z.looseObject({
      id: z.string(),
      title: z.string(),
      dependsOn: z.array(z.string()),
      deliverable: DeliverableSchema.optional(),
    }),
  ),
  createdBy: z.string(),
  reason: z.string(),
});

/** Low–high cost from the calibration spread (R-302). */
export const BandSchema = z.object({
  lowUsd: Usd,
  highUsd: Usd,
  basis: z.enum(['calibrated', 'heuristic', 'mixed']),
});

/** One protocol step of a node: who does it, how often, for how much, and why (R-303). */
export const StepEstimateSchema = z.looseObject({
  role: z.string(),
  ref: Ref,
  calls: z.object({ min: z.number(), max: z.number() }),
  minUsd: Usd,
  expectedUsd: Usd,
  band: BandSchema.optional(),
  ...Routing,
});

export const NodeEstimateSchema = z.looseObject({
  nodeId: z.string(),
  protocol: z.string(),
  ref: Ref.nullable(),
  minUsd: Usd,
  expectedUsd: Usd,
  error: z.string().optional(),
  band: BandSchema.optional(),
  steps: z.array(StepEstimateSchema).optional(),
  ...Routing,
});

export const EstimateSchema = z.looseObject({
  nodes: z.array(NodeEstimateSchema),
  minUsd: Usd,
  totalUsd: Usd,
  complete: z.boolean(),
  problems: z.array(z.string()),
  band: BandSchema.optional(),
  /** The likely cost (D-021, ADR-0026); equals `totalUsd`. */
  expectedUsd: Usd.optional(),
  /**
   * The cap (D-021, ADR-0026): the band's top. What the user approves, what the graph budget
   * check uses, and the run's hard cap: going beyond it asks again. Absent from older kernels.
   */
  capUsd: Usd.optional(),
  /** How past estimates here compared with billed costs (R-402, ADR-0028). */
  accuracy: z.string().optional(),
});

/**
 * A plan's graph as the user edited it (R-301): models, protocol, criticality, budget,
 * nodes added or removed. Only the envelope is checked here; the kernel validates every
 * field (untrusted input) and re-estimates before anything runs. `model` pins a node's
 * first step to that model, with no automatic fallback (ADR-0019).
 */
export const EditedGraphSchema = z.looseObject({
  nodes: z
    .array(
      z.looseObject({
        id: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[A-Za-z0-9_-]+$/),
        model: Ref.optional(),
        deliverable: DeliverableSchema.optional(),
      }),
    )
    .min(1)
    .max(100),
});

/** Steering events of a run (pause, resume, cancel, redirect, instruction, refusal). */
export const ControlEventSchema = z.looseObject({
  type: z.enum([
    'run_paused',
    'run_resumed',
    'run_cancelled',
    'node_redirected',
    'instruction_added',
    'control_refused',
    'node_disputed',
    'dispute_resolved',
  ]),
  nodeId: z.string().optional(),
  reason: z.string().optional(),
});

/**
 * A core `GraphEvent` (packages/core graph.ts), with optional kernel extras: `reason` and
 * `score` on `node_state` events that name a model (R-303), `usage` token counts on
 * `contribution` events (spec §4.4).
 */
export const RunEventSchema = z.looseObject({
  /** `node_state`, `text`, `contribution` or `graph_done` today; clients drop types they do
   * not know (a string here so a newer kernel's event types reach an older client). */
  type: z.string().min(1).max(50),
  nodeId: z.string().optional(),
  reason: z.string().optional(),
  score: z.number().optional(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
});

const ProviderSchema = z.looseObject({
  id: z.string(),
  /** Descriptor kind (`cloud`, `local`, `test`…): a console hides `test` unless allowed. */
  kind: z.string(),
  available: z.boolean(),
  models: z.array(z.looseObject({ id: z.string() })),
});

const SessionSchema = z.looseObject({ id: z.string(), createdAt: z.string(), title: z.string() });
const Ok = z.object({ ok: z.literal(true) });

/** Request params and results, by method name. */
export const Methods = {
  'kernel.hello': {
    params: z.object({ client: z.string().max(100), protocol: z.number().int() }),
    result: z.object({ protocol: z.number().int(), server: z.string() }),
  },
  'providers.list': {
    params: z.object({}).optional(),
    result: z.object({
      providers: z.array(ProviderSchema),
      /** True when this server lets runs use `kind: test` providers by default (`--allow-test`). */
      testAllowed: z.boolean().optional(),
    }),
  },
  'tools.list': {
    params: z.object({}).optional(),
    result: z.object({
      tools: z.array(z.looseObject({ name: z.string(), risk: z.string(), source: z.string() })),
      errors: z.array(z.object({ server: z.string(), message: z.string() })),
    }),
  },
  plan: {
    params: z.object({
      request: z.string().min(1).max(100_000),
      options: RunOptionsSchema.optional(),
    }),
    result: z.object({
      planId: Id,
      graph: GraphSchema,
      estimate: EstimateSchema,
      /** Repository rule files every node will get as untrusted context (R-306). */
      rules: RulesSchema.optional(),
      /** Selected domain packs, why, and the forbidden zones with origin (D-020). */
      packs: PacksSchema.optional(),
      /** Authorised scope status; a run is refused while it has problems. */
      scope: ScopeStatusSchema.optional(),
      /** Memory every node will get: counts, ids, sources, truncation (ADR-0027). */
      memory: MemorySummarySchema.optional(),
    }),
  },
  /** Checks an edited plan and re-estimates it; runs nothing (R-301). */
  'plan.validate': {
    params: z.object({ planId: Id, graph: EditedGraphSchema }),
    result: z.object({
      ok: z.boolean(),
      problems: z.array(z.string()),
      warnings: z.array(z.string()),
      changes: z.array(z.string()),
      estimate: EstimateSchema.optional(),
    }),
  },
  'run.start': {
    params: z.object({
      request: z.string().min(1).max(100_000),
      /** The plan the user saw; when omitted the kernel plans again. */
      planId: Id.optional(),
      /** The plan as edited and approved (needs `planId`); validated again by the kernel. */
      graph: EditedGraphSchema.optional(),
      options: RunOptionsSchema.optional(),
    }),
    result: z.object({ runId: Id }),
  },
  'run.cancel': { params: z.object({ runId: Id }), result: z.object({ cancelled: z.boolean() }) },
  'run.pause': { params: z.object({ runId: Id }), result: Ok },
  'run.resume': { params: z.object({ runId: Id }), result: Ok },
  /** Principle 4: move a node to another model; finished work is kept. */
  'run.redirect': { params: z.object({ runId: Id, nodeId: Id, to: Ref }), result: Ok },
  /** R-304: add an instruction to a node that has not started. */
  'run.instruct': {
    params: z.object({ runId: Id, nodeId: Id, text: z.string().min(1).max(10_000) }),
    result: Ok,
  },
  'patches.apply': {
    params: z.object({ runId: Id, nodeIds: z.array(Id).optional() }),
    result: z.object({
      results: z.array(z.object({ nodeId: Id, ok: z.boolean(), message: z.string() })),
    }),
  },
  'confirm.answer': {
    params: z.object({
      confirmId: Id,
      ok: z.boolean(),
      trustSession: z.boolean().optional(),
      /** For `dispute`: the chosen option id (with `ok: true`); absent or `ok: false` rejects. */
      choice: Id.optional(),
    }),
    /** False when the confirmation was unknown, already answered or expired. */
    result: z.object({ accepted: z.boolean() }),
  },
  'sessions.list': {
    params: z.object({ limit: z.number().int().min(1).max(1000).optional() }),
    result: z.object({ sessions: z.array(SessionSchema) }),
  },
  'sessions.events': {
    params: z.object({ sessionId: Id, limit: z.number().int().min(1).max(100_000).optional() }),
    result: z.object({ events: z.array(z.looseObject({ seq: z.number(), type: z.string() })) }),
  },
  stats: {
    params: z.object({ sessionId: Id.optional() }).optional(),
    result: z.looseObject({}),
  },
  'journal.verify': {
    params: z.object({}).optional(),
    result: z.looseObject({ ok: z.boolean(), checked: z.number() }),
  },
  ...WorkspaceMethods,
  ...MemoryMethods,
  ...LearningMethods,
  ...replayMethods({ RunOptionsSchema, EstimateSchema, GraphSchema, ScopeStatusSchema }),
} as const;
export type MethodName = keyof typeof Methods;
export type MethodResult<M extends MethodName> = z.infer<(typeof Methods)[M]['result']>;

const PatchSchema = z.object({ nodeId: Id, patch: z.string(), files: z.array(z.string()) });

/** Server → client notifications. */
export const Notifications = {
  'run.planned': z.object({ runId: Id, planId: Id, graph: z.unknown(), estimate: z.unknown() }),
  'run.event': z.object({ runId: Id, event: RunEventSchema }),
  'run.state': z.object({
    runId: Id,
    state: z.enum(['running', 'paused', 'cancelling', 'done', 'failed', 'cancelled']),
  }),
  'run.control': z.object({ runId: Id, event: ControlEventSchema }),
  'run.done': z.object({
    runId: Id,
    result: z.unknown(),
    patches: z.array(PatchSchema),
    /** Non-code outputs of approved nodes (D-019, ADR-0022). */
    artifacts: z.array(ArtifactSchema).optional(),
    /** The run's worktree when it ran isolated (R-307): merge or discard it. */
    worktree: z.string().optional(),
    /** Review spend against accepted findings (R-404). */
    verification: z.looseObject({}).optional(),
  }),
  /** The client must answer with `confirm.answer`; silence for `timeoutMs` means "no". */
  'confirm.request': z.object({
    confirmId: Id,
    runId: Id.optional(),
    /** `restore` is destructive (ADR-0021); `artifact` writes `content` (ADR-0022);
     * `memory` keeps a model's proposed fact (ADR-0027; no answer keeps it pending). */
    kind: z.enum(['budget', 'tool', 'patch', 'restore', 'artifact', 'memory', 'dispute']),
    question: z.string().max(10_000),
    risk: z.enum(['read', 'write', 'destructive']).optional(),
    /** For `patch`: the exact diff that would be written, apart from the question. */
    patch: z.string().max(2_000_000).optional(),
    /** For `artifact`: the exact text that would be written, and what it is. */
    content: z.string().max(2_000_000).optional(),
    artifact: z
      .object({
        path: z.string(),
        kind: z.string(),
        mime: z.string(),
        bytes: z.number().int(),
        nodeId: Id,
        reviewed: z.boolean(),
      })
      .optional(),
    /** For `memory`: the proposed fact and where it comes from. */
    memory: MemoryConfirmSchema.optional(),
    /** For `dispute` (R-405): the options to pick from, as untrusted quoted text. Answer
     * with `confirm.answer {ok: true, choice}`; silence or `ok: false` rejects (fail closed). */
    dispute: DisputeSchema.optional(),
    timeoutMs: z.number().int().positive(),
  }),
  /**
   * A `confirm.request` that no longer needs an answer: its run was cancelled and it was
   * settled as "no" (review P3-F2). The client closes that dialog; a late answer is refused.
   */
  'confirm.closed': z.object({
    confirmId: Id,
    runId: Id.optional(),
    reason: z.enum(['cancelled']),
  }),
  log: z.object({ level: z.enum(['info', 'warn', 'error']), message: z.string().max(10_000) }),
} as const;
export type NotificationName = keyof typeof Notifications;

export const RequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string().max(100), z.number().int()]),
  method: z.string().max(100),
  params: z.unknown().optional(),
});

export const ErrorCodes = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unauthorized: -32001,
  budget: -32002,
  /** Not possible in the current state (applying after a cancel, a finished run…). */
  refused: -32003,
  notFound: -32004,
  /** The kernel does not offer this yet (for example pause before phase 3 WP2). */
  unsupported: -32005,
  /** The working directory is not a project. */
  workspace: -32006,
  /** Some nodes of the plan cannot be routed. */
  unroutable: -32007,
} as const;

type Check<T> = { ok: true; value: T } | { ok: false; error: string };

function check<T>(schema: z.ZodType, value: unknown): Check<T> {
  const r = schema.safeParse(value);
  return r.success
    ? { ok: true, value: r.data as T }
    : {
        ok: false,
        error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      };
}

/** Validates params for a method; returns an error message instead of throwing. */
export function parseParams<M extends MethodName>(
  method: M,
  params: unknown,
): Check<z.infer<(typeof Methods)[M]['params']>> {
  return check(Methods[method].params, params);
}

/** Validates a method's result before it is sent (server) or used (client). */
export function parseResult<M extends MethodName>(
  method: M,
  result: unknown,
): Check<MethodResult<M>> {
  return check(Methods[method].result, result);
}

export function parseNotification<N extends NotificationName>(
  name: N,
  params: unknown,
): Check<z.infer<(typeof Notifications)[N]>> {
  return check(Notifications[name], params);
}

export function isMethod(name: string): name is MethodName {
  return Object.hasOwn(Methods, name);
}
