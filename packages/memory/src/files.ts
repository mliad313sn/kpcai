/** Where memory lives under `$KPAI_HOME` (outside every tool jail), and safe file writes. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MemoryError, type MemoryScope } from './types.js';

const SESSION_RE = /^[A-Za-z0-9_-]{1,100}$/;

/** Short stable key of a repository (its real path): `$KPAI_HOME/projects/<key>/`. */
export function repoHash(repo: string): string {
  return createHash('sha256').update(repo).digest('hex').slice(0, 16);
}

export function memoryFile(home: string, scope: MemoryScope): string {
  if (scope.layer === 'user') return join(home, 'memory', 'user.md');
  if (scope.layer === 'project') return join(home, 'projects', repoHash(scope.repo), 'memory.md');
  if (!SESSION_RE.test(scope.sessionId))
    throw new MemoryError('invalid', 'a session id is letters, digits, "-" and "_"');
  return join(home, 'memory', 'sessions', `${scope.sessionId}.md`);
}

export function pendingFile(home: string): string {
  return join(home, 'memory', 'pending.json');
}

/** The file's text, or undefined when it does not exist. */
export async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Write to a temporary file then rename: a crash never leaves half a memory file. */
export async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, file);
}

/** Runs `fn` after every earlier call for the same key has settled (read-modify-write). */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
