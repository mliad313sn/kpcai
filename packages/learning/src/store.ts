/**
 * Measured competence per repository (ADR-0028): for each (model, task type) of one
 * project, the mean grade of its most recent graded nodes, the sample count and the
 * evidence the router cites. Derived from the journal only and rebuilt on demand; nothing
 * is stored besides the journal, so it can always be recomputed and audited.
 *
 * Built once per plan (`CompetenceStore.fromJournal`); `get` is a map lookup, so the
 * router keeps its latency budget.
 */
import { refToString, type MeasuredCompetence, type ModelRef } from '@kernelpai/core';
import type { Journal } from '@kernelpai/journal';
import { gradeJournal, type NodeGrade, type ReadOptions } from './grades.js';
import type { SignalKind } from './signals.js';

/** Most recent graded nodes kept per (model, task type): competence follows the model. */
export const DEFAULT_WINDOW = 100;
/** A node graded at least this counts as approved in the evidence. */
export const GOOD_GRADE = 0.5;

export interface SignalCount {
  /** Signals with value 1. */
  good: number;
  total: number;
}

export interface CompetenceEntry {
  ref: ModelRef;
  taskType: string;
  project: string;
  /** Graded nodes behind the score (after the window). */
  samples: number;
  /** Mean node grade, in [0, 1]. */
  score: number;
  /** Nodes graded ≥ `GOOD_GRADE`. */
  approved: number;
  signals: Partial<Record<SignalKind, SignalCount>>;
  /** The phrase the router's reason line cites. */
  evidence: string;
}

export interface CompetenceStoreOptions extends ReadOptions {
  /** Only grades of this project (a session's working directory); all when absent. */
  project?: string;
  window?: number;
}

const key = (ref: ModelRef, type: string): string => `${refToString(ref)}\u0000${type}`;
const trimSep = (p: string): string => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p);

function count(grades: readonly NodeGrade[]): CompetenceEntry['signals'] {
  const out: CompetenceEntry['signals'] = {};
  for (const g of grades) {
    for (const s of g.signals) {
      const c = (out[s.kind] ??= { good: 0, total: 0 });
      c.total += 1;
      if (s.value >= GOOD_GRADE) c.good += 1;
    }
  }
  return out;
}

/** e.g. "approved 14/16 test tasks here (tests passed 9/10, 1 rolled back)". */
export function evidencePhrase(
  e: Pick<CompetenceEntry, 'approved' | 'samples' | 'taskType' | 'signals'>,
): string {
  const s = e.signals;
  const details: string[] = [];
  if (s.tests) details.push(`tests passed ${s.tests.good}/${s.tests.total}`);
  if (s.critic) details.push(`critics approved ${s.critic.good}/${s.critic.total}`);
  if (s.rollback) details.push(`${s.rollback.total} rolled back`);
  if (s.manual) details.push(`rated good ${s.manual.good}/${s.manual.total}`);
  const type = e.taskType.replace(/_/g, ' ');
  const head = `approved ${e.approved}/${e.samples} ${type} tasks here`;
  return details.length ? `${head} (${details.slice(0, 2).join(', ')})` : head;
}

/** Measured competence of one repository, for `CompetenceRouterOptions.measured`. */
export class CompetenceStore implements MeasuredCompetence {
  private readonly table = new Map<string, CompetenceEntry>();

  private constructor(entries: CompetenceEntry[]) {
    for (const e of entries) this.table.set(key(e.ref, e.taskType), e);
  }

  /** From grades (e.g. `gradeJournal(journal).grades`), most recent last. */
  static fromGrades(
    grades: readonly NodeGrade[],
    options: CompetenceStoreOptions = {},
  ): CompetenceStore {
    const window = Math.max(1, options.window ?? DEFAULT_WINDOW);
    const project = options.project !== undefined ? trimSep(options.project) : undefined;
    const groups = new Map<string, NodeGrade[]>();
    for (const g of grades) {
      if (project !== undefined && trimSep(g.project) !== project) continue;
      const k = key(g.ref, g.taskType);
      const list = groups.get(k);
      if (list) list.push(g);
      else groups.set(k, [g]);
    }
    const entries: CompetenceEntry[] = [];
    for (const list of groups.values()) {
      const recent = [...list].sort((a, b) => a.seq - b.seq).slice(-window);
      const first = recent[0] as NodeGrade;
      const samples = recent.length;
      const approved = recent.filter((g) => g.grade >= GOOD_GRADE).length;
      const base = {
        ref: first.ref,
        taskType: first.taskType,
        project: project ?? first.project,
        samples,
        score: recent.reduce((a, g) => a + g.grade, 0) / samples,
        approved,
        signals: count(recent),
      };
      entries.push({ ...base, evidence: evidencePhrase(base) });
    }
    return new CompetenceStore(entries);
  }

  /** Reads the journal now and grades it (recomputed from scratch, ADR-0028). */
  static fromJournal(journal: Journal, options: CompetenceStoreOptions = {}): CompetenceStore {
    return CompetenceStore.fromGrades(gradeJournal(journal, options).grades, options);
  }

  get(
    ref: ModelRef,
    type: string,
  ): { score: number; samples: number; evidence: string } | undefined {
    const e = this.table.get(key(ref, type));
    return e && { score: e.score, samples: e.samples, evidence: e.evidence };
  }

  /** Every entry, best evidence first (for `kpai stats` and the routing panel). */
  entries(): CompetenceEntry[] {
    return [...this.table.values()].sort(
      (a, b) =>
        b.samples - a.samples ||
        b.score - a.score ||
        key(a.ref, a.taskType).localeCompare(key(b.ref, b.taskType)),
    );
  }
}
