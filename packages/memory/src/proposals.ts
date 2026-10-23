/**
 * Memory proposals in model output (ADR-0027). A node may end with a fenced block:
 *
 *   ```memory
 *   - [project] Tests use vitest and live next to the sources.
 *   - [user] Prefers short commit messages.
 *   - [project, local-only] The staging host is reachable only over the VPN.
 *   ```
 *
 * Each item is one fact; the optional tags pick the layer (`project` by default) and the
 * `local-only` flag. Model output is untrusted: counts and sizes are capped, and every
 * proposal only reaches the pending queue, never memory itself.
 */
import { cleanText } from './guard.js';
import type { Layer } from './types.js';

export const MAX_PROPOSALS_PER_NODE = 5;
export const MAX_PROPOSAL_CHARS = 300;
const MAX_BLOCK_CHARS = 8_000;

export interface ExtractedProposal {
  layer: Layer;
  text: string;
  localOnly: boolean;
}

export interface Extraction {
  proposals: ExtractedProposal[];
  /** Items dropped: over the count, over the size, unknown tags or empty. */
  dropped: number;
}

const BLOCK_RE = /```memory[ \t]*\n([\s\S]*?)```/g;
const TAGS_RE = /^\[([^\]]{1,60})\]\s*/;

function item(line: string): { p?: ExtractedProposal; bad: boolean } {
  const m = /^\s*[-*+]\s+(.*)$/.exec(line);
  if (!m) return { bad: line.trim() !== '' };
  let rest = m[1] ?? '';
  let layer: Layer = 'project';
  let localOnly = false;
  const tags = TAGS_RE.exec(rest);
  if (tags) {
    for (const t of (tags[1] ?? '').split(/[,\s]+/).filter(Boolean)) {
      if (t === 'local-only') localOnly = true;
      else if (t === 'user' || t === 'project' || t === 'session') layer = t;
      else return { bad: true };
    }
    rest = rest.slice(tags[0].length);
  }
  const text = cleanText(rest);
  if (!text || text.length > MAX_PROPOSAL_CHARS) return { bad: true };
  return { p: { layer, text, localOnly }, bad: false };
}

/** The proposals of one node's output, at most `max`, in order. */
export function extractProposals(output: string, max = MAX_PROPOSALS_PER_NODE): Extraction {
  const proposals: ExtractedProposal[] = [];
  let dropped = 0;
  for (const block of output.matchAll(BLOCK_RE)) {
    const body = (block[1] ?? '').slice(0, MAX_BLOCK_CHARS);
    for (const line of body.split('\n')) {
      const { p, bad } = item(line);
      if (bad) dropped++;
      if (!p) continue;
      if (proposals.length >= max || proposals.some((x) => x.text === p.text)) dropped++;
      else proposals.push(p);
    }
  }
  return { proposals, dropped };
}

/** The output with its memory blocks removed (for display and for later nodes). */
export function withoutProposals(output: string): string {
  return output.replace(BLOCK_RE, '').trimEnd();
}
