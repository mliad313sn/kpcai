/**
 * Automatic and manual grades from the journal only (ADR-0028, spec §5.4, R-401).
 *
 * For each node of each run, every model that worked on it gets a grade in [0, 1]: the
 * weighted mean of its signals (`SIGNAL_WEIGHTS`).
 * - critic: a verdict on that model's draft, 1 approved without a major issue, 0 rejected;
 *   a critic of the same model is ignored, of the same provider counts half;
 * - tests: the node's last test run, 1 passed, 0 failed (the producer);
 * - patch: 1 when all its patches were applied as proposed, 0 when one was declined,
 *   refused or failed to apply; rollback: 0 when a checkpoint restore or a declined
 *   merge-back undid it (replaces the patch signal);
 * - cancelled: 0 at a low weight when the run was cancelled;
 * - bench: the bench's deterministic check of the node's answer, 1 or 0;
 * - manual: `kpai grade` good 1 / bad 0. A node carries at most one manual signal (weight
 *   3), from its latest grade whoever the author: grading again, or under other names,
 *   replaces it and never adds weight (P4-F9). Replaced grades are listed as `superseded`.
 */
import { refToString, type ModelRef } from '@kernelpai/core';
import type { Journal, JournalEvent } from '@kernelpai/journal';
import { findRun, splitRuns, type JournalRuns, type RunRecord } from './runs.js';
import {
  ACTIONS,
  SAME_PROVIDER_CRITIC_FACTOR,
  SIGNAL_WEIGHTS,
  weightedGrade,
  type Signal,
} from './signals.js';
import { nodeWork, type NodeWork } from './work.js';

export interface NodeGrade {
  /** Run id, else `<sessionId>#<k>`. */
  runKey: string;
  sessionId: string;
  project: string;
  nodeId: string;
  ref: ModelRef;
  taskType: string;
  /** Weighted mean of the signals, in [0, 1]. */
  grade: number;
  signals: Signal[];
  /** Journal sequence of the latest evidence (orders grades by recency). */
  seq: number;
}

export type IgnoredReason =
  'self-review' | 'self-grade' | 'untrusted source' | 'unknown node' | 'superseded';

export interface IgnoredGrade {
  runKey: string;
  nodeId: string;
  seq: number;
  reason: IgnoredReason;
}

export interface Grading {
  grades: NodeGrade[];
  /** Evidence refused by the anti-gaming rules, for audit (ADR-0028). */
  ignored: IgnoredGrade[];
}

interface Extra {
  /** The node's latest manual grade: one at most, whoever graded (P4-F9). */
  manual?: Signal;
  bench?: Signal;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const signal = (kind: Signal['kind'], value: number, seq: number, factor = 1): Signal => ({
  kind,
  value,
  weight: SIGNAL_WEIGHTS[kind] * factor,
  seq,
});

/** A manual grade whose author is the graded model (or names it) is not a human's opinion. */
function isSelf(author: string, ref: ModelRef): boolean {
  const a = author.trim().toLowerCase();
  return [refToString(ref), ref.model].some((x) => x.toLowerCase() === a);
}

class Grader {
  readonly ignored: IgnoredGrade[] = [];
  private readonly works = new Map<RunRecord, Map<string, NodeWork>>();
  private readonly extras = new Map<NodeWork, Extra>();

  constructor(private readonly runs: JournalRuns) {
    for (const r of runs.runs) this.works.set(r, nodeWork(r));
  }

  private ignore(runKey: string, nodeId: string, seq: number, reason: IgnoredReason): void {
    this.ignored.push({ runKey, nodeId, seq, reason });
  }

  /** Manual grades and bench checks, attached to the node they name. */
  attach(e: JournalEvent): void {
    const run = findRun(this.runs, str(e.payload.runId) ?? '');
    const nodeId = str(e.payload.nodeId) ?? '';
    const w = run && this.works.get(run)?.get(nodeId);
    if (!run || !w?.producer) {
      this.ignore(run?.key ?? str(e.payload.runId) ?? '', nodeId, e.seq, 'unknown node');
      return;
    }
    const extra: Extra = this.extras.get(w) ?? {};
    this.extras.set(w, extra);
    if (e.payload.action === ACTIONS.benchCheck) {
      if (e.payload.source !== 'bench')
        return this.ignore(run.key, nodeId, e.seq, 'untrusted source');
      extra.bench = signal('bench', e.payload.passed === true ? 1 : 0, e.seq);
      return;
    }
    const author = str(e.payload.author) ?? '';
    const grade = str(e.payload.grade);
    if (e.payload.source !== 'human' || !author || (grade !== 'good' && grade !== 'bad')) {
      return this.ignore(run.key, nodeId, e.seq, 'untrusted source');
    }
    if (isSelf(author, w.producer)) return this.ignore(run.key, nodeId, e.seq, 'self-grade');
    const next = signal('manual', grade === 'good' ? 1 : 0, e.seq);
    const old = extra.manual;
    if (old && old.seq > next.seq) return this.ignore(run.key, nodeId, next.seq, 'superseded');
    extra.manual = next;
    if (old) this.ignore(run.key, nodeId, old.seq, 'superseded');
  }

  private nodeSignals(run: RunRecord, w: NodeWork): Signal[] {
    const out: Signal[] = [];
    if (w.tests) out.push(signal('tests', w.tests.passed ? 1 : 0, w.tests.seq));
    const undone = w.patches.find((p) => p.undone);
    const failed = w.patches.find((p) => !p.applied);
    if (undone) out.push(signal('rollback', 0, undone.undoneSeq ?? undone.seq));
    else if (failed || w.refusedSeq !== undefined) {
      out.push(signal('patch', 0, failed?.seq ?? (w.refusedSeq as number)));
    } else if (w.patches.length > 0)
      out.push(signal('patch', 1, (w.patches.at(-1) as { seq: number }).seq));
    if (run.cancelled) out.push(signal('cancelled', 0, run.outcome?.seq ?? 0));
    const extra = this.extras.get(w);
    if (extra?.bench) out.push(extra.bench);
    if (extra?.manual) out.push(extra.manual);
    return out;
  }

  /** Grades of one node: one per model with at least one signal. */
  private gradesOf(run: RunRecord, w: NodeWork): NodeGrade[] {
    for (const seq of w.selfReviews) this.ignore(run.key, w.nodeId, seq, 'self-review');
    if (!w.taskType) return [];
    const per = new Map<string, { ref: ModelRef; signals: Signal[] }>();
    const of = (ref: ModelRef): Signal[] => {
      const k = refToString(ref);
      const entry = per.get(k) ?? { ref, signals: [] };
      per.set(k, entry);
      return entry.signals;
    };
    for (const v of w.verdicts) {
      const factor = v.critic.provider === v.author.provider ? SAME_PROVIDER_CRITIC_FACTOR : 1;
      of(v.author).push(signal('critic', v.approved ? 1 : 0, v.seq, factor));
    }
    if (w.producer) of(w.producer).push(...this.nodeSignals(run, w));
    const out: NodeGrade[] = [];
    for (const { ref, signals } of per.values()) {
      const grade = weightedGrade(signals);
      if (grade === undefined) continue;
      const seq = Math.max(...signals.map((s) => s.seq));
      const { key: runKey, sessionId, project } = run;
      out.push({
        runKey,
        sessionId,
        project,
        nodeId: w.nodeId,
        ref,
        taskType: w.taskType,
        grade,
        signals,
        seq,
      });
    }
    return out;
  }

  all(): NodeGrade[] {
    const out: NodeGrade[] = [];
    for (const run of this.runs.runs) {
      for (const w of this.works.get(run)?.values() ?? []) out.push(...this.gradesOf(run, w));
    }
    return out.sort((a, b) => a.seq - b.seq);
  }
}

/** Grades of every node in the given runs (pure, recomputable). */
export function gradeRuns(runs: JournalRuns): Grading {
  const g = new Grader(runs);
  for (const e of runs.grades) g.attach(e);
  const grades = g.all();
  return { grades, ignored: g.ignored };
}

export interface ReadOptions {
  /** Most recent journal events read. Default 100,000. */
  limit?: number;
}

/** Runs of the journal, each with its project (the session's working directory). */
export function readRuns(journal: Journal, options: ReadOptions = {}): JournalRuns {
  const cwd = new Map(journal.sessions(1_000_000).map((s) => [s.id, s.cwd]));
  const events = journal.events({ limit: options.limit ?? 100_000 });
  return splitRuns(events, (id) => cwd.get(id));
}

/** Every grade the journal supports, read now. */
export function gradeJournal(journal: Journal, options: ReadOptions = {}): Grading {
  return gradeRuns(readRuns(journal, options));
}
