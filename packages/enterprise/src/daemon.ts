/**
 * The headless daemon's loop (R-5E2, R-5E4, R-507, ADR-0035). Each tick: (A) under the
 * store lock, every program takes one step and says what needs a run; (B) unlocked, those
 * work packages are planned (free with the template planner); (C) locked, jobs are queued
 * and the portfolio scheduler picks within the kill switch, concurrency limits, portfolio
 * cap and the spend-rate cap (S10 R3); (D) each pick is delegated in the background. Only
 * one daemon runs per `$KPAI_HOME` (`enterprise/daemon.pid`).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import {
  killList,
  policyFor,
  schedule,
  velocityBlocker,
  type EffectivePolicy,
  type Job,
  type Pick,
  type Queue,
  type RunRecord,
} from '@kernelpai/program';
import type { EnterpriseConfig } from './config.js';
import type { Ctx } from './context.js';
import { launch } from './dispatch.js';
import { GUARD_MS, guardRuns } from './guard.js';
import { HEARTBEAT_FILE, Liveness, readHeartbeat } from './liveness.js';
import { maybeDigest } from './period.js';
import { stepProgram, type Need } from './program-step.js';
import { recoverInterrupted } from './recover.js';
import { writeAtomic } from './store.js';

interface PlannedNeed extends Need {
  capUsd: number;
  providers: string[];
  source: 'local' | 'api' | 'subscription';
  policy: EffectivePolicy;
}

export class Daemon {
  readonly liveness: Liveness;
  private timer: NodeJS.Timeout | undefined;
  private guardTimer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;
  private owner = false;

  constructor(private readonly c: Ctx) {
    this.liveness = new Liveness(c);
  }

  get running(): boolean {
    return this.owner;
  }

  /** Takes the daemon slot, reconciles interrupted runs, beats once, then ticks. */
  async start(): Promise<boolean> {
    if (!this.claim()) return false;
    const now = this.c.clock();
    // Dead-man: a stale heartbeat left by the previous daemon is reported once it is back.
    const last = readHeartbeat(this.c.store.path(HEARTBEAT_FILE), now);
    if (last?.status === 'stale')
      this.c.outbox.push({ kind: 'alert', alert: { staleSince: last.at } });
    await this.c.store.locked(() => recoverInterrupted(this.c, now));
    await this.c.store.locked(() => this.liveness.maybeBeat(this.c.store.config(), now, true));
    this.notify();
    const every = this.c.store.config().tickMs;
    this.timer = setInterval(() => void this.tick(), every);
    this.timer.unref();
    // P5-F1: a kill, stop or pause from another process reaches this process's runs fast.
    this.guardTimer = setInterval(() => this.guard(), Math.min(every, GUARD_MS));
    this.guardTimer.unref();
    return true;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.guardTimer) clearInterval(this.guardTimer);
    this.timer = this.guardTimer = undefined;
    await this.ticking;
    if (this.owner) rmSync(this.c.store.path('daemon.pid'), { force: true });
    this.owner = false;
  }

  /** One pass; overlapping calls share the pass in progress. */
  tick(): Promise<void> {
    this.ticking ??= this.pass().finally(() => (this.ticking = undefined));
    return this.ticking;
  }

  /** Cancels or pauses this process's runs per the store (P5-F1); never throws. */
  guard(): ReturnType<typeof guardRuns> | undefined {
    try {
      return guardRuns(this.c);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.c.feed.line(`run guard failed: ${why.slice(0, 200)}`);
      return undefined;
    }
  }

  private async pass(): Promise<void> {
    this.guard();
    const cfg = this.c.store.config();
    const needs = await this.c.store.locked(() => this.steps(cfg));
    const planned = await this.plan(needs, cfg);
    const picks = await this.c.store.locked(() => this.enqueue(cfg, planned));
    for (const p of picks) {
      this.c.inflight.add(p.job.id);
      void launch(this.c, p);
    }
    await this.c.store.locked(() => this.liveness.maybeBeat(cfg, this.c.clock()));
    this.notify();
  }

  /** Sends what the pass queued, in the background: a channel never blocks a program. */
  private notify(): void {
    if (!this.c.outbox.pending) return;
    const p = this.c.outbox.flush();
    this.c.settling.add(p);
    void p.finally(() => this.c.settling.delete(p));
  }

  private steps(cfg: EnterpriseConfig): Need[] {
    const now = this.c.clock();
    const q = this.c.store.queue();
    const out: Need[] = [];
    for (const id of this.c.store.ids()) {
      const busy = (wpId: string): boolean =>
        [...q.pending, ...q.running.map((r) => r.job)].some(
          (j) => j.programId === id && j.wpId === wpId,
        );
      try {
        out.push(...stepProgram(this.c, id, now, busy, cfg.portfolio.killSwitch));
        maybeDigest(this.c, id, now);
      } catch (err) {
        this.c.feed.line(
          `step failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
          id,
        );
      }
    }
    return out;
  }

  private async plan(needs: Need[], cfg: EnterpriseConfig): Promise<PlannedNeed[]> {
    const out: PlannedNeed[] = [];
    for (const n of needs) {
      try {
        // P5-F3: planned within the effective policy, as `delegate` plans it again.
        const { charter } = this.c.store.read(n.programId).state;
        const policy = policyFor(charter, n.wpId, cfg.portfolio.sources);
        const p = await this.c.starter.plan({ ...n, packs: [], policy });
        const figures = { capUsd: p.capUsd, providers: p.providers, source: p.source };
        out.push({ ...n, ...figures, policy });
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        this.c.feed.line(`${n.wpId}: cannot be planned (${why.slice(0, 200)})`, n.programId);
      }
    }
    return out;
  }

  private enqueue(cfg: EnterpriseConfig, planned: PlannedNeed[]): Pick[] {
    const now = this.c.clock();
    let q = this.c.store.queue();
    for (const n of planned) {
      if (q.pending.some((j) => j.programId === n.programId && j.wpId === n.wpId)) continue;
      // D-029 R1: nobody watches a daemon's run, so a subscription agent never runs it.
      if (!n.providers.length) continue;
      if (n.source === 'subscription') {
        this.c.starter.forgetWp(n.programId, n.wpId);
        this.c.feed.line(
          `${n.wpId}: held, subscription agents run only interactively (D-029 R1)`,
          n.programId,
        );
        continue;
      }
      q = { ...q, pending: [...q.pending, jobOf(n, now)] };
      this.c.feed.notify('enterprise.wp', {
        programId: n.programId,
        wpId: n.wpId,
        to: 'queue',
        state: 'queued',
      });
    }
    const picks = this.pick(cfg, q, now);
    this.c.store.saveQueue(q);
    return picks;
  }

  /** The scheduler's picks among jobs not already being delegated, under the spend rate. */
  private pick(cfg: EnterpriseConfig, q: Queue, now: Date): Pick[] {
    const inflight = q.pending.filter((j) => this.c.inflight.has(j.id));
    const view: Queue = {
      ...q,
      pending: q.pending.filter((j) => !this.c.inflight.has(j.id)),
      running: [
        ...q.running,
        ...inflight.map((job) => ({
          job,
          provider: job.candidates[0]!.provider,
          source: job.candidates[0]!.source,
          startedAt: now.toISOString(),
        })),
      ],
    };
    const active = (id: string): boolean =>
      ['running', 'gate'].includes(this.c.store.read(id).state.status);
    const check = (j: Job) =>
      active(j.programId)
        ? ({ verdict: 'allow', rule: 'program.active', reason: '' } as const)
        : ({ verdict: 'refuse', rule: 'program.inactive', reason: 'not running' } as const);
    const { start } = schedule(cfg.portfolio, view, now, check);
    const runs: RunRecord[] = this.c.store.ids().flatMap((id) => this.c.store.read(id).state.runs);
    runs.push(...inflight.map((j) => pseudoRun(j, now)));
    const out: Pick[] = [];
    for (const p of start) {
      const why = velocityBlocker(runs, p.job.capUsd, cfg.usdPerHour, now);
      if (why) {
        this.c.feed.line(`${p.job.wpId}: held, ${why}`, p.job.programId);
        continue;
      }
      runs.push(pseudoRun(p.job, now));
      out.push(p);
    }
    return out;
  }

  /**
   * Kill switch: nothing starts, every live program run is cancelled; programs stay. Runs
   * of a daemon in another process are cancelled by its own guard (P5-F1).
   */
  async kill(on: boolean): Promise<string[]> {
    const ids = await this.c.store.locked(() => {
      const cfg = this.c.store.config();
      this.c.store.saveConfig({ ...cfg, portfolio: { ...cfg.portfolio, killSwitch: on } });
      return on ? killList(this.c.store.queue()) : [];
    });
    // This process's runs at once; a daemon in another process on its next guard check.
    const cancelled = on ? (this.guard()?.cancel ?? []) : [];
    this.c.fact(undefined, {
      action: on ? 'kill switch on' : 'kill switch off',
      cancelled,
      jobs: ids.length,
    });
    this.c.feed.line(
      on ? `kill switch on: ${cancelled.length} run(s) cancelled` : 'kill switch off',
    );
    return cancelled;
  }

  /** One daemon per home: a live pid in `daemon.pid` keeps the slot. */
  private claim(): boolean {
    const path = this.c.store.path('daemon.pid');
    if (existsSync(path)) {
      const pid = Number(readFileSync(path, 'utf8').trim());
      if (pid !== process.pid && pidAlive(pid)) return false;
    }
    writeAtomic(path, String(process.pid));
    this.owner = true;
    return true;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function jobOf(n: PlannedNeed, now: Date): Job {
  return {
    id: `job-${randomBytes(5).toString('hex')}`,
    programId: n.programId,
    wpId: n.wpId,
    priority: n.purpose === 'review' ? 'high' : 'normal',
    candidates: n.providers.slice(0, 8).map((provider) => ({ provider, source: n.source })),
    // P5-F3: the scheduler holds the job to its work package's policy too.
    policy: {
      sources: n.policy.sources,
      ...(n.policy.providers ? { providers: n.policy.providers.slice(0, 30) } : {}),
      denyProviders: n.policy.deny.slice(0, 30),
    },
    capUsd: n.capUsd,
    enqueuedAt: now.toISOString(),
    attempts: 0,
  };
}

/** A pick's band top, counted against the spend rate before it really starts. */
function pseudoRun(j: Job, now: Date): RunRecord {
  return {
    runId: j.id,
    wpId: j.wpId,
    phaseId: j.wpId,
    capUsd: j.capUsd,
    costUsd: 0,
    status: 'running',
    purpose: 'work',
    source: 'api',
    hours: 0,
    providers: [],
    evidence: [],
    startedAt: now.toISOString(),
  };
}
