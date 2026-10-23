/**
 * Spend of a program, from its run records. A live run reserves its approved band top
 * (D-021); a settled run counts what it really cost. The envelope compares proposals with
 * these figures, never with expected costs.
 */
import { createHash } from 'node:crypto';
import type { Charter, Phase, ProgramState, RunRecord } from './schemas.js';

/** What a run weighs against the envelope now. */
export function committedUsd(run: RunRecord): number {
  if (run.status === 'running') return Math.max(run.capUsd, run.costUsd);
  return run.costUsd;
}

export interface Ledger {
  /** Spent by settled runs plus reserved by live ones, whole program. */
  committedUsd: number;
  /** Already spent (settled and live runs' cost so far). */
  spentUsd: number;
  totalCapUsd: number;
  byPhase: Array<{ phaseId: string; committedUsd: number; spentUsd: number; capUsd: number }>;
}

export function ledger(state: Pick<ProgramState, 'charter' | 'runs'>): Ledger {
  const byPhase = state.charter.phases.map((p: Phase) => {
    const runs = state.runs.filter((r) => r.phaseId === p.id);
    return {
      phaseId: p.id,
      committedUsd: sum(runs.map(committedUsd)),
      spentUsd: sum(runs.map((r) => r.costUsd)),
      capUsd: p.capUsd,
    };
  });
  return {
    committedUsd: sum(state.runs.map(committedUsd)),
    spentUsd: sum(state.runs.map((r) => r.costUsd)),
    totalCapUsd: state.charter.envelope.totalCapUsd,
    byPhase,
  };
}

/** The department of a work package: its lead seat's (D-026); none for a review run. */
export function departmentOf(charter: Charter, wpId: string): string | undefined {
  const wp = charter.phases.flatMap((p) => p.workPackages).find((w) => w.id === wpId);
  return charter.seats.find((s) => s.id === wp?.lead)?.department;
}

/** Committed spend of one department across the program. */
export function departmentCommittedUsd(
  state: Pick<ProgramState, 'charter' | 'runs'>,
  departmentId: string,
): number {
  const runs = state.runs.filter((r) => departmentOf(state.charter, r.wpId) === departmentId);
  return sum(runs.map(committedUsd));
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

/** JSON with sorted keys: the same charter always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The hash the Sponsor's approval is bound to. Any change to the charter changes it. */
export function charterHash(charter: Charter): string {
  return createHash('sha256').update(canonicalJson(charter)).digest('hex');
}
