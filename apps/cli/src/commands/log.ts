import { writeFileSync } from 'node:fs';
import { Kernel, KernelError } from '@kernelpai/kernel';
import { kernelHost } from '../host.js';
import type { Io } from '../io.js';

export interface LogOptions {
  db?: string;
  session?: string;
  limit?: number;
}

/** Runs `f` on a kernel over the journal; an unknown session prints its message, exit 1. */
async function withKernel(
  io: Io,
  db: string | undefined,
  f: (k: Kernel) => number,
): Promise<number> {
  const kernel = new Kernel(kernelHost(io, db ? { db } : {}));
  try {
    return f(kernel);
  } catch (err) {
    if (!(err instanceof KernelError && err.code === 'not_found')) throw err;
    io.err(`${err.message}\n`);
    return 1;
  } finally {
    await kernel.close();
  }
}

/** `kpai log`: list sessions, or the events of one session. */
export function logCommand(io: Io, opts: LogOptions): Promise<number> {
  return withKernel(io, opts.db, (k) => {
    if (!opts.session) {
      for (const s of k.sessions(opts.limit ?? 20)) {
        io.out(
          `${s.id.slice(0, 8)}  ${s.createdAt}  ${String(s.eventCount).padStart(3)} ev  $${s.costUsd.toFixed(6)}  ${s.title}\n`,
        );
      }
      return 0;
    }
    for (const e of k.events(opts.session, opts.limit ?? 1000)) {
      const who = e.provider ? ` ${e.provider}/${e.model}` : '';
      io.out(`#${e.seq} ${e.ts} ${e.type.padEnd(12)}${who} ${JSON.stringify(e.payload)}\n`);
    }
    return 0;
  });
}

/** `kpai export <session>`: Markdown export of a session. */
export function exportCommand(
  io: Io,
  opts: { db?: string; session: string; out?: string },
): Promise<number> {
  return withKernel(io, opts.db, (k) => {
    const md = k.exportMarkdown(opts.session);
    if (opts.out) writeFileSync(opts.out, md, 'utf8');
    else io.out(md);
    return 0;
  });
}

/** `kpai verify`: checks the journal hash chain. */
export function verifyCommand(io: Io, opts: { db?: string }): Promise<number> {
  return withKernel(io, opts.db, (k) => {
    const r = k.verify();
    if (r.ok) io.out(`journal ok: ${r.checked} event(s), hash chain intact\n`);
    else
      io.err(`journal TAMPERED: chain breaks at event #${r.brokenAt} (after ${r.checked} valid)\n`);
    return r.ok ? 0 : 3;
  });
}
