/**
 * Non-code outputs (D-019, ADR-0022): files a node delivers next to its patches, such as
 * reports, notebooks, configs, 3D models and maps. S4's runner extracts them per node
 * (`RunResult.deliverables`, fence ```artifact path=… kind=…); the kernel decides which may
 * be written:
 * - file kinds (notebook, config, model3d, map, asset, build) only from a node a critic from
 *   another provider approved (principle 2, D-014);
 * - document kinds (report, checklist, design) also from a node no critic reviewed (a solo
 *   node), marked `reviewed: false`: each save is then confirmed on its own and `yesApply`
 *   never covers it (PO ruling, D-020). A document a critic rejected is not kept.
 * - an unreviewed document must also be a new Markdown file (P3-F3, see
 *   {@link unreviewedPathProblem} and {@link unreviewedOverwrite}): the model's `kind` is a
 *   claim, the path is what gets written.
 * The text is re-checked here (defence in depth): what the human reads is what is written.
 */
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelRef, TaskGraph } from '@kernelpai/core';
import {
  DELIVERABLES,
  shapeOf,
  type ArtifactKind,
  type ExtractedArtifact,
  type RunResult,
} from '@kernelpai/orchestrator';
import { hasHiddenBytes } from './patches.js';

export type { ArtifactKind };

/** The pack schema's `deliverable` enum minus `answer` and `patch` (S4's `ArtifactKind`). */
export const ARTIFACT_KINDS: readonly ArtifactKind[] = DELIVERABLES.filter(
  (d): d is ArtifactKind => d !== 'answer' && d !== 'patch',
);

/** One artifact as a node's output states it (S4's `ExtractedArtifact`). */
export type NodeArtifact = ExtractedArtifact;

export interface ArtifactProvenance {
  runId: string;
  sessionId: string;
  nodeId: string;
  /** The model whose final version was kept (author, revision or solo). */
  author?: ModelRef;
  /** The critic whose approval let it through; absent when not reviewed. */
  reviewer?: ModelRef;
}

export interface Artifact extends NodeArtifact {
  nodeId: string;
  bytes: number;
  sha256: string;
  /** False for a document no critic reviewed: saved only on its own confirmation. */
  reviewed: boolean;
  provenance: ArtifactProvenance;
}

export interface RefusedArtifact {
  nodeId: string;
  path: string;
  reason: string;
}

export const ARTIFACT_MAX_BYTES = 1024 * 1024;

/** Why an artifact path, kind or content is refused (defence in depth on S4's checks). */
export function artifactProblem(
  path: string,
  kind: string | undefined,
  content: string,
): string | undefined {
  if (!(ARTIFACT_KINDS as readonly string[]).includes(kind ?? ''))
    return `unknown kind ${String(kind).slice(0, 40)} (${ARTIFACT_KINDS.join(', ')})`;
  if (path === '' || path.length > 512) return 'missing or too long path';
  const segs = path.split('/');
  if (
    path.startsWith('/') ||
    /[\\:]/.test(path) ||
    hasHiddenBytes(path) ||
    segs.some((s) => s === '' || s === '.' || s === '..' || s.toLowerCase() === '.git')
  )
    return 'path must be relative, `/`-separated, without `..` or .git';
  if (Buffer.byteLength(content, 'utf8') > ARTIFACT_MAX_BYTES)
    return `larger than ${ARTIFACT_MAX_BYTES} bytes (cannot be shown in full)`;
  if (hasHiddenBytes(content)) return 'contains control characters that could hide content';
  return undefined;
}

function lastRef(
  r: RunResult['results'][string] | undefined,
  roles: readonly string[],
): ModelRef | undefined {
  return [...(r?.contributions ?? [])].reverse().find((c) => roles.includes(c.role))?.ref;
}

/**
 * Unreviewed documents are Markdown (report, checklist and design are all asked for as
 * Markdown, S4's `deliverablePrompt`). `.txt` is left out on purpose: `requirements.txt`,
 * `CMakeLists.txt` or `robots.txt` are configuration; `.csv` is spreadsheet formula input.
 */
export const UNREVIEWED_DOCUMENT = /\.(md|markdown)$/i;
/** Markdown files that other coding agents read as instructions (prompt-injection plants). */
const AGENT_INSTRUCTIONS =
  /^(claude|claude\.local|agents?(\.override)?|gemini|skill|copilot-instructions|conventions)\.(md|markdown)$/i;
/** Folders whose Markdown other agents load as memory or rules (review NF-2). */
const AGENT_FOLDERS = new Set(['memory-bank', 'memory_bank']);

/** Why an artifact no critic reviewed may not be kept at this path, whatever its kind claims. */
export function unreviewedPathProblem(path: string, kind: ArtifactKind): string | undefined {
  if (shapeOf(kind) !== 'document')
    return 'not reviewed by a critic from another provider (only documents may be saved unreviewed)';
  const segs = path.split('/');
  const base = segs[segs.length - 1] ?? '';
  if (!UNREVIEWED_DOCUMENT.test(base))
    return `an unreviewed ${kind} must be a Markdown file (.md); ${path.slice(0, 120)} is not one`;
  if (segs.some((s) => s.startsWith('.')))
    return 'an unreviewed document may not go in a hidden file or folder';
  if (AGENT_INSTRUCTIONS.test(base) || segs.some((s) => AGENT_FOLDERS.has(s.toLowerCase())))
    return 'an unreviewed document may not be an agent instruction file';
  return undefined;
}

/**
 * An unreviewed document never replaces anything: refused when the path exists (a file, a
 * folder or a link, dangling or not). Checked when the run ends and again before saving.
 */
export function unreviewedOverwrite(root: string, path: string): string | undefined {
  try {
    lstatSync(join(root, path));
  } catch {
    return undefined;
  }
  return `${path.slice(0, 120)} already exists: an unreviewed document never replaces a file (rename or remove it, or ask for a reviewed run)`;
}

/** May a node's artifacts be kept, and are they reviewed? Undefined: refused, with why. */
function admission(
  res: RunResult['results'][string] | undefined,
  a: NodeArtifact,
  root: string | undefined,
): { reviewed: boolean } | { refused: string } {
  if (res?.approved === true) return { reviewed: true };
  if (res?.approved === false) return { refused: 'the critic did not approve it' };
  const problem =
    unreviewedPathProblem(a.path, a.kind) ??
    (root === undefined ? undefined : unreviewedOverwrite(root, a.path));
  return problem ? { refused: problem } : { reviewed: false };
}

/**
 * Artifacts the run produced, kept or refused (see the module comment), without duplicates.
 * `root` is the folder they will be written to: an unreviewed one that would replace a file
 * there is refused.
 */
export function collectArtifacts(
  graph: TaskGraph,
  r: RunResult,
  where: { runId: string; sessionId: string; root?: string },
): { artifacts: Artifact[]; refused: RefusedArtifact[] } {
  const { root, ...ids } = where;
  const artifacts: Artifact[] = [];
  const refused: RefusedArtifact[] = [];
  for (const n of graph.nodes) {
    const d = r.deliverables?.[n.id];
    const res = r.results[n.id];
    if (!d || res?.ok !== true) continue;
    for (const b of d.refused) refused.push({ nodeId: n.id, path: b.path, reason: b.reason });
    const author = lastRef(res, ['revision', 'author', 'solo']);
    const reviewer = lastRef(res, ['critic']);
    for (const a of d.artifacts) {
      const shape = artifactProblem(a.path, a.kind, a.content);
      const admit = shape ? { refused: shape } : admission(res, a, root);
      const problem = 'refused' in admit ? admit.refused : undefined;
      if (problem) {
        refused.push({ nodeId: n.id, path: a.path.slice(0, 200), reason: problem });
        continue;
      }
      const sha256 = createHash('sha256').update(a.content, 'utf8').digest('hex');
      const reviewed = 'reviewed' in admit && admit.reviewed;
      // The same file twice: keep one, the reviewed one when there is one.
      const twin = artifacts.findIndex((x) => x.path === a.path && x.sha256 === sha256);
      if (twin >= 0 && (artifacts[twin]?.reviewed || !reviewed)) continue;
      const provenance: ArtifactProvenance = {
        ...ids,
        nodeId: n.id,
        ...(author ? { author } : {}),
        ...(reviewed && reviewer ? { reviewer } : {}),
      };
      const bytes = Buffer.byteLength(a.content, 'utf8');
      const item = { ...a, nodeId: n.id, bytes, sha256, reviewed, provenance };
      if (twin >= 0) artifacts[twin] = item;
      else artifacts.push(item);
    }
  }
  return { artifacts, refused };
}
