/**
 * `$KPAI_HOME/server.json`: how local clients (TUI, desktop shell, `kpai`) find the running
 * kernel server and its token. Readable by the owner only (mode 0600; on Windows the file
 * inherits the user profile's ACL).
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const ServerFileSchema = z.object({
  protocol: z.number().int(),
  url: z.string(),
  port: z.number().int(),
  pid: z.number().int(),
  token: z.string(),
  startedAt: z.string(),
});
export type ServerFile = z.infer<typeof ServerFileSchema>;

export function serverFilePath(home: string): string {
  return join(home, 'server.json');
}

/** Written to a private temporary file then renamed, so it is never readable by others. */
export function writeServerFile(home: string, info: ServerFile): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = serverFilePath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return path;
}

export function readServerFile(home: string): ServerFile | undefined {
  try {
    const r = ServerFileSchema.safeParse(JSON.parse(readFileSync(serverFilePath(home), 'utf8')));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

/** Removes the file only if it still describes this server (another may have started). */
export function removeServerFile(home: string, token: string): void {
  if (readServerFile(home)?.token === token) rmSync(serverFilePath(home), { force: true });
}
