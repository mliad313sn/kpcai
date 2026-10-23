import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GENESIS_HASH, eventHash } from './hash.js';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js';
import {
  EVENT_TYPES,
  type JournalEvent,
  type JournalEventInput,
  type SessionRow,
  type SpendFilter,
  type VerifyResult,
} from './types.js';

interface EventRow {
  seq: number;
  id: string;
  session_id: string;
  ts: string;
  node_id: string | null;
  provider: string | null;
  model: string | null;
  type: string;
  payload: string;
  cost_usd: number | null;
  prev_hash: string;
  hash: string;
}

function toEvent(r: EventRow): JournalEvent {
  return {
    seq: r.seq,
    id: r.id,
    sessionId: r.session_id,
    ts: r.ts,
    nodeId: r.node_id,
    provider: r.provider,
    model: r.model,
    type: r.type as JournalEvent['type'],
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    costUsd: r.cost_usd,
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}

/** Append-only, hash-chained session journal stored in a local SQLite file. */
export class Journal {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  private constructor(db: DatabaseSync, now: () => Date) {
    this.db = db;
    this.now = now;
  }

  static open(path: string, options: { now?: () => Date } = {}): Journal {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    for (let i = version; i < MIGRATIONS.length; i++) db.exec(MIGRATIONS[i] as string);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return new Journal(db, options.now ?? (() => new Date()));
  }

  startSession(title: string, cwd: string): string {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO sessions (id, created_at, title, cwd) VALUES (?, ?, ?, ?)')
      .run(id, this.now().toISOString(), title.slice(0, 200), cwd);
    return id;
  }

  append(input: JournalEventInput): JournalEvent {
    if (!EVENT_TYPES.includes(input.type)) throw new Error(`Unknown event type ${input.type}`);
    const last = this.db.prepare('SELECT hash FROM events ORDER BY seq DESC LIMIT 1').get() as
      { hash: string } | undefined;
    const fields = {
      id: randomUUID(),
      sessionId: input.sessionId,
      ts: this.now().toISOString(),
      nodeId: input.nodeId ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      type: input.type,
      payload: JSON.stringify(input.payload),
      costUsd: input.costUsd ?? null,
    };
    const prevHash = last?.hash ?? GENESIS_HASH;
    const hash = eventHash(prevHash, fields);
    const res = this.db
      .prepare(
        `INSERT INTO events (id, session_id, ts, node_id, provider, model, type, payload, cost_usd, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fields.id,
        fields.sessionId,
        fields.ts,
        fields.nodeId,
        fields.provider,
        fields.model,
        fields.type,
        fields.payload,
        fields.costUsd,
        prevHash,
        hash,
      );
    return {
      ...fields,
      seq: Number(res.lastInsertRowid),
      type: input.type,
      payload: input.payload,
      prevHash,
      hash,
    };
  }

  events(options: { sessionId?: string; limit?: number } = {}): JournalEvent[] {
    const limit = Math.max(1, Math.min(options.limit ?? 1000, 100_000));
    const rows = options.sessionId
      ? this.db
          .prepare('SELECT * FROM events WHERE session_id = ? ORDER BY seq LIMIT ?')
          .all(options.sessionId, limit)
      : this.db.prepare('SELECT * FROM events ORDER BY seq DESC LIMIT ?').all(limit).reverse();
    return (rows as unknown as EventRow[]).map(toEvent);
  }

  sessions(limit = 20): SessionRow[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.created_at, s.title, s.cwd, COUNT(e.seq) AS n, COALESCE(SUM(e.cost_usd), 0) AS cost
         FROM sessions s LEFT JOIN events e ON e.session_id = s.id
         GROUP BY s.id ORDER BY s.created_at DESC, s.rowid DESC LIMIT ?`,
      )
      .all(limit) as unknown as Array<{
      id: string;
      created_at: string;
      title: string;
      cwd: string;
      n: number;
      cost: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      title: r.title,
      cwd: r.cwd,
      eventCount: r.n,
      costUsd: r.cost,
    }));
  }

  findSession(idPrefix: string): SessionRow | undefined {
    return this.sessions(100_000).find((s) => s.id.startsWith(idPrefix));
  }

  /** Sum of `cost_usd` over matching events, in USD (spec §3.4). */
  spend(filter: SpendFilter = {}): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(e.cost_usd), 0) AS total
         FROM events e JOIN sessions s ON s.id = e.session_id
         WHERE (?1 IS NULL OR e.session_id = ?1)
           AND (?2 IS NULL OR s.cwd = ?2)
           AND (?3 IS NULL OR e.ts >= ?3)`,
      )
      .get(
        filter.sessionId ?? null,
        filter.project ?? null,
        filter.since?.toISOString() ?? null,
      ) as {
      total: number;
    };
    return row.total;
  }

  /** Recomputes the whole hash chain; any edited or deleted row breaks it. */
  verify(): VerifyResult {
    const rows = this.db
      .prepare('SELECT * FROM events ORDER BY seq')
      .all() as unknown as EventRow[];
    let prev = GENESIS_HASH;
    for (const [i, r] of rows.entries()) {
      const expected = eventHash(prev, {
        id: r.id,
        sessionId: r.session_id,
        ts: r.ts,
        nodeId: r.node_id,
        provider: r.provider,
        model: r.model,
        type: r.type,
        payload: r.payload,
        costUsd: r.cost_usd,
      });
      if (r.prev_hash !== prev || r.hash !== expected) {
        return { ok: false, checked: i, brokenAt: r.seq };
      }
      prev = r.hash;
    }
    return { ok: true, checked: rows.length };
  }

  close(): void {
    this.db.close();
  }
}
