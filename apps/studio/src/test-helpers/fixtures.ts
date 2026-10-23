/** A plan like the phase-2 demo: architecture → implementation → tests, reviewed. */
export const GRAPH = {
  id: 'g1',
  request: 'add OAuth with tests',
  createdBy: 'template',
  reason: 'code task: design, implement, test',
  nodes: [
    {
      id: 'arch',
      title: 'Design the OAuth flow',
      type: 'reasoning',
      protocol: 'solo',
      dependsOn: [],
      criticality: 'normal',
      messages: [{ role: 'user', content: 'Design <b>OAuth</b>\n  keep it simple' }],
    },
    {
      id: 'impl',
      title: 'Implement it',
      type: 'code',
      protocol: 'author_critic',
      dependsOn: ['arch'],
      criticality: 'critical',
    },
    {
      id: 'tests',
      title: 'Write the tests',
      type: 'code',
      protocol: 'solo',
      dependsOn: ['impl'],
      criticality: 'normal',
    },
  ],
};

const step = (role: string, provider: string, model: string, usd: number) => ({
  role,
  ref: { provider, model },
  calls: { min: 1, max: role === 'critic' ? 3 : 1 },
  perCallUsd: usd,
  minUsd: usd,
  expectedUsd: usd * 2,
});

export const ESTIMATE = {
  nodes: [
    {
      nodeId: 'arch',
      protocol: 'solo',
      ref: { provider: 'anthropic', model: 'model-a' },
      perCallUsd: 0.02,
      rounds: { min: 1, max: 1 },
      minUsd: 0.02,
      expectedUsd: 0.04,
      steps: [step('solo', 'anthropic', 'model-a', 0.02)],
    },
    {
      nodeId: 'impl',
      protocol: 'author_critic',
      upgraded: 'code nodes are reviewed by another provider',
      ref: { provider: 'openai', model: 'model-b' },
      perCallUsd: 0.05,
      rounds: { min: 2, max: 7 },
      minUsd: 0.1,
      expectedUsd: 0.25,
      band: { lowUsd: 0.09, highUsd: 0.3, basis: 'calibrated' },
      score: 0.82,
      reason: 'best code score within budget',
      parts: { competence: 0.95, cost: 0.4, latency: null },
      runnerUp: { ref: { provider: 'mistral', model: 'model-d' }, score: 0.71 },
      steps: [step('author', 'openai', 'model-b', 0.05), step('critic', 'google', 'model-c', 0.05)],
    },
    {
      nodeId: 'tests',
      protocol: 'author_critic',
      ref: { provider: 'mistral', model: 'model-d' },
      perCallUsd: 0.01,
      rounds: { min: 2, max: 7 },
      minUsd: 0.03,
      expectedUsd: 0.11,
      steps: [step('author', 'mistral', 'model-d', 0.01)],
    },
  ],
  minUsd: 0.15,
  totalUsd: 0.4,
  complete: true,
  problems: [],
  band: { lowUsd: 0.12, highUsd: 0.5, basis: 'mixed' },
  // D-021: the likely cost (sum of the nodes' expected) and the hard cap (band top).
  expectedUsd: 0.4,
  capUsd: 0.5,
};

export const PLAN = { planId: 'p1', graph: GRAPH, estimate: ESTIMATE };

export const PATCH = [
  'diff --git a/src/auth.ts b/src/auth.ts',
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -1,2 +1,3 @@',
  ' export {};',
  '-const old = 1;',
  '+const token = "<script>alert(1)</script>";',
  '+   indented  spaces',
].join('\n');

export const PROVIDERS = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'cloud',
    available: true,
    reason: 'key found',
    models: [{ id: 'model-a' }, { id: 'model-e' }],
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    kind: 'local',
    available: false,
    reason: 'not reachable',
    models: [{ id: 'nope' }],
  },
];

export const SESSIONS = [
  {
    id: 's1',
    createdAt: '2026-10-23T10:00:00Z',
    title: 'add OAuth',
    cwd: '/x',
    eventCount: 12,
    costUsd: 0.31,
  },
];

/** Default handlers for a kernel that plans, runs and lists. */
export function kernelHandlers(): Record<string, (p: unknown) => unknown> {
  return {
    plan: () => PLAN,
    'run.start': () => ({ runId: 'r1' }),
    'run.pause': () => ({ ok: true }),
    'run.resume': () => ({ ok: true }),
    'run.cancel': () => ({ cancelled: true }),
    'run.redirect': () => ({ ok: true }),
    'run.instruct': () => ({ ok: true }),
    'runs.list': () => ({ runs: [] }),
    'plan.validate': () => ({ ok: true, problems: [], warnings: [], changes: [] }),
    'patches.apply': (p) => ({
      results: ((p as { nodeIds?: string[] }).nodeIds ?? ['impl']).map((nodeId) => ({
        nodeId,
        ok: true,
        message: 'applied',
      })),
    }),
    'confirm.answer': () => ({ accepted: true }),
    'sessions.list': () => ({ sessions: SESSIONS }),
    'providers.list': () => ({ providers: PROVIDERS }),
    stats: () => ({ calls: 3, costUsd: 0.12 }),
    'tools.list': () => ({
      tools: [{ name: 'fs.read', risk: 'read', source: 'builtin' }],
      errors: [],
    }),
  };
}
