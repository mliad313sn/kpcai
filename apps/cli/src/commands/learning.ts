/**
 * `kpai grade` and `kpai bench` (ADR-0028), and the learning part of `kpai stats`:
 * estimate accuracy here (R-402) and the measured competence the router blends in.
 */
import { Kernel, formatMoney, money, type GraphOptions } from '@kernelpai/kernel';
import type { AccuracyReport, AccuracyRow, CompetenceEntry } from '@kernelpai/learning';
import { kernelHost } from '../host.js';
import type { Io } from '../io.js';
import { sanitizeForTerminal } from '../sanitize.js';

export interface GradeCliOptions {
  db?: string | undefined;
  runId: string;
  nodeId: string;
  grade: string;
  note?: string | undefined;
  author?: string | undefined;
}

const open = (io: Io, db: string | undefined): Kernel =>
  new Kernel(kernelHost(io, db ? { db } : {}));

/** `kpai grade <run> <node> good|bad [note] [--author name]`. */
export async function gradeCommand(io: Io, o: GradeCliOptions): Promise<number> {
  if (o.grade !== 'good' && o.grade !== 'bad') {
    io.err('a grade is "good" or "bad": kpai grade <run> <node> good|bad [note]\n');
    return 2;
  }
  const kernel = open(io, o.db);
  try {
    const r = kernel.learning.grade({
      runId: o.runId,
      nodeId: o.nodeId,
      grade: o.grade,
      ...(o.note ? { note: o.note } : {}),
      ...(o.author ? { author: o.author } : {}),
    });
    const type = r.taskType ? ` (${r.taskType})` : '';
    io.out(
      `graded ${o.grade}: node ${r.nodeId} of run ${r.runId.slice(0, 8)}, by ${sanitizeForTerminal(r.graded)}${type}\n`,
    );
    return 0;
  } finally {
    await kernel.close();
  }
}

/** `kpai bench [--per-kind N] [--allow-test]`: asks once with the total before spending. */
export async function benchCommand(
  io: Io,
  o: { db?: string | undefined; perKind?: number | undefined; options?: GraphOptions },
): Promise<number> {
  const kernel = open(io, o.db);
  try {
    const r = await kernel.learning.bench({
      ...(o.perKind ? { perKind: o.perKind } : {}),
      ...(o.options ? { options: o.options } : {}),
    });
    for (const line of r.summary) io.out(`${sanitizeForTerminal(line)}\n`);
    for (const c of r.changes) {
      const before = c.before ? `${c.before.score.toFixed(2)} (${c.before.samples})` : 'none';
      io.out(
        `competence ${c.ref} ${c.taskType}: ${before} → ${c.after.score.toFixed(2)} (${c.after.samples})\n`,
      );
    }
    return r.ran ? 0 : 4;
  } finally {
    await kernel.close();
  }
}

const pct = (x: number | null): string => (x === null ? '–' : `${(x * 100).toFixed(0)}%`);
const err = (x: number | null): string => (x === null ? '–' : `${x.toFixed(1)}%`);

function accuracyLine(r: AccuracyRow, m: ReturnType<typeof money>): string {
  return `  ${r.label.padEnd(16)} ${String(r.samples).padStart(4)}  in band ${pct(r.inBandRate).padStart(4)}  error ${err(r.meanAbsErrorPct).padStart(6)}  est ${formatMoney(r.meanEstimateUsd, m)} / real ${formatMoney(r.meanActualUsd, m)}`;
}

/** Estimate accuracy (R-402): whole runs, by task type, cold start against calibrated. */
export function renderAccuracy(a: AccuracyReport, m: ReturnType<typeof money>): string {
  const lines = ['estimate accuracy here (estimate approved against billed cost)'];
  lines.push(accuracyLine(a.runs, m));
  for (const r of [...a.byTaskType, ...a.byBasis]) lines.push(accuracyLine(r, m));
  const x = a.excluded;
  lines.push(
    `  left out: ${x.cancelled} cancelled, ${x.notFinished} not finished, ${x.noPlan} without a plan`,
  );
  return `${lines.join('\n')}\n`;
}

/** Measured competence here, with the evidence the router's reason cites (ADR-0028). */
export function renderCompetence(entries: readonly CompetenceEntry[]): string {
  if (entries.length === 0) return 'measured competence here: no graded work yet\n';
  const lines = entries.map(
    (e) =>
      `  ${`${e.ref.provider}/${e.ref.model}`.padEnd(28)} ${e.taskType.padEnd(16)} ${e.score.toFixed(2)}  ${sanitizeForTerminal(e.evidence)}`,
  );
  return `measured competence here\n${lines.join('\n')}\n`;
}
