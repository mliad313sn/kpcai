import { fileURLToPath } from 'node:url';
import { workspaceVerdict } from '@kernelpai/kernel';
import { startServer } from '@kernelpai/server';
import type { Io } from '../io.js';

export interface StudioOptions {
  port?: number;
  db?: string;
  /** `--allow-test`: plans and runs may use offline mock providers unless a request says no. */
  allowTest?: boolean;
}

/** apps/studio/dist next to this CLI (same relative path from src/ and dist/). */
function defaultStaticDir(): string {
  return fileURLToPath(new URL('../../../studio/dist', import.meta.url));
}

/**
 * `kpai studio`: starts the kernel server for KP Studio on 127.0.0.1 and prints the URL to
 * open, token in the fragment. Runs until Ctrl+C. Extra allowed origins (a dev server, the
 * desktop shell) come from KPAI_STUDIO_ORIGINS, comma-separated.
 */
export async function studioCommand(io: Io, o: StudioOptions): Promise<number> {
  const verdict = await workspaceVerdict(io.cwd, io.env);
  if (!verdict.ok) io.err(`note: runs will be refused here — ${verdict.problem ?? ''}\n`);
  const origins = (io.env['KPAI_STUDIO_ORIGINS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const server = await startServer({
    kernel: { env: io.env, cwd: io.cwd, ...(o.db ? { db: o.db } : {}) },
    staticDir: io.env['KPAI_STUDIO_DIST']?.trim() || defaultStaticDir(),
    ...(o.port !== undefined ? { port: o.port } : {}),
    origins,
    ...(o.allowTest ? { defaults: { allowTest: true } } : {}),
  });
  io.out(`KP Studio: ${server.studioUrl}\n`);
  if (o.allowTest) io.err('test providers allowed (--allow-test): offline mocks may be routed\n');
  io.err(
    `kernel server on ${server.url} (token also in $KPAI_HOME/server.json) · Ctrl+C to stop\n`,
  );
  await new Promise<void>((resolve) => {
    const unregister = io.onInterrupt(() => {
      unregister();
      resolve();
    });
  });
  await server.close();
  io.err('kernel server stopped\n');
  return 0;
}
