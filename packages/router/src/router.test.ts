import { ProviderError, refToString } from '@kernelpai/core';
import { describe, expect, it } from 'vitest';
import { CompetenceRouter, MAX_LISTED_REJECTIONS } from './router.js';
import { cand, node } from './test-helpers/fixtures.js';

const names = (xs: { ref: { provider: string; model: string } }[]): string[] =>
  xs.map((x) => refToString(x.ref));

function routeError(fn: () => unknown): ProviderError {
  try {
    fn();
  } catch (e) {
    return e as ProviderError;
  }
  throw new Error('expected route to throw');
}

describe('CompetenceRouter filters', () => {
  const r = new CompetenceRouter();
  const pool = [
    cand('cloud/a'),
    cand('mock/echo', {}, 'test'),
    cand('ollama/llama', { price: { inputPerMTok: 0, outputPerMTok: 0 } }, 'local', 'local'),
    cand('eu/m', {}, 'cloud', 'EU'),
  ];

  it('excludes test providers by default and allows them on request', () => {
    const d = r.route(node(), pool);
    expect(d.rejected).toEqual([
      { ref: { provider: 'mock', model: 'echo' }, reason: 'provider kind "test" excluded' },
    ]);
    const all = r.route(node(), pool, { excludeKinds: [] });
    expect(all.rejected).toHaveLength(0);
    expect(names([all.chosen, ...all.fallbacks])).toContain('mock/echo');
  });

  it('applies denied providers and models', () => {
    const d = r.route(node(), pool, { deniedProviders: ['cloud'], deniedModels: ['eu/m'] });
    expect(d.rejected).toHaveLength(3);
    expect(names([d.chosen])).toEqual(['ollama/llama']);
    expect(d.rejected.find((x) => x.ref.provider === 'eu')?.reason).toBe('model denied');
    expect(d.rejected.find((x) => x.ref.provider === 'cloud')?.reason).toBe(
      'provider cloud denied',
    );
  });

  it('excludes the author provider for diversity', () => {
    const d = r.route(node({ type: 'critique' }), pool, { excludeProviders: ['ollama', 'eu'] });
    expect(names([d.chosen, ...d.fallbacks])).toEqual(['cloud/a']);
    expect(d.rejected.find((x) => x.ref.provider === 'ollama')?.reason).toMatch(/diversity/);
  });

  it('honours localOnly and allowed jurisdictions (case-insensitive)', () => {
    expect(names([r.route(node(), pool, { localOnly: true }).chosen])).toEqual(['ollama/llama']);
    const eu = r.route(node(), pool, { allowedJurisdictions: ['eu', 'LOCAL'] });
    expect(names([eu.chosen, ...eu.fallbacks]).sort()).toEqual(['eu/m', 'ollama/llama']);
    expect(eu.rejected.find((x) => x.ref.provider === 'cloud')?.reason).toBe(
      'jurisdiction US not allowed',
    );
  });

  it('requires every requested modality', () => {
    const vision = cand('v/vision', { modalities: ['text', 'image'] });
    const d = r.route(node({ requiredModalities: ['image'] }), [cand('t/text'), vision]);
    expect(names([d.chosen])).toEqual(['v/vision']);
    expect(d.rejected[0]?.reason).toBe('missing modality image');
  });

  it('requires the context to fit estimated input plus output cap', () => {
    const big = 'x'.repeat(40_000); // ~10k tokens
    const small = cand('s/small', { contextWindow: 8_192, maxOutput: 4_096 });
    const large = cand('l/large', { contextWindow: 128_000 });
    const d = r.route(node({ messages: [{ role: 'user', content: big }] }), [small, large]);
    expect(names([d.chosen])).toEqual(['l/large']);
    expect(d.rejected[0]?.reason).toMatch(/^context 8192 < \d+ tokens needed$/);
    const short = r.route(node({ maxOutputTokens: 1_000 }), [small]);
    expect(names([short.chosen])).toEqual(['s/small']);
  });
});

describe('CompetenceRouter errors', () => {
  const r = new CompetenceRouter();
  it('throws bad_request when no candidates are given', () => {
    const e = routeError(() => r.route(node(), []));
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.kind).toBe('bad_request');
    expect(e.provider).toBe('router');
    expect(e.message).toMatch(/no models available/);
  });
  it('lists why each candidate was rejected', () => {
    const e = routeError(() =>
      r.route(node(), [cand('mock/echo', {}, 'test'), cand('a/b')], { localOnly: true }),
    );
    expect(e.message).toContain('all 2 rejected');
    expect(e.message).toContain('mock/echo: provider kind "test" excluded');
    expect(e.message).toContain('a/b: local only');
  });
  it('summarises long rejection lists', () => {
    const many = Array.from({ length: MAX_LISTED_REJECTIONS + 5 }, (_, i) => cand(`p/m${i}`));
    const e = routeError(() => r.route(node(), many, { deniedProviders: ['p'] }));
    expect(e.message).toContain('… and 5 more');
  });
});
