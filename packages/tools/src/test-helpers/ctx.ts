import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolCall, ToolContext } from '@kernelpai/core';
import type { JournalEventInput } from '@kernelpai/journal';

export interface TestCtx extends ToolContext {
  questions: string[];
}

/** A ToolContext whose confirm() answers from `answers` (default: always no). */
export function makeCtx(
  root: string,
  opts: Partial<ToolContext> & { answers?: boolean[] } = {},
): TestCtx {
  const questions: string[] = [];
  const answers = [...(opts.answers ?? [])];
  return {
    model: opts.model ?? { provider: 'mock', model: 'm1' },
    root,
    sessionId: opts.sessionId ?? 's1',
    nodeId: opts.nodeId ?? 'n1',
    signal: opts.signal,
    questions,
    confirm:
      opts.confirm ??
      (async (q: string) => {
        questions.push(q);
        return answers.length > 0 ? (answers.shift() as boolean) : false;
      }),
  };
}

let seq = 0;
export function call(name: string, input: unknown): ToolCall {
  seq += 1;
  return { id: `c${seq}`, name, input };
}

export async function tempDir(
  prefix = 'kpai-tools-',
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export class RecordingJournal {
  readonly events: JournalEventInput[] = [];
  append(e: JournalEventInput): void {
    this.events.push(e);
  }
  last(): JournalEventInput {
    const e = this.events.at(-1);
    if (!e) throw new Error('no journal event');
    return e;
  }
}
