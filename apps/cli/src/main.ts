import { parseArgs } from 'node:util';
import { ProviderError, TaskTypeSchema } from '@kernelpai/core';
import { askCommand } from './commands/ask.js';
import { exportCommand, logCommand, verifyCommand } from './commands/log.js';
import { packCommand } from './commands/pack.js';
import { providersCommand } from './commands/providers.js';
import { routeCommand, runCommand, type RunOptions } from './commands/run.js';
import { statsCommand } from './commands/stats.js';
import { doCommand, planCommand } from './commands/graph.js';
import { studioCommand } from './commands/studio.js';
import { toolsCommand } from './commands/tools.js';
import {
  checkpointsCommand,
  discardCommand,
  mergeCommand,
  restoreCommand,
} from './commands/workspace.js';
import type { GraphCliOptions as GraphOptions } from './commands/graph.js';
import type { Io } from './io.js';

export const USAGE = `KernelPAI (phase 2)

Usage:
  kpai do <request>                    Plan a task graph, show who does what and the cost,
                                       run it with cross-provider review, show patches
  kpai plan <request>                  The same plan and estimate, dry run
      [--planner template|model] [--apply] [--yes-apply] [--allow-same-provider]
      [--isolated]  run in its own git worktree, merged back on confirmation
      [--scope <file>]  authorised scope (YAML/JSON) for packs that require one
      --yes accepts cost prompts only; writes need --yes-apply or a y at the prompt
  kpai checkpoints [--session <id>]   Checkpoints taken before writes, by run
  kpai restore <ref>                   Restore a checkpoint (always asks; undo printed)
  kpai merge <run-id>                  Merge an isolated run's worktree (asks with the diff)
  kpai discard <run-id>                Remove an isolated run's worktree
  kpai pack list|show|detect|check|init  Domain packs (see kpai pack help)
  kpai tools                           Tools models can use, their risk and source
  kpai studio [--port N] [--allow-test] Start KP Studio's local kernel server, print its URL
                                       (--allow-test: offline mock providers by default)
  kpai run <request>                   Classify, route by competence, budget-check,
                                       run with automatic fallback, journal everything
  kpai route <request>                 Same plan and routing, dry run (nothing sent)
      [--type T] [--criticality low|normal|critical] [--profile economy|balanced|performance]
      [--local-only] [--exclude p1,p2] [--max-tokens N] [--yes] [--over-budget]
      [--new-session] [--allow-test] [--verbose]          --allow-test lets routing use offline mock providers
  kpai stats [--session <id>]          Fallback rate, cost per task, estimate error, router latency
  kpai providers                       Detect providers and list models
  kpai ask -m <provider/model> <text>  Send one request, stream, journal it
      [--system <text>] [--max-tokens N] [--yes]
  kpai log [--session <id>] [--limit N] List sessions, or one session's events
  kpai export <session> [--out file]   Export a session as Markdown
  kpai verify                          Check the journal hash chain

Global: --db <path> (default $KPAI_HOME/journal.db, KPAI_HOME=~/.kernelpai)
`;

const OPTIONS = {
  model: { type: 'string', short: 'm' },
  system: { type: 'string' },
  'max-tokens': { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  db: { type: 'string' },
  session: { type: 'string', short: 's' },
  limit: { type: 'string' },
  out: { type: 'string', short: 'o' },
  help: { type: 'boolean', short: 'h' },
  type: { type: 'string', short: 't' },
  criticality: { type: 'string' },
  profile: { type: 'string', short: 'p' },
  'local-only': { type: 'boolean' },
  exclude: { type: 'string' },
  'allow-test': { type: 'boolean' },
  'over-budget': { type: 'boolean' },
  'new-session': { type: 'boolean' },
  planner: { type: 'string' },
  apply: { type: 'boolean' },
  'yes-apply': { type: 'boolean' },
  'allow-same-provider': { type: 'boolean' },
  verbose: { type: 'boolean', short: 'v' },
  port: { type: 'string' },
  isolated: { type: 'boolean' },
  scope: { type: 'string' },
} as const;

function positiveInt(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${name} must be a positive integer`);
  return n;
}

class UsageError extends Error {}

function portNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535)
    throw new UsageError('--port must be a port number (0 picks a free one)');
  return n;
}

/** Every core task type, the pack domain types included (ADR-0024). */
const TASK_TYPES: readonly string[] = TaskTypeSchema.options;
const CRITICALITIES = ['low', 'normal', 'critical'];

function oneOf<T extends string>(
  name: string,
  raw: string | undefined,
  allowed: readonly string[],
): T | undefined {
  if (raw === undefined) return undefined;
  if (!allowed.includes(raw))
    throw new UsageError(`--${name} must be one of ${allowed.join(', ')}`);
  return raw as T;
}

type Values = ReturnType<
  typeof parseArgs<{ args: string[]; options: typeof OPTIONS; allowPositionals: true }>
>['values'];

function graphOptions(v: Values, rest: string[]): GraphOptions {
  if (rest.length === 0) throw new UsageError('plan/do need a request');
  return {
    request: rest.join(' '),
    planner: oneOf('planner', v.planner, ['template', 'model']),
    profile: v.profile,
    localOnly: v['local-only'],
    exclude: v.exclude
      ?.split(',')
      .map((x) => x.trim())
      .filter(Boolean),
    allowTest: v['allow-test'],
    allowSameProvider: v['allow-same-provider'],
    apply: v.apply,
    yesApply: v['yes-apply'],
    yes: v.yes,
    overBudget: v['over-budget'],
    newSession: v['new-session'],
    verbose: v.verbose,
    db: v.db,
    ...(v.isolated ? { isolated: true } : {}),
    ...(v.scope ? { scopeFile: v.scope } : {}),
  };
}

function runOptions(v: Values, rest: string[]): RunOptions {
  if (rest.length === 0) throw new UsageError('run/route need a request');
  return {
    prompt: rest.join(' '),
    type: oneOf('type', v.type, TASK_TYPES),
    criticality: oneOf('criticality', v.criticality, CRITICALITIES),
    profile: v.profile,
    maxTokens: positiveInt('max-tokens', v['max-tokens']),
    localOnly: v['local-only'],
    exclude: v.exclude
      ?.split(',')
      .map((x) => x.trim())
      .filter(Boolean),
    allowTest: v['allow-test'],
    yes: v.yes,
    overBudget: v['over-budget'],
    newSession: v['new-session'],
    verbose: v.verbose,
    db: v.db,
  };
}

type Handler = (io: Io, v: Values, rest: string[]) => number | Promise<number>;

function askOptions(v: Values, rest: string[]): Parameters<typeof askCommand>[1] {
  if (rest.length === 0) throw new UsageError('ask needs a prompt');
  return {
    model: v.model,
    prompt: rest.join(' '),
    system: v.system,
    maxTokens: positiveInt('max-tokens', v['max-tokens']),
    yes: v.yes,
    db: v.db,
  };
}

const COMMANDS: Readonly<Record<string, Handler>> = {
  do: (io, v, rest) => doCommand(io, graphOptions(v, rest)),
  plan: (io, v, rest) => planCommand(io, graphOptions(v, rest)),
  run: (io, v, rest) => runCommand(io, runOptions(v, rest)),
  route: (io, v, rest) => routeCommand(io, runOptions(v, rest)),
  tools: (io) => toolsCommand(io),
  studio: (io, v) =>
    studioCommand(io, { db: v.db, port: portNumber(v.port), allowTest: v['allow-test'] }),
  stats: (io, v) => statsCommand(io, { db: v.db, session: v.session }),
  providers: (io) => providersCommand(io),
  ask: (io, v, rest) => askCommand(io, askOptions(v, rest)),
  log: (io, v) =>
    logCommand(io, { db: v.db, session: v.session, limit: positiveInt('limit', v.limit) }),
  export: (io, v, rest) => {
    if (!rest[0]) throw new UsageError('export needs a session id');
    return exportCommand(io, { db: v.db, session: rest[0], out: v.out });
  },
  verify: (io, v) => verifyCommand(io, { db: v.db }),
  pack: (io, v, rest) => packCommand(io, rest, { out: v.out }),
  checkpoints: (io, v) => checkpointsCommand(io, { db: v.db, session: v.session }),
  restore: (io, v, rest) => restoreCommand(io, { db: v.db, ref: one('restore', 'a ref', rest) }),
  merge: (io, v, rest) => mergeCommand(io, { db: v.db, runId: one('merge', 'a run id', rest) }),
  discard: (io, v, rest) =>
    discardCommand(io, { db: v.db, runId: one('discard', 'a run id', rest) }),
};

function one(command: string, what: string, rest: string[]): string {
  if (rest.length !== 1 || !rest[0]) throw new UsageError(`${command} needs ${what}`);
  return rest[0];
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  try {
    const { values: v, positionals } = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
    });
    const [command, ...rest] = positionals;
    if (v.help || command === undefined || command === 'help') {
      io.out(USAGE);
      return 0;
    }
    const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
    if (!handler) throw new UsageError(`Unknown command "${command}"`);
    return await handler(io, v, rest);
  } catch (err) {
    return reportError(io, err);
  }
}

function reportError(io: Io, err: unknown): number {
  if (err instanceof UsageError || (err instanceof TypeError && 'code' in err)) {
    io.err(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (err instanceof ProviderError) {
    io.err(`error (${err.kind}): ${err.message}\n`);
    return 1;
  }
  io.err(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
}
