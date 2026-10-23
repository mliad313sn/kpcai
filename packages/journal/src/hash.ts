import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

/** Fields covered by the tamper-evident hash chain, in a fixed order. */
export interface HashedFields {
  id: string;
  sessionId: string;
  ts: string;
  nodeId: string | null;
  provider: string | null;
  model: string | null;
  type: string;
  payload: string;
  costUsd: number | null;
}

export function eventHash(prevHash: string, f: HashedFields): string {
  const canonical = JSON.stringify([
    prevHash,
    f.id,
    f.sessionId,
    f.ts,
    f.nodeId,
    f.provider,
    f.model,
    f.type,
    f.payload,
    f.costUsd,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}
