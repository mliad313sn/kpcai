/**
 * Protocol methods of replay and fork (R-403, P4-F2, P4-F5); version 1, additive. They use
 * schemas of protocol.ts, which passes them in (no import cycle) and merges the result
 * into `Methods`.
 */
import { z } from 'zod';
import { NodeEdit, ReplayResultSchema } from './protocol-learning.js';

const Id = z.string().min(1).max(100);

/** The schemas of protocol.ts the replay and fork methods are made of. */
export interface ReplaySchemas<
  R extends z.ZodType,
  E extends z.ZodType,
  G extends z.ZodType,
  S extends z.ZodType,
> {
  RunOptionsSchema: R;
  EstimateSchema: E;
  GraphSchema: G;
  ScopeStatusSchema: S;
}

export function replayMethods<
  R extends z.ZodType,
  E extends z.ZodType,
  G extends z.ZodType,
  S extends z.ZodType,
>({ RunOptionsSchema, EstimateSchema, GraphSchema, ScopeStatusSchema }: ReplaySchemas<R, E, G, S>) {
  return {
    /**
     * What a replay of one finished node would cost, before anything is spent (P4-F5, D-021):
     * likely and cap. Its `planId` is also the replay's id: `run.replay {planId}` starts it,
     * `run.cancel {runId: planId}` stops it. `options` are held to the run's routing (P4-F2).
     */
    'run.replayPlan': {
      params: z.object({
        runId: Id,
        nodeId: Id,
        ...NodeEdit,
        options: RunOptionsSchema.optional(),
      }),
      result: z.object({
        planId: Id,
        runId: Id,
        nodeId: Id,
        /** The routing the replay is held to: the run's, made stricter by the options. */
        routing: z.looseObject({
          localOnly: z.boolean().optional(),
          exclude: z.array(z.string()).optional(),
          profile: z.string().optional(),
          allowTest: z.boolean().optional(),
        }),
        estimate: EstimateSchema,
        /** Authorised scope status with the current packs; a replay is refused while it has problems. */
        scope: ScopeStatusSchema.optional(),
      }),
    },
    /**
     * Reruns one finished node beside the original. With `planId` (from `run.replayPlan`) it
     * runs that plan, cancellable with `run.cancel {runId: planId}`; without, it plans first.
     * Either way the cap is checked against the budget before anything is spent (D-021).
     */
    'run.replay': {
      params: z.object({
        runId: Id,
        nodeId: Id,
        ...NodeEdit,
        planId: Id.optional(),
        options: RunOptionsSchema.optional(),
      }),
      result: ReplayResultSchema,
    },
    ...forkMethods({ RunOptionsSchema, EstimateSchema, GraphSchema, ScopeStatusSchema }),
  } as const;
}

function forkMethods<
  R extends z.ZodType,
  E extends z.ZodType,
  G extends z.ZodType,
  S extends z.ZodType,
>({ RunOptionsSchema, EstimateSchema, GraphSchema }: ReplaySchemas<R, E, G, S>) {
  return {
    /** A fork from a node (R-403): reused nodes, nodes that run again, and their estimate. */
    'run.forkPlan': {
      params: z.object({
        runId: Id,
        nodeId: Id,
        /** Held to the run's routing constraints as a floor (P4-F2). */
        options: RunOptionsSchema.optional(),
        edit: z
          .object({ ...NodeEdit, instruction: z.string().min(1).max(10_000).optional() })
          .optional(),
      }),
      result: z.object({
        planId: Id,
        parent: z.object({ runId: Id, nodeId: Id }),
        rerun: z.array(z.string()),
        reused: z.array(z.string()),
        edits: z.array(z.string()),
        graph: GraphSchema,
        /** Covers only the nodes that run again; the band's top is the cap (D-021). */
        estimate: EstimateSchema,
      }),
    },
  } as const;
}
