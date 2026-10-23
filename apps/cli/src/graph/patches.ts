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
 * tolerated only as part of CRLF). Such bytes can make a terminal hide or rewrite what the
 * human reviews, so these patches are refused rather than "cleaned" for display.
 */
export function hasHiddenBytes(patch: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]|\r(?!\n)/.test(patch);
}
