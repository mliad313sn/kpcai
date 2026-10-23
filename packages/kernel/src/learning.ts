/**
 * Learning from outcomes at the kernel boundary (ADR-0028): manual grades, the measured
 * competence of this repository, published estimate accuracy (R-402) and the bench (spec
 * §4.6). The engine is `@kernelpai/learning`; this class gives it the kernel's journal,
 * zones, plans, runs and human confirmations. Bench runs never apply anything.
 */
import {
  CompetenceStore,
  GradeError,
  estimateAccuracy,
  localAuthor,
  recordGrade,
  runBench,
  type AccuracyReport,
  type BenchHost,
  type BenchReport,
  type BenchRunResult,
  type CompetenceEntry,
} from '@kernelpai/learning';
import type { Journal } from '@kernelpai/journal';
import { inForbiddenZone } from '@kernelpai/tools';
import type { Confirm } from './confirm.js';
import { formatMoney, money, type Env } from './env.js';
import { KernelError } from './errors.js';
import { busPacks, policyFor, selectPacks } from './packs.js';
import type { GraphOptions } from './setup.js';
import type { Plan, RunHandle, StartRunInput } from './types.js';

export interface LearningHost {
  env: Env;
  cwd: string;
  journal(): Journal;
  confirm: Confirm;
  say(text: string): void;
  plan(request: string, options: GraphOptions): Promise<Plan>;
  startRun(input: StartRunInput): Promise<RunHandle>;
}

export interface GradeInput {
  runId: string;
  nodeId: string;
  grade: 'good' | 'bad';
  note?: string;
  /** Who grades; default the local user. Never a model. */
  author?: string;
}

export interface GradeResult {
  runId: string;
  nodeId: string;
  graded: string;
  taskType?: string;
}

export class KernelLearning {
  constructor(private readonly h: LearningHost) {}

  /** A human's grade of one node, journaled with its author (ADR-0028). */
  grade(i: GradeInput): GradeResult {
    try {
      const r = recordGrade(this.h.journal(), {
        run: i.runId,
        nodeId: i.nodeId,
        grade: i.grade,
        author: i.author ?? localAuthor(),
        ...(i.note ? { note: i.note } : {}),
      });
      const ref = `${r.ref.provider}/${r.ref.model}`;
      return {
        runId: r.runKey,
        nodeId: r.nodeId,
        graded: ref,
        ...(r.taskType ? { taskType: r.taskType } : {}),
      };
    } catch (err) {
      if (err instanceof GradeError) throw new KernelError(err.code, err.message);
      throw err;
    }
  }

  /** Measured competence here, best evidence first (what routing blends in). */
  competence(): CompetenceEntry[] {
    return CompetenceStore.fromJournal(this.h.journal(), { project: this.h.cwd }).entries();
  }

  /** Estimates against billed costs in this workspace (R-402). */
  accuracy(): AccuracyReport {
    return estimateAccuracy(this.h.journal(), { project: this.h.cwd });
  }

  /** Files the bench may read: never one in a forbidden zone in force here. */
  private async allowed(): Promise<(rel: string) => boolean> {
    const packs = await selectPacks(this.h.env, this.h.cwd).catch(() => undefined);
    const { policy } = await policyFor(this.h.env, packs ? busPacks(packs, 'bench') : undefined);
    const zones = policy.zoneSet();
    return (rel) => !inForbiddenZone(rel, zones);
  }

  /**
   * A short calibration on this repository: tasks planned (nothing spent), one question
   * with the total, then each task through the normal run path. Outputs are only read.
   */
  async bench(o: { perKind?: number; options?: GraphOptions } = {}): Promise<BenchReport> {
    const m = money(this.h.env);
    const options = { ...o.options, isolated: false };
    const plans = new Map<string, Plan>();
    const host: BenchHost = {
      plan: async (task) => {
        const p = await this.h.plan(task.request, options);
        plans.set(p.planId, p);
        return { planId: p.planId, expectedUsd: p.estimate.expectedUsd, capUsd: p.estimate.capUsd };
      },
      run: async (task, plan) => {
        const handle = await this.h.startRun({
          request: task.request,
          planId: plan.planId,
          options,
        });
        const order = plans.get(plan.planId)?.graph.nodes.map((n) => n.id) ?? [];
        return benchResult(handle, await handle.done, order);
      },
      confirm: (question) => this.h.confirm({ kind: 'budget', question }),
      say: (t) => this.h.say(t),
      money: (usd) => formatMoney(usd, m),
    };
    return runBench({
      root: this.h.cwd,
      allowed: await this.allowed(),
      journal: this.h.journal(),
      project: this.h.cwd,
      host,
      ...(o.perKind ? { perKind: o.perKind } : {}),
    });
  }
}

/** A run as the bench reads it: answers in graph order, the last one the deliverable. */
function benchResult(
  h: RunHandle,
  o: Awaited<RunHandle['done']>,
  order: readonly string[],
): BenchRunResult {
  const base = { runId: h.runId, sessionId: h.sessionId };
  if (o.status === 'not_run') return { ...base, status: 'not_run', cancelled: false, answers: [] };
  const answers = order
    .map((id) => o.result.results[id])
    .filter((r) => r !== undefined && r.ok && r.output !== '')
    .map((r) => ({ nodeId: r!.nodeId, text: r!.output }));
  return {
    ...base,
    status: 'finished',
    cancelled: o.cancelled,
    answers,
    costUsd: o.result.costUsd,
  };
}
