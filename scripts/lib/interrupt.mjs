import { spawn } from 'node:child_process';

/**
 * Runs the CLI and sends Ctrl+C (SIGINT) `afterMs` after it first prints anything (plan on
 * stderr, or answer on stdout), instead of a fixed delay from spawn that raced start-up on
 * slow CI runners. Resolves with the exit code (null if killed by the signal).
 */
export function runAndInterrupt(bin, args, env, { timeoutMs = 15_000, afterMs = 250 } = {}) {
  const child = spawn(process.execPath, [bin, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let sent = false;
  const forward = (sink) => (chunk) => {
    sink.write(chunk);
    if (sent) return;
    sent = true;
    setTimeout(() => child.kill('SIGINT'), afterMs);
  };
  child.stdout.on('data', forward(process.stdout));
  child.stderr.on('data', forward(process.stderr));
  const guard = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  return new Promise((resolve) =>
    child.on('exit', (code) => {
      clearTimeout(guard);
      resolve(code);
    }),
  );
}
