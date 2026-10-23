/**
 * S10 R2 (ADR-0035): the daemon journals a heartbeat every `heartbeatSec`, runs the
 * watchdog, and writes `enterprise/heartbeat.json`, the dead-man file an external checker
 * reads (`kpai program heartbeat --check`, or GET /enterprise/heartbeat on the loopback
 * server): older than three beats means the daemon is dead or stuck. Each new alert is
 * journaled once and shown in the feed. The heartbeat holds counts and rule ids only.
 */
import { existsSync, readFileSync } from 'node:fs';
import { deadMan, watchdog, type WatchAlert } from '@kernelpai/program';
import { staleAfterSec, thresholds, type EnterpriseConfig } from './config.js';
import type { Ctx } from './context.js';
import { writeAtomic } from './store.js';

export interface Heartbeat {
  at: string;
  pid: number;
  intervalSec: number;
  staleAfterSec: number;
  status: 'ok' | 'alert' | 'stale';
  alerts: Array<{ rule: string; text: string; programId?: string }>;
  programs: number;
  running: number;
}

export const HEARTBEAT_FILE = 'heartbeat.json';

/** The heartbeat file as an external checker sees it: `stale` when the daemon went silent. */
export function readHeartbeat(path: string, now: Date): Heartbeat | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const hb = JSON.parse(readFileSync(path, 'utf8')) as Heartbeat;
    return deadMan(hb, now).stale ? { ...hb, status: 'stale' } : hb;
  } catch {
    return undefined;
  }
}

export class Liveness {
  private last = 0;
  private readonly seen = new Set<string>();
  /** Since when the queue has been held by a rate limit, if it is. */
  queueBlockedSince: string | undefined;

  constructor(private readonly c: Ctx) {}

  /** Beats when due (or when `force`); returns the heartbeat written, if any. */
  maybeBeat(cfg: EnterpriseConfig, now: Date, force = false): Heartbeat | undefined {
    if (!force && now.getTime() - this.last < cfg.heartbeatSec * 1_000) return undefined;
    this.last = now.getTime();
    return this.beat(cfg, now);
  }

  private beat(cfg: EnterpriseConfig, now: Date): Heartbeat {
    const programs = this.c.store.ids().map((id) => this.c.store.read(id).state);
    const runActivity = Object.fromEntries(this.c.activity);
    const alerts = watchdog(
      {
        programs,
        now,
        runActivity,
        ...(this.queueBlockedSince ? { queueBlockedSince: this.queueBlockedSince } : {}),
      },
      thresholds(cfg),
    );
    const hb: Heartbeat = {
      at: now.toISOString(),
      pid: process.pid,
      intervalSec: cfg.heartbeatSec,
      staleAfterSec: staleAfterSec(cfg),
      status: alerts.length ? 'alert' : 'ok',
      alerts: alerts.map((a) => ({
        rule: a.rule,
        text: a.text.slice(0, 500),
        ...(a.programId ? { programId: a.programId } : {}),
      })),
      programs: programs.length,
      running: programs.reduce(
        (n, s) => n + s.runs.filter((r) => r.status === 'running').length,
        0,
      ),
    };
    writeAtomic(this.c.store.path(HEARTBEAT_FILE), `${JSON.stringify(hb, null, 2)}\n`);
    this.c.fact(undefined, {
      action: 'enterprise heartbeat',
      status: hb.status,
      alerts: alerts.map((a) => a.rule),
      programs: hb.programs,
      running: hb.running,
    });
    this.c.feed.notify('enterprise.heartbeat', { ...hb });
    this.announce(alerts, now);
    return hb;
  }

  /** New alerts go to the journal and the feed once; a cleared alert may fire again. */
  private announce(alerts: WatchAlert[], now: Date): void {
    const keys = new Set(alerts.map((a) => `${a.rule}|${a.programId ?? ''}|${a.runId ?? ''}`));
    for (const a of alerts) {
      const key = `${a.rule}|${a.programId ?? ''}|${a.runId ?? ''}`;
      if (this.seen.has(key)) continue;
      this.c.fact(a.programId, { action: 'watchdog alert', rule: a.rule, runId: a.runId });
      this.c.feed.line(
        `watchdog: ${a.rule} — ${a.text}`,
        a.programId,
        a.runId ? [{ kind: 'run', id: a.runId }] : [],
        now,
      );
    }
    this.seen.clear();
    for (const k of keys) this.seen.add(k);
  }
}
