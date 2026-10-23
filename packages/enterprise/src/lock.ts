/**
 * One writer at a time on the Enterprise store, across processes (`kpai program answer`
 * while `kpai serve --headless` runs) and inside one process. A lock file created with
 * O_EXCL holds the owner's pid; a lock whose owner is gone, or older than `staleMs`, is
 * taken over. Locks are held for a read-modify-write only, never across a kernel call.
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const chains = new Map<string, Promise<unknown>>();

export interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True when the lock file's owner is gone or the lock is older than `staleMs`. */
function stale(path: string, staleMs: number): boolean {
  try {
    const pid = Number(readFileSync(path, 'utf8').trim());
    if (!alive(pid)) return true;
    return Date.now() - statSync(path).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

function tryCreate(path: string): boolean {
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

async function acquire(path: string, o: Required<LockOptions>): Promise<void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const until = Date.now() + o.timeoutMs;
  for (;;) {
    if (tryCreate(path)) return;
    if (stale(path, o.staleMs)) {
      rmSync(path, { force: true });
      continue;
    }
    if (Date.now() > until) throw new Error(`the Enterprise store is locked (${path})`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Runs `fn` holding the lock at `path`; calls in this process queue up in order. */
export function withLock<T>(
  path: string,
  fn: () => T | Promise<T>,
  o: LockOptions = {},
): Promise<T> {
  const opts = { timeoutMs: o.timeoutMs ?? 30_000, staleMs: o.staleMs ?? 120_000 };
  const prev = chains.get(path) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await acquire(path, opts);
      try {
        return await fn();
      } finally {
        rmSync(path, { force: true });
      }
    });
  chains.set(path, next);
  void next
    .finally(() => {
      if (chains.get(path) === next) chains.delete(path);
    })
    .catch(() => undefined);
  return next;
}
