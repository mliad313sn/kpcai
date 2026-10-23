import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Io } from '../io.js';

export interface FakeIo extends Io {
  stdout: string;
  stderr: string;
  home: string;
  interrupt(): void;
  confirmAnswers: boolean[];
  questions: string[];
}

export function fakeIo(env: Record<string, string> = {}): FakeIo {
  const home = mkdtempSync(join(tmpdir(), 'kpai-cli-'));
  let handler: (() => void) | undefined;
  const io: FakeIo = {
    stdout: '',
    stderr: '',
    home,
    confirmAnswers: [],
    questions: [],
    env: { KPAI_HOME: home, OLLAMA_HOST: 'http://127.0.0.1:9', ...env },
    cwd: '/work/repo',
    out: (t) => void (io.stdout += t),
    err: (t) => void (io.stderr += t),
    confirm: (q) => {
      io.questions.push(q);
      return Promise.resolve(io.confirmAnswers.shift() ?? false);
    },
    onInterrupt: (h) => {
      handler = h;
      return () => (handler = undefined);
    },
    interrupt: () => handler?.(),
  };
  return io;
}
