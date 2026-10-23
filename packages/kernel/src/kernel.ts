/**
 * The kernel service layer (ADR-0019): what a front end can ask of KernelPAI. The CLI and
 * the console server are thin clients of this class; every safety rule lives here once
 * (workspace guard, budget gates, graph cap, critic-approved patches, confirmed writes,
 * serialized confirmations).
 */
import { randomUUID } from 'node:crypto';
import type { ModelRef } from '@kernelpai/core';
import type { Journal } from '@kernelpai/journal';
import type { ControlOutcome, PlanCheck, RunControl } from '@kernelpai/orchestrator';
import { applyAll } from './apply.js';
import type { GateHost } from './budget-gate.js';
import { hostConfirm, type Confirm } from './confirm.js';
import { KernelError } from './errors.js';
import { checkEdit, editedPlan, makePlan } from './planning.js';
import { Queries } from './queries.js';
import { executeRun, type ActiveRun, type RunContext } from './run.js';
import type { GraphOptions } from './setup.js';
import type {
  ApplyResult,
  KernelHost,
  Plan,
  RunHandle,
  RunOutcome,
  RunState,
  StartRunInput,
} from './types.js';
import { workspaceProblem } from './workspace.js';

const KEEP_PLANS = 32;
const KEEP_RUNS = 32;
const SESSION_IDLE_MS = 30 * 60_000;
const FINISHED: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled']);

interface StoredRun extends ActiveRun {
  done: Promise<RunOutcome>;
}

export class Kernel extends Queries {
  private readonly plans = new Map<string, Plan>();
  private readonly runs = new Map<string, StoredRun>();
  private readonly confirm: Confirm;
  private readonly gateHost: GateHost;

  constructor(host: KernelHost, journal?: Journal) {
    super(host, journal);
    this.confirm = hostConfirm(host.confirm);
    this.gateHost = {
      env: host.env,
      cwd: host.cwd,
      say: (t) => host.say?.(t),
      confirm: this.confirm,
    };
  }

  /** A new session, or the one used in this folder in the last 30 minutes (`resume`). */
  openSession(title: string, resume: boolean): string {
    const found = resume
      ? this.journal.resumableSession(this.host.cwd, SESSION_IDLE_MS, new Date())
      : undefined;
    return found?.id ?? this.journal.startSession(title.slice(0, 80), this.host.cwd);
  }

  /** Tools act in the workspace: refuse the home folder, a drive root, a non-project. */
  checkWorkspace(): void {
    const problem = workspaceProblem(this.host.cwd);
    if (problem) throw new KernelError('workspace', problem);
  }

  /**
   * Plans a request: graph, who would do what, the cost range and band, each node's
   * routing reason. Runs nothing; a model planner is a paid call, so it is
   * workspace-guarded and budget-gated first.
   */
  async plan(request: string, options: GraphOptions = {}, sessionId?: string): Promise<Plan> {
    if (options.planner === 'model') this.checkWorkspace();
    const sid = sessionId ?? this.openSession(request, true);
    const plan = await makePlan(
      { gateHost: this.gateHost, journal: this.journal },
      request,
      options,
      sid,
    );
    this.plans.set(plan.planId, plan);
    while (this.plans.size > KEEP_PLANS) this.plans.delete(this.plans.keys().next().value!);
    return plan;
  }

  /** Checks a user-edited graph of a plan and re-estimates it (R-301). Runs nothing. */
  validatePlan(planId: string, graph: unknown): PlanCheck {
    const plan = this.plans.get(planId);
    if (!plan) throw new KernelError('not_found', `no plan ${planId} (plans expire; plan again)`);
    return checkEdit(plan, graph, this.journal).check;
  }

  /**
   * Starts an approved plan, as proposed or as edited (`graph`), or plans again when no
   * `planId`. Throws before anything is spent when the workspace is not a project, an
   * edit does not check out or a node cannot be routed; the whole-graph budget check then
   * runs inside `done` (it may ask the human).
   */
  async startRun(input: StartRunInput): Promise<RunHandle> {
    this.checkWorkspace();
    if (input.graph !== undefined && !input.planId)
      throw new KernelError('invalid', 'an edited graph needs the planId it was edited from');
    const proposed = input.planId ? this.planById(input.planId, input.request) : undefined;
    const planned = proposed ?? (await this.plan(input.request, input.options ?? {}));
    const p = input.graph !== undefined ? editedPlan(planned, input.graph, this.journal) : planned;
    this.journal.append({
      sessionId: p.sessionId,
      type: 'routing',
      nodeId: p.graph.id,
      payload: { plan: p.graph, estimate: p.estimate, ...(p.edits ? { edits: p.edits } : {}) },
    });
    if (!p.estimate.complete) {
      const problems = p.estimate.problems.join('; ');
      throw new KernelError('unroutable', `some nodes cannot be routed: ${problems}`);
    }
    return this.launch(p, input.options);
  }

  private launch(p: Plan, options: GraphOptions | undefined): RunHandle {
    const run = {
      runId: randomUUID(),
      plan: p,
      flags: { ...p.options, ...options },
      ctl: new AbortController(),
      state: 'starting',
    } as StoredRun;
    const ctx: RunContext = {
      host: this.host,
      journal: this.journal,
      gateHost: this.gateHost,
      setState: (r, s) => this.setState(r, s),
    };
    this.host.onRunPlanned?.(run.runId, p);
    run.done = executeRun(ctx, run).then((o) => (run.outcome = o));
    run.done.catch(() => this.setState(run, 'failed'));
    this.runs.set(run.runId, run);
    for (const [id, r] of this.runs) {
      if (this.runs.size <= KEEP_RUNS) break;
      if (FINISHED.has(r.state)) this.runs.delete(id);
    }
    return { runId: run.runId, planId: p.planId, sessionId: p.sessionId, done: run.done };
  }

  private planById(planId: string, request: string): Plan {
    const plan = this.plans.get(planId);
    if (!plan) throw new KernelError('not_found', `no plan ${planId} (plans expire; plan again)`);
    if (plan.request !== request)
      throw new KernelError('invalid', `plan ${planId} was made for another request`);
    return plan;
  }

  private setState(run: ActiveRun, state: RunState): void {
    if (run.state === state) return;
    run.state = state;
    this.host.onRunState?.(run.runId, state);
  }

  private runById(runId: string): StoredRun {
    const run = this.runs.get(runId);
    if (!run) throw new KernelError('not_found', `no run ${runId}`);
    return run;
  }

  /** Cancels a run: running steps stop and keep their partial output. False if finished. */
  cancel(runId: string): boolean {
    const run = this.runById(runId);
    if (FINISHED.has(run.state) || run.ctl.signal.aborted) return false;
    // A live runner journals and reports the cancel itself; before it starts, the kernel does.
    if (!run.runner?.status().active) {
      this.journal.append({
        sessionId: run.plan.sessionId,
        type: 'intervention',
        payload: { action: 'cancel graph' },
      });
    } else run.runner.cancel();
    run.ctl.abort();
    this.setState(run, 'cancelling');
    return true;
  }

  /** Stops scheduling new nodes; nodes in flight finish (R-304). */
  pause(runId: string): void {
    this.steer(runId, (c) => c.pause());
  }

  resume(runId: string): void {
    this.steer(runId, (c) => c.resume());
  }

  /** Principle 4: moves a pending or running node to another model; finished work is kept. */
  async redirect(runId: string, nodeId: string, to: ModelRef): Promise<void> {
    const runner = this.liveRunner(runId);
    refusedUnlessOk(await runner.redirect(nodeId, to));
  }

  /** Adds a human instruction to a node that has not started (R-304). */
  instruct(runId: string, nodeId: string, text: string): void {
    this.steer(runId, (c) => c.addInstruction(nodeId, text));
  }

  private steer(runId: string, act: (c: RunControl) => ControlOutcome): void {
    refusedUnlessOk(act(this.liveRunner(runId)));
  }

  private liveRunner(runId: string): RunControl {
    const run = this.runById(runId);
    if (FINISHED.has(run.state)) throw new KernelError('refused', `run ${runId} has finished`);
    if (!run.runner?.status().active)
      throw new KernelError('refused', `run ${runId} has not started yet (budget check)`);
    return run.runner;
  }

  /** Where a run stands: its state and, once finished, its outcome. */
  runInfo(runId: string): { state: RunState | 'starting'; outcome?: RunOutcome } {
    const run = this.runById(runId);
    return { state: run.state, ...(run.outcome ? { outcome: run.outcome } : {}) };
  }

  /**
   * Applies a finished run's critic-approved patches (all, or those of `nodeIds`). Never
   * after a cancel (review P2-F6); each write is confirmed unless `yesApply`.
   */
  async applyPatches(
    runId: string,
    opts: { nodeIds?: string[]; yesApply?: boolean } = {},
  ): Promise<ApplyResult[]> {
    const run = this.runById(runId);
    const o = run.outcome;
    if (!o) throw new KernelError('refused', `run ${runId} has not finished`);
    if (o.status !== 'finished' || o.cancelled)
      throw new KernelError('refused', `run ${runId} was cancelled or not run: nothing is applied`);
    const wanted = opts.nodeIds ? new Set(opts.nodeIds) : undefined;
    const patches = o.patches.filter((p) => !wanted || wanted.has(p.nodeId));
    if (wanted && patches.length === 0)
      throw new KernelError('not_found', 'no approved patch for these nodes');
    const ctx = {
      host: this.host,
      journal: this.journal,
      confirm: this.confirm,
      sessionId: run.plan.sessionId,
      runId,
      ...(opts.yesApply ? { yesApply: true } : {}),
    };
    return applyAll(ctx, patches);
  }

  /** Cancels what still runs, waits for it, closes the journal. */
  async close(): Promise<void> {
    for (const run of this.runs.values()) if (!FINISHED.has(run.state)) run.ctl.abort();
    await Promise.allSettled([...this.runs.values()].map((r) => r.done));
    this.closeJournal();
  }
}

function refusedUnlessOk(o: ControlOutcome): void {
  if (!o.ok) throw new KernelError('refused', o.reason);
}
