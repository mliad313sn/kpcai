/**
 * Unified memory (spec §3.1, ADR-0027): three layers of facts, each with its provenance.
 * Facts live in Markdown files a human can read and edit; model proposals wait in a
 * pending queue until a human confirms them.
 */

/** `session`: the current session; `project`: one repository; `user`: the person. */
export type Layer = 'user' | 'project' | 'session';
export const LAYERS: readonly Layer[] = ['user', 'project', 'session'];

/** Where a fact came from. */
export interface Provenance {
  /** `human`, or the model that proposed it as `provider/model`; `unknown` when lost. */
  source: string;
  /** Day the fact was written or proposed, `YYYY-MM-DD` (kept as written when hand-edited). */
  date: string;
  /** What it rests on: `run:<id>`, `node:<id>`, `event:<seq>` (journal). */
  evidence: string[];
  /** Never sent to a cloud provider (only to `kind: local` providers). */
  localOnly: boolean;
  /** Day a human confirmed a model's proposal. */
  confirmed?: string;
  /** Day the text was last changed through the API. */
  edited?: string;
}

export interface Fact {
  /** `m-` and 4 to 32 letters or digits; stable across edits. */
  id: string;
  layer: Layer;
  /** One line of text, redacted. */
  text: string;
  provenance: Provenance;
  /** Unknown provenance attributes found in the file, kept as they were. */
  extra?: Record<string, string>;
}

/** Something odd in a memory file; the data is kept. */
export interface MemoryProblem {
  /** 1-based line in the file, 0 for the file as a whole. */
  line: number;
  message: string;
}

/** Which file a call acts on. */
export type MemoryScope =
  { layer: 'user' } | { layer: 'project'; repo: string } | { layer: 'session'; sessionId: string };

/** A model's proposal, waiting for a human. */
export interface PendingFact {
  id: string;
  /** The layer and file it would be stored in once confirmed. */
  scope: MemoryScope;
  text: string;
  provenance: Provenance;
  /** When it was queued (ISO time). */
  proposedAt: string;
}

/** True for facts a human wrote: injected as user context, not as untrusted data. */
export function isHuman(p: Provenance): boolean {
  return p.source === 'human';
}

export type MemoryErrorCode = 'refused' | 'not_found' | 'invalid';

export class MemoryError extends Error {
  constructor(
    readonly code: MemoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MemoryError';
  }
}
