import { writeFileSync } from 'node:fs';
import { sessionToMarkdown } from '@kernelpai/journal';
import { openJournal } from '../context.js';
import type { Io } from '../io.js';

export interface LogOptions {
  db?: string;
  session?: string;
  limit?: number;
}

/** `kpai log`: list sessions, or the events of one session. */
export function logCommand(io: Io, opts: LogOptions): number {
  const journal = openJournal(io.env, opts.db);
  try {
    if (!opts.session) {
      for (const s of journal.sessions(opts.limit ?? 20)) {
        io.out(
          `${s.id.slice(0, 8)}  ${s.createdAt}  ${String(s.eventCount).padStart(3)} ev  $${s.costUsd.toFixed(6)}  ${s.title}\n`,
        );
      }
      return 0;
    }
    const session = journal.findSession(opts.session);
    if (!session) {
      io.err(`No session starting with "${opts.session}"\n`);
      return 1;
    }
    for (const e of journal.events({ sessionId: session.id, limit: opts.limit ?? 1000 })) {
      const who = e.provider ? ` ${e.provider}/${e.model}` : '';
      io.out(`#${e.seq} ${e.ts} ${e.type.padEnd(12)}${who} ${JSON.stringify(e.payload)}\n`);
    }
    return 0;
  } finally {
    journal.close();
  }
}

/** `kpai export <session>`: Markdown export of a session. */
export function exportCommand(
  io: Io,
  opts: { db?: string; session: string; out?: string },
): number {
  const journal = openJournal(io.env, opts.db);
  try {
    const session = journal.findSession(opts.session);
    if (!session) {
      io.err(`No session starting with "${opts.session}"\n`);
      return 1;
    }
    const md = sessionToMarkdown(session, journal.events({ sessionId: session.id }));
    if (opts.out) writeFileSync(opts.out, md, 'utf8');
    else io.out(md);
    return 0;
  } finally {
    journal.close();
  }
}

/** `kpai verify`: checks the journal hash chain. */
export function verifyCommand(io: Io, opts: { db?: string }): number {
  const journal = openJournal(io.env, opts.db);
  try {
    const r = journal.verify();
    if (r.ok) io.out(`journal ok: ${r.checked} event(s), hash chain intact\n`);
    else
      io.err(`journal TAMPERED: chain breaks at event #${r.brokenAt} (after ${r.checked} valid)\n`);
    return r.ok ? 0 : 3;
  } finally {
    journal.close();
  }
}
