import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
} from 'node:fs';
import path from 'node:path';
import { canonicalSync, isInside } from './paths.js';
import type { KeyProbe } from './zones.js';

/**
 * Tells an Apple Keynote document named `*.key` from key material (WI-S7-01), so
 * `*.key` can stay a credential zone without blocking presentations.
 *
 * Safety: only items whose canonical path is inside the canonical root are looked at;
 * a file is opened read-only, non-blocking and without following a final symlink, must
 * be a regular file on the open descriptor, and at most {@link KEYNOTE_SNIFF_BYTES} are
 * read from its head and as many from its tail; a folder is listed up to
 * {@link KEYNOTE_DIR_ENTRIES} entries. Any doubt or error answers "not Keynote", which
 * keeps the item forbidden. Nothing read here reaches a model: the answer is a boolean.
 */
export const KEYNOTE_SNIFF_BYTES = 64 * 1024;
export const KEYNOTE_DIR_ENTRIES = 256;

/** Entry names of an iWork Keynote archive or package (2009 `index.apxl`, 2013+ `Index/`). */
const KEYNOTE_ENTRY = /^(?:Index\/[^/]+\.iwa|Index\.zip|index\.apxl(?:\.gz)?)$/;
const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;

/** Names of zip records (local headers at +26/+30, central headers at +28/+46) in a buffer. */
export function zipNames(buf: Buffer): string[] {
  const names: string[] = [];
  for (let i = 0; i + 30 <= buf.length; i++) {
    if (buf[i] !== 0x50 || buf[i + 1] !== 0x4b) continue;
    const sig = buf.readUInt32LE(i);
    const [lenAt, nameAt] =
      sig === LOCAL_HEADER ? [26, 30] : sig === CENTRAL_HEADER ? [28, 46] : [0, 0];
    if (nameAt === 0 || i + nameAt > buf.length) continue;
    const len = buf.readUInt16LE(i + lenAt);
    if (len === 0 || len > 512 || i + nameAt + len > buf.length) continue;
    names.push(buf.subarray(i + nameAt, i + nameAt + len).toString('latin1'));
  }
  return names;
}

function readAt(fd: number, length: number, position: number): Buffer {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, position);
  return buf.subarray(0, n);
}

/** True for a single-file Keynote document: a zip whose records name Keynote entries. */
function keynoteFile(abs: string): boolean {
  const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(abs, flags);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size < 30) return false;
    const head = readAt(fd, Math.min(KEYNOTE_SNIFF_BYTES, st.size), 0);
    if (head.readUInt32LE(0) !== LOCAL_HEADER) return false;
    if (zipNames(head).some((n) => KEYNOTE_ENTRY.test(n))) return true;
    if (st.size <= KEYNOTE_SNIFF_BYTES) return false;
    const len = Math.min(KEYNOTE_SNIFF_BYTES, st.size - KEYNOTE_SNIFF_BYTES);
    const tail = readAt(fd, len, st.size - len);
    return zipNames(tail).some((n) => KEYNOTE_ENTRY.test(n));
  } finally {
    closeSync(fd);
  }
}

/** True for a Keynote package folder: it holds `Index.zip`, `Index/` or `index.apxl[.gz]`. */
function keynoteFolder(abs: string): boolean {
  const dir = opendirSync(abs);
  try {
    for (let i = 0; i < KEYNOTE_DIR_ENTRIES; i++) {
      const e = dir.readSync();
      if (e === null) return false;
      if (e.isDirectory() && e.name === 'Index') return true;
      if (e.isFile() && /^(?:Index\.zip|index\.apxl(?:\.gz)?)$/.test(e.name)) return true;
    }
    return false;
  } finally {
    dir.closeSync();
  }
}

/** The probe the permission policy uses for paths under `root`. */
export function keynoteProbe(root: string): KeyProbe {
  const realRoot = canonicalSync(root);
  return (rel) => {
    try {
      const real = canonicalSync(path.resolve(realRoot, rel));
      if (real === realRoot || !isInside(realRoot, real)) return false;
      const st = lstatSync(real);
      if (st.isDirectory()) return keynoteFolder(real);
      return st.isFile() && keynoteFile(real);
    } catch {
      return false;
    }
  };
}
