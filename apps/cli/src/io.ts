import { createInterface } from 'node:readline/promises';
import { serialized, type Env } from '@kernelpai/kernel';
import { isYes, t } from './i18n/core.js';

/** Confirmations are asked one at a time (review P2-F7); see the kernel's `serialized`. */
export { serialized };

/** Everything the CLI touches in the outside world, injectable for tests. */
export interface Io {
  out(text: string): void;
  err(text: string): void;
  env: Env;
  cwd: string;
  /** True when stdout is a terminal (stream live); false when piped (print final answer only). */
  stdoutIsTTY: boolean;
  confirm(question: string): Promise<boolean>;
  /** Registers a Ctrl+C handler; returns an unregister function. */
  onInterrupt(handler: () => void): () => void;
}

/**
 * One SIGINT listener for the whole process. While a call is in flight its handler runs
 * (cancel, keep partial output); at any other moment Ctrl+C exits cleanly with 130, so an
 * interrupt is never lost to a race with start-up or shutdown.
 */
function interruptBus(): Io['onInterrupt'] {
  const handlers: Array<() => void> = [];
  process.on('SIGINT', () => {
    const top = handlers.at(-1);
    if (top) top();
    else process.exit(130);
  });
  return (handler) => {
    handlers.push(handler);
    return () => {
      const i = handlers.lastIndexOf(handler);
      if (i >= 0) handlers.splice(i, 1);
    };
  };
}

export function processIo(): Io {
  const onInterrupt = interruptBus();
  return {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
    env: process.env,
    cwd: process.cwd(),
    stdoutIsTTY: process.stdout.isTTY === true,
    confirm: serialized(async (question) => {
      if (!process.stdin.isTTY) return false;
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        // The question is the kernel's text, shown as is; the prompt around it is localised.
        const answer = await rl.question(t('confirm.prompt', { question }));
        return isYes(answer);
      } catch (err) {
        // Ctrl+C at a prompt is an interrupt like any other: exit 130 (review N5).
        if (err instanceof Error && err.name === 'AbortError') process.exit(130);
        throw err;
      } finally {
        rl.close();
      }
    }),
    onInterrupt,
  };
}
