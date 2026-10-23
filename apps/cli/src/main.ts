import { parseArgs } from 'node:util';
import { ProviderError, TaskTypeSchema } from '@kernelpai/core';
import { askCommand } from './commands/ask.js';
import { exportCommand, logCommand, verifyCommand } from './commands/log.js';
import { benchCommand, gradeCommand } from './commands/learning.js';
import { memoryCommand } from './commands/memory.js';
import { packCommand } from './commands/pack.js';
import { providersCommand } from './commands/providers.js';
import { forkCommand, replayCommand, type NodeCliOptions } from './commands/replay.js';
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
import { cliLocale, setLocale, t } from './i18n/core.js';
import { en } from './i18n/en.js';

/** The English usage text; `kpai help` prints it in the user's language (`usage()`). */
export const USAGE: string = en.usage;

export function usage(): string {
  return t('usage');
}

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
  lang: { type: 'string' },
  layer: { type: 'string' },
  author: { type: 'string' },
  'per-kind': { type: 'string' },
  productivity: { type: 'boolean' },
  since: { type: 'string' },
  protocol: { type: 'string' },
  instruction: { type: 'string' },
} as const;

function positiveInt(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(t('error.positiveInt', { name }));
  return n;
}

class UsageError extends Error {}

function portNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new UsageError(t('error.port'));
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
    throw new UsageError(t('error.oneOf', { name, allowed: allowed.join(', ') }));
  return raw as T;
}

type Values = ReturnType<
  typeof parseArgs<{ args: string[]; options: typeof OPTIONS; allowPositionals: true }>
>['values'];

function graphOptions(v: Values, rest: string[]): GraphOptions {
  if (rest.length === 0) throw new UsageError(t('error.graphNeedsRequest'));
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
  if (rest.length === 0) throw new UsageError(t('error.runNeedsRequest'));
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

/** `kpai replay|fork <run> <node>`: the run and node, the edit, and the usual run flags. */
function nodeOptions(v: Values, rest: string[]): NodeCliOptions {
  const [runId, nodeId, ...extra] = rest;
  if (!runId || !nodeId || extra.length > 0) throw new UsageError(t('error.nodeNeedsArgs'));
  return {
    db: v.db,
    runId,
    nodeId,
    model: v.model,
    protocol: v.protocol,
    instruction: v.instruction,
    apply: v.apply,
    yesApply: v['yes-apply'],
    ...(v['allow-test'] ? { allowTest: true } : {}),
    ...(v.yes ? { yes: true } : {}),
    ...(v['over-budget'] ? { overBudget: true } : {}),
    ...(v['allow-same-provider'] ? { allowSameProvider: true } : {}),
    ...(v.isolated ? { isolated: true } : {}),
  };
}

function askOptions(v: Values, rest: string[]): Parameters<typeof askCommand>[1] {
  if (rest.length === 0) throw new UsageError(t('error.askNeedsPrompt'));
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
  stats: (io, v) =>
    statsCommand(io, {
      db: v.db,
      session: v.session,
      productivity: v.productivity,
      since: v.since,
    }),
  providers: (io) => providersCommand(io),
  ask: (io, v, rest) => askCommand(io, askOptions(v, rest)),
  log: (io, v) =>
    logCommand(io, { db: v.db, session: v.session, limit: positiveInt('limit', v.limit) }),
  export: (io, v, rest) => {
    if (!rest[0]) throw new UsageError(t('error.exportNeedsSession'));
    return exportCommand(io, { db: v.db, session: rest[0], out: v.out });
  },
  verify: (io, v) => verifyCommand(io, { db: v.db }),
  pack: (io, v, rest) => packCommand(io, rest, { out: v.out }),
  grade: (io, v, rest) => {
    const [runId, nodeId, grade, ...note] = rest;
    if (!runId || !nodeId || !grade) throw new UsageError(t('error.gradeNeedsArgs'));
    return gradeCommand(io, {
      db: v.db,
      runId,
      nodeId,
      grade,
      note: note.join(' ') || undefined,
      author: v.author,
    });
  },
  bench: (io, v) =>
    benchCommand(io, {
      db: v.db,
      perKind: positiveInt('per-kind', v['per-kind']),
      options: { ...(v['allow-test'] ? { allowTest: true } : {}), ...(v.yes ? { yes: true } : {}) },
    }),
  replay: (io, v, rest) => replayCommand(io, nodeOptions(v, rest)),
  fork: (io, v, rest) => forkCommand(io, nodeOptions(v, rest)),
  memory: (io, v, rest) =>
    memoryCommand(io, rest, {
      db: v.db,
      layer: v.layer,
      session: v.session,
      localOnly: v['local-only'],
    }),
  checkpoints: (io, v) => checkpointsCommand(io, { db: v.db, session: v.session }),
  restore: (io, v, rest) =>
    restoreCommand(io, { db: v.db, ref: one('error.restoreNeedsRef', rest) }),
  merge: (io, v, rest) => mergeCommand(io, { db: v.db, runId: one('error.mergeNeedsRunId', rest) }),
  discard: (io, v, rest) =>
    discardCommand(io, { db: v.db, runId: one('error.discardNeedsRunId', rest) }),
};

type NeedsKey = 'error.restoreNeedsRef' | 'error.mergeNeedsRunId' | 'error.discardNeedsRunId';

function one(missing: NeedsKey, rest: string[]): string {
  if (rest.length !== 1 || !rest[0]) throw new UsageError(t(missing));
  return rest[0];
}

/** `--lang` is read before parsing so that even a parse error speaks the user's language. */
function langFlag(argv: readonly string[]): string | undefined {
  const i = argv.findIndex((a) => a === '--lang' || a.startsWith('--lang='));
  if (i < 0) return undefined;
  const arg = argv[i]!;
  return arg.startsWith('--lang=') ? arg.slice('--lang='.length) : argv[i + 1];
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const lang = langFlag(argv);
  setLocale(cliLocale(io.env, lang));
  try {
    if (lang !== undefined && !/^(en|fr)(?:[-_].*)?$/i.test(lang))
      throw new UsageError(t('error.lang', { value: lang }));
    const { values: v, positionals } = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
    });
    const [command, ...rest] = positionals;
    if (v.help || command === undefined || command === 'help') {
      io.out(usage());
      return 0;
    }
    const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
    if (!handler) throw new UsageError(t('error.unknownCommand', { command }));
    return await handler(io, v, rest);
  } catch (err) {
    return reportError(io, err);
  }
}

/** Node's argument parser reports in English: its errors are reworded, the detail kept. */
function argsMessage(err: TypeError & { code?: unknown }): string {
  const option = /'(-[^']*)'/.exec(err.message)?.[1];
  if (err.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && option)
    return t('error.unknownOption', { option });
  return t('error.badArguments', { detail: err.message });
}

/** Error frames are translated; the error's own text (kernel, provider) is passed as is. */
function reportError(io: Io, err: unknown): number {
  if (err instanceof UsageError || (err instanceof TypeError && 'code' in err)) {
    const message = err instanceof UsageError ? err.message : argsMessage(err);
    io.err(t('error.usage', { message, usage: usage() }));
    return 2;
  }
  if (err instanceof ProviderError) {
    io.err(t('error.provider', { kind: err.kind, message: err.message }));
    return 1;
  }
  io.err(t('error.generic', { message: err instanceof Error ? err.message : String(err) }));
  return 1;
}
