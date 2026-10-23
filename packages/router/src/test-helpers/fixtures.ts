import type { Candidate, ModelCard, ProviderDescriptor, TaskNode } from '@kernelpai/core';

export function card(over: Partial<ModelCard> = {}): ModelCard {
  return {
    id: 'm',
    contextWindow: 200_000,
    maxOutput: 8_000,
    modalities: ['text', 'code'],
    price: { inputPerMTok: 1, outputPerMTok: 4 },
    latencyMsTypical: 1_000,
    strengths: [],
    weaknesses: [],
    ...over,
  };
}

export function cand(
  ref: string,
  over: Partial<ModelCard> = {},
  kind: ProviderDescriptor['kind'] = 'cloud',
  jurisdiction = 'US',
): Candidate {
  const [provider, model] = ref.split('/') as [string, string];
  return {
    ref: { provider, model },
    providerKind: kind,
    jurisdiction,
    card: card({ id: model, ...over }),
  };
}

export function node(over: Partial<TaskNode> = {}): TaskNode {
  return {
    id: 'n1',
    type: 'code_generation',
    messages: [{ role: 'user', content: 'Write a function that adds two numbers.' }],
    criticality: 'normal',
    ...over,
  };
}

/** Deterministic pseudo-random candidates for latency tests. */
export function syntheticCandidates(n: number, seed = 42): Candidate[] {
  let s = seed;
  const rnd = (): number => (s = (s * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
  const kinds: ProviderDescriptor['kind'][] = ['cloud', 'local', 'aggregator', 'test'];
  return Array.from({ length: n }, (_, i) =>
    cand(
      `p${i % 37}/model-${i}`,
      {
        contextWindow: [8_192, 32_000, 128_000, 1_000_000][i % 4] as number,
        price: { inputPerMTok: rnd() * 15, outputPerMTok: rnd() * 60 },
        latencyMsTypical: 200 + Math.floor(rnd() * 5_000),
        competence: { code_generation: rnd(), analysis: rnd() },
      },
      kinds[i % kinds.length],
      i % 3 === 0 ? 'EU' : 'US',
    ),
  );
}
