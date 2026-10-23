/** Journal event types (spec §5.2): routing, call, tool, intervention, plus outcome records. */
export const EVENT_TYPES = [
  'routing',
  'call',
  'response',
  'tool',
  'intervention',
  'error',
] as const;
export type JournalEventType = (typeof EVENT_TYPES)[number];

export interface JournalEventInput {
  sessionId: string;
  type: JournalEventType;
  nodeId?: string;
  provider?: string;
  model?: string;
  payload: Record<string, unknown>;
  costUsd?: number;
}

export interface JournalEvent extends Required<
  Omit<JournalEventInput, 'nodeId' | 'provider' | 'model' | 'costUsd'>
> {
  seq: number;
  id: string;
  ts: string;
  nodeId: string | null;
  provider: string | null;
  model: string | null;
  costUsd: number | null;
  prevHash: string;
  hash: string;
}

export interface SessionRow {
  id: string;
  createdAt: string;
  title: string;
  cwd: string;
  eventCount: number;
  costUsd: number;
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  /** Sequence number of the first event whose hash does not match. */
  brokenAt?: number;
}

/** Filter for `Journal.spend`; all given fields must match (AND). */
export interface SpendFilter {
  sessionId?: string;
  /** Project key: the session's working directory (`sessions.cwd`). */
  project?: string;
  /** Only events at or after this instant (inclusive). */
  since?: Date;
  /** Only events strictly before this instant (exclusive). */
  until?: Date;
}
