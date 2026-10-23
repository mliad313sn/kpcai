/**
 * The `enterprise.snapshot` view (design §14.2, protocol-enterprise.ts): programs, seats,
 * gauges, the Sponsor's inbox, the queue, reports, results with assurance labels, the
 * heartbeat and the rubber-stamp rate. Built from the store and the journal-derived state
 * only; the text a model wrote (escalation questions) is passed as text, never as markup.
 */
import {
  approvalClass,
  effectiveExpiry,
  ledger,
  rubberStampRate,
  spendBySource,
  spendLastHour,
  type ProgramState,
} from '@kernelpai/program';
import type { Ctx } from './context.js';
import { readHeartbeat, HEARTBEAT_FILE } from './liveness.js';
import type { ProgramMeta } from './meta.js';
import { results } from './reports.js';

type Rec = { state: ProgramState; meta: ProgramMeta };

function health(s: ProgramState): 'on_track' | 'at_risk' | 'blocked' {
  if (s.status === 'paused' || s.status === 'stopped') return 'blocked';
  if (s.escalations.some((e) => !e.answer)) return 'at_risk';
  const l = ledger(s);
  return l.totalCapUsd > 0 && l.committedUsd / l.totalCapUsd > 0.8 ? 'at_risk' : 'on_track';
}

export function programCard({ state: s, meta }: Rec) {
  const open = s.escalations.find((e) => !e.answer);
  const expires = effectiveExpiry(s)?.toISOString();
  return {
    programId: s.charter.programId,
    goal: s.charter.goal,
    status: s.status,
    health: health(s),
    phases: s.charter.phases.map((p, i) => ({
      id: p.id,
      title: p.title,
      state:
        i < s.phaseIndex || s.status === 'delivered'
          ? ('done' as const)
          : i === s.phaseIndex
            ? ('current' as const)
            : ('next' as const),
    })),
    ...(s.status === 'gate' || s.gates.length
      ? {
          gate: {
            phaseId: s.charter.phases[s.phaseIndex]!.id,
            ...(s.gates.at(-1) ? { verdict: s.gates.at(-1)!.verdict } : {}),
          },
        }
      : {}),
    ...(open ? { nextDecision: { escalationId: open.id, question: open.question } } : {}),
    ...(expires ? { expires } : {}),
    ...(s.status === 'paused' && meta.pausedReason ? { pausedReason: meta.pausedReason } : {}),
  };
}

function seats({ state: s }: Rec) {
  const phase = s.charter.phases[s.phaseIndex];
  return s.charter.seats.map((seat) => {
    const wps = phase?.workPackages.filter((w) => w.lead === seat.id).map((w) => w.id) ?? [];
    const key = seat.kind === 'reviewer' ? phase?.id : undefined;
    const live = s.runs.find(
      (r) => r.status === 'running' && (wps.includes(r.wpId) || r.wpId === key),
    );
    const waiting = s.escalations.some(
      (e) => !e.answer && e.subject && wps.includes(e.subject.wpId),
    );
    const state = live
      ? seat.kind === 'reviewer'
        ? 'reviewing'
        : 'writing'
      : waiting
        ? 'waiting_for_you'
        : s.status === 'paused'
          ? 'blocked'
          : 'idle';
    return {
      programId: s.charter.programId,
      seatId: seat.id,
      department: seat.department,
      kind: seat.kind,
      title: seat.title,
      state,
      ...(live ? { wpId: live.wpId, runId: live.runId, source: live.source } : {}),
    };
  });
}

function inbox({ state: s, meta }: Rec) {
  return s.escalations
    .filter((e) => !e.answer && !meta.escalations[e.id]?.expired)
    .map((e) => ({
      programId: s.charter.programId,
      escalationId: e.id,
      rule: e.rule,
      question: e.question,
      evidence: meta.escalations[e.id]?.evidence ?? [],
      class: approvalClass(e),
      askedAt: e.at,
      viewed: meta.viewed.some((v) => v.escalationId === e.id),
      ...(e.subject ? { subject: e.subject } : {}),
    }));
}

function gauges(c: Ctx, recs: Rec[], now: Date) {
  const cfg = c.store.config();
  const q = c.store.queue();
  const runs = recs.flatMap((r) => r.state.runs);
  const ls = recs.map((r) => ({
    id: r.state.charter.programId,
    l: ledger(r.state),
    src: spendBySource(r.state),
  }));
  const sum = (f: (x: (typeof ls)[number]) => number) => ls.reduce((a, x) => a + f(x), 0);
  return [
    {
      scope: 'portfolio' as const,
      id: cfg.portfolio.id,
      usd: {
        committed: q.spentUsd + q.running.reduce((a, r) => a + r.job.capUsd, 0),
        spent: sum((x) => x.l.spentUsd),
        cap: cfg.portfolio.capUsd,
      },
      concurrency: { inUse: q.running.length, limit: cfg.portfolio.limits.total },
      ...(cfg.usdPerHour
        ? { rate: { usdLastHour: spendLastHour(runs, now), usdPerHour: cfg.usdPerHour } }
        : {}),
    },
    ...ls.map((x) => ({
      scope: 'program' as const,
      id: x.id,
      usd: { committed: x.l.committedUsd, spent: x.l.spentUsd, cap: x.l.totalCapUsd },
    })),
    {
      scope: 'source' as const,
      id: 'api',
      usd: {
        committed: sum((x) => x.src.apiUsd),
        spent: sum((x) => x.src.apiUsd),
        cap: cfg.portfolio.capUsd,
      },
    },
    { scope: 'source' as const, id: 'local', localHours: sum((x) => x.src.localHours) },
  ];
}

function queue(c: Ctx) {
  const q = c.store.queue();
  const entry = (j: (typeof q.pending)[number], state: 'pending' | 'running') => ({
    jobId: j.id,
    programId: j.programId,
    wpId: j.wpId,
    priority: j.priority,
    state,
    enqueuedAt: j.enqueuedAt,
    capUsd: j.capUsd,
  });
  return [
    ...q.running.map((r) => entry(r.job, 'running')),
    ...q.pending.map((j) => entry(j, 'pending')),
  ];
}

export function snapshot(c: Ctx) {
  const now = c.clock();
  const recs: Rec[] = c.store.ids().map((id) => c.store.read(id));
  const hb = readHeartbeat(c.store.path(HEARTBEAT_FILE), now);
  return {
    version: 1 as const,
    at: now.toISOString(),
    killSwitch: c.store.config().portfolio.killSwitch,
    programs: recs.map(programCard),
    seats: recs.flatMap(seats),
    gauges: gauges(c, recs, now),
    inbox: recs.flatMap(inbox),
    cursor: c.feed.seq,
    queue: queue(c),
    reports: recs.flatMap((r) =>
      r.meta.reports.map((x) => ({ programId: r.state.charter.programId, ...x })),
    ),
    results: recs.flatMap((r) => results(r.state, r.meta)),
    ...(hb ? { heartbeat: hb } : {}),
    rubberStamp: (({ rate, consequential }) => ({ rate, consequential }))(
      rubberStampRate(recs.flatMap((r) => r.meta.answers)),
    ),
  };
}
