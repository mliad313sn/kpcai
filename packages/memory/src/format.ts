/**
 * Memory files as Markdown (ADR-0027): optional front matter, any prose, and one list item
 * per fact with its provenance in a trailing `kpai` comment (attrs.ts). The parser is
 * tolerant of hand edits: lines it does not understand are kept verbatim and reported, an
 * item without provenance is a fact the human wrote, and nothing is ever dropped.
 */
import { createHash } from 'node:crypto';
import { formatAttrs, isFactId, parseAttrs } from './attrs.js';
import type { Fact, Layer, MemoryProblem, Provenance } from './types.js';

export type DocLine = { kind: 'raw'; text: string } | { kind: 'fact'; fact: Fact };

export interface MemoryDoc {
  layer: Layer;
  /** Front matter lines between the `---` fences, verbatim (none when absent). */
  front: string[] | undefined;
  lines: DocLine[];
  problems: MemoryProblem[];
}

const ITEM_RE = /^ {0,1}[-*+][ \t]+(.*)$/;
const CONT_RE = /^(?: {2,}|\t)\S/;
const TAIL_RE = /^<!--\s*kpai\b([^]*?)-->\s*$/;

/** A fresh doc for a layer, with a short header for the human reading it. */
export function emptyDoc(layer: Layer, meta: Record<string, string> = {}): MemoryDoc {
  const front = ['kpai: memory', 'version: 1', `layer: ${layer}`];
  for (const [k, v] of Object.entries(meta)) front.push(`${k}: ${v.replace(/[\r\n]/g, ' ')}`);
  const title = { user: 'User memory', project: 'Project memory', session: 'Session memory' };
  const lines: DocLine[] = [
    { kind: 'raw', text: '' },
    { kind: 'raw', text: `# ${title[layer]}` },
    { kind: 'raw', text: '' },
    {
      kind: 'raw',
      text: '<!-- One fact per list item. Keep the trailing kpai comment when you edit a fact: it holds where the fact came from. -->',
    },
    { kind: 'raw', text: '' },
  ];
  return { layer, front, lines, problems: [] };
}

/** Id for a fact found without one: derived from its text, so it is stable between reads. */
export function derivedId(text: string, taken: ReadonlySet<string>): string {
  for (let salt = 0; ; salt++) {
    const id = `m-${createHash('sha256').update(`${salt}:${text}`).digest('hex').slice(0, 8)}`;
    if (!taken.has(id)) return id;
  }
}

function splitTail(item: string): { text: string; attrs?: string } {
  const at = item.lastIndexOf('<!--');
  if (at < 0) return { text: item.trim() };
  const m = TAIL_RE.exec(item.slice(at));
  return m ? { text: item.slice(0, at).trim(), attrs: m[1] ?? '' } : { text: item.trim() };
}

/** Adds a continuation line to an item's text, keeping its provenance comment last. */
function joinBeforeTail(body: string, more: string): string {
  const { text, attrs } = splitTail(body);
  if (attrs === undefined) return `${body} ${more}`;
  return `${text} ${more} ${body.slice(body.lastIndexOf('<!--'))}`;
}

function frontOf(
  rows: string[],
  problems: MemoryProblem[],
): { front: string[] | undefined; start: number } {
  if (rows[0]?.trim() !== '---') return { front: undefined, start: 0 };
  const end = rows.findIndex((r, i) => i > 0 && r.trim() === '---');
  if (end < 0) {
    problems.push({ line: 1, message: 'front matter is not closed: read as text' });
    return { front: undefined, start: 0 };
  }
  const front = rows.slice(1, end);
  front.forEach((r, i) => {
    if (r.trim() && !/^[A-Za-z0-9_-]+:/.test(r))
      problems.push({ line: i + 2, message: 'front matter line is not "key: value"; kept' });
  });
  return { front, start: end + 1 };
}

interface Building {
  doc: MemoryDoc;
  ids: Set<string>;
  /** The fact item being read and the line it started on. */
  open?: { line: number; body: string };
}

function closeItem(b: Building): void {
  const open = b.open;
  if (!open) return;
  b.open = undefined;
  const { text, attrs } = splitTail(open.body);
  const report = (message: string): void => void b.doc.problems.push({ line: open.line, message });
  if (!text) {
    report('empty list item; kept as text');
    b.doc.lines.push({ kind: 'raw', text: `- ${open.body}`.trimEnd() });
    return;
  }
  const parsed = attrs === undefined ? undefined : parseAttrs(attrs);
  const provenance: Provenance = parsed?.provenance ?? {
    source: 'human',
    date: '',
    evidence: [],
    localOnly: false,
  };
  if (!parsed) report('no provenance: read as a fact you wrote');
  for (const m of parsed?.problems ?? []) report(m);
  let id = parsed?.id;
  if (id !== undefined && !isFactId(id)) report(`id "${id.slice(0, 40)}" is not valid; replaced`);
  if (id !== undefined && isFactId(id) && b.ids.has(id)) report(`id ${id} repeated; replaced`);
  if (id === undefined || !isFactId(id) || b.ids.has(id)) id = derivedId(text, b.ids);
  b.ids.add(id);
  const extra = parsed && Object.keys(parsed.extra).length ? { extra: parsed.extra } : {};
  b.doc.lines.push({ kind: 'fact', fact: { id, layer: b.doc.layer, text, provenance, ...extra } });
}

/** Parses a memory file; the result serializes back to the same facts and prose. */
export function parseMemory(source: string, layer: Layer): MemoryDoc {
  const rows = source.replace(/\r\n?/g, '\n').split('\n');
  if (rows.at(-1) === '') rows.pop();
  const doc: MemoryDoc = { layer, front: undefined, lines: [], problems: [] };
  const { front, start } = frontOf(rows, doc.problems);
  doc.front = front;
  const declared = front?.map((r) => /^layer:\s*(\S+)/.exec(r)?.[1]).find(Boolean);
  if (declared && declared !== layer)
    doc.problems.push({
      line: 0,
      message: `front matter says layer ${declared}; read as ${layer}`,
    });
  const b: Building = { doc, ids: new Set() };
  let fence = false;
  rows.slice(start).forEach((row, i) => {
    const line = start + i + 1;
    if (/^\s*(```|~~~)/.test(row)) fence = !fence;
    const item = fence ? null : ITEM_RE.exec(row);
    if (b.open && !fence && CONT_RE.test(row)) {
      b.doc.problems.push({ line, message: 'continuation line joined to the fact above' });
      b.open.body = joinBeforeTail(b.open.body, row.trim());
      return;
    }
    closeItem(b);
    if (item) b.open = { line, body: item[1] ?? '' };
    else doc.lines.push({ kind: 'raw', text: row });
  });
  closeItem(b);
  return doc;
}

/** One fact as a list item. */
export function factLine(f: Fact): string {
  return `- ${f.text} ${formatAttrs(f.id, f.provenance, f.extra)}`;
}

export function serializeMemory(doc: MemoryDoc): string {
  const out: string[] = [];
  if (doc.front) out.push('---', ...doc.front, '---');
  for (const l of doc.lines) out.push(l.kind === 'raw' ? l.text : factLine(l.fact));
  return `${out.join('\n')}\n`;
}

export function factsOf(doc: MemoryDoc): Fact[] {
  return doc.lines.flatMap((l) => (l.kind === 'fact' ? [l.fact] : []));
}

/** Appends a fact after the last fact (or at the end), with a blank line before a first one. */
export function appendFact(doc: MemoryDoc, fact: Fact): void {
  const last = doc.lines.findLastIndex((l) => l.kind === 'fact');
  if (last >= 0) {
    doc.lines.splice(last + 1, 0, { kind: 'fact', fact });
    return;
  }
  while (isBlank(doc.lines.at(-1))) doc.lines.pop();
  doc.lines.push({ kind: 'raw', text: '' }, { kind: 'fact', fact });
}

function isBlank(l: DocLine | undefined): boolean {
  return l !== undefined && l.kind === 'raw' && l.text.trim() === '';
}
