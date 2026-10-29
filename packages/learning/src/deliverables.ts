/**
 * Deliverables for the north star (docs/metrics/NORTH-STAR.md): every accepted change of
 * `changes.ts` with the intent it served, its class (code or document), the assurance
 * label its run earned (S10 R5, `assuranceOf` of `@kernelpai/program`, from journaled
 * verdicts and test runs only) and whether it was undone within the durability window:
 *
 * - rolled back: a workspace restore covering it (`markRollbacks`), within the window;
 * - reverted (J3): a later accepted write put one of its files back to the hash it had
 *   before the change (`images` of `git.apply`, `fs.write` and `merge-back`).
 */
import type { JournalEvent } from '@kernelpai/journal';
import { assuranceOf, type Assurance, type NodeFacts } from '@kernelpai/program';
import { markRollbacks, runChanges, type Change } from './changes.js';
import { intentsOf, type Intent } from './intents.js';
import type { JournalRuns, RunRecord } from './runs.js';
import { nodeWork } from './work.js';

/** Code, tests and config need ≥ V2; documents and other outputs ≥ V1 (`DVO-doc`). */
export type DeliverableClass = 'code' | 'doc';

export interface Undone {
  kind: 'rollback' | 'revert';
  seq: number;
  ts: string;
}

export interface Deliverable {
  change: Change;
  intent: Intent;
  cls: DeliverableClass;
  assurance: Assurance;
  /** What earned the label, e.g. "V2: approved by mock-delta (2 nodes); 1 test run(s) passed". */
  basis: string;
  landedAt: string;
  undone?: Undone;
}

type Image = { pre: string | null; post: string | null };

/** Files with no objective validator: documents, reports, notes. */
const DOC_FILE = /\.(md|mdx|markdown|txt|rst|adoc|asciidoc|org|tex|html?)$/i;
const REVIEWED: ReadonlySet<string> = new Set(['author_critic']);
const VIEWED = 'evidence viewed';
const RECORDED = 'node recorded';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const action = (e: JournalEvent): string | undefined =>
  e.type === 'intervention' ? str(e.payload.action) : undefined;

export function classOf(c: Pick<Change, 'kind' | 'files'>): DeliverableClass {
  if (c.files.length === 0) return c.kind === 'artifact' ? 'doc' : 'code';
  return c.files.every((f) => DOC_FILE.test(f)) ? 'doc' : 'code';
}

/** Rank of a label: V0 = 0 … V3 = 3. */
export const rank = (a: Assurance): number => Number(a.slice(1));

/** Verified: ≥ V2 for code, ≥ V1 for documents. */
export const verified = (d: Pick<Deliverable, 'cls' | 'assurance'>): boolean =>
  rank(d.assurance) >= (d.cls === 'code' ? 2 : 1);

function protocols(plan: JournalEvent | undefined): Map<string, string> {
  const nodes = (plan?.payload.plan as { nodes?: unknown } | undefined)?.nodes;
  const out = new Map<string, string>();
  if (!Array.isArray(nodes)) return out;
  for (const n of nodes as Array<Record<string, unknown>>) {
    const id = str(n?.['id']);
    const p = str(n?.['protocol']);
    if (id && p) out.set(id, p);
  }
  return out;
}

/** Finished, not cancelled, and no node record says it failed. */
function cleanFinish(run: RunRecord): boolean {
  if (run.outcome?.status !== 'finished' || run.cancelled) return false;
  return !run.events.some(
    (e) =>
      action(e) === RECORDED &&
      e.payload.reused !== true &&
      (e.payload.result as { ok?: unknown } | undefined)?.ok === false,
  );
}

/** The run's assurance from its journal (as `enterprise/assure.ts`), V3 when viewed. */
export function runAssurance(run: RunRecord, viewed: boolean): { label: Assurance; basis: string } {
  const plan = protocols(run.plan);
  const nodes: NodeFacts[] = [...nodeWork(run).values()].map((w) => ({
    nodeId: w.nodeId,
    reviewable: REVIEWED.has(plan.get(w.nodeId) ?? 'author_critic'),
    ...(w.producer ? { producer: w.producer.provider } : {}),
    verdicts: w.verdicts.map((v) => ({
      authorProvider: v.author.provider,
      criticProvider: v.critic.provider,
      approved: v.approved,
      seq: v.seq,
    })),
    ...(w.tests ? { tests: { passed: w.tests.passed } } : {}),
  }));
  return assuranceOf({ ok: cleanFinish(run), nodes, viewed });
}

/** Run ids whose evidence a person opened (`evidence viewed`, J2). */
export function viewedRuns(events: readonly JournalEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    if (action(e) !== VIEWED) continue;
    const ref = e.payload.ref as { kind?: unknown; id?: unknown } | undefined;
    if (ref?.kind === 'run' && typeof ref.id === 'string') out.add(ref.id);
  }
  return out;
}

function imageMap(v: unknown): Map<string, Image> {
  const out = new Map<string, Image>();
  if (typeof v !== 'object' || v === null) return out;
  for (const [f, x] of Object.entries(v as Record<string, unknown>)) {
    const i = x as { pre?: unknown; post?: unknown } | null;
    const ok = (h: unknown): h is string | null => h === null || typeof h === 'string';
    if (i && ok(i.pre) && ok(i.post)) out.set(f, { pre: i.pre, post: i.post });
  }
  return out;
}

/** J3 images per journal sequence: kernel writes (`meta.images`) and merges (`images`). */
export function imagesBySeq(events: readonly JournalEvent[]): Map<number, Map<string, Image>> {
  const out = new Map<number, Map<string, Image>>();
  for (const e of events) {
    const raw =
      e.type === 'tool'
        ? (e.payload.meta as { images?: unknown } | undefined)?.images
        : action(e) === 'merge-back'
          ? e.payload.images
          : undefined;
    const m = imageMap(raw);
    if (m.size > 0) out.set(e.seq, m);
  }
  return out;
}

/** The images of a change where it landed: the merge for an isolated run, else the write. */
function imagesOf(c: Change, by: Map<number, Map<string, Image>>): Map<string, Image> {
  const all = (c.landed && by.get(c.landed.seq)) || by.get(c.seq) || new Map<string, Image>();
  return new Map([...all].filter(([f]) => c.files.length === 0 || c.files.includes(f)));
}

interface Landed {
  d: Deliverable;
  at: number;
  images: Map<string, Image>;
}

/** A later accepted write that put one of the change's files back to its pre-image. */
function markReverts(list: Landed[], windowMs: number): void {
  const sorted = [...list].sort(
    (a, b) => (a.d.change.landed?.seq ?? 0) - (b.d.change.landed?.seq ?? 0),
  );
  for (const [i, x] of sorted.entries()) {
    if (x.d.undone) continue;
    const changed = [...x.images].filter(([, im]) => im.pre !== im.post);
    const later = sorted
      .slice(i + 1)
      .find(
        (y) =>
          y.at - x.at <= windowMs &&
          changed.some(([f, im]) => y.images.has(f) && y.images.get(f)?.post === im.pre),
      );
    const seq = later?.d.change.landed?.seq;
    if (later && seq !== undefined) x.d.undone = { kind: 'revert', seq, ts: later.d.landedAt };
  }
}

/**
 * The accepted deliverables of `runs` (one project), with their intent, class, assurance and
 * undoing. `events` are every event of the project (restores and merges of any run).
 */
export function deliverablesOf(
  all: JournalRuns,
  runs: readonly RunRecord[],
  events: readonly JournalEvent[],
  windowMs: number,
): Deliverable[] {
  const intents = intentsOf(all);
  const viewed = viewedRuns(events);
  const ts = new Map(events.map((e) => [e.seq, e.ts]));
  const images = imagesBySeq(events);
  const out: Landed[] = [];
  for (const run of runs) {
    const changes = runChanges(run);
    markRollbacks(changes, events);
    const accepted = changes.filter((c) => c.status === 'accepted' && c.landed);
    if (accepted.length === 0) continue;
    const a = runAssurance(run, run.runId !== undefined && viewed.has(run.runId));
    const intent = intents.get(run.key) ?? {
      key: `proxy|${run.key}`,
      id: run.key,
      origin: 'proxy',
    };
    for (const c of accepted) {
      const landedAt = c.landed?.ts ?? '';
      const d: Deliverable = {
        change: c,
        intent,
        cls: classOf(c),
        assurance: a.label,
        basis: a.basis,
        landedAt,
      };
      const at = Date.parse(landedAt);
      const back = c.rolledBackSeq;
      const backTs = back === undefined ? undefined : ts.get(back);
      if (back !== undefined && backTs && Date.parse(backTs) - at <= windowMs)
        d.undone = { kind: 'rollback', seq: back, ts: backTs };
      out.push({ d, at, images: imagesOf(c, images) });
    }
  }
  markReverts(out, windowMs);
  return out
    .map((x) => x.d)
    .sort((a, b) => (a.change.landed?.seq ?? 0) - (b.change.landed?.seq ?? 0));
}

/** True when at least one kernel write or merge carried J3 images. */
export function hasImages(events: readonly JournalEvent[]): boolean {
  return imagesBySeq(events).size > 0;
}
