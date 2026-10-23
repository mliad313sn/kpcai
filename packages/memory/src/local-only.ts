/**
 * Local-only facts after a local model has seen them (review P4-F3, ADR-0027 §6).
 *
 * A `local-only` fact is given only to `kind: local` providers. What such a provider writes
 * may quote it, so two mechanisms keep that output away from cloud providers:
 *
 * - **Taint** (`LocalTaint`): a node one of whose model calls went to a local provider while
 *   local-only facts existed is tainted, and so is every node that depends on it, directly
 *   or not. The run routes every later step of a tainted node (critics, judges, voters,
 *   revisions) and of its dependents to local providers only, or fails closed.
 * - **Redaction** (`localOnlyRedactor`): defence in depth. Text going to a non-local
 *   provider or to the journal has every quote of a local-only fact replaced: whitespace
 *   normalised, case ignored, and any quoted run of `MIN_QUOTE_CHARS` characters caught.
 */

/** Shortest quote of a longer fact that is redacted (characters, after normalisation). */
export const MIN_QUOTE_CHARS = 24;
/** Facts shorter than this are not redacted (too common to tell apart from prose). */
export const MIN_FACT_CHARS = 6;
export const LOCAL_ONLY_MARK = '[local-only fact withheld]';

interface Normalised {
  text: string;
  /** For each character of `text`: where it starts and ends in the original. */
  from: number[];
  to: number[];
}

/** Lower case, whitespace runs as one space, the injection's `‹›` read as `<>`. */
function normalise(s: string): Normalised {
  const out: Normalised = { text: '', from: [], to: [] };
  let i = 0;
  for (const ch of s) {
    const end = i + ch.length;
    if (/\s/u.test(ch)) {
      const last = out.text.length - 1;
      if (last >= 0 && out.text[last] === ' ' && out.to[last] === i) out.to[last] = end;
      else push(out, ' ', i, end);
    } else {
      const mapped = ch === '‹' ? '<' : ch === '›' ? '>' : ch.toLowerCase();
      for (const c of mapped) push(out, c, i, end);
    }
    i = end;
  }
  return out;
}

function push(n: Normalised, c: string, from: number, to: number): void {
  n.text += c;
  n.from.push(from);
  n.to.push(to);
}

/** Spans (in normalised indexes) of `text` that quote one of the facts. */
function quoted(
  text: string,
  grams: ReadonlyMap<number, ReadonlySet<string>>,
): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const [len, set] of grams) {
    for (let j = 0; j + len <= text.length; j++) {
      if (set.has(text.slice(j, j + len))) spans.push([j, j + len]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const s of spans) {
    const last = merged.at(-1);
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  return merged;
}

export type Redactor = (text: string) => string;

/**
 * A function that replaces every quote of the given facts with `LOCAL_ONLY_MARK`: the whole
 * fact, or any run of at least `minQuote` characters of it, whitespace and case ignored.
 */
export function localOnlyRedactor(facts: readonly string[], minQuote = MIN_QUOTE_CHARS): Redactor {
  const grams = new Map<number, Set<string>>();
  for (const f of facts) {
    const n = normalise(f).text.trim();
    if (n.length < MIN_FACT_CHARS) continue;
    const len = Math.min(minQuote, n.length);
    const set = grams.get(len) ?? new Set<string>();
    for (let i = 0; i + len <= n.length; i++) set.add(n.slice(i, i + len));
    grams.set(len, set);
  }
  if (grams.size === 0) return (text) => text;
  return (text) => {
    if (!text) return text;
    const n = normalise(text);
    const spans = quoted(n.text, grams);
    if (spans.length === 0) return text;
    let out = '';
    let at = 0;
    for (const [a0, b0] of spans) {
      let [a, b] = [a0, b0];
      while (a < b && n.text[a] === ' ') a++;
      while (b > a && n.text[b - 1] === ' ') b--;
      const start = n.from[a] ?? text.length;
      out += text.slice(at, start) + LOCAL_ONLY_MARK;
      at = n.to[b - 1] ?? text.length;
    }
    return out + text.slice(at);
  };
}

/** Every string inside a JSON-like value redacted; other values as they are. */
export function redactDeep<T>(value: T, redact: Redactor): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => redactDeep(v, redact)) as T;
  if (value !== null && typeof value === 'object' && isPlain(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, redact);
    return out as T;
  }
  return value;
}

function isPlain(v: object): boolean {
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

export interface TaintNode {
  id: string;
  dependsOn: readonly string[];
}

/**
 * Which nodes have seen local-only facts, directly (a call to a local provider) or through
 * a dependency. Inactive (never taints) when there is no local-only fact to protect.
 */
export class LocalTaint {
  private readonly direct = new Set<string>();
  private readonly deps: Map<string, readonly string[]>;

  constructor(
    nodes: readonly TaintNode[],
    readonly active: boolean,
  ) {
    this.deps = new Map(nodes.map((n) => [n.id, n.dependsOn]));
  }

  /** A model call of `nodeId` went to a provider; `local` when its kind is `local`. */
  observe(nodeId: string, local: boolean): void {
    if (this.active && local) this.direct.add(nodeId);
  }

  /** The tainted node `nodeId` is, or depends on; undefined when it is clean. */
  source(nodeId: string): string | undefined {
    if (!this.active) return undefined;
    const seen = new Set<string>();
    const stack = [nodeId];
    while (stack.length) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      if (this.direct.has(id)) return id;
      stack.push(...(this.deps.get(id) ?? []));
    }
    return undefined;
  }

  tainted(): string[] {
    return [...this.direct].sort();
  }
}
