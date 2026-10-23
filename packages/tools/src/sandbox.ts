import { scrubEnv, type Env } from './env.js';

/**
 * How `shell.run` is isolated, recorded in every `tool` journal event.
 * - `sandbox-runtime`: OS sandbox (`@anthropic-ai/sandbox-runtime`: bubblewrap on
 *   Linux, seatbelt on macOS). Not wired yet: no adapter is registered by default.
 * - `scrubbed`: no OS isolation; cwd = root, scrubbed env, timeout, output cap,
 *   and every call is confirmed (macOS/Linux fallback).
 * - `confirm-only`: Windows; same limits, every call confirmed.
 */
export type SandboxMode = 'sandbox-runtime' | 'scrubbed' | 'confirm-only';

export interface SandboxedCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

/** Per-OS shell isolation behind one interface, so a real sandbox can be enabled later. */
export interface ShellSandbox {
  readonly mode: SandboxMode;
  /** True only when the OS confines the process; otherwise every call is confirmed. */
  readonly isolating: boolean;
  prepare(cmd: {
    command: string;
    args: readonly string[];
    cwd: string;
    env: Env;
  }): SandboxedCommand;
}

class FallbackSandbox implements ShellSandbox {
  readonly isolating = false;
  constructor(readonly mode: SandboxMode) {}

  prepare(cmd: {
    command: string;
    args: readonly string[];
    cwd: string;
    env: Env;
  }): SandboxedCommand {
    return { command: cmd.command, args: [...cmd.args], env: scrubEnv(cmd.env), cwd: cmd.cwd };
  }
}

/**
 * Picks the shell sandbox for this OS. `@anthropic-ai/sandbox-runtime` is not a
 * dependency yet (it needs bubblewrap on Linux, absent from the dev container,
 * and could not be shown to work here), so macOS/Linux use `scrubbed` and
 * Windows `confirm-only`. A caller may inject an isolating adapter.
 */
export function detectSandbox(platform: NodeJS.Platform = process.platform): ShellSandbox {
  return new FallbackSandbox(platform === 'win32' ? 'confirm-only' : 'scrubbed');
}
