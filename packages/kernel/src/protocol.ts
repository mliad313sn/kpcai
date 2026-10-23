/**
 * KernelPAI console protocol (ADR-0019): JSON-RPC 2.0 over a local WebSocket between the
 * kernel server and its clients (web, desktop, TUI). Every message is validated with these
 * schemas on both sides; anything that does not parse is rejected.
 *
 * Client → server: requests (`Methods`). Server → client: notifications (`Notifications`)
 * and confirmation requests the client must answer with `confirm.answer`.
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

const Ref = z.object({ provider: z.string(), model: z.string() });
const Id = z.string().min(1).max(100);

export const RunOptionsSchema = z.object({
  planner: z.enum(['template', 'model']).optional(),
  profile: z.enum(['economy', 'balanced', 'performance']).optional(),
  localOnly: z.boolean().optional(),
  exclude: z.array(z.string()).max(50).optional(),
  allowTest: z.boolean().optional(),
  allowSameProvider: z.boolean().optional(),
  overBudget: z.boolean().optional(),
});
export type RunOptions = z.infer<typeof RunOptionsSchema>;

/** Request params and results, by method name. Results are typed loosely (`unknown` parts are
 * kernel objects defined in core/journal) and validated where clients depend on them. */
export const Methods = {
  'kernel.hello': {
    params: z.object({ client: z.string().max(100), protocol: z.number().int() }),
  },
  'providers.list': { params: z.object({}).optional() },
  'tools.list': { params: z.object({}).optional() },
  plan: {
    params: z.object({
      request: z.string().min(1).max(100_000),
      options: RunOptionsSchema.optional(),
    }),
  },
  'run.start': {
    params: z.object({
      request: z.string().min(1).max(100_000),
      /** The plan the user saw; when omitted the kernel plans again. */
      planId: Id.optional(),
      options: RunOptionsSchema.optional(),
    }),
  },
  'run.cancel': { params: z.object({ runId: Id }) },
  'run.pause': { params: z.object({ runId: Id }) },
  'run.resume': { params: z.object({ runId: Id }) },
  /** Principle 4: move a node to another model; finished work is kept. */
  'run.redirect': { params: z.object({ runId: Id, nodeId: Id, to: Ref }) },
  'patches.apply': { params: z.object({ runId: Id, nodeIds: z.array(Id).optional() }) },
  'confirm.answer': {
    params: z.object({ confirmId: Id, ok: z.boolean(), trustSession: z.boolean().optional() }),
  },
  'sessions.list': { params: z.object({ limit: z.number().int().min(1).max(1000).optional() }) },
  'sessions.events': {
    params: z.object({ sessionId: Id, limit: z.number().int().min(1).max(100_000).optional() }),
  },
  stats: { params: z.object({ sessionId: Id.optional() }).optional() },
  'journal.verify': { params: z.object({}).optional() },
} as const;
export type MethodName = keyof typeof Methods;

/** Server → client notifications. `run.event` carries a core `GraphEvent`. */
export const Notifications = {
  'run.planned': z.object({ runId: Id, planId: Id, graph: z.unknown(), estimate: z.unknown() }),
  'run.event': z.object({ runId: Id, event: z.unknown() }),
  'run.state': z.object({
    runId: Id,
    state: z.enum(['running', 'paused', 'cancelling', 'done', 'failed', 'cancelled']),
  }),
  'run.done': z.object({
    runId: Id,
    result: z.unknown(),
    patches: z.array(z.object({ nodeId: Id, patch: z.string(), files: z.array(z.string()) })),
  }),
  /** The client must answer with `confirm.answer`; silence for `timeoutMs` means "no". */
  'confirm.request': z.object({
    confirmId: Id,
    runId: Id.optional(),
    kind: z.enum(['budget', 'tool', 'patch']),
    question: z.string().max(10_000),
    risk: z.enum(['read', 'write', 'destructive']).optional(),
    timeoutMs: z.number().int().positive(),
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
  notFound: -32004,
} as const;

/** Validates params for a method; returns an error message instead of throwing. */
export function parseParams<M extends MethodName>(
  method: M,
  params: unknown,
): { ok: true; value: z.infer<(typeof Methods)[M]['params']> } | { ok: false; error: string } {
  const schema: z.ZodType = Methods[method].params;
  const r = schema.safeParse(params);
  return r.success
    ? { ok: true, value: r.data as z.infer<(typeof Methods)[M]['params']> }
    : {
        ok: false,
        error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      };
}

export function isMethod(name: string): name is MethodName {
  return Object.hasOwn(Methods, name);
}
