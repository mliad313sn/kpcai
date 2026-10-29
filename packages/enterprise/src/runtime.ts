/**
 * The Enterprise runtime (ADR-0031, ADR-0035): one object per process that serves the
 * `program.*` and `enterprise.*` protocol, the `kpai program` commands and, when started,
 * the headless daemon. It shares the host's kernel; the kernel's questions for a program
 * run are routed here (`confirmFor`) and answered by the envelope or the Sponsor's inbox.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  KernelError,
  kpaiHome,
  type ConfirmRequest,
  type GraphOptions,
  type Kernel,
  type KernelHost,
} from '@kernelpai/kernel';
import { charterHash, type ProgramState } from '@kernelpai/program';
import type { ChannelsFile } from './channels/config.js';
import { Outbox, type Delivery } from './channels/outbox.js';
import { ConfirmGate } from './confirm-gate.js';
import { sessionCache, type Ctx } from './context.js';
import { Daemon } from './daemon.js';
import { draftProgram, type DraftInput, type Drafted } from './draft.js';
import { Feed, type Activity, type Emit } from './feed.js';
import { HEARTBEAT_FILE, readHeartbeat, type Heartbeat } from './liveness.js';
import type { ProgramMeta } from './meta.js';
import { programCard, snapshot } from './snapshot.js';
import { Sponsor } from './sponsor.js';
import { KernelRunStarter, programContext } from './starter.js';
import { watch } from './dispatch.js';
import { EnterpriseStore, writeAtomic } from './store.js';

export interface RuntimeOptions {
  kernel: Kernel;
  env: KernelHost['env'];
  /** Defaults of every program run (`allowTest` for offline demos). */
  options?: GraphOptions;
  emit?: Emit;
  clock?: () => Date;
  /** Poll interval while a run waits for the Sponsor (tests use a short one). */
  pollMs?: number;
}

export class EnterpriseRuntime {
  readonly store: EnterpriseStore;
  readonly feed: Feed;
  readonly daemon: Daemon;
  readonly sponsor: Sponsor;
  private readonly c: Ctx;

  constructor(private readonly o: RuntimeOptions) {
    this.store = new EnterpriseStore(kpaiHome(o.env));
    this.feed = new Feed(this.store.path('activity.jsonl'), o.emit);
    const clock = o.clock ?? (() => new Date());
    const sessionOf = sessionCache(o.kernel);
    const c = {
      store: this.store,
      kernel: o.kernel,
      feed: this.feed,
      clock,
      options: o.options ?? {},
      live: new Map(),
      activity: new Map(),
      inflight: new Set<string>(),
      settling: new Set<Promise<unknown>>(),
      sessionOf,
      fact: (programId: string | undefined, payload: Record<string, unknown>) => {
        const clean = Object.fromEntries(
          Object.entries(payload).filter(([, v]) => v !== undefined),
        );
        o.kernel.recordFact(sessionOf(programId), clean);
      },
    } as unknown as Ctx;
    c.gate = new ConfirmGate({
      store: this.store,
      kernel: o.kernel,
      feed: this.feed,
      clock,
      waitMs: () => this.store.config().confirmWaitMinutes * 60_000,
      ...(o.pollMs ? { pollMs: o.pollMs } : {}),
      session: (id) => sessionOf(id),
    });
    c.outbox = new Outbox({
      store: this.store,
      feed: this.feed,
      env: o.env,
      clock,
      fact: (id, payload) => c.fact(id, payload),
    });
    c.starter = new KernelRunStarter({
      kernel: o.kernel,
      options: c.options,
      reviewExclude: (id) => this.builders(id),
      charterHash: (id) => charterHash(this.store.read(id).state.charter),
      onStarted: (s) => watch(c, s),
    });
    this.c = c;
    this.daemon = new Daemon(c);
    this.sponsor = new Sponsor(c);
  }

  /** The context (tests swap the starter for a fake kernel side). */
  get ctx(): Ctx {
    return this.c;
  }

  private builders(id: string): string[] {
    const s = this.store.read(id).state;
    const phase = s.charter.phases[s.phaseIndex]?.id;
    return [
      ...new Set(
        s.runs
          .filter((r) => r.phaseId === phase && r.purpose === 'work')
          .flatMap((r) => r.providers),
      ),
    ];
  }

  /** The kernel asks a question: a program run's goes to the envelope, others to the human. */
  confirmFor(req: ConfirmRequest): Promise<boolean> | undefined {
    const ctx = programContext.getStore();
    return ctx ? this.c.gate.decide(ctx, req) : undefined;
  }

  /**
   * The kernel cancelled a run (`KernelHost.cancelConfirmations`): a program run's
   * question waiting in the Sponsor's inbox ends now, as a no, and expires (P5-R1).
   */
  cancelConfirmations(runId: string): void {
    this.c.gate.abandon(runId, 'run cancelled');
  }

  /** Disputes in a program run fail closed: picking an answer is a human choice (R-405). */
  chooseFor(): Promise<string | null> | undefined {
    const ctx = programContext.getStore();
    if (!ctx) return undefined;
    this.c.fact(ctx.programId, { action: 'dispute rejected: unattended', wpId: ctx.wpId });
    return Promise.resolve(null);
  }

  /** Kernel activity on a run (the watchdog's stalled-worker signal). */
  touch(runId: string): void {
    if (this.c.live.has(runId)) this.c.activity.set(runId, this.c.clock().toISOString());
  }

  create(input: DraftInput): Promise<Drafted> {
    return draftProgram(this.c, this.o.kernel, input);
  }

  list() {
    return this.store.ids().map((id) => programCard(this.store.read(id)));
  }

  get(id: string): ProgramState & { meta: ProgramMeta; charterHash: string } {
    if (!this.store.has(id)) throw new KernelError('not_found', `no program ${id.slice(0, 80)}`);
    const { state, meta } = this.store.read(id);
    return { ...state, meta, charterHash: charterHash(state.charter) };
  }

  reports(id: string, since?: string) {
    const { meta } = this.store.read(id);
    return meta.reports
      .filter((r) => !since || r.at > since)
      .map((r) => ({
        programId: id,
        ...r,
        markdown: readFileSync(this.store.file(id, `reports/${r.reportId}.md`), 'utf8'),
      }));
  }

  /** The program's transition log and whether its hash chain holds. */
  history(id: string) {
    return this.store.history(id);
  }

  snapshot() {
    return snapshot(this.c);
  }

  activity(since = 0, limit = 200): { items: Activity[]; cursor: number } {
    return { items: this.feed.since(since, limit), cursor: this.feed.seq };
  }

  heartbeat(): Heartbeat {
    const hb = readHeartbeat(this.store.path(HEARTBEAT_FILE), this.c.clock());
    if (hb) return hb;
    const cfg = this.store.config();
    return {
      at: new Date(0).toISOString(),
      pid: 0,
      intervalSec: cfg.heartbeatSec,
      staleAfterSec: cfg.heartbeatSec * 3,
      status: 'stale',
      alerts: [],
      programs: 0,
      running: 0,
    };
  }

  /** Outbound channels as configured: env var names, never their values (ADR-0036). */
  channels(): ChannelsFile {
    return this.c.outbox.config();
  }

  /** `kpai notify test`: one content-free test notice to one configured channel. */
  notifyTest(channelId: string): Promise<Delivery[]> {
    return this.c.outbox.deliver({ kind: 'test', channelId });
  }

  /**
   * The dead-man check for cron (`kpai notify check`): a stale heartbeat alerts the channels
   * once per silence. Returns the heartbeat's status, `none` when no daemon ever ran here.
   */
  async deadManCheck(): Promise<'ok' | 'alert' | 'stale' | 'none'> {
    const hb = readHeartbeat(this.store.path(HEARTBEAT_FILE), this.c.clock());
    if (!hb) return 'none';
    if (hb.status !== 'stale') return hb.status;
    const marker = this.store.path('deadman.json');
    const told = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : '';
    if (told !== hb.at) {
      await this.c.outbox.deliver({ kind: 'alert', alert: { staleSince: hb.at } });
      writeAtomic(marker, hb.at);
    }
    return 'stale';
  }

  /** Waits for settlements in flight (tests and shutdown). */
  async idle(): Promise<void> {
    // A run that just ended starts its settlement on a later turn: let it begin.
    await new Promise((r) => setTimeout(r, 1));
    while (this.c.settling.size || this.c.inflight.size || this.c.outbox.pending) {
      if (this.c.outbox.pending) await this.c.outbox.flush();
      await Promise.allSettled([...this.c.settling]);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async close(): Promise<void> {
    await this.daemon.stop();
    await this.idle();
  }
}
