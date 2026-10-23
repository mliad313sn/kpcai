import { parseArgs } from 'node:util';
import { ProviderError } from '@kernelpai/core';
import { askCommand } from './commands/ask.js';
import { exportCommand, logCommand, verifyCommand } from './commands/log.js';
import { providersCommand } from './commands/providers.js';
import type { Io } from './io.js';

export const USAGE = `KernelPAI (phase 0)

Usage:
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
} as const;

function positiveInt(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${name} must be a positive integer`);
  return n;
}

class UsageError extends Error {}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  try {
    const { values: v, positionals } = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
    });
    const [command, ...rest] = positionals;
    const db = v.db;
    switch (v.help ? 'help' : command) {
      case 'providers':
        return await providersCommand(io);
      case 'ask':
        if (rest.length === 0) throw new UsageError('ask needs a prompt');
        return await askCommand(io, {
          model: v.model,
          prompt: rest.join(' '),
          system: v.system,
          maxTokens: positiveInt('max-tokens', v['max-tokens']),
          yes: v.yes,
          db,
        });
      case 'log':
        return logCommand(io, { db, session: v.session, limit: positiveInt('limit', v.limit) });
      case 'export':
        if (!rest[0]) throw new UsageError('export needs a session id');
        return exportCommand(io, { db, session: rest[0], out: v.out });
      case 'verify':
        return verifyCommand(io, { db });
      case 'help':
      case undefined:
        io.out(USAGE);
        return 0;
      default:
        throw new UsageError(`Unknown command "${command}"`);
    }
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
