/**
 * A believable portfolio for the Enterprise e2e: two programs, a team (or `seats` seats over
 * departments), gauges with band tops reserved, asks, results and reports. Goals and
 * questions carry markup on purpose: the console must show it as text.
 */
const DEPTS = ['engineering', 'security', 'review', 'design', 'data', 'documentation'];
const KINDS = ['builder', 'security', 'reviewer', 'specialist', 'architect', 'builder'];
const TITLES = [
  'Builder',
  'Security reviewer',
  'Independent reviewer',
  'CAD engineer',
  'Architect',
  'Tech writer',
];
const STATES = ['writing', 'thinking', 'idle', 'reviewing', 'idle', 'blocked', 'writing'];
const SOURCES = ['subscription', 'local', 'api'];
const MODELS = [
  { provider: 'anthropic', model: 'claude-code' },
  { provider: 'ollama', model: 'qwen-coder' },
  { provider: 'google', model: 'gemini-api' },
];

export interface SnapOptions {
  seats?: number;
  heartbeatAgeSec?: number;
}

export type Snap = ReturnType<typeof enterpriseSnapshot>;

export function seat(i: number) {
  return {
    programId: i % 5 === 4 ? 'p-bracket' : 'p-auth',
    seatId: `s${i}`,
    department: DEPTS[i % DEPTS.length]!,
    kind: KINDS[i % KINDS.length]!,
    title:
      i === 0 ? 'Lead <b>builder</b>' : `${TITLES[i % TITLES.length]} ${Math.floor(i / 6) + 1}`,
    model: MODELS[i % MODELS.length]!,
    source: SOURCES[i % SOURCES.length]!,
    state: i === 1 ? 'waiting_for_you' : STATES[i % STATES.length]!,
    ...(i % 3 === 0 ? { wpId: `wp${i}` } : {}),
  };
}

function programs() {
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
      goal: 'A parametric 3D-printable bracket with its slicing profile',
      status: 'paused',
      health: 'at_risk',
      phases: [{ id: 'b1', title: 'Model', state: 'current' }],
      gate: { phaseId: 'b1' },
      pausedReason: '25 % of the phase cap spent, no verified result yet',
    },
  ];
}

function inbox(now: number) {
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
      askedAt: new Date(now - 3 * 3600_000).toISOString(),
      subject: { wpId: 'wp3', capUsd: 0.5 },
    },
    ...['src/a.ts', 'src/b.ts'].map((f, i) => ({
      programId: 'p-auth',
      escalationId: `e-t${i}`,
      rule: 'write-in-worktree',
      question: `Write ${f} in the worktree?`,
      evidence: [],
      class: 'trivial',
    })),
  ];
}

export function enterpriseSnapshot(o: SnapOptions = {}) {
  const now = Date.now();
  const at = new Date(now).toISOString();
  const n = o.seats ?? 7;
  return {
    version: 1 as const,
    at,
    killSwitch: false,
    programs: programs(),
    seats: Array.from({ length: n }, (_, i) => seat(i)),
    gauges: [
      {
        scope: 'portfolio',
        id: 'all',
        usd: { spent: 12.4, committed: 18, cap: 50 },
        rate: { usdLastHour: 2.1, usdPerHour: 5 },
        concurrency: { inUse: 3, limit: 8 },
      },
      {
        scope: 'source',
        id: 'claude-code',
        quota: { runs: 3, runsCap: 10, hours: 1.5, hoursCap: 8 },
      },
      { scope: 'source', id: 'ollama', localHours: 2.5 },
    ],
    inbox: inbox(now),
    cursor: 100,
    reports: [
      { programId: 'p-auth', reportId: 'r1', kind: 'digest', title: 'Day 1', at, channels: [] },
      {
        programId: 'p-auth',
        reportId: 'r2',
        kind: 'gate',
        title: 'Gate of Design',
        at,
        channels: ['markdown', 'email'],
      },
    ],
    results: [
      ...Array.from({ length: 6 }, (_, i) => ({
        programId: 'p-auth',
        wpId: `wp${i}`,
        runId: `run-v2-${i}`,
        status: 'done',
        assurance: 'V2',
        basis: 'critic + tests',
      })),
      {
        programId: 'p-auth',
        wpId: 'wp3',
        runId: 'run-1',
        status: 'done',
        assurance: 'V1',
        basis: 'critic mock-delta approved; no tests',
      },
      {
        programId: 'p-auth',
        wpId: 'wp7',
        runId: 'run-7',
        status: 'done',
        assurance: 'V0',
        basis: 'not reviewed',
      },
      {
        programId: 'p-auth',
        wpId: 'wp8',
        runId: 'run-8',
        status: 'done',
        assurance: 'V3',
        basis: 'you checked',
      },
    ],
    heartbeat: {
      at: new Date(now - (o.heartbeatAgeSec ?? 20) * 1000).toISOString(),
      intervalSec: 60,
      staleAfterSec: 300,
      status: 'ok',
      alerts: [],
    },
    rubberStamp: { rate: 0, consequential: 3 },
  };
}

export function activity() {
  const lines = [
    'Security reviewed the login patch (approved, 2 notes)',
    'wp3 started on anthropic/claude-code, band top $0.50',
    'Tests passed for wp1 (14 tests) <b>bold?</b>',
    'Gate of Design passed (V2)',
  ];
  return Array.from({ length: 40 }, (_, i) => ({
    seq: 60 + i,
    at: new Date(Date.now() - (40 - i) * 60_000).toISOString(),
    programId: i % 4 === 3 ? 'p-bracket' : 'p-auth',
    text: lines[i % lines.length]!,
    refs: i % 2 ? [{ kind: 'run', id: `run-${i}` }] : [],
  }));
}
