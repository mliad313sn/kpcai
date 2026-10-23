import { ToolError } from '../types.js';

/**
 * Pure checks on a unified diff before `git apply` sees it (review P2-F1/F2).
 *
 * Text: no C0/C1 control characters except tab and newline, so nothing can hide
 * from the human reading the patch (OSC/CSI escapes, backspaces, bidi overrides).
 * Carriage returns are accepted only when the patch is consistently CRLF.
 *
 * Sections: every target comes from `diff --git a/X b/Y`, `---`/`+++`, and
 * rename/copy lines. Refused unless an option allows them: binary sections,
 * executable modes (100755) and symlink modes (120000). Every section needs at
 * least one text hunk, except whole-file deletions and pure (100 %) renames;
 * creating an empty file or a mode-only change is therefore refused.
 */
export interface PatchRules {
  allowBinary?: boolean;
  allowExecutable?: boolean;
  allowSymlinks?: boolean;
}

export interface PatchSection {
  /** Root-relative paths named by the section (old and new). */
  paths: string[];
  hunks: number;
  binary: boolean;
  deleted: boolean;
  renamed: boolean;
  modes: string[];
}

/** Bidirectional overrides and isolates (Trojan Source) hide code as well as escapes do. */
const BIDI = /[‪-‮⁦-⁩]/;

function badChar(c: string): boolean {
  const code = c.codePointAt(0) as number;
  if (code === 0x09 || code === 0x0a) return false;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || BIDI.test(c);
}

/**
 * Refuses control characters; the message names line, column and code point,
 * never the raw bytes (they could act on the terminal that shows the error).
 */
export function assertPrintable(patch: string): void {
  const crlf = patch.includes('\r\n');
  if (crlf && /\r(?!\n)|(?<!\r)\n/.test(patch)) {
    throw new ToolError('patch mixes CRLF and LF line endings or has a stray carriage return');
  }
  const lines = patch.split(crlf ? '\r\n' : '\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    for (let col = 0; col < line.length; col++) {
      const c = line[col] as string;
      if (!badChar(c)) continue;
      const hex = (c.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0');
      throw new ToolError(
        `patch contains a control character U+${hex} at line ${i + 1}, column ${col + 1}; refused so nothing can hide from review`,
      );
    }
  }
}

function newSection(): PatchSection {
  return { paths: [], hunks: 0, binary: false, deleted: false, renamed: false, modes: [] };
}

function stripPrefix(name: string): string {
  if (name === '/dev/null') return '';
  if (!/^[ab]\//.test(name)) throw new ToolError(`patch paths must start with a/ or b/: ${name}`);
  return name.slice(2);
}

/** Reads one header line into the current section. */
function readHeader(line: string, s: PatchSection): void {
  const m = /^(?:new file mode|deleted file mode|old mode|new mode) (\d+)/.exec(line);
  if (m) s.modes.push(m[1] as string);
  if (line.startsWith('deleted file mode')) s.deleted = true;
  if (/^similarity index 100%/.test(line)) s.renamed = true;
  if (line.startsWith('GIT binary patch') || /^Binary files .* differ$/.test(line)) s.binary = true;
  const r = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line);
  if (r) s.paths.push(r[1] as string);
  const h = /^(?:---|\+\+\+) (.+?)(\t.*)?$/.exec(line);
  if (h) {
    const p = stripPrefix(h[1] as string);
    if (p) s.paths.push(p);
  }
}

function gitHeaderPaths(line: string): string[] {
  const m =
    /^diff --git a\/(\S+) b\/(\S+)$/.exec(line) ?? /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  if (!m) throw new ToolError('unsupported diff --git header (quoted or unusual paths)');
  return [m[1] as string, m[2] as string];
}

/** Lines still expected in the current hunk, from `@@ -a,b +c,d @@`. */
interface HunkLeft {
  old: number;
  new: number;
}

function hunkCounts(line: string): HunkLeft {
  const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
  if (!m) throw new ToolError('malformed hunk header in patch');
  return { old: Number(m[1] ?? 1), new: Number(m[2] ?? 1) };
}

/** Consumes one hunk body line; returns false when the line ends the hunk early. */
function consume(line: string, left: HunkLeft): boolean {
  const c = line[0];
  if (c === '\\') return true;
  if (c === ' ' || line === '') {
    left.old -= 1;
    left.new -= 1;
  } else if (c === '-') left.old -= 1;
  else if (c === '+') left.new -= 1;
  else return false;
  return true;
}

/** Splits a patch into sections (one per file) and collects their headers. */
export function parsePatch(patch: string): PatchSection[] {
  const sections: PatchSection[] = [];
  let cur: PatchSection | undefined;
  let left: HunkLeft | undefined;
  for (const line of patch.split(/\r?\n/)) {
    if (left && consume(line, left)) {
      if (left.old <= 0 && left.new <= 0) left = undefined;
      continue;
    }
    left = undefined;
    const git = line.startsWith('diff --git ');
    if (git || (line.startsWith('--- ') && (cur === undefined || cur.hunks > 0))) {
      cur = newSection();
      sections.push(cur);
      if (git) cur.paths.push(...gitHeaderPaths(line));
    }
    if (!cur) continue;
    if (line.startsWith('@@ ')) {
      cur.hunks += 1;
      left = hunkCounts(line);
    } else readHeader(line, cur);
  }
  if (sections.length === 0) {
    throw new ToolError('no file headers (diff --git a/… b/… or --- a/… +++ b/…) found');
  }
  return sections;
}

/** Applies the section rules; throws with the first refusal. */
export function checkSections(sections: PatchSection[], rules: PatchRules = {}): void {
  for (const s of sections) {
    const name = s.paths.at(-1) ?? '(unknown)';
    if (s.binary && !rules.allowBinary) throw new ToolError(`binary patch refused: ${name}`);
    if (s.modes.includes('120000') && !rules.allowSymlinks) {
      throw new ToolError(`patches that create or change symlinks are refused: ${name}`);
    }
    if (s.modes.includes('100755') && !rules.allowExecutable) {
      throw new ToolError(`patches that create or make files executable are refused: ${name}`);
    }
    if (s.hunks === 0 && !s.binary && !s.deleted && !s.renamed) {
      throw new ToolError(
        `section without a text hunk refused (empty file or mode-only change): ${name}`,
      );
    }
  }
}

/** Paths from `git apply --numstat -z` output; binary entries (`-\t-`) are flagged. */
export function parseNumstat(out: string): { paths: string[]; binary: string[] } {
  const tokens = out.split('\0');
  const paths: string[] = [];
  const binary: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i] as string);
    if (!m) continue;
    const named = m[3] ? [m[3]] : [tokens[i + 1] ?? '', tokens[i + 2] ?? ''];
    if (!m[3]) i += 2;
    paths.push(...named.filter((p) => p !== ''));
    if (m[1] === '-') binary.push(...named);
  }
  return { paths, binary };
}

/** Modes announced by `git apply --summary` (`create mode 100755 x`, `mode change a => b x`). */
export function summaryModes(out: string): string[] {
  const modes: string[] = [];
  for (const m of out.matchAll(/(?:create|delete) mode (\d{6})|mode change \d{6} => (\d{6})/g)) {
    modes.push((m[1] ?? m[2]) as string);
  }
  return modes;
}
