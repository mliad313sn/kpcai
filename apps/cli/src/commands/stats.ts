import { Kernel, KernelError } from '@kernelpai/kernel';
import { money } from '../config.js';
import { kernelHost } from '../host.js';
import type { Io } from '../io.js';
import { renderMetrics } from '../render.js';
import { renderAccuracy, renderCompetence } from './learning.js';

/** `kpai stats [--session id]`: phase metrics computed from the journal. */
export async function statsCommand(
  io: Io,
  opts: { db?: string; session?: string },
): Promise<number> {
  const kernel = new Kernel(kernelHost(io, opts.db ? { db: opts.db } : {}));
  try {
    const m = money(io.env);
    io.out(renderMetrics(kernel.stats(opts.session), m));
    // R-402 and ADR-0028: for this workspace, whatever the session filter.
    io.out(renderAccuracy(kernel.learning.accuracy(), m));
    io.out(renderCompetence(kernel.learning.competence()));
    return 0;
  } catch (err) {
    if (!(err instanceof KernelError && err.code === 'not_found')) throw err;
    io.err(`${err.message}\n`);
    return 1;
  } finally {
    await kernel.close();
  }
}
