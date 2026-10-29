/**
 * The kernel service layer (ADR-0019): what a front end can ask of KernelPAI. The CLI and
 * the console server are thin clients of this class; every safety rule lives here once
 * (workspace guard, budget gates, graph cap, critic-approved patches, confirmed writes,
 * serialized confirmations).
 */
import { randomUUID } from 'node:crypto';
import type { ModelRef } from '@kernelpai/core';
import type { Journal } from '@kernelpai/journal';
import type { ControlOutcome, ReplayResult, RunControl } from '@kernelpai/orchestrator';
import { applyAll, applyArtifacts, runApplyContext, type ApplyContext } from './apply.js';
import type { GateHost } from './budget-gate.js';
import { askJournal } from './asks.js';
import { askQueue, hostChoose, hostConfirm, type Choose, type Confirm } from './confirm.js';
import { KernelError } from './errors.js';
import { checkEdit, editedPlan, makePlan, type KernelPlanCheck } from './planning.js';
import { Queries } from './queries.js';
import { executeRun, type ActiveRun, type RunContext } from './run.js';
import type { GraphOptions } from './setup.js';
import type {
  ApplyResult,
  ArtifactApplyResult,
  KernelHost,
  RunSummary,
  Plan,
  RunHandle,
  RunOutcome,
  RunState,
  StartRunInput,
} from './types.js';
import { busPacks, selectPacks } from './packs.js';
import { summarizeRun } from './runs-view.js';
import { askZoneRelaxations, gatherScope, guardWorkspace } from './authorise.js';
import { checkScope } from './scope.js';
import { CANCEL_ACTION, notWritable, planRecord, recordedOutcome, runFlags } from './run-record.js';
import { WorkspaceOps, type CheckpointInfo } from './workspace-ops.js';
import { KernelMemory, type ExportResult } from './memory-service.js';
import { KernelLearning } from './learning.js';
import { KernelReplays, type ReplayFlags, type ReplayHandle, type ReplayPlan } from './replay.js';
import { KernelTickets } from './tickets-service.js';
import type { PackZoneOptions } from '@kernelpai/tools';

const KEEP_PLANS = 32;
const KEEP_RUNS = 32;
const SESSION_IDLE_MS = 30 * 60_000;
const FINISHED: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled']);

interface StoredRun extends ActiveRun {
  done: Promise<RunOutcome>;
  /** The human is asked about the run's memory proposals once it is done (ADR-0027). */
  asked?: Promise<unknown>;
}

export class Kernel extends Queries {
  private readonly plans = new Map<string, Plan>();
  private readonly runs = new Map<string, StoredRun>();
  private readonly confirm: Confirm;
  private readonly choose: Choose;
  private readonly gateHost: GateHost;
  /** Checkpoints, restore, worktrees (R-305, R-307). */
  readonly workspace: WorkspaceOps;
  /** Unified memory: facts, pending proposals, export (ADR-0027). */
  readonly memory: KernelMemory;
  /** Grades, measured competence, estimate accuracy, bench (ADR-0028). */
  readonly learning: KernelLearning;
  /** Replay a node, plan a fork (R-403); a fork starts with `startFork`. */
  readonly replays: KernelReplays;
  /** Local Markdown tickets as run input, status written back on confirmation (ADR-0033). */
  readonly tickets: KernelTickets;

  constructor(host: KernelHost, journal?: Journal) {
    super(host, journal);
    // A question of a run cancelled while it waited is declined unasked (review P3-F2).
    const queue = askQueue();
    const voided = (req: { runId?: string }): boolean => this.cancelling(req.runId);
    // S10 R6 J2: each answered question of a run is journaled in the run's session.
    const log = askJournal(() => this.journal, this.runs);
    this.confirm = hostConfirm(host.confirm, voided, queue, log);
    // Disputes share the confirmations' queue: one question at a time (R-405, P2-F7).
    this.choose = hostChoose(host.choose, voided, queue);
    this.workspace = new WorkspaceOps({
      env: host.env,
      cwd: host.cwd,
      journal: () => this.journal,
      confirm: this.confirm,
      say: (t) => host.say?.(t),
    });
    this.gateHost = {
      env: host.env,
      cwd: host.cwd,
      say: (t) => host.say?.(t),
      confirm: this.confirm,
    };
    this.memory = new KernelMemory({
      env: host.env,
      cwd: host.cwd,
      journal: () => this.journal,
      session: (action) => this.openSession(action, true),
      confirm: this.confirm,
      checkpoint: (label, sid) =>
        this.workspace.before(host.cwd, `memory-${randomUUID().slice(0, 8)}`, label, sid),
    });
    this.learning = new KernelLearning({
      ...this.gateHost,
      journal: () => this.journal,
      plan: (request, options) => this.plan(request, options),
      startRun: (input) => this.startRun(input),
    });
    this.tickets = new KernelTickets({
      env: host.env,
      cwd: host.cwd,
      journal: () => this.journal,
      confirm: this.confirm,
      session: (title) => this.openSession(title, true),
    });
    this.replays = new KernelReplays({
      gateHost: this.gateHost,
      choose: this.choose,
      journal: () => this.journal,
      session: (title) => this.openSession(title, false),
    });
  }

  /**
   * Reruns a finished run's node beside the original (R-403); never while the run is live.
   * Plans the replay and starts it at once: its cap is still checked against the budget
   * (D-021). Front ends that show the estimate first use `replayPlan` and `startReplay`.
   */
  async replay(...args: Parameters<KernelReplays['plan']>): Promise<ReplayResult> {
    const plan = await this.replayPlan(...args);
    const o = args[3] ?? {};
    return (await this.startReplay(plan.planId, { yes: o.yes, overBudget: o.overBudget })).done;
  }

  /** A replay's likely cost and cap, before anything is spent (P4-F5). Runs nothing. */
  async replayPlan(...args: Parameters<KernelReplays['plan']>): Promise<ReplayPlan> {
    this.notLive(args[0], 'replay a node');
    return this.replays.plan(...args);
  }

  /**
   * Starts a planned replay. It spends and its tools act in the workspace, so the workspace
   * is guarded like a run's; `cancel(replayId)` stops it (P4-F5).
   */
  async startReplay(planId: string, flags: ReplayFlags = {}): Promise<ReplayHandle> {
    await this.checkWorkspace();
    return this.replays.start(planId, flags);
  }

  /** Plans a fork of a past run from a node (R-403); start it with `startFork`. */
  async forkPlan(...args: Parameters<KernelReplays['forkPlan']>): Promise<Plan> {
    this.notLive(args[0], 'fork it');
    const plan = await this.replays.forkPlan(...args);
    this.keepPlan(plan);
    return plan;
  }

  /** Starts a planned fork: budget-checked on its band top (D-021) like any plan. */
  startFork(planId: string, options: GraphOptions = {}): Promise<RunHandle> {
    const plan = this.plans.get(planId);
    if (!plan?.fork) throw new KernelError('not_found', `no fork plan ${planId} (plan it again)`);
    return this.startRun({ request: plan.request, planId, options });
  }

  private keepPlan(plan: Plan): void {
    this.plans.set(plan.planId, plan);
    while (this.plans.size > KEEP_PLANS) this.plans.delete(this.plans.keys().next().value!);
  }

  /** Writes the project memory to `.kpstudio/memory.md`; not while a run writes in place. */
  exportMemory(): Promise<ExportResult> {
    this.noLiveRunInPlace('export memory');
    return this.memory.exportToRepo();
  }

  /** Asks about a finished run's memory proposals; what is not confirmed stays pending. */
  private async askProposals(runId: string, o: RunOutcome): Promise<void> {
    if (o.status !== 'finished' || !o.proposals?.length) return;
    const r = await this.memory.ask(o.proposals, runId);
    for (const f of r.confirmed) this.host.say?.(`memory: kept ${f.id} (${f.layer})\n`);
    if (r.pending)
      this.host.say?.(`memory: ${r.pending} proposal(s) pending (kpai memory pending)\n`);
  }

  /** A new session, or the one used in this folder in the last 30 minutes (`resume`). */
  openSession(title: string, resume: boolean): string {
    const found = resume
      ? this.journal.resumableSession(this.host.cwd, SESSION_IDLE_MS, new Date())
      : undefined;
    return found?.id ?? this.journal.startSession(title.slice(0, 80), this.host.cwd);
  }

  /**
   * Tools act in the workspace: refuse the home folder, a drive root, a non-project. A
   * domain pack's files make a folder a project (WI-S1-01); opt-in files are asked once.
   */
  async checkWorkspace(): Promise<void> {
    await guardWorkspace(this.host.env, this.host.cwd, this.confirm);
  }

  /**
   * Plans a request: graph, who would do what, the cost range and band, each node's
   * routing reason. Runs nothing; a model planner is a paid call, so it is
   * workspace-guarded and budget-gated first.
   */
  async plan(request: string, options: GraphOptions = {}, sessionId?: string): Promise<Plan> {
    if (options.planner === 'model') await this.checkWorkspace();
    const sid = sessionId ?? this.openSession(request, true);
    const plan = await makePlan(
      { gateHost: this.gateHost, journal: this.journal },
      request,
      options,
      sid,
    );
    this.keepPlan(plan);
    return plan;
  }

  /** Checks a user-edited graph of a plan and re-estimates it (R-301). Runs nothing. */
  validatePlan(planId: string, graph: unknown): KernelPlanCheck {
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
    await this.checkWorkspace();
    if (input.graph !== undefined && !input.planId)
      throw new KernelError('invalid', 'an edited graph needs the planId it was edited from');
    const proposed = input.planId ? this.planById(input.planId, input.request) : undefined;
    const planned = proposed ?? (await this.plan(input.request, input.options ?? {}));
    const p = input.graph !== undefined ? editedPlan(planned, input.graph, this.journal) : planned;
    this.journal.append(planRecord(p));
    if (!p.estimate.complete) {
      const problems = p.estimate.problems.join('; ');
      throw new KernelError('unroutable', `some nodes cannot be routed: ${problems}`);
    }
    // A scope given at launch replaces the one checked when planning.
    const given = input.options?.scope;
    const scoped =
      given === undefined
        ? p
        : { ...p, scope: await checkScope(p.packs.selected, this.host.cwd, given, p.graph.nodes) };
    const scope = await gatherScope(this.journal, this.confirm, scoped);
    const env = this.host.env;
    const packs = await askZoneRelaxations(env, this.host.cwd, this.confirm, scoped.packs);
    return this.launch({ ...scoped, packs }, input.options, scope);
  }

  private launch(p: Plan, options: GraphOptions | undefined, scope: unknown): RunHandle {
    const run = {
      ...(scope !== undefined ? { scope } : {}),
      runId: randomUUID(),
      plan: p,
      flags: runFlags(p.options, options),
      ctl: new AbortController(),
      state: 'starting',
      startedAt: new Date().toISOString(),
      costUsd: 0,
      verdicts: new Map(),
    } as StoredRun;
    const ctx: RunContext = {
      host: this.host,
      journal: this.journal,
      gateHost: this.gateHost,
      choose: this.choose,
      ws: this.workspace,
      setState: (r, s) => this.setState(r, s),
    };
    this.host.onRunPlanned?.(run.runId, p);
    run.done = executeRun(ctx, run).then((o) => (run.outcome = o));
    run.done.catch(() => this.setState(run, 'failed'));
    run.asked = run.done.then((o) => this.askProposals(run.runId, o)).catch(() => undefined);
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

  /**
   * Cancels a run: running steps stop and keep their partial output. Its confirmations
   * still open or queued are declined (review P3-F2). False if finished.
   */
  cancel(runId: string): boolean {
    // A live replay's id (P4-F5): journaled by the replay, its questions closed.
    const replay = this.replays.cancel(runId);
    if (replay) this.host.cancelConfirmations?.(runId);
    if (replay !== undefined) return replay;
    const run = this.runById(runId);
    if (FINISHED.has(run.state) || run.ctl.signal.aborted) return false;
    // A live runner journals and reports the cancel itself; before it starts, the kernel does.
    if (!run.runner?.status().active) {
      this.journal.append({
        sessionId: run.plan.sessionId,
        type: 'intervention',
        payload: { action: CANCEL_ACTION, runId },
      });
    } else run.runner.cancel();
    run.ctl.abort();
    this.host.cancelConfirmations?.(runId);
    this.setState(run, 'cancelling');
    return true;
  }

  /** True while a cancelled run or replay winds down: its questions are void. */
  private cancelling(runId: string | undefined): boolean {
    if (this.replays.cancelling(runId)) return true;
    const run = runId === undefined ? undefined : this.runs.get(runId);
    return run !== undefined && run.ctl.signal.aborted && !FINISHED.has(run.state);
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

  /** The outcome of a finished run whose output may be written (never after a cancel, P2-F6). */
  private writable(runId: string): {
    run: StoredRun;
    o: Extract<RunOutcome, { status: 'finished' }>;
  } {
    const run = this.runById(runId);
    const o = run.outcome;
    if (!o) throw new KernelError('refused', `run ${runId} has not finished`);
    if (o.status !== 'finished' || o.cancelled)
      throw new KernelError('refused', `run ${runId} was cancelled or not run: nothing is applied`);
    return { run, o };
  }

  /** Writes go to the run's tree, each after a checkpoint of that tree (R-305, R-307). */
  private applyContext(run: StoredRun, yesApply: boolean | undefined): ApplyContext {
    const base = { host: this.host, journal: this.journal, confirm: this.confirm };
    return runApplyContext({ ...base, workspace: this.workspace }, run, yesApply);
  }

  /**
   * Applies a finished run's critic-approved patches (all, or those of `nodeIds`). Never
   * after a cancel (review P2-F6); each write is confirmed unless `yesApply`.
   */
  async applyPatches(
    runId: string,
    opts: { nodeIds?: string[]; yesApply?: boolean } = {},
  ): Promise<ApplyResult[]> {
    const { run, o } = this.writable(runId);
    const wanted = opts.nodeIds ? new Set(opts.nodeIds) : undefined;
    const patches = o.patches.filter((p) => !wanted || wanted.has(p.nodeId));
    if (wanted && patches.length === 0)
      throw new KernelError('not_found', 'no approved patch for these nodes');
    return applyAll(this.applyContext(run, opts.yesApply), patches);
  }

  /** Writes a finished run's approved artifacts (all, or those at `paths`), confirmed (D-019). */
  async applyArtifacts(
    runId: string,
    opts: { paths?: string[]; yesApply?: boolean } = {},
  ): Promise<ArtifactApplyResult[]> {
    const { run, o } = this.writable(runId);
    const wanted = opts.paths ? new Set(opts.paths) : undefined;
    const list = o.artifacts.filter((a) => !wanted || wanted.has(a.path));
    if (wanted && list.length === 0)
      throw new KernelError('not_found', 'no approved artifact at these paths');
    return applyArtifacts(this.applyContext(run, opts.yesApply), list);
  }

  /** The session to journal a workspace action in: the run's, else this folder's. */
  private sessionFor(runId: string, action: string): string {
    return this.runs.get(runId)?.plan.sessionId ?? this.openSession(`${action} ${runId}`, true);
  }

  /** Refuses while the run is live: its tree is still being written. */
  private notLive(runId: string, action: string): void {
    const run = this.runs.get(runId);
    if (run && !FINISHED.has(run.state))
      throw new KernelError('refused', `run ${runId} is still running: cannot ${action} now`);
  }

  /** Refuses while any run writing in place (not in its own worktree) is live. */
  private noLiveRunInPlace(action: string): void {
    for (const r of this.runs.values()) {
      if (!r.workRoot && !FINISHED.has(r.state))
        throw new KernelError(
          'refused',
          `run ${r.runId} is running in place: cannot ${action} now`,
        );
    }
  }

  /** The packs whose zones bind a workspace action: the run's plan, else the folder's now. */
  private async packZones(runId: string, sessionId: string): Promise<PackZoneOptions | undefined> {
    const run = this.runs.get(runId);
    if (run) return busPacks(run.plan.packs, sessionId);
    const now = await selectPacks(this.host.env, this.host.cwd).catch(() => undefined);
    return now ? busPacks(now, sessionId) : undefined;
  }

  /** Checkpoints of a run (workspace and worktree), oldest first (R-305). */
  async checkpoints(runId: string): Promise<CheckpointInfo[]> {
    return this.workspace.list(runId);
  }

  /** Restores a checkpoint of a run: destructive, confirmed, journaled (R-305). */
  async restore(ref: string, runId?: string): ReturnType<WorkspaceOps['restore']> {
    const owner = /^refs\/kpai\/checkpoints\/([^/]+?)(?:-wt)?\/\d+$/.exec(ref)?.[1];
    if (!owner || (runId !== undefined && owner !== runId))
      throw new KernelError(
        'invalid',
        `${ref.slice(0, 200)} is not a checkpoint of run ${runId ?? '?'}`,
      );
    this.notLive(owner, 'restore');
    // The workspace is also the tree of every in-place run (P3-F7).
    if (!/-wt\/\d+$/.test(ref)) this.noLiveRunInPlace('restore');
    const sessionId = this.sessionFor(owner, 'restore');
    return this.workspace.restore(ref, sessionId, await this.packZones(owner, sessionId));
  }

  /** Merges an isolated run's worktree into the workspace: a confirmed write (R-307). */
  async merge(runId: string): ReturnType<WorkspaceOps['merge']> {
    this.notLive(runId, 'merge');
    // Known here or not, the outcome is read from the journal (review P3-F7).
    const why = notWritable(runId, recordedOutcome(this.journal, runId));
    if (why) throw new KernelError('refused', why);
    const sessionId = this.sessionFor(runId, 'merge');
    return this.workspace.merge(runId, sessionId, await this.packZones(runId, sessionId));
  }

  /** Removes an isolated run's worktree (checkpoints are kept). */
  async discard(runId: string): Promise<{ removed: boolean }> {
    this.notLive(runId, 'discard');
    const r = await this.workspace.discard(runId, this.sessionFor(runId, 'discard'));
    const run = this.runs.get(runId);
    if (run) delete run.worktree;
    return r;
  }

  /** The runs manager view: every run this kernel knows, newest first (R-307). */
  async runList(): Promise<RunSummary[]> {
    const runs = [...this.runs.values()].reverse();
    return Promise.all(runs.map((r) => summarizeRun(r, this.workspace)));
  }

  /** Cancels what still runs, waits for it, closes the journal. */
  async close(): Promise<void> {
    for (const run of this.runs.values()) {
      if (FINISHED.has(run.state)) continue;
      run.ctl.abort();
      this.host.cancelConfirmations?.(run.runId);
    }
    await this.replays.close((id) => this.host.cancelConfirmations?.(id));
    await Promise.allSettled([...this.runs.values()].flatMap((r) => [r.done, r.asked]));
    this.closeJournal();
  }
}

function refusedUnlessOk(o: ControlOutcome): void {
  if (!o.ok) throw new KernelError('refused', o.reason);
}
