import { metrics } from '@kernelpai/executor';
import { money } from '../config.js';
import { openJournal } from '../context.js';
import type { Io } from '../io.js';
import { renderMetrics } from '../render.js';

/** `kpai stats [--session id]`: phase metrics computed from the journal. */
export function statsCommand(io: Io, opts: { db?: string; session?: string }): number {
  const journal = openJournal(io.env, opts.db);
  try {
    let sessionId: string | undefined;
    if (opts.session) {
      sessionId = journal.findSession(opts.session)?.id;
      if (!sessionId) {
        io.err(`No session starting with "${opts.session}"\n`);
        return 1;
      }
    }
    io.out(renderMetrics(metrics(journal, sessionId ? { sessionId } : {}), money(io.env)));
    return 0;
  } finally {
    journal.close();
  }
}
