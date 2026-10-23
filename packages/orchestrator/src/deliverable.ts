import type { GraphNode } from '@kernelpai/core';
import type { NodeHint } from '@kernelpai/packs';

/**
 * What a node hands back (WI-S4-01, D-019). Mirrors the pack schema's `deliverable` enum
 * (`@kernelpai/packs`), checked at compile time below. Only `patch` goes through the
 * diff/apply path; the other kinds come back as artifacts (see {@link extractArtifacts}).
 */
export type Deliverable = NodeHint['deliverable'];

export const DELIVERABLES = [
  'answer',
  'report',
  'patch',
  'notebook',
  'design',
  'build',
  'checklist',
  'model3d',
  'map',
  'config',
  'asset',
] as const satisfies readonly Deliverable[];

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Compile-time guard: fails `tsc` if the pack schema adds or removes a deliverable kind. */
export const DELIVERABLES_MATCH_PACKS: Same<(typeof DELIVERABLES)[number], Deliverable> = true;

export function isDeliverable(v: unknown): v is Deliverable {
  return typeof v === 'string' && (DELIVERABLES as readonly string[]).includes(v);
}

/** How an artifact is carried in the model's reply. */
export type ArtifactShape = 'none' | 'diff' | 'document' | 'files';

const DOCUMENTS: ReadonlySet<Deliverable> = new Set(['report', 'checklist', 'design']);

export function shapeOf(d: Deliverable): ArtifactShape {
  if (d === 'answer') return 'none';
  if (d === 'patch') return 'diff';
  return DOCUMENTS.has(d) ? 'document' : 'files';
}

/** A node's deliverable: its own, else `patch` for code and tests, else `answer`. */
export function deliverableOf(node: GraphNode & { deliverable?: unknown }): Deliverable {
  if (isDeliverable(node.deliverable)) return node.deliverable;
  return node.type === 'code_generation' || node.type === 'test' ? 'patch' : 'answer';
}

const DOCUMENT_ASK: Record<string, string> = {
  report:
    'Answer with the complete report in Markdown (headings, lists, tables where useful). Your whole reply is saved as the report: no diff, no preamble.',
  checklist:
    'Answer with a Markdown checklist: one "- [ ] " line per step, each saying how to check it. Your whole reply is saved as the checklist: no diff.',
  design:
    'Answer with the complete design document in Markdown (goals, decisions, structure, open questions). Your whole reply is saved as the document: no diff.',
};

/** Kinds handed back as artifacts (every deliverable but `answer` and `patch`). */
export type ArtifactKind = Exclude<Deliverable, 'answer' | 'patch'>;

const FILE_ASK: Record<string, { what: string; path: string }> = {
  notebook: {
    what: 'the notebook as percent-format cells ("# %%") in a .py file, or a complete .ipynb JSON file',
    path: 'notebooks/analysis.py',
  },
  config: { what: 'the complete configuration file(s)', path: 'config/example.yaml' },
  model3d: {
    what: 'the parametric model source (for example OpenSCAD .scad or CadQuery .py)',
    path: 'models/part.scad',
  },
  map: {
    what: 'the map as GeoJSON, a style file or the script that renders it',
    path: 'maps/result.geojson',
  },
  asset: {
    what: 'the asset(s) in a text format (SVG, JSON, shader source)',
    path: 'assets/icon.svg',
  },
  build: {
    what: 'the build files (build scripts, manifests, CI or firmware configuration)',
    path: 'scripts/build.sh',
  },
};

/**
 * The closing line of an author prompt: what the model must hand back, in which form.
 * Files use the artifact fence of ADR-0022 (S1): ```artifact path=… kind=….
 */
export function deliverablePrompt(d: Deliverable): string {
  const shape = shapeOf(d);
  if (shape === 'diff') {
    return 'Answer with the complete change as a unified diff (git format) against the repository.';
  }
  if (shape === 'none') return 'Answer with the complete result.';
  if (shape === 'document') return DOCUMENT_ASK[d] as string;
  const f = FILE_ASK[d] as { what: string; path: string };
  return [
    `Deliver ${f.what} as files, not as a diff. Put each file in its own fenced block opened with the word artifact, a relative path and the kind, for example:`,
    '```' + `artifact path=${f.path} kind=${d}`,
    '…file content…',
    '```',
    'A short explanation may come before the blocks; nothing is written until the user saves it.',
  ].join('\n');
}

/**
 * One artifact extracted from a node's output. Same shape as the kernel's `NodeArtifact`
 * (ADR-0022, S1), so it can feed `collectArtifacts` directly.
 */
export interface ExtractedArtifact {
  /** Relative save path: the model's (validated) or `<nodeId>.md` for a whole-reply document. */
  path: string;
  kind: ArtifactKind;
  mime: string;
  content: string;
}

/** A block that was refused, with the reason (same shape as the kernel's refusals). */
export interface RefusedBlock {
  path: string;
  reason: string;
}

/** A node's deliverable kind and what was extracted from its final output. */
export interface NodeDeliverable {
  nodeId: string;
  deliverable: Deliverable;
  artifacts: ExtractedArtifact[];
  /** Blocks refused (unsafe path, hidden bytes, size, duplicate) or a missing artifact. */
  refused: RefusedBlock[];
}

export const MAX_ARTIFACTS_PER_NODE = 32;
export const MAX_ARTIFACT_BYTES = 1024 * 1024;
const MAX_PATH = 200;
const SEGMENT = /^[\p{L}\p{N}_@+\- ][\p{L}\p{N}._@+\- ]*$/u;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]|\r(?!\n)/;

/** A model-suggested path is data: relative, no `..`, no `.git`, no odd characters. */
export function safeArtifactPath(p: string): string | undefined {
  const path = p.trim();
  if (path.length === 0 || path.length > MAX_PATH || /^[/~]|^[A-Za-z]:/.test(path)) return;
  const segs = path.split('/');
  if (segs.some((s) => !SEGMENT.test(s) || s.trim() !== s || s.toLowerCase() === '.git')) return;
  return path;
}

const MEDIA: Record<string, string> = {
  md: 'text/markdown',
  json: 'application/json',
  geojson: 'application/geo+json',
  ipynb: 'application/x-ipynb+json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  svg: 'image/svg+xml',
  csv: 'text/csv',
  html: 'text/html',
};

export function mediaTypeOf(path: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  return MEDIA[ext] ?? 'text/plain';
}

interface Fence {
  info: string;
  body: string;
}

/** Fenced blocks (``` or ~~~, closed by a fence of the same kind at least as long). */
export function fencedBlocks(text: string): Fence[] {
  const lines = text.split('\n');
  const out: Fence[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i] as string);
    if (!open) continue;
    const fence = open[1] as string;
    const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
    const end = lines.findIndex((l, j) => j > i && close.test(l));
    if (end === -1) break;
    out.push({ info: (open[2] as string).trim(), body: lines.slice(i + 1, end).join('\n') });
    i = end;
  }
  return out;
}

function attrs(info: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of info.matchAll(/([a-z]+)=(?:"([^"]*)"|([^\s"]+))/g)) {
    out[m[1] as string] = m[2] ?? m[3] ?? '';
  }
  return out;
}

const isArtifactKind = (v: string | undefined): v is ArtifactKind =>
  isDeliverable(v) && v !== 'answer' && v !== 'patch';

/** One artifact block checked: path, kind, MIME type, size and hidden bytes. */
function checkBlock(b: Fence, fallback: ArtifactKind): ExtractedArtifact | RefusedBlock {
  const a = attrs(b.info);
  const raw = a['path'] ?? '';
  const path = safeArtifactPath(raw);
  const shown = raw.slice(0, 200);
  if (!path) return { path: shown, reason: 'path must be relative, plain and without .. or .git' };
  const kind = a['kind'] ?? fallback;
  if (!isArtifactKind(kind)) return { path, reason: `unknown kind ${kind.slice(0, 40)}` };
  const mime = a['mime'] ?? mediaTypeOf(path);
  if (!MIME.test(mime)) return { path, reason: `invalid MIME type ${mime.slice(0, 80)}` };
  if (Buffer.byteLength(b.body, 'utf8') > MAX_ARTIFACT_BYTES) {
    return { path, reason: `larger than ${MAX_ARTIFACT_BYTES} bytes` };
  }
  if (HIDDEN.test(b.body))
    return { path, reason: 'contains control characters that could hide content' };
  return { path, kind, mime, content: b.body };
}

/** Blocks opened with `artifact` (ADR-0022), checked and de-duplicated. */
function blockArtifacts(res: NodeDeliverable, output: string, fallback: ArtifactKind): void {
  const seen = new Set(res.artifacts.map((a) => a.path));
  for (const b of fencedBlocks(output)) {
    if (!/^artifact(\s|$)/.test(b.info)) continue;
    const r = checkBlock(b, fallback);
    if ('reason' in r) res.refused.push(r);
    else if (seen.has(r.path)) res.refused.push({ path: r.path, reason: 'duplicate path' });
    else if (res.artifacts.length >= MAX_ARTIFACTS_PER_NODE) {
      res.refused.push({ path: r.path, reason: `more than ${MAX_ARTIFACTS_PER_NODE} files` });
    } else {
      seen.add(r.path);
      res.artifacts.push(r);
    }
  }
}

/** A reply wrapped whole in one fence (``` markdown …```) is unwrapped. */
function unwrapDocument(output: string): string {
  const t = output.trim();
  const blocks = fencedBlocks(t);
  const only = blocks.length === 1 && /^(`{3,}|~{3,})/.test(t) && /(`{3,}|~{3,})$/.test(t);
  return only ? (blocks[0] as Fence).body : t;
}

/** A document deliverable (report, checklist, design) given as the whole reply. */
function wholeReply(res: NodeDeliverable, output: string, kind: ArtifactKind): void {
  const content = unwrapDocument(output);
  const path = safeArtifactPath(`${res.nodeId}.md`) ?? 'result.md';
  const r = checkBlock({ info: `artifact path=${path} kind=${kind}`, body: content }, kind);
  if (content === '') res.refused.push({ path, reason: 'the output is empty' });
  else if ('reason' in r) res.refused.push(r);
  else res.artifacts.push(r);
}

/**
 * Extracts a node's artifacts from its final output (none for `answer` and `patch`).
 * Artifact fences (ADR-0022) are taken from every other kind; a document deliverable
 * (report, checklist, design) is also the whole reply, as `<nodeId>.md`. A file kind
 * without any block is reported. Model output is untrusted: unsafe paths, hidden bytes
 * and oversize blocks are refused with the reason.
 */
export function extractArtifacts(
  nodeId: string,
  deliverable: Deliverable,
  output: string,
): NodeDeliverable {
  const res: NodeDeliverable = { nodeId, deliverable, artifacts: [], refused: [] };
  if (!isArtifactKind(deliverable)) return res;
  if (shapeOf(deliverable) === 'document') wholeReply(res, output, deliverable);
  blockArtifacts(res, output, deliverable);
  if (res.artifacts.length === 0 && res.refused.length === 0) {
    res.refused.push({ path: '', reason: 'no artifact block (```artifact path=…) found' });
  }
  return res;
}
