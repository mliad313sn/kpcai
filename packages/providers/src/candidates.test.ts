import { describe, expect, it } from 'vitest';
import type { ProviderAdapter } from '@kernelpai/core';
import { candidates } from './candidates.js';
import { BUILTIN_DESCRIPTOR_DIR, ProviderRegistry, loadDescriptors } from './registry.js';
import { deadUrl } from './test-helpers/server.js';

describe('candidates(registry)', () => {
  it('lists the models of available providers and the reasons of the others', async () => {
    const dead = await deadUrl();
    const env = {
      OPENAI_API_KEY: 'k',
      MISTRAL_API_KEY: 'k',
      OLLAMA_HOST: dead,
      LLAMACPP_BASE_URL: `${dead}/v1`,
    };
    const reg = new ProviderRegistry(loadDescriptors([BUILTIN_DESCRIPTOR_DIR]), env);
    const scan = await candidates(reg);
    const providers = new Set(scan.candidates.map((c) => c.ref.provider));
    expect([...providers].sort()).toEqual(['mistral', 'mock', 'openai']);
    const astra = scan.candidates.find((c) => c.ref.model === 'gpt-6-astra');
    expect(astra).toMatchObject({
      ref: { provider: 'openai', model: 'gpt-6-astra' },
      providerKind: 'cloud',
      jurisdiction: 'US',
    });
    expect(astra?.card.competence?.code_generation).toBeGreaterThan(0.8);
    const reasons = Object.fromEntries(scan.unavailable.map((u) => [u.provider, u.reason]));
    expect(reasons['anthropic']).toBe('ANTHROPIC_API_KEY is not set');
    expect(reasons['llamacpp']).toMatch(/not reachable/);
    expect(reasons['ollama']).toMatch(/not reachable/);
    expect(Object.keys(reasons)).toHaveLength(7);
  });

  it('treats a throwing detect() as unavailable', async () => {
    const reg = new ProviderRegistry(loadDescriptors([BUILTIN_DESCRIPTOR_DIR]), {});
    const mock = reg.get('mock');
    const broken: ProviderAdapter = {
      ...mock,
      descriptor: mock.descriptor,
      capabilities: () => mock.capabilities(),
      detect: () => Promise.reject(new Error('boom')),
    };
    const scan = await candidates({ list: () => [broken] });
    expect(scan).toEqual({
      candidates: [],
      unavailable: [{ provider: 'mock', reason: 'Error: boom' }],
    });
  });
});
