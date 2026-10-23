/**
 * A fake Enterprise portfolio for tests: two programs, a small team (or `seats` seats spread
 * over departments), gauges, asks, results and reports, plus FakeKernel handlers for the
 * `program.*` / `enterprise.*` methods. Text fields carry markup on purpose: the view must
 * show it as text.
 */
import type { EnterpriseSnapshot } from '@kernelpai/kernel/protocol';
import { RpcFailure, type Handler } from './fake-kernel';

const NOW = Date.parse('2026-10-23T12:00:00Z');
export const AT = new Date(NOW).toISOString();

const DEPTS = ['engineering', 'security', 'review', 'design', 'data'];
const KINDS = ['builder', 'security', 'reviewer', 'specialist', 'architect'];
const STATES = ['writing', 'thinking', 'idle', 'reviewing', 'idle', 'blocked'] as const;
const SOURCES = ['subscription', 'local', 'api'] as const;

type Seat = EnterpriseSnapshot['seats'][number];

export function seat(i: number, over: Partial<Seat> = {}): Seat {
  return {
    programId: i % 7 === 3 ? 'p-bracket' : 'p-auth',
    seatId: `s${i}`,
    department: DEPTS[i % DEPTS.length]!,
    kind: KINDS[i % KINDS.length]!,
    title: i === 0 ? 'Lead <b>builder</b>' : `Seat ${i}`,
    model: { provider: i % 2 ? 'mock-beta' : 'mock-alpha', model: 'm1' },
    source: SOURCES[i % SOURCES.length]!,
    state: i === 1 ? 'waiting_for_you' : STATES[i % STATES.length]!,
    ...(i % 3 === 0 ? { wpId: `wp${i}` } : {}),
    ...(i === 0 ? { runId: 'run-1' } : {}),
    ...over,
  };
}

function programs(): EnterpriseSnapshot['programs'] {
  return [
    {
      programId: 'p-auth',
      goal: 'OAuth login <script>alert(1)</script> with tests',
      status: 'running',
      health: 'on_track',
      phases: [
        { id: 'ph1', title: 'Design', state: 'done' },
        { id: 'ph2', title: 'Build', state: 'current' },
        { id: 'ph3', title: 'Release', state: 'next' },
      ],
      nextDecision: { escalationId: 'e-merge', question: 'Merge wp3 into main?' },
      expires: '2026-11-06T12:00:00Z',
    },
    {
      programId: 'p-bracket',
      goal: 'A parametric 3D-printable bracket',
      status: 'paused',
      health: 'at_risk',
      phases: [{ id: 'b1', title: 'Model', state: 'current' }],
      gate: { phaseId: 'b1' },
      pausedReason: '25 % spent, no verified result yet',
    },
  ];
}

function gauges(): EnterpriseSnapshot['gauges'] {
  return [
    {
      scope: 'portfolio',
      id: 'all',
      usd: { spent: 12.4, committed: 18, cap: 50 },
      rate: { usdLastHour: 2.1, usdPerHour: 5 },
      concurrency: { inUse: 3, limit: 8 },
    },
    { scope: 'program', id: 'p-auth', usd: { spent: 10, committed: 15, cap: 40 } },
    {
      scope: 'source',
      id: 'claude-code',
      quota: { runs: 3, runsCap: 10, hours: 1.5, hoursCap: 8 },
    },
    { scope: 'source', id: 'ollama', localHours: 2.5 },
  ];
}

function inbox(): EnterpriseSnapshot['inbox'] {
  return [
    {
      programId: 'p-auth',
      escalationId: 'e-merge',
      rule: 'merge-default-branch',
      question: 'Merge wp3 into <i>main</i>?',
      evidence: [
        { kind: 'run', id: 'run-1' },
        { kind: 'diff', id: 'd-1' },
      ],
      class: 'consequential',
      askedAt: new Date(NOW - 3 * 3600_000).toISOString(),
      subject: { wpId: 'wp3', capUsd: 0.5 },
    },
    {
      programId: 'p-auth',
      escalationId: 'e-t1',
      rule: 'write-in-worktree',
      question: 'Write src/a.ts in the worktree?',
      evidence: [],
      class: 'trivial',
    },
    {
      programId: 'p-bracket',
      escalationId: 'e-t2',
      rule: 'write-in-worktree',
      question: 'Write model.scad in the worktree?',
      evidence: [],
      class: 'trivial',
    },
  ];
}

export interface SnapOptions {
  seats?: number;
  heartbeatAgeSec?: number;
  noHeartbeat?: boolean;
  killSwitch?: boolean;
}

export function snapshot(o: SnapOptions = {}): EnterpriseSnapshot {
  const n = o.seats ?? 6;
  return {
    version: 1,
    at: AT,
    killSwitch: o.killSwitch ?? false,
    programs: programs(),
    seats: Array.from({ length: n }, (_, i) => seat(i)),
    gauges: gauges(),
    inbox: inbox(),
    cursor: 40,
    queue: [
      {
        jobId: 'j1',
        programId: 'p-auth',
        wpId: 'wp5',
        priority: 'normal',
        state: 'pending',
        enqueuedAt: AT,
        held: 'provider limit reached',
      },
    ],
    reports: [
      { programId: 'p-auth', reportId: 'r1', kind: 'digest', title: 'Day 1', at: AT, channels: [] },
      {
        programId: 'p-auth',
        reportId: 'r2',
        kind: 'gate',
        title: 'Gate <u>ph1</u>',
        at: new Date(NOW + 1000).toISOString(),
        channels: ['markdown', 'email'],
        verified: false,
      },
    ],
    results: [
      {
        programId: 'p-auth',
        wpId: 'wp1',
        runId: 'run-0',
        status: 'done',
        assurance: 'V2',
        basis: 'critic + 14 tests',
      },
      {
        programId: 'p-auth',
        wpId: 'wp3',
        runId: 'run-1',
        status: 'done',
        assurance: 'V1',
        basis: 'critic mock-delta',
      },
      {
        programId: 'p-auth',
        wpId: 'wp2',
        runId: 'run-2',
        status: 'done',
        assurance: 'V0',
        basis: 'no review',
      },
    ],
    ...(o.noHeartbeat
      ? {}
      : {
          heartbeat: {
            at: new Date(Date.now() - (o.heartbeatAgeSec ?? 10) * 1000).toISOString(),
            intervalSec: 60,
            staleAfterSec: 300,
            status: 'ok' as const,
            alerts: [],
          },
        }),
    rubberStamp: { rate: 0.25, consequential: 4 },
  };
}

export const ACTIVITY = [
  {
    seq: 39,
    at: AT,
    programId: 'p-auth',
    text: 'wp3 reviewed: <b>approved</b>',
    refs: [{ kind: 'run' as const, id: 'run-1' }],
  },
  { seq: 38, at: AT, text: 'Portfolio started', refs: [] },
];

export interface EnterpriseFake {
  handlers: Record<string, Handler>;
  /** Replaces the snapshot the fake answers with. */
  set(s: EnterpriseSnapshot): void;
}

/** Handlers for a FakeKernel; `viewed` escalations are tracked like the daemon does. */
export function enterpriseFake(initial: EnterpriseSnapshot = snapshot()): EnterpriseFake {
  let snap = initial;
  const viewed = new Set<string>();
  const ok = () => ({ ok: true });
  const answer = (p: unknown) => {
    const { escalationId, answer: a } = p as { escalationId: string; answer: string };
    const item = snap.inbox.find((i) => i.escalationId === escalationId);
    if (item?.class !== 'trivial' && a === 'yes' && !viewed.has(escalationId))
      throw new RpcFailure(-32003, 'open the evidence first');
    return { ok: true };
  };
  return {
    set: (s) => {
      snap = s;
    },
    handlers: {
      'enterprise.snapshot': () => snap,
      'enterprise.activity': () => ({ items: ACTIVITY, cursor: 40 }),
      'enterprise.kill': () => ({ cancelled: ['run-1', 'run-2'] }),
      'enterprise.unkill': () => ({ cancelled: [] }),
      'program.pause': ok,
      'program.resume': ok,
      'program.stop': ok,
      'program.viewed': (p) => {
        viewed.add((p as { escalationId: string }).escalationId);
        return { ok: true };
      },
      'program.answer': answer,
      'program.answerBatch': (p) => ({
        answered: (p as { escalationIds: string[] }).escalationIds,
        refused: [],
      }),
    },
  };
}
