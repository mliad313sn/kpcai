import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface RunSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Total bytes kept from stdout + stderr; the process is killed past it. */
  maxOutputBytes: number;
  stdin?: string;
  signal?: AbortSignal;
  /** Keep stdout as raw bytes in `stdoutBytes` (blob contents); `stdout` stays empty. */
  binary?: boolean;
}

export interface RunResult {
  /** Exit code, or null when killed by a signal / never started. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Raw stdout when the spec asked for `binary`. */
  stdoutBytes?: Buffer;
  timedOut: boolean;
  truncated: boolean;
  aborted: boolean;
  /** Spawn failure (e.g. command not found). */
  error?: string;
  durationMs: number;
}

const isWindows = process.platform === 'win32';

function killTree(child: ChildProcessWithoutNullStreams): void {
  // POSIX: the child leads its own process group, so grandchildren die too.
  if (!isWindows && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // fall through to a plain kill
    }
  }
  child.kill('SIGKILL');
}

function emptyResult(): RunResult {
  return {
    code: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    truncated: false,
    aborted: false,
    durationMs: 0,
  };
}

/** Keeps output up to the cap; past it, marks the result truncated and kills the process. */
function capture(
  child: ChildProcessWithoutNullStreams,
  res: RunResult,
  max: number,
  binary = false,
): void {
  let kept = 0;
  const bytes: Buffer[] = [];
  const collect = (key: 'stdout' | 'stderr') => (chunk: Buffer) => {
    const room = max - kept;
    if (room <= 0) return;
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    kept += part.length;
    if (binary && key === 'stdout') {
      bytes.push(part);
    } else res[key] += part.toString('utf8');
    if (chunk.length > room) {
      res.truncated = true;
      killTree(child);
    }
  };
  child.stdout.on('data', collect('stdout'));
  // 'close' (which resolves the run) fires only after stdout has ended.
  if (binary) child.stdout.on('end', () => (res.stdoutBytes = Buffer.concat(bytes)));
  child.stderr.on('data', collect('stderr'));
}

/**
 * Runs a program with an argument array (never through a shell), a timeout and
 * an output cap. Never rejects: failures are reported in the result.
 */
export function runProcess(spec: RunSpec): Promise<RunResult> {
  const started = Date.now();
  const res = emptyResult();
  if (spec.signal?.aborted) return Promise.resolve({ ...res, aborted: true, error: 'aborted' });
  return new Promise((resolve) => {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      windowsHide: true,
      detached: !isWindows,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    capture(child, res, spec.maxOutputBytes, spec.binary);
    if (spec.binary) res.stdoutBytes = Buffer.alloc(0);
    const timer = setTimeout(() => {
      res.timedOut = true;
      killTree(child);
    }, spec.timeoutMs);
    const onAbort = (): void => {
      res.aborted = true;
      killTree(child);
    };
    spec.signal?.addEventListener('abort', onAbort, { once: true });
    let done = false;
    const finish = (extra: Partial<RunResult>): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      spec.signal?.removeEventListener('abort', onAbort);
      resolve({ ...res, ...extra, durationMs: Date.now() - started });
    };
    child.on('error', (err) => finish({ error: err.message }));
    child.on('close', (code) => finish({ code }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(spec.stdin ?? '');
  });
}
