import { spawn } from 'node:child_process';

/** Most bytes kept of each of stdout and stderr; the rest is dropped (hostile output). */
export const MAX_STREAM_BYTES = 1_048_576;

export interface SpawnRequest {
  binary: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  /** True when output went past `MAX_STREAM_BYTES` and was cut. */
  truncated: boolean;
  /** The binary could not be started (not installed, not executable). */
  spawnError?: string;
  durationMs: number;
}

/** Collects at most `MAX_STREAM_BYTES` of a stream. */
class Capped {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  push(b: Buffer): void {
    const room = MAX_STREAM_BYTES - this.size;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    const kept = b.length > room ? b.subarray(0, room) : b;
    if (kept.length < b.length) this.truncated = true;
    this.chunks.push(kept);
    this.size += kept.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/** Kills the child's whole process group (POSIX), else the child alone. */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL');
    else process.kill(pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/**
 * Runs a binary without a shell, in `cwd`, with exactly `env`. The timeout and the signal
 * kill its whole process group, so a CLI that forks helpers cannot outlive its budget.
 */
export function runProcess(req: SpawnRequest): Promise<SpawnResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const out = new Capped();
    const err = new Capped();
    let timedOut = false;
    let cancelled = false;
    const child = spawn(req.binary, [...req.args], {
      cwd: req.cwd,
      env: req.env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, req.timeoutMs);
    const onAbort = (): void => {
      cancelled = true;
      killTree(child.pid);
    };
    req.signal?.addEventListener('abort', onAbort, { once: true });
    if (req.signal?.aborted) onAbort();
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.stdin.on('error', () => undefined);
    child.stdin.end(req.stdin ?? '');
    const done = (exitCode: number | null, spawnError?: string): void => {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
      resolve({
        stdout: out.text(),
        stderr: err.text(),
        exitCode,
        timedOut,
        cancelled,
        truncated: out.truncated || err.truncated,
        ...(spawnError !== undefined ? { spawnError } : {}),
        durationMs: Date.now() - started,
      });
    };
    // Helpers the CLI left behind die with it (they would hold the pipes open).
    child.on('exit', () => killTree(child.pid));
    child.on('error', (e) => done(null, e.message));
    child.on('close', (code) => done(code));
  });
}
