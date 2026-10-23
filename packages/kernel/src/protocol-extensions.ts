/**
 * Protocol additions for skills, named agents, hooks and local tickets (R-502, ADR-0033;
 * version 1, additive). Merged into `Methods` by protocol.ts. Descriptions, ticket text
 * and criteria are untrusted repository text: clients show them quoted, never as markup.
 */
import { z } from 'zod';

const Name = z.string().min(1).max(100);
const Origin = z.enum(['repo', 'home']);
const Trust = z.enum(['untrusted', 'user']);

const ExtensionEntry = {
  name: Name,
  description: z.string().max(2000),
  origin: Origin,
  path: z.string().max(600),
  trust: Trust,
};

/** What the workspace offers: names, descriptions, origins and tool lists, never bodies. */
export const ExtensionsSummarySchema = z.looseObject({
  skills: z.array(
    z.looseObject({ ...ExtensionEntry, allowedTools: z.array(z.string()).optional() }),
  ),
  agents: z.array(
    z.looseObject({
      ...ExtensionEntry,
      tools: z.array(z.string()).optional(),
      /** A model hint, resolved through the catalog when a node uses the agent. */
      model: z.string().max(100).optional(),
    }),
  ),
  hooks: z.array(
    z.looseObject({
      name: Name,
      event: z.enum(['before-plan', 'before-tool', 'after-patch']),
      origin: Origin,
      command: z.string().max(400),
      /** False: the hook's process is confirmed each time it runs. */
      allowListed: z.boolean(),
    }),
  ),
  problems: z.array(z.string()),
});

export const TicketStatusSchema = z.enum(['open', 'in-progress', 'done', 'failed', 'blocked']);

export const TicketSchema = z.looseObject({
  id: Name,
  path: z.string().max(600),
  title: z.string().max(400),
  status: z.union([TicketStatusSchema, z.literal('unknown')]),
  criteria: z.array(z.string().max(1000)),
  skill: Name.optional(),
  agent: Name.optional(),
  trust: z.literal('untrusted'),
});

const TicketId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const ExtensionMethods = {
  /** Skills, named agents and hooks of the workspace (R-502). Runs nothing. */
  'extensions.list': {
    params: z.object({}).optional(),
    result: ExtensionsSummarySchema,
  },
  'tickets.list': {
    params: z.object({}).optional(),
    result: z.object({ tickets: z.array(TicketSchema), problems: z.array(z.string()) }),
  },
  /**
   * One ticket and the request a run of it starts with (`run.start {request, options}`):
   * the ticket quoted as untrusted text, then its exit criteria; `options` carries only
   * the ticket's skill and agent, which can only narrow.
   */
  'tickets.show': {
    params: z.object({ id: TicketId }),
    result: z.object({
      ticket: TicketSchema,
      request: z.string(),
      options: z.object({ skill: Name.optional(), agent: Name.optional() }),
    }),
  },
  /**
   * Writes a ticket's status after a `confirm.request` (kind `artifact`) with the exact new
   * file is answered yes; `written: false` on a no or silence.
   */
  'tickets.setStatus': {
    params: z.object({ id: TicketId, status: TicketStatusSchema, runId: Name.optional() }),
    result: z.object({ written: z.boolean(), status: TicketStatusSchema, message: z.string() }),
  },
} as const;

/** D-028 facts on `confirm.request` (optional; older clients ignore them). */
export const ConfirmFacts = {
  /** For `budget`: the amount asked, in USD; absent when it is not known. */
  amountUsd: z.number().nonnegative().optional(),
  /** The write lands in the run's own worktree, not the user's tree. */
  inWorktree: z.boolean().optional(),
  /** The step may actuate a physical device (a pack with physical effects). */
  physical: z.boolean().optional(),
};

/** D-028 facts on `run.done`: providers that served the run and their source. */
export const RunSourceFacts = {
  providers: z.array(z.string().max(100)).max(100).optional(),
  source: z.enum(['local', 'api', 'subscription', 'mixed']).optional(),
  sources: z
    .array(
      z.object({ provider: z.string().max(100), source: z.enum(['local', 'api', 'subscription']) }),
    )
    .max(100)
    .optional(),
};
