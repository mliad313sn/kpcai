import { createInterface } from 'node:readline/promises';
import type { Env } from '@kernelpai/providers';

/** Everything the CLI touches in the outside world, injectable for tests. */
export interface Io {
  out(text: string): void;
  err(text: string): void;
  env: Env;
  cwd: string;
  confirm(question: string): Promise<boolean>;
  /** Registers a Ctrl+C handler; returns an unregister function. */
  onInterrupt(handler: () => void): () => void;
}

export function processIo(): Io {
  return {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
    env: process.env,
    cwd: process.cwd(),
    confirm: async (question) => {
      if (!process.stdin.isTTY) return false;
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await rl.question(`${question} [y/N] `);
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        rl.close();
      }
    },
    onInterrupt: (handler) => {
      process.on('SIGINT', handler);
      return () => process.off('SIGINT', handler);
    },
  };
}
