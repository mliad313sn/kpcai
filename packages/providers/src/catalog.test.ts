import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { catalogDiff, formatCatalogDiff } from './catalog.js';
import { BUILTIN_DESCRIPTOR_DIR, loadDescriptors, parseDescriptor } from './registry.js';

const descriptor = parseDescriptor(
  [
    'id: acme',
    'name: Acme',
    'kind: cloud',
    'adapter: ai-sdk:openai',
    'jurisdiction: US',
    'retention: r',
    'models:',
    '  - { id: big, contextWindow: 1000, maxOutput: 100, modalities: [text], price: { inputPerMTok: 1, outputPerMTok: 2 } }',
    '  - { id: gone, contextWindow: 10, maxOutput: 5, modalities: [text], price: { inputPerMTok: 0, outputPerMTok: 0 } }',
  ].join('\n'),
  'acme.yaml',
);

const api = {
  'acme-dev': {
    id: 'acme-dev',
    models: {
      big: { id: 'big', cost: { input: 1.5, output: 2 }, limit: { context: 2000, output: 100 } },
      other: { id: 'other' },
    },
  },
};

describe('catalogDiff', () => {
  it('reports price and limit differences and missing models, through a provider map', () => {
    const diff = catalogDiff([descriptor], api, { acme: 'acme-dev' });
    expect(diff.compared).toBe(2);
    expect(diff.changes).toEqual([
      { provider: 'acme', model: 'big', field: 'inputPerMTok', yaml: 1, catalog: 1.5 },
      { provider: 'acme', model: 'big', field: 'contextWindow', yaml: 1000, catalog: 2000 },
      { provider: 'acme', model: 'gone', field: 'missing' },
    ]);
    const text = formatCatalogDiff(diff);
    expect(text).toContain('acme/big: inputPerMTok 1 (yaml) -> 1.5 (models.dev)');
    expect(text).toContain('acme/gone: not in models.dev');
    expect(text).toMatch(/2 model card\(s\) compared, 3 difference\(s\)\. YAML was not modified\./);
  });

  it('skips local, test and unknown providers with a reason', () => {
    const builtins = loadDescriptors([BUILTIN_DESCRIPTOR_DIR]);
    const diff = catalogDiff([...builtins, descriptor], api);
    const skipped = Object.fromEntries(diff.skipped.map((s) => [s.provider, s.reason]));
    expect(skipped).toMatchObject({
      mock: 'kind test',
      ollama: 'kind local',
      llamacpp: 'kind local',
      acme: 'no models.dev provider "acme"',
    });
    expect(formatCatalogDiff(diff)).toContain('skipped mock: kind test');
  });

  it('rejects a document that is not a models.dev catalog', () => {
    expect(() => catalogDiff([descriptor], { acme: { models: 3 } })).toThrow();
  });

  it('finds no drift between the built-in YAML and the 2026-10-23 fixture', () => {
    const fixture: unknown = JSON.parse(
      readFileSync(new URL('./test-helpers/models-dev-2026-10-23.json', import.meta.url), 'utf8'),
    );
    const diff = catalogDiff(loadDescriptors([BUILTIN_DESCRIPTOR_DIR]), fixture);
    expect(diff.changes).toEqual([]);
    expect(diff.compared).toBe(15);
  });
});
