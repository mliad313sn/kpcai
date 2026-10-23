/**
 * `kpai serve --headless` (R-5E4, R-507, ADR-0035): the kernel server with no UI, bound to
 * 127.0.0.1, running the Enterprise daemon so approved programs keep going with no client
 * attached. It survives restarts: programs, queue and questions live under $KPAI_HOME; a
 * run cut by a restart is settled and planned again within the envelope. Ctrl+C stops it.
 */
import { startServer } from '@kernelpai/server';
import type { Io } from '../io.js';

export interface ServeOptions {
  port?: number | undefined;
  db?: string | undefined;
  allowTest?: boolean | undefined;
}

export async function serveCommand(io: Io, o: ServeOptions): Promise<number> {
  const server = await startServer({
    kernel: { env: io.env, cwd: io.cwd, ...(o.db ? { db: o.db } : {}) },
    headless: true,
    enterprise: { daemon: true },
    ...(o.port !== undefined ? { port: o.port } : {}),
    ...(o.allowTest ? { defaults: { allowTest: true } } : {}),
  });
  io.out(`KernelPAI daemon on ${server.url} (headless; token in $KPAI_HOME/server.json)\n`);
  io.err(
    `heartbeat: ${server.url}/enterprise/heartbeat · kpai program heartbeat --check · Ctrl+C to stop\n`,
  );
  await new Promise<void>((resolve) => {
    const unregister = io.onInterrupt(() => {
      unregister();
      resolve();
    });
  });
  await server.close();
  io.err('daemon stopped\n');
  return 0;
}
