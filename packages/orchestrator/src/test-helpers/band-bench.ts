/**
 * Deterministic band benchmark (S8 bug 2): plans and runs a fixed mix of graphs on the
 * offline MockAdapter, with one journal shared across runs, and checks each plan-time
 * cost band against the run's realised cost. Request sizes vary by a seeded PRNG so the
 * history has a spread; nothing touches the network or the clock.
 */
import {
  ProviderDescriptorSchema,
  type Candidate,
  type GraphNode,
  type ProviderAdapter,
  type TaskGraph,
} from '@kernelpai/core';
import { outputCalibration } from '@kernelpai/executor';
import { Journal } from '@kernelpai/journal';
import { MockAdapter } from '@kernelpai/providers';
import { CompetenceRouter } from '@kernelpai/router';
import { outputSpread, type BandBasis } from '../band.js';
import { estimateGraph, type GraphEstimate } from '../estimate.js';
import { DEFAULT_CODE_TOOLS, TemplatePlanner } from '../planner/template.js';
import { GraphRunner } from '../runner.js';
import { FakeToolBus, toolDef } from './fakes.js';

/** Same four mocks as S8's repro: one strong task type each, different prices. */
const MOCKS: Array<[string, number, number, Record<string, number>]> = [
  ['mock-alpha', 3, 15, { analysis: 0.95, code_generation: 0.6, test: 0.6, critique: 0.6 }],
  ['mock-beta', 2, 10, { analysis: 0.6, code_generation: 0.95, test: 0.6, critique: 0.6 }],
  ['mock-gamma', 1, 5, { analysis: 0.6, code_generation: 0.6, test: 0.95, critique: 0.6 }],
  ['mock-delta', 2, 10, { analysis: 0.6, code_generation: 0.6, test: 0.6, critique: 0.95 }],
];

function mockAdapter([id, pin, pout, comp]: (typeof MOCKS)[number]): MockAdapter {
  return new MockAdapter(
    ProviderDescriptorSchema.parse({
      id,
      name: id,
      kind: 'cloud',
      adapter: 'mock',
      jurisdiction: 'US',
      retention: 'none',
      models: [
        {
          id: 'm1',
          contextWindow: 64_000,
          maxOutput: 4096,
          modalities: ['text', 'code'],
          price: { inputPerMTok: pin, outputPerMTok: pout },
          competence: { writing: 0.6, research: 0.5, decision: 0.6, ...comp },
        },
      ],
    }),
  );
}

export interface BenchRow {
  scenario: string;
  round: number;
  basis: BandBasis;
  lowUsd: number;
  expectedUsd: number;
  highUsd: number;
  costUsd: number;
  hit: boolean;
  /** Breaches of low ≤ expected ≤ high in the plan's estimate (should be none). */
  breaches: string[];
}

/** Every step, node and graph figure with `low ≤ expected ≤ high` broken (D-021). */
export function bandBreaches(e: GraphEstimate): string[] {
  const out: string[] = [];
  const check = (what: string, low: number, expected: number, high: number): void => {
    if (!(low <= expected + 1e-6 && expected <= high + 1e-6)) {
      out.push(`${what}: ${low} ≤ ${expected} ≤ ${high}`);
    }
  };
  for (const n of e.nodes) {
    n.steps.forEach((s, i) =>
      check(`${n.nodeId}.${i}:${s.role}`, s.band.lowUsd, s.expectedUsd, s.band.highUsd),
    );
    check(n.nodeId, n.band.lowUsd, n.expectedUsd, n.band.highUsd);
  }
  check('graph', e.band.lowUsd, e.totalUsd, e.band.highUsd);
  return out;
}

export interface BenchSummary {
  n: number;
  hits: number;
  hitRate: number;
  /** Median of high / low (a zero low counts as high / cost). */
  medianWidth: number;
  /** Median of high / expected: how far the cap (D-021) sits above the likely figure. */
  medianCapRatio: number;
}

/** A deterministic LCG in [0, 1). */
function prng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
}

const WORDS = ['state', 'token', 'parser', 'cache', 'retry', 'queue', 'index', 'schema'];
const subject = (rnd: () => number): string =>
  Array.from({ length: 5 + Math.floor(rnd() * 120) }, () => WORDS[Math.floor(rnd() * 8)]).join(' ');

const node = (id: string, type: GraphNode['type'], over: Partial<GraphNode> = {}): GraphNode => ({
  id,
  title: id,
  type,
  protocol: 'solo',
  dependsOn: [],
  criticality: 'normal',
  messages: [{ role: 'user', content: `${id}: ${over.title ?? ''}` }],
  ...over,
});

const msg = (content: string): GraphNode['messages'] => [{ role: 'user', content }];
const planner = new TemplatePlanner({ newId: () => 'g' });
const template = (request: string): Promise<TaskGraph> => planner.plan(request, { root: '/' });
const hand = (nodes: GraphNode[]): Promise<TaskGraph> =>
  Promise.resolve({ id: 'g', request: 'bench', nodes, createdBy: 'template', reason: 'bench' });

/** The scenario mix: template plans (code, critical code, choice) and pack-like chains. */
export const SCENARIOS: Array<[string, (s: string) => Promise<TaskGraph>]> = [
  ['code', (s) => template(`implement a parser for ${s}`)],
  ['oauth', (s) => template(`add an OAuth state validator with tests for ${s}`)],
  ['choice', (s) => template(`which should we use, postgres or sqlite, for ${s}?`)],
  [
    'report',
    (s) =>
      hand([
        node('gather', 'research', { messages: msg(`Gather facts about ${s}`) }),
        node('draft', 'writing', {
          protocol: 'author_critic',
          dependsOn: ['gather'],
          messages: msg(`Write a short report about ${s}`),
        }),
        node('verify', 'critique', { dependsOn: ['draft'], messages: msg(`Check ${s}`) }),
      ]),
  ],
  [
    'explain',
    (s) =>
      hand([
        node('explain', 'writing', { messages: msg(`Explain ${s}`) }),
        node('step', 'analysis', { dependsOn: ['explain'], messages: msg('One next step') }),
      ]),
  ],
  [
    'revise',
    (s) =>
      hand([
        node('fix', 'code_generation', {
          protocol: 'author_critic',
          messages: msg(`Fix ${s} [[reject]]`),
        }),
      ]),
  ],
  [
    'tools',
    (s) =>
      hand([
        node('probe', 'analysis', {
          tools: ['fs.read'],
          messages: msg(`Look up ${s} [[tool:fs.read {"path":"README.md"}]]`),
        }),
      ]),
  ],
];

export interface BenchOptions {
  rounds?: number;
  seed?: number;
}

/** Runs `rounds` × every scenario; returns one row per run. */
export async function runBandBench(options: BenchOptions = {}): Promise<BenchRow[]> {
  const adapters = new Map<string, ProviderAdapter>(
    MOCKS.map((m) => [m[0], mockAdapter(m) as ProviderAdapter]),
  );
  const candidates: Candidate[] = [...adapters.values()].map((a) => ({
    ref: { provider: a.descriptor.id, model: 'm1' },
    providerKind: 'cloud',
    jurisdiction: 'US',
    card: a.capabilities()[0]!,
  }));
  const journal = Journal.open(':memory:');
  const sessionId = journal.startSession('band-bench', '/');
  const tools = new FakeToolBus([...DEFAULT_CODE_TOOLS].map((n) => toolDef(n)));
  const rnd = prng(options.seed ?? 7);
  const rows: BenchRow[] = [];
  for (let round = 0; round < (options.rounds ?? 10); round++) {
    for (const [scenario, plan] of SCENARIOS) {
      const graph = await plan(subject(rnd));
      // As the kernel does per plan: calibration and spread read from the journal now.
      const router = new CompetenceRouter({ expectedOutput: outputCalibration(journal) });
      const est: GraphEstimate = estimateGraph(graph, {
        router,
        candidates,
        spread: outputSpread(journal),
      });
      const result = await new GraphRunner({
        router,
        candidates,
        resolve: (ref) => adapters.get(ref.provider) as ProviderAdapter,
        journal,
        sessionId,
        tools,
        executor: { firstChunkTimeoutMs: 0, idleTimeoutMs: 0 },
      }).run(graph);
      if (!result.ok) throw new Error(`bench run failed: ${scenario} ${JSON.stringify(result)}`);
      const { lowUsd, highUsd, basis } = est.band;
      const costUsd = result.costUsd;
      const hit = costUsd >= lowUsd - 1e-9 && costUsd <= highUsd + 1e-9;
      rows.push({
        scenario,
        round,
        basis,
        lowUsd,
        expectedUsd: est.totalUsd,
        highUsd,
        costUsd,
        hit,
        breaches: bandBreaches(est),
      });
    }
  }
  journal.close();
  return rows;
}

export function summarise(rows: readonly BenchRow[]): BenchSummary {
  const mid = (xs: number[]): number => {
    const sorted = [...xs].sort((a, b) => a - b);
    const m = sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] as number) : 0;
    return Math.round(m * 100) / 100;
  };
  const hits = rows.filter((r) => r.hit).length;
  return {
    n: rows.length,
    hits,
    hitRate: rows.length ? hits / rows.length : 0,
    medianWidth: mid(rows.map((r) => r.highUsd / (r.lowUsd > 0 ? r.lowUsd : r.costUsd))),
    medianCapRatio: mid(rows.map((r) => r.highUsd / r.expectedUsd)),
  };
}
