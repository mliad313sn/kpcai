/**
 * The Enterprise store under `$KPAI_HOME` (ADR-0035, R-507): one folder per program with its
 * state (`state.json`), a hash-chained log of every transition, accepted or refused
 * (`events.jsonl`), the runtime's bookkeeping (`meta.json`) and its reports; plus the
 * portfolio's durable queue, settings, activity feed and heartbeat under `enterprise/`.
 * Files are written to a private temporary file and renamed: a crash never leaves half a
 * state. Mutations happen inside `locked`, one writer at a time across processes.
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  ProgramStateSchema,
  QueueSchema,
  transition,
  type MachineActor,
  type ProgramState,
  type Queue,
  type Transition,
} from '@kernelpai/program';
import { configFrom, type EnterpriseConfig } from './config.js';
import { withLock } from './lock.js';
import { ProgramMetaSchema, type ProgramMeta } from './meta.js';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface ProgramRecord {
  state: ProgramState;
  meta: ProgramMeta;
}

export function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export class EnterpriseStore {
  readonly programsDir: string;
  readonly dir: string;

  constructor(readonly home: string) {
    this.programsDir = join(home, 'programs');
    this.dir = join(home, 'enterprise');
    mkdirSync(this.programsDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  /** One read-modify-write at a time (this process and others). Never nest. */
  locked<T>(fn: () => T | Promise<T>): Promise<T> {
    return withLock(join(this.dir, '.lock'), fn);
  }

  ids(): string[] {
    return readdirSync(this.programsDir, { withFileTypes: true })
      .filter(
        (d) => d.isDirectory() && ID.test(d.name) && existsSync(this.file(d.name, 'state.json')),
      )
      .map((d) => d.name)
      .sort();
  }

  has(id: string): boolean {
    return ID.test(id) && existsSync(this.file(id, 'state.json'));
  }

  file(id: string, name: string): string {
    if (!ID.test(id)) throw new Error(`not a program id: ${id.slice(0, 80)}`);
    return join(this.programsDir, id, name);
  }

  read(id: string): ProgramRecord {
    const state = ProgramStateSchema.parse(readJson(this.file(id, 'state.json')));
    const metaPath = this.file(id, 'meta.json');
    const meta = ProgramMetaSchema.parse(existsSync(metaPath) ? readJson(metaPath) : {});
    return { state, meta };
  }

  /** A new program folder; refuses an id already used. */
  create(id: string, rec: ProgramRecord): void {
    if (this.has(id)) throw new Error(`program ${id} exists`);
    mkdirSync(join(this.programsDir, id, 'reports'), { recursive: true, mode: 0o700 });
    this.writeMeta(id, rec.meta);
    this.writeState(id, rec.state);
    this.log(id, { actor: 'po', type: 'created', ok: true });
  }

  writeState(id: string, s: ProgramState): void {
    writeAtomic(
      this.file(id, 'state.json'),
      `${JSON.stringify(ProgramStateSchema.parse(s), null, 2)}\n`,
    );
  }

  writeMeta(id: string, m: ProgramMeta): void {
    writeAtomic(
      this.file(id, 'meta.json'),
      `${JSON.stringify(ProgramMetaSchema.parse(m), null, 2)}\n`,
    );
  }

  updateMeta(id: string, fn: (m: ProgramMeta) => void): ProgramMeta {
    const { meta } = this.read(id);
    fn(meta);
    this.writeMeta(id, meta);
    return meta;
  }

  /**
   * Applies one event through the pure machine, persists the new state and logs the
   * attempt (refusals too). Call inside `locked`.
   */
  applyLocked(id: string, event: unknown, actor: MachineActor, now: Date): Transition {
    const { state } = this.read(id);
    const t = transition(state, event, actor, now);
    const type = (event as { type?: unknown } | null)?.type;
    if (t.ok) this.writeState(id, t.state);
    this.log(id, {
      actor,
      type: typeof type === 'string' ? type.slice(0, 40) : 'invalid',
      ok: t.ok,
      ...(t.ok ? { event } : { reason: t.reason.slice(0, 500) }),
    });
    return t;
  }

  apply(id: string, event: unknown, actor: MachineActor, now: Date): Promise<Transition> {
    return this.locked(() => this.applyLocked(id, event, actor, now));
  }

  /** Appends to the program's transition log; each line chains the previous line's hash. */
  log(id: string, entry: Record<string, unknown>): void {
    const path = this.file(id, 'events.jsonl');
    const prev = existsSync(path) ? lastHash(readFileSync(path, 'utf8')) : '';
    const body = JSON.stringify({ at: new Date().toISOString(), ...entry, prev });
    const hash = createHash('sha256').update(body).digest('hex');
    appendFileSync(path, `${JSON.stringify({ ...JSON.parse(body), hash })}\n`, { mode: 0o600 });
  }

  /** The log's lines, with whether every hash still chains (tamper evidence). */
  history(id: string): { entries: Array<Record<string, unknown>>; ok: boolean } {
    const path = this.file(id, 'events.jsonl');
    if (!existsSync(path)) return { entries: [], ok: true };
    const entries = readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    let prev = '';
    let ok = true;
    for (const e of entries) {
      const { hash, ...rest } = e;
      const want = createHash('sha256').update(JSON.stringify(rest)).digest('hex');
      if (e['prev'] !== prev || hash !== want) ok = false;
      prev = String(hash);
    }
    return { entries, ok };
  }

  queue(): Queue {
    const path = join(this.dir, 'queue.json');
    return QueueSchema.parse(existsSync(path) ? readJson(path) : {});
  }

  saveQueue(q: Queue): void {
    writeAtomic(join(this.dir, 'queue.json'), `${JSON.stringify(QueueSchema.parse(q), null, 2)}\n`);
  }

  config(): EnterpriseConfig {
    const path = join(this.dir, 'portfolio.json');
    return configFrom(existsSync(path) ? readJson(path) : {});
  }

  saveConfig(c: EnterpriseConfig): void {
    writeAtomic(join(this.dir, 'portfolio.json'), `${JSON.stringify(c, null, 2)}\n`);
  }

  path(name: string): string {
    return join(this.dir, name);
  }
}

function lastHash(text: string): string {
  const line = text.trimEnd().split('\n').at(-1);
  if (!line) return '';
  try {
    return String((JSON.parse(line) as { hash?: unknown }).hash ?? '');
  } catch {
    return '';
  }
}
