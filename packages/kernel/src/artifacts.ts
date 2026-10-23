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
 * The text is re-checked here (defence in depth): what the human reads is what is written.
 */
import { createHash } from 'node:crypto';
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

/** May a node's artifacts be kept, and are they reviewed? Undefined: refused, with why. */
function admission(
  res: RunResult['results'][string] | undefined,
  kind: ArtifactKind,
): { reviewed: boolean } | { refused: string } {
  if (res?.approved === true) return { reviewed: true };
  if (shapeOf(kind) === 'document' && res?.approved === undefined) return { reviewed: false };
  return {
    refused:
      res?.approved === false
        ? 'the critic did not approve it'
        : 'not reviewed by a critic from another provider (only documents may be saved unreviewed)',
  };
}

/** Artifacts the run produced, kept or refused (see the module comment), without duplicates. */
export function collectArtifacts(
  graph: TaskGraph,
  r: RunResult,
  ids: { runId: string; sessionId: string },
): { artifacts: Artifact[]; refused: RefusedArtifact[] } {
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
      const admit = admission(res, a.kind);
      const problem =
        'refused' in admit ? admit.refused : artifactProblem(a.path, a.kind, a.content);
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
