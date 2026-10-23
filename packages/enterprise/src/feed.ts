/**
 * The activity feed and the `enterprise.*` stream (design §14.2). Every notification has a
 * monotonic `seq`; activity lines are kept in `enterprise/activity.jsonl` so a client (or
 * a restarted daemon) resumes with `since`. Lines are written by the runtime from typed
 * facts ("wp1 started on mock-beta, band top $0.12"), never copied from model output.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { Ref } from './meta.js';

export type Emit = (name: string, params: Record<string, unknown>) => void;

export interface Activity {
  seq: number;
  at: string;
  programId?: string;
  text: string;
  refs: Ref[];
}

const KEEP = 2_000;

export class Feed {
  private items: Activity[] = [];
  private seqNo = 0;

  constructor(
    private readonly path: string,
    private readonly emit: Emit = () => undefined,
  ) {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, 'utf8').split('\n').slice(-KEEP)) {
      try {
        const a = JSON.parse(line) as Activity;
        if (typeof a.seq === 'number') this.items.push(a);
      } catch {
        // A torn last line after a crash is skipped.
      }
    }
    this.seqNo = this.items.at(-1)?.seq ?? 0;
  }

  get seq(): number {
    return this.seqNo;
  }

  /** A notification with the next sequence number. */
  notify(name: string, params: Record<string, unknown>): void {
    this.seqNo += 1;
    this.emit(name, { ...params, seq: this.seqNo });
  }

  /** One plain-language line, persisted and streamed. */
  line(text: string, programId?: string, refs: Ref[] = [], at = new Date()): Activity {
    this.seqNo += 1;
    const a: Activity = {
      seq: this.seqNo,
      at: at.toISOString(),
      ...(programId ? { programId } : {}),
      text: text.slice(0, 1_000),
      refs,
    };
    this.items.push(a);
    if (this.items.length > KEEP) this.items.splice(0, this.items.length - KEEP);
    appendFileSync(this.path, `${JSON.stringify(a)}\n`, { mode: 0o600 });
    this.emit('enterprise.activity', { ...a });
    return a;
  }

  since(seq = 0, limit = 200): Activity[] {
    return this.items.filter((a) => a.seq > seq).slice(0, limit);
  }
}
