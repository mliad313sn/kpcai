#!/usr/bin/env node
// Router latency bench (spec §7: decision < 50 ms p95).
// Run after `npx tsc -b packages/router`: node scripts/bench-router.mjs [candidates] [runs]
import { CompetenceRouter } from '../packages/router/dist/index.js';

const N = Number(process.argv[2] ?? 1000);
const RUNS = Number(process.argv[3] ?? 500);
const TYPES = [
  'analysis',
  'code_generation',
  'writing',
  'research',
  'test',
  'critique',
  'decision',
];
const KINDS = ['cloud', 'local', 'aggregator', 'test'];

let seed = 42;
const rnd = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;

function candidate(i) {
  const competence = Object.fromEntries(TYPES.filter(() => rnd() < 0.7).map((t) => [t, rnd()]));
  return {
    ref: { provider: `p${i % 41}`, model: `model-${i}` },
    providerKind: KINDS[i % KINDS.length],
    jurisdiction: ['US', 'EU', 'local'][i % 3],
    card: {
      id: `model-${i}`,
      contextWindow: [8_192, 32_000, 128_000, 1_000_000][i % 4],
      maxOutput: [4_096, 8_192, 32_000][i % 3],
      modalities: i % 5 === 0 ? ['text', 'image', 'code'] : ['text', 'code'],
      price: { inputPerMTok: rnd() * 15, outputPerMTok: rnd() * 60 },
      latencyMsTypical: i % 11 === 0 ? undefined : 200 + Math.floor(rnd() * 5_000),
      competence,
      strengths: [TYPES[i % TYPES.length]],
      weaknesses: [TYPES[(i + 3) % TYPES.length]],
    },
  };
}

const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)];
const candidates = Array.from({ length: N }, (_, i) => candidate(i));
const router = new CompetenceRouter({ profile: 'balanced' });
const node = (i) => ({
  id: `n${i}`,
  type: TYPES[i % TYPES.length],
  criticality: 'normal',
  messages: [
    { role: 'system', content: 'You are a careful engineer.' },
    { role: 'user', content: 'Refactor this module. '.repeat(400) },
  ],
  maxOutputTokens: 4_000,
});

for (let i = 0; i < 50; i++) router.route(node(i), candidates); // warm-up
const inner = [];
const wall = [];
let last;
for (let i = 0; i < RUNS; i++) {
  const t = process.hrtime.bigint();
  last = router.route(node(i), candidates);
  wall.push(Number(process.hrtime.bigint() - t) / 1e6);
  inner.push(last.elapsedMs);
}

const ms = (x) => `${x.toFixed(2)} ms`;
console.log(`router bench: ${N} candidates × ${RUNS} decisions`);
console.log(`  elapsedMs  p50 ${ms(pct(inner, 0.5))}  p95 ${ms(pct(inner, 0.95))}`);
console.log(`  wall       p50 ${ms(pct(wall, 0.5))}  p95 ${ms(pct(wall, 0.95))}`);
console.log(`  last: ${last.fallbacks.length + 1} ranked, ${last.rejected.length} rejected`);
console.log(`  reason: ${last.reason}`);
const p95 = pct(wall, 0.95);
if (p95 >= 50) {
  console.error(`FAIL: p95 ${ms(p95)} >= 50 ms`);
  process.exit(1);
}
