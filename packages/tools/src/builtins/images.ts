/**
 * S10 R6 J3 (B-28): SHA-256 "images" of the files a kernel write touches, before and after,
 * so a later write that puts a file back to its pre-image (a revert) can be told apart from
 * one that extends it (docs/metrics/NORTH-STAR.md). Hashes only, never content; they stay
 * in the local journal (a hash of a tiny file can be guessed).
 */
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

/** `null`: the file does not exist (created or deleted by the write). */
export type FileImage = string | null;

export interface FileImages {
  pre: FileImage;
  post: FileImage;
}

/** At most this many files are hashed per write; larger ones are left out. */
export const MAX_IMAGE_FILES = 500;
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/**
 * The SHA-256 of each root-relative file, `null` when absent. A symlink, a directory, a
 * file too large or unreadable is left out (undefined): it proves nothing either way.
 */
export async function hashFiles(
  root: string,
  files: readonly string[],
): Promise<Record<string, FileImage>> {
  const out: Record<string, FileImage> = {};
  for (const rel of files.slice(0, MAX_IMAGE_FILES)) {
    const abs = path.join(root, rel);
    const st = await lstat(abs).catch((err: NodeJS.ErrnoException) =>
      err.code === 'ENOENT' ? null : undefined,
    );
    if (st === null) out[rel] = null;
    else if (st?.isFile() && st.size <= MAX_IMAGE_BYTES) {
      const buf = await readFile(abs).catch(() => undefined);
      if (buf) out[rel] = createHash('sha256').update(buf).digest('hex');
    }
  }
  return out;
}

/** Pre- and post-images joined per file (files hashed on both sides only). */
export function joinImages(
  pre: Record<string, FileImage>,
  post: Record<string, FileImage>,
): Record<string, FileImages> {
  const out: Record<string, FileImages> = {};
  for (const [f, before] of Object.entries(pre))
    if (f in post) out[f] = { pre: before, post: post[f] ?? null };
  return out;
}
