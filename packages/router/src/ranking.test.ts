import type { MeasuredCompetence } from '@kernelpai/core';
import { refToString } from '@kernelpai/core';
import { describe, expect, it } from 'vitest';
import { CompetenceRouter } from './router.js';
import { cand, node, syntheticCandidates } from './test-helpers/fixtures.js';

const pick = (r: CompetenceRouter, ...args: Parameters<CompetenceRouter['route']>): string =>
  refToString(r.route(...args).chosen.ref);

const free = { price: { inputPerMTok: 0, outputPerMTok: 0 } };
const pricey = { price: { inputPerMTok: 15, outputPerMTok: 75 } };

describe('CompetenceRouter weights', () => {
  it('static competence: the stronger card wins when all else is equal', () => {
    const r = new CompetenceRouter();
    const pool = [
      cand('a/weak', { weaknesses: ['code_generation'] }),
      cand('b/strong', { strengths: ['code_generation'] }),
    ];
    expect(pick(r, node(), pool)).toBe('b/strong');
  });

  it('measured competence moves the ranking once there are samples', () => {
    const measured: MeasuredCompetence = {
      get: (ref) => (ref.provider === 'a' ? { score: 1, samples: 50 } : { score: 0, samples: 50 }),
    };
    const pool = [
      cand('a/m', { competence: { code_generation: 0.6 } }),
      cand('b/m', { competence: { code_generation: 0.7 } }),
    ];
    expect(pick(new CompetenceRouter(), node(), pool)).toBe('b/m');
    const r = new CompetenceRouter({ measured });
    const d = r.route(node(), pool);
    expect(refToString(d.chosen.ref)).toBe('a/m');
    expect(d.chosen.parts.measuredCompetence).toBe(1);
    expect(d.reason).toContain('measured competence');
  });

  it('cost: the cheaper model wins at equal competence', () => {
    const r = new CompetenceRouter();
    expect(pick(r, node(), [cand('a/pricey', pricey), cand('b/cheap', free)])).toBe('b/cheap');
    const d = r.route(node({ budgetUsd: 10 }), [cand('a/pricey', pricey)]);
    expect(d.chosen.parts.costPenalty).toBeLessThan(0.1);
  });

  it('latency: the faster model wins at equal competence and price', () => {
    const r = new CompetenceRouter();
    const d = r.route(node({ maxLatencyMs: 10_000 }), [
      cand('a/slow', { latencyMsTypical: 9_000 }),
      cand('b/fast', { latencyMsTypical: 500 }),
    ]);
    expect(refToString(d.chosen.ref)).toBe('b/fast');
    expect(d.chosen.parts.latencyPenalty).toBe(0.05);
    expect(d.reason).toMatch(/on latency/);
  });

  it('a zero weight removes its factor', () => {
    const r = new CompetenceRouter({ weights: { cost: 0, latency: 0 } });
    const pool = [
      cand('a/cheap', free),
      cand('b/pricey', { ...pricey, strengths: ['code_generation'] }),
    ];
    expect(pick(r, node(), pool)).toBe('b/pricey');
  });
});

describe('CompetenceRouter profiles', () => {
  const pool = [
    cand(
      'ollama/small',
      { ...free, competence: { code_generation: 0.55 }, latencyMsTypical: 3_000 },
      'local',
      'local',
    ),
    cand('cloud/flagship', {
      ...pricey,
      competence: { code_generation: 0.95 },
      latencyMsTypical: 3_000,
    }),
  ];
  it('economy prefers the free local model, performance the flagship', () => {
    expect(pick(new CompetenceRouter({ profile: 'economy' }), node(), pool)).toBe('ollama/small');
    expect(pick(new CompetenceRouter({ profile: 'performance' }), node(), pool)).toBe(
      'cloud/flagship',
    );
  });
  it('exposes its profile and weights', () => {
    const r = new CompetenceRouter({ profile: 'performance' });
    expect(r.profile).toBe('performance');
    expect(r.weights.competenceStatic).toBeGreaterThan(r.weights.cost);
  });
});

describe('CompetenceRouter decisions', () => {
  it('returns ordered fallbacks, the node id and a one-line reason', () => {
    const r = new CompetenceRouter();
    const pool = [
      cand('c/mid'),
      cand('a/best', { strengths: ['code_generation'] }),
      cand('b/worst', { weaknesses: ['code_generation'] }),
      cand('mock/x', {}, 'test'),
    ];
    const d = r.route(node({ id: 'node-7' }), pool);
    expect(d.nodeId).toBe('node-7');
    expect([d.chosen, ...d.fallbacks].map((x) => refToString(x.ref))).toEqual([
      'a/best',
      'c/mid',
      'b/worst',
    ]);
    expect(d.fallbacks[0]!.score).toBeGreaterThan(d.fallbacks[1]!.score);
    expect(d.reason).not.toContain('\n');
    expect(d.reason).toMatch(
      /^a\/best for code_generation: score -?\d\.\d{3}, ~\$[\d.]+; beats c\/mid \(-?\d\.\d{3}\) on static competence \(\+\d\.\d{3}\); 1 rejected$/,
    );
  });

  it('says when only one candidate survives', () => {
    const d = new CompetenceRouter().route(node(), [cand('a/only')]);
    expect(d.reason).toContain('only candidate left after filters; 0 rejected');
    expect(d.fallbacks).toEqual([]);
  });

  it('breaks ties by cheaper expected cost, then by name', () => {
    const r = new CompetenceRouter({ weights: { cost: 0 } });
    const d = r.route(node(), [cand('z/cheap', free), cand('a/pricey', pricey)]);
    expect(refToString(d.chosen.ref)).toBe('z/cheap');
    expect(d.reason).toContain('ties a/pricey');
    const same = r.route(node(), [cand('b/m'), cand('a/m'), cand('c/m')]);
    expect([same.chosen, ...same.fallbacks].map((x) => refToString(x.ref))).toEqual([
      'a/m',
      'b/m',
      'c/m',
    ]);
  });

  it('measures elapsedMs with the injected clock', () => {
    let t = 100;
    const r = new CompetenceRouter({ clock: () => (t += 7) });
    expect(r.route(node(), [cand('a/m')]).elapsedMs).toBe(7);
    expect(new CompetenceRouter().route(node(), [cand('a/m')]).elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('uses estimateRequest for the cost estimate', () => {
    const d = new CompetenceRouter().route(node({ maxOutputTokens: 2_000 }), [cand('a/m')]);
    expect(d.chosen.estimate.basis).toBe('heuristic');
    expect(d.chosen.estimate.maxOutputTokens).toBe(2_000);
    expect(d.chosen.estimate.expectedCostUsd).toBeGreaterThan(0);
  });
});

describe('CompetenceRouter latency', () => {
  it('p95 < 50 ms on 200 candidates', () => {
    const r = new CompetenceRouter();
    const pool = syntheticCandidates(200);
    const n = node({
      messages: [{ role: 'user', content: 'x'.repeat(8_000) }],
      maxOutputTokens: 4_000,
    });
    const xs: number[] = [];
    for (let i = 0; i < 200; i++) xs.push(r.route(n, pool).elapsedMs);
    xs.sort((a, b) => a - b);
    const p95 = xs[Math.floor((xs.length - 1) * 0.95)]!;
    expect(p95).toBeLessThan(50);
  });
});
