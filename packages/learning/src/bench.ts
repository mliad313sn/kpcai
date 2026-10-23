/**
 * `kpai bench` engine (spec §4.6, §5.4, ADR-0028): a short, opt-in calibration on the
 * user's own repository. It builds a few reference tasks, plans them through the kernel
 * (nothing is spent), shows their cost and asks before running; each approved task then
 * runs through the normal kernel path (budget gates, confirmations, critics, journal).
 * Each answer gets a deterministic check, journaled as a `bench check`; the competence store
 * is then rebuilt from the journal, so the bench recalibrates routing like any other run.
 */
import type { Journal } from '@kernelpai/journal';
import { scanSources, type RepoScanOptions } from './bench-repo.js';
import { benchTasks, type BenchCheck, type BenchTask } from './bench-tasks.js';
import { ACTIONS } from './signals.js';
import { CompetenceStore, type CompetenceEntry } from './store.js';

export interface BenchPlan {
  planId: string;
  /** Likely cost (USD). */
  expectedUsd: number;
  /** Most the run may spend without asking again: the band's top (USD, D-021). */
  capUsd: number;
}

export interface BenchRunResult {
  runId: string;
  sessionId: string;
  status: 'finished' | 'not_run' | 'failed';
  cancelled: boolean;
  /** Answer of each node that produced one, in graph order (the last is the deliverable). */
  answers: Array<{ nodeId: string; text: string }>;
  costUsd?: number;
}

/** What the bench needs from the kernel; see the integration spec in ADR-0028. */
export interface BenchHost {
  /** Plans the task's request (no model call is paid for the estimate). */
  plan(task: BenchTask): Promise<BenchPlan>;
  /** Runs an approved plan through the kernel's normal path. */
  run(task: BenchTask, plan: BenchPlan): Promise<BenchRunResult>;
  /** Asks the human; false or no answer means no. */
  confirm(question: string): Promise<boolean>;
  say?(text: string): void;
  /** Money in the user's display currency; default USD. */
  money?(usd: number): string;
}

export interface BenchOptions extends Omit<RepoScanOptions, 'root'> {
  root: string;
  journal: Journal;
  host: BenchHost;
  /** Project key of the competence store (the session cwd); default `root`. */
  project?: string;
  /** Tasks of each kind. Default 1 (three tasks). */
  perKind?: number;
}

export interface BenchTaskResult {
  task: Pick<BenchTask, 'id' | 'kind' | 'taskType' | 'file'>;
  plan?: BenchPlan;
  runId?: string;
  status: BenchRunResult['status'] | 'unplanned';
  check?: BenchCheck & { nodeId: string };
  error?: string;
}

export interface CompetenceChange {
  ref: string;
  taskType: string;
  before?: { score: number; samples: number };
  after: { score: number; samples: number };
}

export interface BenchReport {
  /** The human said no (or nothing could be planned): nothing ran, nothing was spent. */
  ran: boolean;
  expectedUsd: number;
  capUsd: number;
  tasks: BenchTaskResult[];
  changes: CompetenceChange[];
  /** One line per task and the outcome, for the CLI. */
  summary: string[];
}

const usd = (x: number): string => `$${x.toFixed(4)}`;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

async function planAll(tasks: readonly BenchTask[], host: BenchHost): Promise<BenchTaskResult[]> {
  const out: BenchTaskResult[] = [];
  for (const task of tasks) {
    const t = { id: task.id, kind: task.kind, taskType: task.taskType, file: task.file };
    try {
      out.push({ task: t, plan: await host.plan(task), status: 'not_run' });
    } catch (err) {
      out.push({ task: t, status: 'unplanned', error: errText(err) });
    }
  }
  return out;
}

function journalCheck(
  j: Journal,
  task: BenchTask,
  r: BenchRunResult,
  nodeId: string,
  c: BenchCheck,
) {
  j.append({
    sessionId: r.sessionId,
    type: 'intervention',
    nodeId,
    payload: {
      action: ACTIONS.benchCheck,
      source: 'bench',
      runId: r.runId,
      nodeId,
      task: task.id,
      kind: task.kind,
      passed: c.passed,
      detail: c.detail,
    },
  });
}

async function runOne(o: BenchOptions, task: BenchTask, res: BenchTaskResult): Promise<void> {
  try {
    const r = await o.host.run(task, res.plan as BenchPlan);
    res.runId = r.runId;
    res.status = r.status;
    const last = r.answers.at(-1);
    if (r.status !== 'finished' || r.cancelled || !last) return;
    const c = task.check(last.text);
    res.check = { ...c, nodeId: last.nodeId };
    journalCheck(o.journal, task, r, last.nodeId, c);
  } catch (err) {
    res.status = 'failed';
    res.error = errText(err);
  }
}

function changes(before: CompetenceStore, after: CompetenceStore): CompetenceChange[] {
  const old = new Map(before.entries().map((e) => [keyOf(e), e]));
  const out: CompetenceChange[] = [];
  for (const e of after.entries()) {
    const b = old.get(keyOf(e));
    if (b && b.samples === e.samples && b.score === e.score) continue;
    out.push({
      ref: `${e.ref.provider}/${e.ref.model}`,
      taskType: e.taskType,
      ...(b ? { before: { score: b.score, samples: b.samples } } : {}),
      after: { score: e.score, samples: e.samples },
    });
  }
  return out;
}

const keyOf = (e: CompetenceEntry): string => `${e.ref.provider}/${e.ref.model}\u0000${e.taskType}`;

function summarize(r: BenchTaskResult, money: (x: number) => string): string {
  const head = `${r.task.kind} ${r.task.file}`;
  if (r.status === 'unplanned') return `${head}: not planned (${r.error ?? 'no route'})`;
  if (!r.check) return `${head}: ${r.status}${r.error ? ` (${r.error})` : ''}`;
  const cost = r.plan ? ` · est. ${money(r.plan.expectedUsd)}` : '';
  return `${head}: ${r.check.passed ? 'pass' : 'fail'} (${r.check.detail})${cost}`;
}

/** Runs the bench; asks before anything is spent and returns what changed. */
export async function runBench(o: BenchOptions): Promise<BenchReport> {
  const money = o.host.money ?? usd;
  const tasks = benchTasks(scanSources(o), o.perKind ?? 1);
  const results = await planAll(tasks, o.host);
  const planned = results.filter((r) => r.plan);
  const expectedUsd = planned.reduce((a, r) => a + (r.plan?.expectedUsd ?? 0), 0);
  const capUsd = planned.reduce((a, r) => a + (r.plan?.capUsd ?? 0), 0);
  const empty = { expectedUsd, capUsd, tasks: results, changes: [] };
  if (planned.length === 0) {
    return {
      ran: false,
      ...empty,
      summary: ['bench: no task could be planned on this repository'],
    };
  }
  const question = `Bench: ${planned.length} task(s) on this repository, likely ${money(expectedUsd)}, at most ${money(capUsd)}. Run it?`;
  if (!(await o.host.confirm(question))) {
    return { ran: false, ...empty, summary: ['bench: declined, nothing was run'] };
  }
  const project = o.project ?? o.root;
  const before = CompetenceStore.fromJournal(o.journal, { project });
  for (const [i, task] of tasks.entries()) {
    const res = results[i] as BenchTaskResult;
    if (!res.plan) continue;
    o.host.say?.(`bench: ${task.kind} ${task.file}…\n`);
    await runOne(o, task, res);
  }
  const after = CompetenceStore.fromJournal(o.journal, { project });
  const summary = results.map((r) => summarize(r, money));
  return { ran: true, ...empty, changes: changes(before, after), summary };
}
