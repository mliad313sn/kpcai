import { Kernel, KernelError } from '@kernelpai/kernel';
import { money } from '../config.js';
import { kernelHost } from '../host.js';
import { t } from '../i18n/core.js';
import type { Io } from '../io.js';
import { renderMetrics } from '../render.js';
import { renderAccuracy, renderCompetence } from './learning.js';
import { renderProductivity } from './productivity.js';

export interface StatsCliOptions {
  db?: string | undefined;
  session?: string | undefined;
  /** R-406: the productivity block, after the accuracy block. */
  productivity?: boolean | undefined;
  /** Productivity of the runs started since this instant (ISO 8601). */
  since?: string | undefined;
}

/** `kpai stats [--session id] [--productivity [--since date]]`: metrics from the journal. */
export async function statsCommand(io: Io, opts: StatsCliOptions): Promise<number> {
  const kernel = new Kernel(kernelHost(io, opts.db ? { db: opts.db } : {}));
  try {
    const m = money(io.env);
    io.out(renderMetrics(kernel.stats(opts.session), m));
    // R-402 and ADR-0028: for this workspace, whatever the session filter.
    io.out(renderAccuracy(kernel.learning.accuracy(), m));
    if (opts.productivity || opts.since !== undefined) {
      const since = opts.since !== undefined ? { since: opts.since } : {};
      io.out(renderProductivity(kernel.learning.productivity(since), m));
    }
    io.out(renderCompetence(kernel.learning.competence()));
    return 0;
  } catch (err) {
    if (err instanceof KernelError && err.code === 'invalid') {
      io.err(`${t('error.productivityInvalid', { message: err.message })}\n`);
      return 2;
    }
    if (!(err instanceof KernelError && err.code === 'not_found')) throw err;
    io.err(`${err.message}\n`);
    return 1;
  } finally {
    await kernel.close();
  }
}
