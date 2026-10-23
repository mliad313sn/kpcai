import type { GraphResult, TaskGraph } from '@kernelpai/core';
import { deliverableOf } from '@kernelpai/orchestrator';

/**
 * Unified diffs inside model output: fenced ```diff / ```patch blocks, or a bare text that
 * starts with `diff --git` or `--- `. Model output is untrusted; the diffs are only shown
 * and then applied through the tool bus (`git.apply`: jailed, checked, confirmed).
 */
export function extractPatches(text: string): string[] {
  const fenced = [...text.matchAll(/```(?:diff|patch)\s*\n([\s\S]*?)```/g)]
    .map((m) => (m[1] ?? '').trim())
    .filter(isPatch);
  if (fenced.length > 0) return fenced.map(withNewline);
  const bare = text.slice(Math.max(0, firstPatchStart(text))).trim();
  return firstPatchStart(text) >= 0 && isPatch(bare) ? [withNewline(bare)] : [];
}

function firstPatchStart(text: string): number {
  const m = /^(diff --git |--- (?:a\/|\/dev\/null))/m.exec(text);
  return m ? m.index : -1;
}

function isPatch(s: string): boolean {
  return /^(diff --git |--- )/m.test(s) && /^@@ /m.test(s);
}

function withNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`;
}

/** Files a patch touches, from its `+++ b/…` headers. */
export function patchFiles(patch: string): string[] {
  return [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => (m[1] ?? '').trim());
}

/**
 * True when a patch contains control characters other than tab and newline (a CR is
 * tolerated only as part of CRLF), or bidi overrides/isolates ("Trojan Source", review N5). Such bytes can make a terminal hide or rewrite what the
 * human reviews, so these patches are refused rather than "cleaned" for display.
 */
export function hasHiddenBytes(patch: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]|\r(?!\n)/.test(patch);
}

export interface Patch {
  nodeId: string;
  patch: string;
  /** Files the patch touches, from its `+++ b/…` headers. */
  files: string[];
}

/**
 * Patches from nodes that deliver a patch, succeeded **and were approved** by a critic from
 * another provider (principle 2, review P2-F4), without exact duplicates. A patch carrying
 * control characters is refused outright, so what the human reads is exactly what would be
 * applied (P2-F1, F12).
 */
export function collect(graph: TaskGraph, r: GraphResult): { patches: Patch[]; refused: Patch[] } {
  const seen = new Set<string>();
  const all = graph.nodes
    // Only nodes that deliver a patch (code and tests by default; S4's `deliverableOf`).
    .filter((n) => deliverableOf(n) === 'patch')
    .filter((n) => r.results[n.id]?.ok === true && r.results[n.id]?.approved === true)
    .flatMap((n) =>
      extractPatches(r.results[n.id]?.output ?? '').map((patch) => ({
        nodeId: n.id,
        patch,
        files: patchFiles(patch),
      })),
    );
  const unique = all.filter((p) => !seen.has(p.patch) && (seen.add(p.patch), true));
  return {
    patches: unique.filter((p) => !hasHiddenBytes(p.patch)),
    refused: unique.filter((p) => hasHiddenBytes(p.patch)),
  };
}
